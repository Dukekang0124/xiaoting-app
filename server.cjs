/**
 * 墨小溟 · 单端口服务（静态托管 + 云端 ASR 代理 + 内测埋点）
 * ================================================================
 * 为什么需要它（v1.3 §2 的根因）：
 *   浏览器内置的 Web Speech API 在 iOS Safari 与微信内置浏览器里不可用（WKWebView 不暴露
 *   SpeechRecognition），而这两处恰好是国内真机流量的大头 —— 用户按了「按住说」却拿不到一个字。
 *   要真正解决，只能把录音送到专业云端 ASR。而云端 ASR 要 API Key / Secret Key，
 *   这类密钥绝不能进前端（F12 就能拿走，免费额度一天被刷光），所以必须有一个服务端代理。
 *
 * 三条设计纪律：
 *   1. 零依赖。只用 Node 内置模块 + 全局 fetch（Node 18+）。发布沙箱要装依赖才跑得起来的东西，
 *      在真机上就是一次不确定的失败面。
 *   2. 静态白名单。只对外暴露 /index.html、/styles.css、/sw.js、/manifest.webmanifest
 *      与 /js/ /icons/ /assets/ 三类前缀。server.cjs、package.json、server/asr.keys.json、
 *      _selftest/、data/ 一律 404 —— 密钥文件就在本项目里，这条不是防外人，是防自己写错。
 *   3. 永远 fail-soft。没配密钥返回 503 asr_not_configured，前端据此回落到浏览器内置识别或打字，
 *      绝不白屏、绝不把错误堆栈甩给用户。
 *
 * 复用来源：识别请求体（含 len 的 base64 填充修正）、错误码表、3303/3304 退避重试，
 *          均对齐「英语开口练」已线上验证的 kaikou-api Worker 实现，不重造。
 *
 * 启动：node server.cjs        （必须监听 $PORT 且绑定 0.0.0.0，反代才能进来）
 * 密钥：环境变量 ASR_BAIDU_AK / ASR_BAIDU_SK，或 server/asr.keys.json（见 asr.keys.example.json）
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const ROOT = __dirname;
// 清单→JS 生成器：与 scripts/build-web.mjs 共用同一份实现（唯一真相源 server/version.json）。
const { buildManifestJs } = require('./scripts/version-manifest-js.cjs');
async function ensureManifestJs(abs) {
  try {
    const raw = await fsp.readFile(path.join(ROOT, 'server', 'version.json'), 'utf8');
    const obj = JSON.parse(raw);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, buildManifestJs(obj), 'utf8');
    return true;
  } catch (e) {
    console.error('[moxiaoming][manifest-js-fail]', e && e.message);
    return false;
  }
}

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const VERSION = '1.6.8';

/* ==================== 静态资源白名单 ==================== */

const PUBLIC_FILES = new Set([
  '/index.html', '/styles.css', '/sw.js', '/manifest.webmanifest',
  // '/version.json'（v1.1.4）：静态版本清单。必须与后端 /api/version/latest 同源可达，
  // 理由见 js/update.js 顶部——APK 里读不到后端时就靠它。本地放行它，是为了让
  // "走静态清单"这条分支在自测里能真跑（否则本地行为与线上不一致，等于没测）。
  '/version.json',
  // '/version-latest.js'（v1.6.2）：清单的**脚本形态**（window.__VERSION_MANIFEST__ = {...}）。
  // APK 里取清单是跨域（页面在 https://localhost，清单在托管域），而线上网关对 /version.json
  // 不返回 Access-Control-Allow-Origin ⇒ fetch 被 CORS 拒 ⇒ 更新弹窗一次都不弹。
  // 经典 <script src> 不受 CORS 读限制，这条才是 APK 真能走通的路。
  '/version-latest.js',
  // '/moxiaoming_motion_sound_config.json'（v1.6.3）：动效/音效参数真相源。
  // 不放行的话本地自测 fetch 不到，而线上有 ⇒ 「本地全绿、线上没生效」的经典假绿。
  '/moxiaoming_motion_sound_config.json',
]);
// '/vendor/'（v1.1.3）：云服务 SDK 的随包副本。之前只有 /js/ /icons/ /assets/，
// 加了 vendor/ 却忘了开白名单 ⇒ 本地副本 404 ⇒ SDK 静默回退 CDN ⇒ 一旦外网不可达整条 AI 链路降级。
// 这类"加了新目录没同步白名单"的失败不会报错，只会让功能悄悄变差。
const PUBLIC_PREFIXES = ['/js/', '/icons/', '/assets/', '/vendor/', '/apk/'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.apk': 'application/vnd.android.package-archive',
};

/** 把 URL pathname 解析成磁盘绝对路径；不在白名单内一律返回 null（404）。 */
async function resolvePublic(pathname) {
  let p;
  try { p = decodeURIComponent(pathname); } catch (e) { return null; }
  if (pathname === '/' || p === '/') p = '/index.html';
  if (!p.startsWith('/') || p.includes('\0') || p.includes('..')) return null;
  if (!PUBLIC_FILES.has(p) && !PUBLIC_PREFIXES.some((d) => p.startsWith(d))) return null;
  // '/version.json'（v1.1.4）：线上是构建产物 www/version.json，本地没有这个根级文件。
  // 这里直接映到单一真相源 server/version.json —— 不复制副本，本地与线上行为因此完全一致，
  // 「走静态清单」这条分支才可能在自测里被真跑（否则本地 404、线上 200，等于没测）。
  if (p === '/version.json') return path.join(ROOT, 'server', 'version.json');
  if (p === '/version-latest.js') {
    const absJs = path.join(ROOT, 'www', 'version-latest.js');
    // 本地没跑过 build:web 时不能让它 404 —— 那会让"脚本通道"这条分支在自测里永远失败，
    // 而失败会被静默吞掉（回落硬编码）⇒ 又是一次看得见摸不着的假绿。这里直接从 SSOT 生成。
    try { await fsp.access(absJs); }
    catch (e) { if (!(await ensureManifestJs(absJs))) return null; }
    return absJs;
  }
  // '/apk/'（v1.1.5）：安装包。线上是构建产物 www/apk/，这里直接映射过去，
  // 让「点立即更新能不能真下到包」在本地自测里可被真跑。
  // 🔴 之前漏了这条：线上清单里 download_url 指向 /apk/xxx.apk，而本地一律 404 ——
  //    「本地 404、线上 200」等于这条分支压根没被验证过，正是更新按钮曾经点了没反应的原因。
  if (p.startsWith('/apk/')) {
    const rel = p.slice('/apk/'.length);
    if (!rel || rel.includes('..') || rel.includes('\0')) return null;
    const absApk = path.join(ROOT, 'www', 'apk', rel);
    const dist = path.join(ROOT, 'www', 'apk');
    if (!absApk.startsWith(dist + path.sep)) return null;
    return absApk;
  }
  const abs = path.join(ROOT, p);
  // 双保险：解析后仍必须在项目目录内（防符号链接/拼接绕过）
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return null;
  return abs;
}

async function serveStatic(req, res, pathname) {
  const abs = await resolvePublic(pathname);
  if (!abs) return sendText(res, 404, 'not found');
  let st;
  try { st = await fsp.stat(abs); } catch (e) { return sendText(res, 404, 'not found'); }
  if (!st.isFile()) return sendText(res, 404, 'not found');

  // ETag 用 mtime+size：静态资源必须让改动立刻可见（内测期改一版就要能刷出来），
  // 所以给 no-cache（每次带 If-None-Match 回来问）而不是长缓存；命中则 304，几乎零成本。
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    ETag: etag,
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  headers['Content-Length'] = st.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(abs).pipe(res);
}

/* ==================== 响应小工具 ==================== */

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body_too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/* ==================== 来源门禁 + 限流 ==================== */
//
// 应用与接口同源，所以门禁不需要维护一份域名白名单（发布域名换过一次就要改代码，很容易漏）：
//   - 带 Origin 头 → 必须与 Host 同源（浏览器发出的同源 fetch 一定带 Origin）
//   - 不带 Origin → 看 Sec-Fetch-Site；再不行看 Referer 是否同源
// curl / 脚本三者皆无 → 拒绝。这样「同源可用、异源全挡」，且换域名无需改配置。
function sameOrigin(req) {
  const host = String(req.headers.host || '');
  const origin = req.headers.origin;
  if (origin) {
    try { return new URL(origin).host === host; } catch (e) { return false; }
  }
  const site = String(req.headers['sec-fetch-site'] || '');
  if (site === 'same-origin' || site === 'none') return true;
  const ref = req.headers.referer;
  if (ref) {
    try { return new URL(ref).host === host; } catch (e) { return false; }
  }
  return false;
}

const RATE = { asr: { perMin: 20, perDay: 300 }, events: { perMin: 12, perDay: 200 } };
const buckets = new Map();

function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.socket.remoteAddress || 'unknown';
}

function checkRate(kind, ip) {
  const lim = RATE[kind];
  const now = Date.now();
  const minute = Math.floor(now / 60000);
  const day = new Date(now).toISOString().slice(0, 10);
  const key = ip + ':' + kind;
  let b = buckets.get(key);
  if (!b || b.minute !== minute || b.day !== day) {
    b = { minute, day, minCount: 0, dayCount: (b && b.day === day) ? b.dayCount : 0 };
    buckets.set(key, b);
    if (buckets.size > 5000) {
      for (const [k, v] of buckets) {
        if (v.day !== day) buckets.delete(k);
        if (buckets.size < 2500) break;
      }
    }
  }
  b.minCount++; b.dayCount++;
  return { ok: b.minCount <= lim.perMin && b.dayCount <= lim.perDay, dayCount: b.dayCount, limit: lim };
}

/* ==================== 密钥装载 ==================== */
//
// 顺序：环境变量 → server/asr.keys.json → ASR_KEYS_FILE 指向的文件。
// 最后一条是给本机开发用的：可以直接指向你已有的密钥记录文件，不必把密钥复制进项目。
// 密钥只在进程内存里，任何响应体、日志里都不会出现它。
let KEY_CACHE = null;
let KEY_FAILED_AT = 0;

function pickKeys(src) {
  const ak = src.apiKey || src.ak || src.API_KEY || (src.baidu && src.baidu.apiKey) || '';
  const sk = src.secretKey || src.sk || src.SECRET_KEY || (src.baidu && src.baidu.secretKey) || '';
  return (ak && sk) ? { ak: String(ak).trim(), sk: String(sk).trim() } : null;
}

function loadKeys() {
  if (KEY_CACHE) return KEY_CACHE;
  if (KEY_FAILED_AT && Date.now() - KEY_FAILED_AT < 60000) return { ak: '', sk: '', source: 'none' };

  const envAk = process.env.ASR_BAIDU_AK || process.env.BAIDU_API_KEY || '';
  const envSk = process.env.ASR_BAIDU_SK || process.env.BAIDU_SECRET_KEY || '';
  if (envAk && envSk) {
    KEY_CACHE = { ak: envAk.trim(), sk: envSk.trim(), source: 'env' };
    return KEY_CACHE;
  }

  const files = [path.join(ROOT, 'server', 'asr.keys.json')];
  if (process.env.ASR_KEYS_FILE) files.push(process.env.ASR_KEYS_FILE);

  for (const f of files) {
    let raw;
    try { raw = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
    try {
      const got = pickKeys(JSON.parse(raw));
      if (got) { KEY_CACHE = { ...got, source: 'json:' + path.basename(f) }; return KEY_CACHE; }
    } catch (e) { /* 不是 JSON，落下去按纯文本兜底 */ }
    // 纯文本兜底：人工记录格式（"API Key：xxx" / "Secret Key: yyy"）
    const ak = (raw.match(/(?:API[\s_-]*Key|apiKey|\bak\b)\s*[:：=]\s*([A-Za-z0-9_-]{8,})/i) || [])[1] || '';
    const sk = (raw.match(/(?:Secret[\s_-]*Key|secretKey|\bsk\b)\s*[:：=]\s*([A-Za-z0-9_-]{8,})/i) || [])[1] || '';
    if (ak && sk) { KEY_CACHE = { ak, sk, source: 'text:' + path.basename(f) }; return KEY_CACHE; }
  }

  KEY_FAILED_AT = Date.now();
  return { ak: '', sk: '', source: 'none' };
}

/* ==================== 百度 ASR ==================== */

// 两个地址留了环境变量出口：默认值就是生产值，不改行为；但有了它，
// /api/asr 这条链路才能被端到端真跑（把两个 URL 指向本地桩，验证「识别成功 → 可选顺句 → 返回」
// 这条接线真的通，而不是只能靠读代码推断）。没有这个出口，缺少百度密钥的机器上这段就永远测不到。
const BAIDU_TOKEN_URL = process.env.ASR_TOKEN_URL || 'https://aip.baidubce.com/oauth/2.0/token';
const BAIDU_ASR_URL = process.env.ASR_API_URL || 'https://vop.baidu.com/server_api';
const DEV_PID = { zh: 1537, en: 1737 };
const MAX_B64_LEN = 3_000_000; // 16kHz/16bit 单声道 ≈ 32KB/秒，base64 后 55 秒 ≈ 2.4MB

let TOKEN = { v: '', exp: 0 };

async function getToken(keys) {
  if (TOKEN.v && Date.now() < TOKEN.exp) return TOKEN.v;
  const r = await fetchWithTimeout(BAIDU_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: keys.ak,
      client_secret: keys.sk,
    }),
  }, 12000);
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) {
    // 百度原文里不会包含 Secret Key，可以安全带回去排查
    throw new Error('token_failed:' + (j.error || j.error_description || ('http_' + r.status)));
  }
  // expires_in 是秒（2592000 = 30 天），提前 1 天过期，避免时钟误差用到过期 token
  TOKEN = { v: j.access_token, exp: Date.now() + (Number(j.expires_in) || 2592000) * 1000 - 86400000 };
  return TOKEN.v;
}

const ASR_ERR = {
  3300: '输入参数不正确', 3301: '音频质量过差（太短/太小/全是噪音）', 3302: '鉴权失败，检查 API Key / Secret Key',
  3303: '语音服务器后端问题', 3304: '请求并发超限，请稍后重试', 3305: '每日请求量超限',
  3307: '识别服务内部错误', 3308: '音频过长', 3309: '音频数据问题', 3310: '音频过大',
  3312: '参数 format 与音频实际格式不匹配', 3313: '单次上传音频时长超限（上限 60 秒）',
  3314: 'len 参数与音频实际字节数不一致（检查 base64 填充）', 3315: '音频格式不支持',
  3316: '音频采样率不支持（需 16000Hz）',
};
const RETRIABLE = new Set([3303, 3304]);

async function handleAsr(req, res) {
  if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'origin_not_allowed' });
  const ip = clientIp(req);
  const rl = checkRate('asr', ip);
  if (!rl.ok) return sendJson(res, 429, { ok: false, error: 'rate_limited', day_count: rl.dayCount, day_limit: rl.limit.perDay });

  const keys = loadKeys();
  if (!keys.ak || !keys.sk) {
    // 没配密钥：明确告诉前端"回落"，这不是失败
    return sendJson(res, 503, { ok: false, error: 'asr_not_configured' });
  }

  let body;
  try {
    body = JSON.parse((await readBody(req)).toString('utf8'));
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: 'bad_json' });
  }

  const speech = String((body && body.speech) || '');
  const lang = DEV_PID[body && body.lang] ? body.lang : 'zh';
  if (!speech) return sendJson(res, 400, { ok: false, error: 'empty_audio' });
  if (speech.length > MAX_B64_LEN) return sendJson(res, 413, { ok: false, error: 'audio_too_long', max: MAX_B64_LEN });

  let token;
  try {
    token = await getToken(keys);
  } catch (e) {
    return sendJson(res, 502, { ok: false, error: 'token_error', detail: String(e.message || e) });
  }

  // 百度要求 len = 原始音频字节数（不是 base64 字符数），且必须严格相等，差 1 就报 3300/3314。
  // 反推时必须扣掉 base64 末尾的 '=' 填充：无 → L/4*3；1 个 → -1；2 个 → -2。
  // 这里踩过坑：早期直接写 floor(L*3/4)，自测音频恰是 3 的倍数（无填充）所以没暴露，
  // 一旦接上浏览器转码出的真实录音（几乎必然带填充）就全线 3300。
  const pad = speech.endsWith('==') ? 2 : (speech.endsWith('=') ? 1 : 0);
  const rawLen = Math.floor((speech.length * 3) / 4) - pad;

  const payload = {
    format: 'wav', rate: 16000, channel: 1, cuid: 'xiaoting',
    token, dev_pid: DEV_PID[lang], len: rawLen, speech,
  };

  const t0 = Date.now();
  let j = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    let r;
    try {
      r = await fetchWithTimeout(BAIDU_ASR_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }, 15000);
    } catch (e) {
      if (attempt < 2) { await sleep(300 * 2 ** attempt); continue; }
      return sendJson(res, 502, { ok: false, error: 'asr_network', detail: String(e.message || e), ms: Date.now() - t0 });
    }
    j = await r.json().catch(() => null);
    if (j && j.err_no === 0) {
      const rawText = (j.result || []).join(' ').trim();
      // 可选的一步：顺句。asr_cleanup 默认关闭 ⇒ isModuleEnabled 直接短路，零成本、响应结构也不变。
      // 开启后若模型失败/被护栏拒绝，一律保留原文 —— 一个可选步骤不该把「识别成功」拖成失败。
      const c = await asrCleanup(rawText);
      const out = {
        ok: true,
        text: c.applied ? c.text : rawText,
        engine: 'baidu',
        ms: Date.now() - t0,
      };
      if (c.applied) {
        // 顺句生效时把原文一并给出：对情绪产品，用户原话是证据，不能因为顺过一次句就丢掉。
        out.text_raw = rawText;
        out.cleanup = { applied: true, model: c.model || '', ms: c.ms || 0, ratio: c.ratio, degraded: !!c.degraded };
      } else if (c.reason && c.reason !== 'module_disabled' && c.reason !== 'empty') {
        // 开着但没采纳（模型失败或被护栏拦下）也要留痕，否则"为什么没顺句"无从追问。
        out.cleanup = { applied: false, reason: c.reason, model: c.model || '', ms: c.ms || 0 };
      }
      return sendJson(res, 200, out);
    }
    if (!j || !RETRIABLE.has(j.err_no)) break;
    await sleep(300 * 2 ** attempt); // 300ms, 600ms
  }

  const errNo = j ? j.err_no : -1;
  return sendJson(res, 502, {
    ok: false, error: 'asr_failed', err_no: errNo, err_msg: j ? j.err_msg : 'no_response',
    hint: ASR_ERR[errNo] || '未知错误', ms: Date.now() - t0,
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ==================== 内测埋点（v1.3 §4 的地基） ====================
 * 只做一件事：把客户端事件按天落到 JSONL，并提供一个聚合视图。
 * 不用数据库（沙箱没有），一个文件一天的追加写入足够扛内测量级，
 * 而且 JSONL 可以直接下载下来用脚本算，不依赖任何服务。
 * 隐私边界：只收结构化计数与错误码，不收用户正文。
 */
const DATA_DIR = path.join(ROOT, 'data');

async function handleEvents(req, res) {
  if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'origin_not_allowed' });
  const rl = checkRate('events', clientIp(req));
  if (!rl.ok) return sendJson(res, 429, { ok: false, error: 'rate_limited' });

  let body;
  try { body = JSON.parse((await readBody(req)).toString('utf8')); }
  catch (e) { return sendJson(res, 400, { ok: false, error: 'bad_json' }); }

  const list = Array.isArray(body && body.events) ? body.events.slice(0, 50) : [];
  if (!list.length) return sendJson(res, 400, { ok: false, error: 'no_events' });

  const day = new Date().toISOString().slice(0, 10);
  const lines = [];
  for (const e of list) {
    if (!e || typeof e.name !== 'string' || !e.name) continue;
    lines.push(JSON.stringify({
      ts: Number(e.ts) || Date.now(),
      name: e.name.slice(0, 40),
      sid: String(e.sid || '').slice(0, 40),
      dev: String(e.dev || '').slice(0, 40),
      ver: String(e.ver || '').slice(0, 16),
      data: sanitizeData(e.data),
    }));
  }
  if (!lines.length) return sendJson(res, 400, { ok: false, error: 'no_valid_events' });

  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    await fsp.appendFile(path.join(DATA_DIR, 'events-' + day + '.jsonl'), lines.join('\n') + '\n', 'utf8');
  } catch (e) {
    // 落盘失败不能影响用户链路
    return sendJson(res, 200, { ok: true, stored: 0, persisted: false });
  }
  return sendJson(res, 200, { ok: true, stored: lines.length, persisted: true });
}

/** data 只允许扁平的基础类型，挡掉把用户正文夹带进来的可能 */
function sanitizeData(d) {
  if (!d || typeof d !== 'object') return {};
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(d)) {
    if (n++ >= 12) break;
    const key = String(k).slice(0, 24);
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
    else if (typeof v === 'boolean') out[key] = v;
    else if (typeof v === 'string') out[key] = v.slice(0, 40).replace(/[\r\n\t]/g, ' ');
  }
  return out;
}

async function handleStats(req, res, url) {
  const key = url.searchParams.get('key') || '';
  const STATS_KEY = process.env.STATS_KEY || '';
  if (!STATS_KEY || key !== STATS_KEY) return sendJson(res, 404, { ok: false, error: 'not_found' });

  const days = Math.min(30, Math.max(1, parseInt(url.searchParams.get('days'), 10) || 7));
  const since = Date.now() - days * 86400000;
  const byName = {};
  const byDay = {};
  const sids = new Map(); // sid -> { asrOk, asrFail, draft, rounds, saved, risk }
  let total = 0;

  let files = [];
  try { files = (await fsp.readdir(DATA_DIR)).filter((f) => f.startsWith('events-') && f.endsWith('.jsonl')); }
  catch (e) { files = []; }

  for (const f of files) {
    let text;
    try { text = await fsp.readFile(path.join(DATA_DIR, f), 'utf8'); } catch (e) { continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      let e;
      try { e = JSON.parse(line); } catch (err) { continue; }
      if (!e.ts || e.ts < since) continue;
      total++;
      byName[e.name] = (byName[e.name] || 0) + 1;
      const d = new Date(e.ts).toISOString().slice(0, 10);
      byDay[d] = (byDay[d] || 0) + 1;
      if (!e.sid) continue;
      let s = sids.get(e.sid);
      if (!s) { s = { asrOk: 0, asrFail: 0, draft: 0, maxRound: 0, saved: 0, risk: {} }; sids.set(e.sid, s); }
      if (e.name === 'asr_ok') s.asrOk++;
      else if (e.name === 'asr_fail') s.asrFail++;
      else if (e.name === 'draft_start') s.draft++;
      else if (e.name === 'followup_round') s.maxRound = Math.max(s.maxRound, Number(e.data && e.data.round) || 0);
      else if (e.name === 'card_saved') s.saved++;
      else if (e.name === 'risk') {
        const lv = String((e.data && e.data.level) || '');
        s.risk[lv] = (s.risk[lv] || 0) + 1;
      }
    }
  }

  const sessions = [...sids.values()];
  const asrOk = sessions.reduce((a, s) => a + s.asrOk, 0);
  const asrFail = sessions.reduce((a, s) => a + s.asrFail, 0);
  const drafts = sessions.reduce((a, s) => a + s.draft, 0);
  const saved = sessions.reduce((a, s) => a + s.saved, 0);
  // §4 四项内测指标（高风险转介"准确率"需要人工/模型复核标注，本端点先出"判定分布"）
  const risks = {};
  sessions.forEach((s) => Object.entries(s.risk).forEach(([k, v]) => { risks[k] = (risks[k] || 0) + v; }));
  const followupDone = sessions.filter((s) => s.maxRound >= 3).length;

  return sendJson(res, 200, {
    ok: true,
    days,
    events_total: total,
    top: Object.entries(byName).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    byDay,
    sessions: sids.size,
    metrics: {
      recording_success_rate: (asrOk + asrFail) ? Math.round((asrOk / (asrOk + asrFail)) * 100) : null,
      asr_ok: asrOk, asr_fail: asrFail,
      draft_sessions: drafts,
      followup_full_rate: sessions.length ? Math.round((followupDone / sessions.length) * 100) : null,
      card_save_rate: drafts ? Math.round((saved / drafts) * 100) : null,
      risk_distribution: risks,
    },
  });
}

async function handleHealth(req, res) {
  const keys = loadKeys();
  const configured = !!(keys.ak && keys.sk);
  sendJson(res, 200, {
    ok: true,
    version: VERSION,
    asr: configured ? 'ready' : 'unconfigured',
    // 只回粗粒度来源，不回文件名 —— 这个端点是公开的，没必要告诉任何人密钥记在哪个文件里
    key_source: configured ? (keys.source === 'env' ? 'env' : 'file') : 'none',
    token_cached: !!(TOKEN.v && Date.now() < TOKEN.exp),
    now: new Date().toISOString(),
  });
  // 预热 token：让用户按下「按住说」之后的那一次识别少一次取 token 的往返（约 0.3-0.8s）
  if (configured && !(TOKEN.v && Date.now() < TOKEN.exp)) {
    getToken(keys).catch((e) => console.warn('[moxiaoming][token-warm-fail]', String(e.message || e)));
  }
}

/* ==================== 版本接口（v0.7.0：版本更新与自动弹窗） ==================== */

const VERSION_FILE = path.join(ROOT, 'server', 'version.json');

// 文件缺失/损坏时的兜底：latest_version 回退到「当前构建版本」⇒ 不会误弹更新。
// 缺字段也合并补齐，避免前端拿到 undefined 而报错。
const VERSION_FALLBACK = {
  latest_version: VERSION,
  force_update: false,
  download_url: '',
  web_url: '',
  release_notes: [],
  history: [],
};

function loadVersion() {
  try {
    const raw = fs.readFileSync(VERSION_FILE, 'utf8');
    const obj = JSON.parse(raw);
    const merged = Object.assign({}, VERSION_FALLBACK, obj);
    if (!Array.isArray(merged.history)) merged.history = [];
    if (!Array.isArray(merged.release_notes)) merged.release_notes = [];
    return merged;
  } catch (e) {
    return VERSION_FALLBACK;
  }
}

// 只回前端弹窗需要的 5 个字段（《版本更新与自动弹窗模块开发指令》§后端契约）
function handleVersionLatest(req, res) {
  const v = loadVersion();
  sendJson(res, 200, {
    latest_version: v.latest_version,
    release_notes: v.release_notes,
    download_url: v.download_url,
    force_update: !!v.force_update,
    web_url: v.web_url,
  });
}

// 更新历史（给「关于墨小溟 / 更新日志」页用）
function handleVersionHistory(req, res) {
  const v = loadVersion();
  sendJson(res, 200, {
    latest_version: v.latest_version,
    versions: v.history,
  });
}

/* ==================== 内部模型调度（v1.1.4：后端核心机制） ====================
 *
 * 为什么这一段的每个端点都带前缀 /api/llm/ 却「不对用户展示」：
 *   · /api/llm       —— 前端唯一入口，但它只传模块名，不传模型名 ⇒ 换模型不用改前端、不用重发版；
 *   · /api/llm/config—— 配置脱敏快照，给运维/审计看「现在跑的是哪套规则」，一个字符的 key 都不带出去；
 *   · /api/llm/stats —— 调用日志聚合（哪个模型、多少毫秒、降级率）。
 * 密钥只在路由层内存里，永远不经过 sendJson 出去。
 */

const llmRouter = require('./server/llm-router.cjs');
// ASR 文本顺句（可选模块 asr_cleanup，默认关闭）。做成依赖注入是为了可被桩替换 —— 没有百度
// 密钥的机器上 /api/asr 只会返回 503，若把逻辑内联在这里，那段分支就永远得不到验证。
const { createAsrCleanup } = require('./server/asr-cleanup.cjs');
const asrCleanup = createAsrCleanup(llmRouter);

const LLM_MAX_BODY = 256 * 1024; // 单次请求体上限：Prompt 再长也不该超过这个数

function readBody(req, limit = LLM_MAX_BODY) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(new Error('body_too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// 模块名白名单：不允许前端凭空指定一个模块名去打模型（那也是种越权）
const LLM_MODULES = ['default', 'safety', 'analysis', 'followup', 'card', 'timeline', 'weekly', 'asr_cleanup'];

async function handleLlm(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'use_post' });
  // 🔴 同源门禁（与 /api/asr、/api/events 一致）。
  // 为什么必须加：这个端点会**真花钱**调模型。没有门禁时，任何网页/脚本都能拿它当免费额度池，
  // 实测过：`Origin: https://evil.example` 打进来返回 200 且真调用了模型。
  // 代价是原生容器（页面在 https://localhost、请求打绝对基址）会被判为异源 —— 但那是**全局性**问题
  // （/api/asr 同样如此，真机才改用设备识别），该整体解决，不该靠给单个端点开洞来绕过。
  if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'origin_not_allowed' });

  let payload;
  try {
    const raw = await readBody(req);
    payload = JSON.parse(raw || '{}');
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: 'bad_json' });
  }

  const module = LLM_MODULES.includes(payload.module) ? payload.module : 'default';
  const system = typeof payload.system === 'string' ? payload.system : '';
  const user = typeof payload.user === 'string' ? payload.user : '';
  if (!user.trim()) return sendJson(res, 400, { ok: false, error: 'empty_user' });

  const maxChars = (llmRouter.loadConfig().defaults || {}).maxInputChars || 4000;
  const r = await llmRouter.route({
    module,
    system,
    user: user.slice(0, maxChars),
    json: !!payload.json,
    temperature: typeof payload.temperature === 'number' ? payload.temperature : undefined,
    maxTokens: typeof payload.maxTokens === 'number' ? payload.maxTokens : undefined,
    timeoutMs: typeof payload.timeoutMs === 'number' ? payload.timeoutMs : undefined,
  });

  // 回给前端的结构里**没有** provider 的 endpoint 与 key，只有「用了谁、降了几档」这类可观测信息
  return sendJson(res, 200, {
    ok: !!r.ok,
    text: r.text || '',
    model: r.model || '',
    channel: r.provider || '',
    degraded: !!r.degraded,
    attempts: r.attempts || 0,
    ms: r.ms || 0,
    code: r.code || '',
    // tried[] 带上 provider：失败轨迹要能回答「是智谱挂了还是网关挂了」。
    // provider id / endpoint 本就在无需鉴权的 /api/llm/config 里可见，这里补回不新增任何暴露面。
    tried: (r.tried || []).map((t) => ({ provider: t.provider, model: t.model, ok: t.ok, code: t.code, ms: t.ms, attempt: t.attempt })),
  });
}

function handleLlmConfig(req, res) {
  return sendJson(res, 200, { ok: true, ...llmRouter.inspectConfig() });
}

function handleLlmStats(req, res, url) {
  const n = Math.min(60, Math.max(1, Number(url.searchParams.get('recent') || 20)));
  return sendJson(res, 200, { ok: true, stats: llmRouter.stats(), recent: llmRouter.recent(n) });
}

async function handleLlmPing(req, res, url) {
  // 探活会真打模型（花额度、也制造线上噪声），属于运维动作：
  // 不放在公开路径上无条件可跑，与 /api/stats 同一把钥匙。未配置 STATS_KEY 时一律不可用。
  const key = (url && url.searchParams.get('key')) || '';
  const STATS_KEY = process.env.STATS_KEY || '';
  if (!STATS_KEY || key !== STATS_KEY) return sendJson(res, 404, { ok: false, error: 'not_found' });
  let payload = {};
  try { payload = JSON.parse((await readBody(req, 4096)) || '{}'); } catch (e) { /* 允许空 body */ }
  const module = LLM_MODULES.includes(payload.module) ? payload.module : 'safety';
  const results = await llmRouter.ping(module);
  return sendJson(res, 200, { ok: true, module, results });
}

/* ==================== 入口 ==================== */

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://' + (req.headers.host || 'localhost')); }
  catch (e) { return sendText(res, 400, 'bad request'); }
  const p = url.pathname;

  try {
    if (p.startsWith('/api/')) {
      if (p === '/api/health') return await handleHealth(req, res);
      if (p === '/api/version/latest') return await handleVersionLatest(req, res);
      if (p === '/api/version/history') return await handleVersionHistory(req, res);
      if (p === '/api/asr') {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'use_post' });
        return await handleAsr(req, res);
      }
      if (p === '/api/events') {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'use_post' });
        return await handleEvents(req, res);
      }
      if (p === '/api/stats') return await handleStats(req, res, url);
      // 内部模型调度（后端核心机制，不对用户展示）
      if (p === '/api/llm') return await handleLlm(req, res);
      if (p === '/api/llm/config') return handleLlmConfig(req, res);
      if (p === '/api/llm/stats') return handleLlmStats(req, res, url);
      if (p === '/api/llm/ping') {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'use_post' });
        return await handleLlmPing(req, res, url);
      }
      return sendJson(res, 404, { ok: false, error: 'no_such_api' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'method not allowed');
    return await serveStatic(req, res, p);
  } catch (e) {
    console.error('[moxiaoming][error]', e);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal' });
  }
});

server.listen(PORT, HOST, () => {
  const k = loadKeys();
  console.log(`[moxiaoming] v${VERSION} listening on ${HOST}:${PORT}`);
  console.log(`[moxiaoming] asr=${k.ak ? 'ready(' + k.source + ')' : 'unconfigured'} stats=${process.env.STATS_KEY ? 'on' : 'off'}`);
  if (k.ak) getToken(k).catch((e) => console.warn('[moxiaoming][token-warm-fail]', String(e.message || e)));
});

// 反代/沙箱会发 SIGTERM，正常收尾，避免半截写入
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000); });
}
