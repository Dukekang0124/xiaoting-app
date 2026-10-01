// 墨小溟 · 版本更新与自动弹窗（v0.7.0）
// ------------------------------------------------------------------
// 设计要点（《版本更新与自动弹窗模块开发指令》）：
//   检测时机：App 启动 + 从后台回到前台（visibilitychange）
//   平台识别：微信 / Android(APK) / iOS / 普通浏览器
//   弹窗：自定义 Modal（非 window.confirm）—— 圆角 20px、暖奶油白 #FFF8F0、墨小溟举牌 IP、温和文案
//   非强制：立即更新(柔紫) + 稍后再说(灰，关闭 + 当天不再提醒)
//   强制：单个「立即更新」按钮，不可关闭
//   release_notes 逐条小圆点展示
//
// 测试入口（仅当 URL 带 query 时生效，正常用户不会带，零副作用）：
//   ?fake_version=9.9.9  → 把"线上最新版"临时改成指定值，方便看弹窗
//   ?force_update=1      → 把"是否强制"临时改成 true
//   ?showUpdate=1|force  → 版本相同也强制弹一次（纯视觉检查用）
//   ?app=android         → 模拟 APK 分支（正常安卓壳靠 UA 标记识别）

import { mascot } from './ip.js';
import { apiBase, isNativeApp } from './config.js';
import * as diag from './diag.js';
import { toast } from './store.js';

/* ---------------- 常量 ---------------- */

const SNOOZE_KEY = 'xiaoting:update_snooze_day'; // 当天"稍后再说"过的日期

/**
 * v1.4.2 · 硬编码「已知最新」兜底（康哥要求，但取值规则我改了，理由见下）
 *
 * 为什么需要它：线上版本清单是**静态文件**，只有发布站点才会变。
 *   一旦发版漏了发布站点（v1.4.1 正是如此：APK 发了、www 没发），
 *   线上 latest 还停在 1.3.5 ⇒ 比用户手上的 1.4.0 还旧 ⇒ 永远判定「已是最新」。
 *   这类故障前端完全看不出来，用户只会觉得「更新功能是死的」。
 *
 * 🔴 取值规则必须是「线上与硬编码**取较大者**」，不能用硬编码直接覆盖：
 *   直接覆盖 ⇒ 以后每发一版都得回来改这个常量，忘了改就等于把更新功能**反向锁死**
 *   （新版 1.6.0 上线了，硬编码还写 1.4.2 ⇒ 用户永远收不到 1.6.0 的提示）。
 *   那等于用一个新坑换掉旧坑。取大者时，它只在「线上更旧/取不到」时才起作用。
 *
 * 🔴 与 APP_VERSION 必须同步：自测里有一条断言卡死这条（两者必须相等），
 *   否则「发版忘改常量」又会变成下一个静默故障。
 */
export const LATEST_VERSION = '1.6.4';

/** 兜底安装包地址：必须是**版本化文件名**，不能用 xiaoting-latest.apk 别名
 *  （别名指向"站点上最新的那一版"，站点没发布时它反而是旧版 ⇒ 会让人装回旧包）。 */
const FALLBACK_APK_URL = 'https://xiaoting.app.workbuddy.host/apk/Xiaoting-v1.6.4-release.apk';

/**
 * 版本清单的两个候选路径，按顺序试（v1.1.4 修）。
 *
 * 🔴 为什么必须走 apiBase()：
 *   APK 里网页跑在 WebView 的 `https://localhost` 上（Capacitor androidScheme=https）。
 *   相对路径 `/api/version/latest` 打的是 **WebView 本地资产服务**，永远 404
 *   ⇒ 更新检测一次都不会成功、且失败被静默吞掉 ⇒ **用户永远收不到新版提示**。
 *   这与 v1.1.2 修过的 ASR 是同一类缺陷（`js/asr.js` 早就用了 apiBase），当年漏了本文件。
 *
 * 🔴 为什么要有静态清单这条兜底：
 *   公开站是**静态托管**（CloudStudio Gateway），没有 Node 后端 ⇒ `/api/version/*` 恒 404。
 *   所以 `version.json` 会被一并发布成静态文件，它不依赖任何服务端，是 APK 唯一可靠路径。
 *   顺序是有意的：有后端时优先用后端（以后端为准），没后端就落到静态清单。
 */
const LATEST_PATHS = ['/api/version/latest', '/version.json'];

/** 清单的**脚本形态**（v1.6.2）：同一份清单再发一份 `window.__VERSION_MANIFEST__ = {...}`。
 *
 * 🔴 这条通道是被真机截图逼出来的，不是"顺手多加一个候选"：
 *   APK 里页面跑在 Capacitor 的 `https://localhost`，取清单只能拼成跨域绝对地址
 *   `https://xiaoting.app.workbuddy.host/version.json`。实测线上该响应的头：
 *     HTTP/1.1 200 + Content-Type: application/json
 *   ——**没有 Access-Control-Allow-Origin**（带 Origin 头复测过，两次都如此）。
 *   于是浏览器把 fetch 判成 CORS 失败 ⇒ 两个 JSON 候选（/api/version/latest 恒 404、
 *   /version.json 被 CORS 拒）全挂 ⇒ 落硬编码兜底 ⇒ `latest === LATEST_VERSION === APP_VERSION`
 *   ⇒ `cmpVersion === 0` ⇒ `hasNew = false` ⇒ **更新弹窗一次都不会弹**。
 *   用户截图里那句「暂时没连上更新服务，按本地记录你已是最新 v1.4.6」就是这条链路的输出。
 *
 *   `<script src>` 是经典脚本标签，从诞生起就允许跨源执行，不受 CORS 的"读回来"限制。
 *   所以只要清单能以 JS 赋值脚本的形式发布，跨域读清单这条路就通了 ——
 *   既不用求托管方给 ACAO，也不必为一次版本检测去换托管平台。
 *   生成规则见 scripts/version-manifest-js.cjs（build-web.mjs 与 server.cjs 共用同一实现）。
 */
const SCRIPT_MANIFEST_PATH = '/version-latest.js';

// v1.4.6 · 清单第三条路：Cloudflare Pages 域名（与站点**不同源、不同 CDN、不同缓存桶**）。
// 背景（v1.4.4 真机截图实证）：发版后 workbuddy 网关的缓存收敛窗口可达小时级，
// 期间站点清单一直返回旧 latest ⇒ 检查更新永远「已是最新」，用户收不到任何提示。
// 只靠"等 TTL 自愈"是把用户的更新体验押在运气上。清单从此三条候选**并行全拿、取版本号最大者**：
// 任何一个节点先更新到新清单，用户就能收到提示 —— 这是"保证弹"的唯一结构性解法。
const LATEST_FALLBACK_ORIGIN = 'https://xiaoting-asr.pages.dev';
// 🔴 开关必须与部署状态同步：pages.dev 上还没有 version.json（部署需要 CF 凭证，待办），
//    现在启用的话每轮检查更新都会多一个必失败请求（SPA 回落 200+HTML ⇒ JSON.parse 抛错 ⇒
//    console.error 噪音 + 主回归「无页面 JS 错误」护栏红）。部署完成后改 true。
const LATEST_FALLBACK_ENABLED = false;

/** 最近一次取数失败的原因（给诊断页 / 自测断言用，不再静默） */
let lastError = '';

export function lastFetchError() { return lastError; }

/* ---------------- 小工具 ---------------- */

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * 把可能是相对路径的地址补成绝对地址。
 * APK 里页面在 `https://localhost`，任何相对路径都指向 WebView 本地资产 ⇒ 必须补到服务端基址。
 * 已经是 http(s):// 的原样返回（静态清单里的地址本来就是绝对的）。
 */
function absUrl(u) {
  const s = String(u == null ? '' : u).trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  const base = apiBase();
  if (!base) return s; // Web 同源：相对路径本来就是对的
  return base + (s.startsWith('/') ? s : '/' + s);
}

export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 语义化版本比较：a>b 返回正数，a<b 返回负数，相等返回 0 */
export function cmpVersion(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * 平台识别：微信 / Android(APK) / iOS / 普通浏览器
 *
 * 🔴 v1.1.6 修：`isApk` 曾经**只看 UA 标记**（`xiaotingandroid|xiaoting_app`），
 *   但那个标记全仓库从来没有被设过——`capacitor.config.json` 里没有 `appendUserAgent`，
 *   CI 生成 android 工程时也没注入。后果是真机里 `isApk` 恒为 false：
 *     · 弹窗走 Web 文案（"会自动刷新到最新版"，而 APK 里资源是打包在壳内的，刷新不可能变新版）
 *     · 点「立即更新」进 `webUpdateReload()` —— 清缓存 + reload，**永远装不上新版**
 *   即"弹窗弹得出来、按钮点不动"，断的正是「可供更新」那一半。
 *   判据改成 Capacitor 桥（`isNativeApp()`）——和 `apiBase()` 用的是同一个信号，
 *   它才是"我此刻跑在原生壳里"的可靠事实来源；UA 标记与 `?app=android` 保留为兜底/自测入口。
 */
export function platform() {
  const ua = navigator.userAgent || '';
  const isWeChat = /micromessenger/i.test(ua);
  const isIOS = /iphone|ipad|ipod/i.test(ua);
  const isAndroid = /android/i.test(ua);
  const isApk = isNativeApp()
    || /xiaotingandroid|xiaoting_app/i.test(ua)
    || /[?&]app=android\b/.test(location.search);
  return { ua, isWeChat, isIOS, isAndroid, isApk };
}

export function getSnoozeDay() {
  try { return localStorage.getItem(SNOOZE_KEY) || ''; } catch (e) { return ''; }
}
export function setSnoozeDay() {
  try { localStorage.setItem(SNOOZE_KEY, todayStr()); } catch (e) {}
}

/**
 * 按**版本**记住"用户已经拒绝过这次更新"（v1.4.3，对齐 Sinoky 的 apkDismissed 语义）。
 *
 * 旧行为是"当天不再提示，明天继续弹"：用户明确点过「稍后再说」，第二天又被弹一次，
 * 而他并没有改变主意。按版本记忆才对得上用户的真实意图——
 * 「这个版本我暂时不装」≠「今天不装，明天我可能就装」。
 *
 * 自动检测才会被它短路；「关于墨小溟」页的手动检查**永远可用**（用户主动问就必须给答案）。
 * 拒绝过 1.4.3 之后，1.6.0 发布时仍然会正常提示（版本不同）。
 */
const DISMISS_KEY = 'xiaoting:update_dismissed_ver';

export function getDismissedVersion() {
  try { return localStorage.getItem(DISMISS_KEY) || ''; } catch (e) { return ''; }
}
export function setDismissedVersion(v) {
  try { localStorage.setItem(DISMISS_KEY, String(v || '')); } catch (e) {}
}

async function fetchJson(url) {
  // v1.4.6：随机 query 破网关缓存桶。
  // `cache:'no-store'` 只约束**浏览器** HTTP 缓存，管不了 CloudStudio 网关 ——
  // 它按 (路径, Accept-Encoding) 分桶缓存（v1.3.5 实测），发版后清单会被拖在旧节点上
  // 长达小时级，期间用户无论怎么点都只拿到旧快照（v1.4.4 真机截图实证：
  // 线上已发 1.4.5，真机检查更新却读回 1.4.4）。随机 query = 新 URL key = 网关必然回源。
  // 清单是低频请求（启动 + 手动检查），每次多一个回源代价可忽略。Sinoky 同款（?t= 防缓存）。
  const bustUrl = url + (url.includes('?') ? '&' : '?') + 'cb=' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  // v1.1.10：版本检测补 8 秒超时保护（ASR/LLM 已有，这里补齐最后一处网络请求）
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(bustUrl, { cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) {
      // v1.2.1 攻坚·战役三：真实错误日志（HTTP 状态 + URL），排障时直接在控制台看得到，不只在诊断面板。
      console.error('[更新检测] 请求失败', { url: bustUrl, http: res.status });
      throw new Error('http_' + res.status);
    }
    return res.json();
  } catch (e) {
    if (!(e && String(e.message).startsWith('http_'))) console.error('[更新检测] 请求异常', { url: bustUrl, err: String((e && e.message) || e) });
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 用 <script src> 把一个地址当脚本加载（只取执行副作用，不读响应体）。
 *
 * 🔴 必须自己带超时 + 区分 onload/onerror：脚本标签不会因为目标 404 而 reject promise，
 *    它只在网络层失败时触发 onerror，加载不成功时干脆什么都不发生。
 *    没有兜底的话这条通道会一直挂着，把整个 fetchManifest 拖到超时。
 *
 * 🔴 加载前必须先把 `window.__VERSION_MANIFEST__` 清空：这个变量挂在 window 上，
 *    上一次成功留下的值会一直留着 —— 不清空的话，"这次通道失败"会被读成"上一次那份旧清单"，
 *    版本号变成旧的 ⇒ 弹窗又变成永远不弹，而且一个错都不报（最坏的静默失效）。
 */
function loadScript(url) {
  return new Promise((resolve, reject) => {
    const prev = (typeof window !== 'undefined') ? window.__VERSION_MANIFEST__ : undefined;
    if (typeof window !== 'undefined') window.__VERSION_MANIFEST__ = null;
    const s = document.createElement('script');
    let settled = false;
    const bust = url + (url.includes('?') ? '&' : '?') + 'cb=' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const timer = setTimeout(() => finish(new Error('script_timeout')), 6000);
    function finish(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (s.parentNode) s.parentNode.removeChild(s); } catch (e) { /* ignore */ }
      // 出错时把上一个值放回去，别污染别处对同一个变量的读取
      if (err && typeof window !== 'undefined') window.__VERSION_MANIFEST__ = prev;
      if (err) reject(err);
      else resolve();
    }
    s.onload = () => finish(null);
    s.onerror = () => finish(new Error('script_error'));
    s.async = true;
    s.src = bust;
    try {
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {
      finish(new Error('script_inject_failed'));
    }
  });
}

/**
 * 依次试候选路径（v1.4.6 起改为**并行全拿、取版本号最大者**）。
 *
 * 🔴 为什么不能"第一个成功就返回"：旧缓存也是**合法结果**（200 + 合法 JSON，只是 latest 停在旧值）。
 *    "第一个成功"遇上网关缓存拖住时，等于永远采信最旧的节点 —— 第三候选加得再多也轮不到它。
 *    并行取大者才有意义：任何一个通道先拿到新清单，用户就能收到提示。
 * 全部失败时把**每个候选的失败原因**都带上 —— 排障时最怕的就是只看到一句 fetch_failed。
 * @returns {{data:object, via:string}} via = 胜出候选的标签（诊断用）
 */
async function fetchManifest(paths) {
  const cands = [];
  if (LATEST_FALLBACK_ENABLED) cands.push({ label: 'pages.dev', url: LATEST_FALLBACK_ORIGIN + '/version.json' });
  for (const p of paths) cands.push({ label: p, url: /^https?:\/\//.test(p) ? p : apiBase() + p });
  // v1.6.2：跨域场景（APK）里 JSON 通道会被 CORS 拒，脚本通道是唯一能通的那个。
  // 放同一批并行取，所以"取最大者"对它也一样成立。
  cands.push({ label: 'version-latest.js', url: apiBase() + SCRIPT_MANIFEST_PATH, script: true });
  const settled = await Promise.allSettled(cands.map(async ({ label, url, script }) => {
    if (script) {
      // 🔴 脚本通道是唯一"结果写在共享变量上"的候选：window.__VERSION_MANIFEST__ 是全局的、
      //    三条通道并行跑，任何一个成功都会写它。所以只有它读这个变量，用完立刻清空。
      await loadScript(url);
      const data = (typeof window !== 'undefined') ? window.__VERSION_MANIFEST__ : null;
      window.__VERSION_MANIFEST__ = null;
      if (!data || typeof data !== 'object' || !(data.latest_version || data.history)) throw new Error('empty_script_manifest');
      return { label, data };
    }
    // JSON 通道用**自己 fetchJson 解析出来的那份**，绝不改去读 window 变量 ——
    // 否则并行时会被脚本通道的清单顶掉：实测踩过（更新历史里的 history 被顶成空 ⇒ 更新日志页 0 条）。
    const data = await fetchJson(url);
    if (!(data && typeof data === 'object' && (data.latest_version || data.history))) throw new Error('bad_shape');
    return { label, data };
  }));
  const ok = [];
  const fails = [];
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    if (s.status === 'fulfilled') ok.push(s.value);
    else fails.push(cands[i].label + ':' + ((s.reason && s.reason.message) || 'err'));
  }
  if (!ok.length) {
    lastError = fails.join(' | ');
    diag.note('update', 'manifest_fail', { tried: lastError, base: apiBase() || '(same-origin)' });
    throw new Error('fetch_failed: ' + lastError);
  }
  // 取版本号最大者；并列时优先站点通道（pages.dev 是备用独立通道，正常情况以站点为准）
  let best = null;
  for (const o of ok) {
    if (!best || cmpVersion(String(o.data.latest_version || ''), String(best.data.latest_version || '')) > 0) best = o;
  }
  const siteHit = ok.find((o) => o.label !== 'pages.dev');
  const pick = (siteHit && cmpVersion(String(siteHit.data.latest_version || ''), String(best.data.latest_version || '')) === 0) ? siteHit : best;
  diag.note('update', 'manifest_pick', {
    via: pick.label,
    latest: pick.data.latest_version || '',
    candidates: ok.map((o) => `${o.label}=${o.data.latest_version || '?'}`).join(' | ') || '-',
    failed: fails.join(' | ') || '-',
  });
  return { data: pick.data, via: pick.label };
}

/** 取线上最新版本信息（带测试 query 覆盖）。三候选并行取大者，见 fetchManifest。 */
export async function fetchLatest() {
  let picked = null;
  try {
    picked = await fetchManifest(LATEST_PATHS);
  } catch (e) {
    picked = null; // 失败不抛：下面用硬编码兜底，用户至少还能收到"有新版本"这件事
  }
  const via = (picked && picked.via) || '';
  let data = picked && picked.data;

  const remoteLatest = String((data && data.latest_version) || '');
  const remoteIsStale = cmpVersion(remoteLatest || '0', LATEST_VERSION) < 0;

  if (!data) {
    data = {
      latest_version: LATEST_VERSION,
      release_notes: [],
      force_update: false,
      download_url: FALLBACK_APK_URL,
      _source: 'hardcoded',
      _remote: 'fetch_failed',
      _via: '',
    };
    diag.note('update', 'manifest_fallback', { source: 'hardcoded', remote: 'fetch_failed', used: LATEST_VERSION });
  } else if (remoteIsStale) {
    // 🔴 线上清单比已知最新还旧（典型：发了 APK 没发站点）⇒ 用硬编码的版本号**和下载地址**。
    //    下载地址必须一起换：否则会拿 1.3.5 的包去"升级"一个 1.4.0 的用户，那是在帮倒忙。
    data = Object.assign({}, data, {
      latest_version: LATEST_VERSION,
      download_url: FALLBACK_APK_URL,
      _source: 'hardcoded',
      _remote: remoteLatest,
      _via: via,
    });
    diag.note('update', 'manifest_fallback', { source: 'hardcoded', remote: remoteLatest, used: LATEST_VERSION, via });
  } else {
    data = Object.assign({}, data, { _source: 'remote', _remote: remoteLatest, _via: via });
  }

  const q = new URLSearchParams(location.search);
  const fake = q.get('fake_version');
  const forced = q.get('force_update');
  if (fake) data.latest_version = fake;
  if (forced === '1' || forced === 'true') data.force_update = true;
  return data;
}

/** 取更新历史（给「关于墨小溟」页）。后端与静态清单字段名不同，这里统一形状。 */
export async function fetchHistory() {
  // v1.4.6：fetchManifest 现在返回 {data, via} 包装（并行取大者），这里解包 ——
  //   漏解包的后果实测过：拿到包装对象当数据 ⇒ latest_version 空、versions 空 ⇒
  //   更新日志页渲染「暂无更新历史」（主回归 H6 两条红当场抓住）。
  const picked = await fetchManifest(['/api/version/history', '/version.json']);
  const data = picked.data;
  return {
    latest_version: data.latest_version || '',
    versions: data.versions || data.history || [],
  };
}

/* ---------------- 弹窗渲染 ---------------- */

let modalEl = null;
let lastShownKey = ''; // 防止同一次 session 内（前台/后台来回切）重复弹

function closeModal() {
  if (modalEl && modalEl.parentNode) modalEl.parentNode.removeChild(modalEl);
  modalEl = null;
}

function subCopy(p, data) {
  if (p.isWeChat) return '微信里没法直接更新，点右上角「···」在浏览器中打开，就能装最新版啦。';
  if (p.isApk) return '点「立即更新」会弹出安装指引，跟着 3 步就能装上最新版。';
  return '点击立即更新，墨小溟会自动刷新到最新版。';
}

function primaryLabel(p) {
  if (p.isWeChat) return '复制下载链接';
  return '立即更新';
}

function showModal(data, opts) {
  const p = opts.platform || platform();
  const force = !!opts.force;
  closeModal(); // 先清掉可能残留的旧弹窗

  const notesHtml = (data.release_notes || [])
    .map((n) => `<li>${esc(n)}</li>`)
    .join('');

  const overlay = document.createElement('div');
  overlay.className = 'update-overlay' + (force ? ' update-overlay--force' : '');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.innerHTML = `
    <div class="update-card">
      <div class="update-ip">
        ${mascot('happy', 104)}
        <div class="update-sign">有新版啦</div>
      </div>
      <h3 class="update-title">墨小溟更新到了 v${esc(data.latest_version)}</h3>
      <p class="update-sub">${esc(subCopy(p, data))}</p>
      ${notesHtml ? `<ul class="update-notes">${notesHtml}</ul>` : ''}
      <div class="update-actions">
        <button class="update-btn update-btn--primary" id="updateNow" type="button">${esc(primaryLabel(p))}</button>
        ${force ? '' : '<button class="update-btn update-btn--ghost" id="updateLater" type="button">稍后再说</button>'}
      </div>
    </div>`;

  document.body.appendChild(overlay);
  modalEl = overlay;

  /**
   * 「稍后再说」的统一语义（v1.4.3）：当天不再自动弹 **且** 这个版本不再自动弹。
   * 三个入口（稍后按钮 / 点遮罩 / ESC）都走这里，避免以后加入口时漏掉其中一个。
   * 强制更新（force）永远不给这条路 —— 上面三个入口在 force 时都不注册。
   */
  const snooze = () => { setSnoozeDay(); setDismissedVersion(data.latest_version); };

  const now = document.getElementById('updateNow');
  if (now) now.addEventListener('click', () => doUpdate(p, data));

  const later = document.getElementById('updateLater');
  if (later) later.addEventListener('click', () => {
    snooze();
    closeModal();
  });

  // 强制更新：点遮罩不关、ESC 不关；非强制：点遮罩 = 稍后再说
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay && !force) {
      snooze();
      closeModal();
    }
  });
  if (!force) {
    overlay._onKey = (e) => { if (e.key === 'Escape') { snooze(); closeModal(); } };
    document.addEventListener('keydown', overlay._onKey);
  }
}

/* ---------------- 更新动作（三端分支） ---------------- */

function copyText(t) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).catch(() => fallbackCopy(t));
    } else {
      fallbackCopy(t);
    }
  } catch (e) {
    fallbackCopy(t);
  }
}

function fallbackCopy(t) {
  const ta = document.createElement('textarea');
  ta.value = t;
  ta.style.cssText = 'position:fixed;top:-9999px;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch (e) {}
  document.body.removeChild(ta);
}

/** Web / iOS：清空 Service Worker 缓存后刷新，确保拿到最新静态资源 */
function webUpdateReload() {
  try {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then((regs) => {
        Promise.all(regs.map((r) => r.unregister()))
          .then(() => {
            if ('caches' in window) {
              caches.keys().then((ks) => Promise.all(ks.map((k) => caches.delete(k))))
                .then(() => location.reload(true))
                .catch(() => location.reload(true));
            } else {
              location.reload(true);
            }
          })
          .catch(() => location.reload(true));
      }).catch(() => location.reload(true));
    } else {
      location.reload(true);
    }
  } catch (e) {
    location.reload(true);
  }
}

export function doUpdate(p, data) {
  if (p.isWeChat) {
    // 微信内无法自动更新：复制链接，引导用户在浏览器打开
    copyText(data.web_url || location.href);
    const sub = modalEl && modalEl.querySelector('.update-sub');
    if (sub) {
      sub.textContent = '链接已复制 ✓ 去浏览器打开墨小溟，就能装最新版。';
      sub.classList.add('update-sub--ok');
    }
    const now = modalEl && document.getElementById('updateNow');
    if (now) now.textContent = '已复制，去浏览器打开';
    return;
  }
  if (p.isApk) {
    // APK：不再直接甩系统浏览器（那样用户只看到一团乱跳、还不知道下一步干嘛）。
    // 改为应用内安装指引弹窗：先讲清 3 步，点「开始下载」才触发下载，下载后提示下拉通知栏安装 + 未知来源权限。
    showInstallGuide(data, p);
    return;
  }
  // Web / iOS：清空缓存后刷新
  webUpdateReload();
}

/**
 * APK 应用内安装指引弹窗（v1.2.0，Task #117）。
 * 不甩系统浏览器，而是先在应用内讲清 3 步；点「开始下载」才触发下载（WebView 把 .apk 当下载而非页面跳转），
 * 再把弹窗切换成「下载中 → 完成后下拉通知栏安装 + 未知来源权限提示」，全程用户都知道在干嘛。
 * 零依赖：不引入任何新原生插件，只靠 DOM 弹窗 + window.location.href 触发下载。
 */
/* ---------------- 应用内安装器（v1.4.1 · Task #141） ---------------- */

/**
 * 取原生安装器（Filesystem 落盘 + FileOpener 唤起安装器）。
 *
 * 🔴 v1.6.4 根因修复：这里**曾经**用 `import('@capacitor/filesystem')` 这种裸模块说明符动态 import，
 *    在原生 WebView 里是 100% 失败的（两个原因叠加，缺一不可）：
 *      1) 本仓是**无构建 ES Module** 项目，WebView 解析不了 `@capacitor/...` 这种裸说明符；
 *      2) node_modules 里压根没装这两个包（package.json 声明有、APK 的 Java 层也注册了，
 *         但 npm 没装全 —— `ls node_modules/@capacitor` 只有 android/cli/core）。
 *    ⇒ 动态 import 抛错 → 被 catch → 返回 null → 上层**静默回落 `window.location.href`**
 *      → 下载被甩给系统/浏览器 → 用户被赶去通知栏点「Xiaoting…apk」。
 *      **这就是"下载更新时跳出了产品"的真因**（康哥 v1.6.3 真机截图）。
 *
 *    正确姿势和本仓其他 native 能力完全一致：**从 Capacitor 桥上按注册名取插件**，
 *    既不静态依赖，也能在 native 里真拿到。参照：
 *      · 返回键 `registerBackHandler()`： `window.Capacitor.Plugins.App`
 *      · 设备语音识别 `js/native-asr.js`： `window.Capacitor.Plugins['SpeechRecognition']`
 *    这两个都在真机上验证过能用，所以桥这条路是通的。
 *
 * @returns null 表示不可用（Web 端 / 插件没注册），调用方据此降级（且必须如实告诉用户，不能静默甩锅）。
 */
async function loadInstaller() {
  if (!isNativeApp()) return null;
  const C = typeof window !== 'undefined' ? window.Capacitor : null;
  const plugins = (C && C.Plugins) || null;
  const Filesystem = plugins && (plugins.Filesystem || plugins.FilesystemPlugin);
  const FileOpener = plugins && (plugins.FileOpener || plugins.FileOpenerPlugin);
  if (!Filesystem || !FileOpener) {
    diag.note('update', 'installer_unavailable', {
      detail: 'Capacitor桥=' + (C ? '有' : '无') + ' Plugins=' + (plugins ? '有' : '无') +
              ' Filesystem=' + (Filesystem ? '有' : '无') + ' FileOpener=' + (FileOpener ? '有' : '无'),
    });
    return null;
  }
  return { Filesystem, FileOpener };
}

/** v1.6.4：原生下载走 Filesystem 的 CACHE 目录（DownloadFileOptions.directory 官方枚举值是字符串）。 */
const DL_DIR = 'CACHE';

function bytesToBase64(u8) {
  let s = '';
  const CHUNK = 0x8000; // 分块，避免 apply 参数过多爆栈
  for (let i = 0; i < u8.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

/**
 * 下载结果到底是不是一个真的 APK。
 *
 * 🔴 为什么必须校验：托管平台对**不存在的路径**有两种完全不同的反应，而只有一种会被
 *   `res.ok` 拦住：
 *     · 普通静态托管 → 404（`res.ok===false`，已被拦住）✅ 墨小溟线上就是这种
 *     · SPA 式托管（Cloudflare Pages / Vercel 等）→ **回落 index.html 并返回 200**
 *   ⇒ 第二种情况下 `res.ok` 为真，正文却是 HTML。实测复现过：
 *     `https://xiaoting-asr.pages.dev/apk/Xiaoting-v9.9.9-release.apk`
 *     → HTTP **200**、`text/html`、8491 字节。
 *   如果只靠 `res.ok` + 体积判断，这段 HTML 会被写进缓存目录并**调起系统安装器**，
 *   用户看到「已唤起安装界面」，然后系统报「解析包时出现问题」——完全不知道发生了什么。
 *
 *   Sinoky 与 ChunkSpoke 都栽在同一个坑上（ChunkSpoke 的注释写明是「Sinoky 踩坑移植」），
 *   两家的解法一致：**校验 ZIP/APK 魔数 PK\x03\x04**。
 *   体积阈值治不了这个病 —— 假包 8KB，比 1KB 的阈值大得多。
 *
 * @returns {{ok:true}|{ok:false, reason:string, detail:string}}
 */
export function validateApkBytes(bytes, contentType) {
  const ct = String(contentType || '');
  if (!bytes || bytes.byteLength < 4096) {
    return { ok: false, reason: 'download_too_small', detail: `仅 ${(bytes && bytes.byteLength) || 0} 字节` };
  }
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  if (!isZip) {
    const head = Array.from(bytes.slice(0, 4)).map((b) => b.toString(16).padStart(2, '0')).join(' ');
    return {
      ok: false,
      reason: 'not_an_apk',
      detail: `前四字节 ${head}（应为 50 4b 03 04），Content-Type=${ct || '(空)'}`,
    };
  }
  return { ok: true };
}

/**
 * 应用内下载安装包 → 写入缓存目录 → 调起系统安装器。
 *
 * 与旧流程（触发下载 + 让用户自己去通知栏找）的区别：
 * 旧流程把「在通知栏里找到一个叫 Xiaoting…apk 的文件」这个动作甩给了用户，
 * 很多人就卡在这一步。新流程下完直接弹系统安装界面。
 *
 * 依赖（缺一不可，CI 已注入/打包）：
 *   · REQUEST_INSTALL_PACKAGES 权限 —— 缺了系统静默拒绝，表现为「点了没反应」
 *   · @capacitor/filesystem        —— 落盘并换取 content:// URI（Android 7+ 直接给文件路径会被拒）
 *   · @capacitor-community/file-opener —— 发 ACTION_VIEW 唤起安装器
 *
 * @returns {{ok:true}|{ok:false, reason:string, detail?:string}}
 */
export async function installApkInApp(url, version = '', opts = {}) {
  const kit = await loadInstaller();
  if (!kit) return { ok: false, reason: 'plugin_missing' };
  const { Filesystem, FileOpener } = kit;
  const file = `xiaoting-v${String(version || 'latest').replace(/[^\w.]/g, '')}.apk`;

  // 失败时把半截文件删掉，免得下次 getUri 拿到的是一个"看起来在、装了会解析包失败"的坏文件
  const drop = async () => { try { await Filesystem.deleteFile({ path: file, directory: DL_DIR }); } catch (e) { /* ignore */ } };
  let handle = null;

  try {
    // 🔴 progress 监听**必须先注册**：原生下载在 native 栈里跑，进度事件下载途中就派发；
    //    等 downloadFile 返回才注册 = 一次都收不到（那会做成一条永远不动的假进度条，比没有更糟）。
    //    官方签名：Filesystem.addListener('progress', (p: ProgressStatus) => void)，
    //    ProgressStatus = { url, bytes, contentLength }（Android/iOS 原生支持，分块节流 100ms）。
    if (typeof Filesystem.addListener === 'function') {
      handle = await Filesystem.addListener('progress', (p) => {
        const bytes = Number(p && p.bytes) || 0;
        const total = Number(p && p.contentLength) || 0;
        // total 为 0（服务器没给 Content-Length）时 pct 记 -1 ⇒ UI 显示"下载中"而不编造一个假百分比
        const pct = total > 0 ? Math.min(100, Math.round((bytes / total) * 100)) : -1;
        if (opts.onProgress) { try { opts.onProgress({ bytes, total, pct, phase: 'downloading' }); } catch (e) { /* ignore */ } }
      });
    }

    // 🔴 为什么用原生 downloadFile 而不是 fetch/XHR：
    //    APK 里的页面跑在 https://localhost，包在 https://xiaoting.app.workbuddy.host ⇒ 跨域。
    //    托管不给 ACAO ⇒ fetch/XHR 必被 CORS 拒（v1.6.2 就栽在这，当时只能甩给系统下载器）。
    //    原生栈下载不受同源策略管，且自带 bytes/contentLength 进度事件 —— 一举两得。
    await Filesystem.downloadFile({ url, path: file, directory: DL_DIR, progress: true, recursive: true });

    // 🔴 假包拦截：托管平台对不存在的路径会回落 index.html 并返回 200 —— downloadFile 一样会照单全收。
    //    原生层拿不到 bytes 数组，所以用**落盘体积 vs 清单体积**来判：差太多就是拿到了网页文件，
    //    绝不能拿着 HTML 去唤起安装器（用户会看到「解析包时出现问题」，绕一圈回到原点）。
    let size = 0;
    try { const st = await Filesystem.stat({ path: file, directory: DL_DIR }); size = Number(st && st.size) || 0; } catch (e) { /* ignore */ }
    const expect = Number(opts.expectSize) || 0;
    if (size === 0 || (expect > 0 && Math.abs(size - expect) > 2048)) {
      diag.note('update', 'installer_bad_payload', { ok: false, detail: `落盘 ${size}B / 清单 ${expect}B url=${url}` });
      await drop();
      return { ok: false, reason: 'not_an_apk', detail: `落盘 ${size}B，清单写的是 ${expect}B`, retryable: true };
    }

    const uri = await Filesystem.getUri({ path: file, directory: DL_DIR });
    await FileOpener.open({ url: uri.uri, contentType: 'application/vnd.android.package-archive' });
    diag.note('update', 'installer_opened', { ok: true, detail: `已唤起系统安装器 ${uri.uri} 大小=${size}B` });
    return { ok: true, size };
  } catch (e) {
    const detail = String((e && e.message) || e).slice(0, 160);
    await drop();
    // 网络中断/超时 ⇒ 可重试（UI 给「再试一次」）；403/404/协议错 ⇒ 重试没用，别让用户空点
    const retryable = /timeout|timed out|network|unreachable|ssl|reset|aborted|closed/i.test(detail);
    if (absUrl(url) !== url && /failed to fetch|typeerror|cors/i.test(detail)) {
      diag.note('update', 'installer_cors_blocked', { ok: false, detail, url: String(url || '').slice(0, 120) });
      return { ok: false, reason: 'cors_blocked', detail, retryable: false };
    }
    diag.note('update', 'installer_failed', { ok: false, detail });
    return { ok: false, reason: retryable ? 'download_failed' : 'installer_failed', detail, retryable };
  } finally {
    if (handle && typeof handle.remove === 'function') { try { await handle.remove(); } catch (e) { /* ignore */ } }
  }
}

function showInstallGuide(data, p) {
  const url = absUrl(data.download_url) || absUrl(data.web_url) || location.href;
  const overlay = document.createElement('div');
  overlay.className = 'install-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.innerHTML = `
    <div class="install-card">
      <div class="update-ip">
        ${mascot('happy', 96)}
        <div class="update-sign">安装指引</div>
      </div>
      <h3 class="update-title">墨小溟 v${esc(data.latest_version)} 已就绪</h3>
      <p class="update-sub">下面 3 步就能装上最新版，很快：</p>
      <ol class="install-steps">
        <li>点「开始下载」，安装包会在后台下载。</li>
        <li>下载完成后，从屏幕<b>顶部下拉通知栏</b>，点一下「Xiaoting…apk」。</li>
        <li>若弹出「允许安装未知应用」，打开该权限，再点安装即可。</li>
      </ol>
      <div class="install-actions">
        <button class="update-btn update-btn--primary" id="installStart" type="button">开始下载</button>
        <button class="update-btn update-btn--ghost" id="installLater" type="button">稍后再说</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const card = overlay.querySelector('.install-card');
  const close = () => { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); };
  const file = `xiaoting-v${String(data.latest_version || '').replace(/[^\w.]/g, '')}.apk`;
  let lastKit = null;   // 成功后的「再打开一次安装界面」不必重新下载
  let lastRun = null;

  /** 统一渲染卡片：IP + 标题 + 正文 + 按钮组（下载中 / 失败 / 成功三态共用一套，避免各写一套跑偏）。 */
  const setCard = (o) => {
    if (!card) return;
    const acts = (o.actions && o.actions.length ? o.actions : [{ id: 'installDone', text: '我知道了' }]).filter(Boolean);
    card.innerHTML = `
      <div class="update-ip">
        ${mascot(o.sign, 96)}
        <div class="update-sign">${esc(o.label || '')}</div>
      </div>
      <h3 class="update-title">${esc(o.title)}</h3>
      ${o.body ? `<div class="install-body">${o.body}</div>` : ''}
      <div class="install-actions">${acts.map((a) =>
        `<button class="update-btn ${a.ghost ? 'update-btn--ghost' : 'update-btn--primary'}" id="${a.id}" type="button">${esc(a.text)}</button>`).join('')}</div>`;
    acts.forEach((a) => {
      const el = document.getElementById(a.id);
      if (!el) return;
      el.addEventListener('click', () => {
        if (a.id === 'installDone' || a.id === 'dlCancel') { close(); return; }
        if (a.id === 'dlRetry') { void run(); return; }
        if (a.id === 'dlReopen') { void reopen(); return; }
        if (a.id === 'dlManual') { try { window.location.href = url; } catch (e) { /* ignore */ } close(); }
      });
    });
  };

  /** 进度条。pct < 0 = 服务器没给 Content-Length ⇒ 只说"正在下载"，绝不编一个百分比。 */
  const setProgress = (p) => {
    const fill = document.getElementById('dlFill');
    const hint = document.getElementById('dlHint');
    const mb = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
    if (fill) {
      if (p && p.pct >= 0) { fill.style.width = p.pct + '%'; fill.classList.remove('dl-bar__fill--indet'); }
      else { fill.style.width = '6%'; fill.classList.add('dl-bar__fill--indet'); }
    }
    if (hint) {
      hint.textContent = (p && p.total)
        ? `已下载 ${mb(p.bytes)} / ${mb(p.total)}`
        : '正在下载…（这台暂时报不出总大小，就不给你编百分比了）';
    }
  };

  /** 装完之后包还在缓存里，"再打开一次安装界面"直接拿 URI 再开，不重Download。 */
  const reopen = async () => {
    if (!lastKit) { await run(); return; }
    try {
      const uri = await lastKit.Filesystem.getUri({ path: file, directory: DL_DIR });
      await lastKit.FileOpener.open({ url: uri.uri, contentType: 'application/vnd.android.package-archive' });
      return;
    } catch (e) { /* 拿不到就完整重走一遍 */ }
    await run();
  };

  const run = async () => {
    const kit = await loadInstaller();
    lastKit = kit;

    // 🔴 v1.6.4：桥上真的没有插件时**不再「静默 location.href 甩出去」**——
    //    那正是 v1.6.3 真机上「下载跳出产品、还得去通知栏找包」的直接来源（截图实证）。
    //    拿不到能力就如实说这台设备装不了，并给一个用户自己点的手动入口。
    if (!kit) {
      setCard({ sign: 'worried', label: '装不了', title: '这台设备上没法直接装',
        body: '没找到安装需要的系统能力（保存文件 / 唤起安装），少数被裁剪过的系统上会发生。<br/>' +
              '这条链路全程在 App 内完成，只有最后装的那一下是系统在安装；' +
              '如果连这一步都没有，只能手动装：点下面按钮打开下载页，下完从通知栏点开。',
        actions: [{ id: 'dlManual', text: '手动下载' }, { id: 'installDone', text: '知道了', ghost: true }] });
      return;
    }

    setCard({ sign: 'listening', label: '下载中', title: '正在下载安装包…',
      body: '<div class="dl-bar"><i class="dl-bar__fill" id="dlFill"></i></div>' +
            '<p class="update-sub" id="dlHint">准备连接…</p>' +
            '<p class="update-sub update-sub--dim">这次下载全程在你手机里完成，不用切到浏览器，也不用去通知栏找包。</p>',
      actions: [{ id: 'dlCancel', text: '先放着', ghost: true }] });

    const r = await installApkInApp(url, data.latest_version, {
      expectSize: (data.apk && Number(data.apk.size)) || 0,
      onProgress: setProgress,
    });
    lastRun = r;

    if (r.ok) {
      setCard({ sign: 'happy', label: '已就绪', title: '安装界面已经打开了',
        body: '按系统提示点「安装」，装完会自动回到墨小溟（那一下是系统在安装界面，不算跳出产品）。<br/>' +
              '第一次装可能会问「允许安装未知应用」，那是问你同不同意装，点允许就行。' +
              (r.size ? `<p class="update-sub update-sub--dim">安装包 ${(r.size / 1048576).toFixed(1)} MB，已经下好放在缓存里了。</p>` : ''),
        actions: [{ id: 'dlReopen', text: '再打开一次安装界面' }, { id: 'installDone', text: '我知道了', ghost: true }] });
      armInstalled(data.latest_version); // 记一笔：App 重启后才敢说"已经装上了"
      return;
    }

    // 拿回来的不是安装包（假包 / 体积对不上）：绝不能当成下载成功 —— 用户会装出「解析包时出现问题」
    if (r.reason === 'not_an_apk') {
      setCard({ sign: 'worried', label: '没下成', title: '安装包没下下来',
        body: '那个地址拿回来的不是安装包（多半是个网页文件），这是发布环节的问题，不是你手机的问题。<br/>' +
              '稍后再试一次；实在不行去「关于墨小溟」手动下载。',
        actions: [{ id: 'dlRetry', text: '再试一次' }, { id: 'installDone', text: '稍后再说', ghost: true }] });
      return;
    }

    // 下载中断 / 其它失败：给重试，且如实说"已下那部分不算数"（装了会解析失败）
    setCard({ sign: 'worried', label: '下载中断', title: '没下完，先停在这了',
      body: `${esc(String(r.detail || r.reason || '未知原因'))}<br/>` +
            '网络断一下就会这样。已经下的那部分不算数——拿半截包去装只会报「解析包失败」，所以给你重新下一遍。' +
            (r.retryable === false ? '<br/>这个原因再试一次多半也一样，换个时间或网络再来。' : ''),
      actions: (r.retryable === false ? [] : [{ id: 'dlRetry', text: '再试一次' }])
        .concat([{ id: 'installDone', text: '先放着', ghost: true }]) });
  };

  const start = document.getElementById('installStart');
  if (start) start.addEventListener('click', () => { void run(); });

  const later = document.getElementById('installLater');
  if (later) later.addEventListener('click', close);
}

/* ---------------- 装完之后的那句交代（v1.6.4） ---------------- */

const ARMED_PREFIX = 'xiaoting:update_armed_';

/** 唤起安装界面成功时记一笔 —— 是后来敢说"已经装上了"的唯一凭据。 */
function armInstalled(version) {
  try { localStorage.setItem(ARMED_PREFIX + String(version), String(Date.now())); } catch (e) { /* ignore */ }
}

/**
 * 「更新已完成」的状态提示。
 *
 * 🔴 为什么不能看 APP_VERSION 变了就喊"更新完成"：
 *    用户完全可能在安装界面点了取消、或被系统拦下来 —— 那时版本压根没变，
 *    喊出来就是**谎报**（本仓规矩：宁可少说一句，不可说一句假话）。
 *    所以只认一条：唤起安装界面时记过记号，**且现在跑的确实就是那个版本** ⇒ 才说"装上了"。
 *    记号还在、版本却没变 ⇒ 说明没装上，一个字都不提（想装去「关于墨小溟」检查更新）。
 */
export function announceJustUpdated() {
  const cur = String(window.APP_VERSION || '');
  if (!cur) return false;
  try {
    if (!localStorage.getItem(ARMED_PREFIX + cur)) return false;
    localStorage.removeItem(ARMED_PREFIX + cur); // 只说一次，别每次启动都念
  } catch (e) { return false; }
  try { toast(`已经用上 v${cur} 了。谢谢你还在说。`, 3600); } catch (e) { /* ignore */ }
  return true;
}

/* ---------------- 检测主流程 ---------------- */

/**
 * 检测是否有新版本需要提示。
 * @param {{manual?:boolean, forceShow?:boolean}} opts
 *   manual：来自「关于墨小溟」页的手动检查，总是尝试弹（除非已无新版）
 *   forceShow：版本相同也强弹一次（纯视觉检查）
 * @returns {Promise<{shown:boolean, reason?:string, force?:boolean, data?:object}>}
 */
export async function checkUpdate(opts = {}) {
  let data;
  try {
    data = await fetchLatest();
  } catch (e) {
    // 🔴 不再静默：失败原因带回去（含每个候选路径各自的错），并已由 fetchManifest 记进诊断日志。
    // 之前这里只返回 'fetch_failed'，导致"更新弹窗一次都没弹过"这件事在开发期完全看不见。
    return { shown: false, reason: 'fetch_failed', detail: lastError };
  }

  const current = window.APP_VERSION || '0.0.0';
  const latest = String(data.latest_version || '');
  const hasNew = cmpVersion(latest, current) > 0;
  const q = new URLSearchParams(location.search);
  const showUpdate = opts.forceShow || q.get('showUpdate') === '1' || q.get('showUpdate') === 'force';

  // 🔴 v1.4.0：所有分支都带上 current / latest，调用方才能给用户一句可读的结果。
  //   起因：手动点「检查更新」在「已是最新版」时只 return {reason:'no_update'}，
  //   调用处 `.catch(()=>{})` 无 else ⇒ 页面零反馈 ⇒ 用户体感「更新功能坏了/连不上」。
  //   接口其实是通的（实测 /version.json 三通道 200 + 合法 JSON），坏的是"没有回话"。
  //   v1.4.6：把 _source 一起带出去 —— 硬编码兜底路径的"最新"是**本地缓存常量**，
  //   不是真清单。v1.4.4 真机实证：兜底时文案写「线上 v1.4.4」，用户以为是服务器说的，
  //   实际上那一刻线上已是 1.4.5 —— 这句话把用户和开发者一起骗了（截图排查）。
  const ctx = { current, latest, source: data._source || 'remote' };

  if (!hasNew && !showUpdate) {
    // v1.6.4：装完重启、版本已经是最新 ⇒ 给一句交代（没真的装上就一个字不提）
    announceJustUpdated();
    return Object.assign({ shown: false, reason: 'no_update' }, ctx);
  }

  // v1.4.3：用户对**这个版本**点过「稍后再说」⇒ 不再自动打扰。
  //   放在 force 判断之外是刻意的：强制更新（force_update / 低于最低可用版本）不接受拒绝。
  //   手动检查（opts.manual）也不受影响 —— 用户主动问，就必须回答。
  if (!data.force_update && !showUpdate && !opts.manual && getDismissedVersion() === latest) {
    return Object.assign({ shown: false, reason: 'dismissed' }, ctx);
  }

  if (!data.force_update && !showUpdate && !opts.manual && getSnoozeDay() === todayStr()) {
    return Object.assign({ shown: false, reason: 'snoozed' }, ctx);
  }

  // 防止同一次 session 内重复弹（前台/后台来回切）
  const key = `${data.latest_version}:${data.force_update ? 'F' : 'N'}:${todayStr()}`;
  if (!showUpdate && !opts.manual && key === lastShownKey) return Object.assign({ shown: false, reason: 'already_shown' }, ctx);
  lastShownKey = key;

  showModal(data, { force: !!data.force_update, platform: platform() });

  // 🔴 v1.4.3 修：这里必须带 `reason: 'shown'`。
  //    describeCheckResult 是按 r.reason 分派的，漏了它就会落到 default 分支，
  //    于是「手动检查 + 发现新版本」这个**最该有回话**的场景反而显示「检查失败：未知原因」
  //    —— 用户同时看到弹窗和一句"检查失败"，自相矛盾。
  //    v1.4.0 承诺"检查更新永远有回话"时只覆盖了「没新版」那一半，这半边一直漏着，
  //    是四象限测试（象限①/④ 的手动检查分支）把它暴露出来的。
  return Object.assign({ shown: true, reason: 'shown', force: !!data.force_update, data }, ctx);
}

/**
 * 把 checkUpdate 的结果翻译成一句**给用户看的人话**（v1.4.0）。
 * 手动检查必须永远有回话 —— 这是"更新功能是死的"这类误判的唯一根治办法。
 * 失败时把**真实原因**（每个候选路径各自的错）原样带出来，用户可截图，开发者可据此定位。
 */
export function describeCheckResult(r) {
  const cur = (r && r.current) || window.APP_VERSION || '?';
  const latest = (r && r.latest) || '';
  switch (r && r.reason) {
    case 'no_update':
      // v1.4.6：兜底路径不再谎称「线上」。硬编码是打包时的常量，永远不可能是"未来的新版"，
      // 但它也**证明不了**当前没有新版 —— 必须把"这是本地判断"说出口，引导用户网络好时再查。
      if (r.source === 'hardcoded') {
        // 🔴 v1.6.2：这句老文案把故障美化成了结论，必须改掉。
        //   它写「按本地记录你已是最新 v1.4.6」，而那一刻线上已经是 1.6.1 ——
        //   用户和排查的人都以为这话是服务器说的，Actual 是**本地常量**说了句"我不知道"，
        //   被翻译成"你已经是最新"。硬编码兜底证明不了有新版，也证明不了没新版；
        //   如实说「无法确认」，才对得起用户的信任。
        return { ok: true, text: `暂时读不到更新服务，无法确认有没有新版本（当前 v${cur}）；联网后再点一次「检查更新」` };
      }
      return { ok: true, text: `已是最新版本 v${cur}（线上 v${latest || cur}）` };
    case 'shown':
      return { ok: true, text: `发现新版本 v${latest}，已为你弹出更新提示` };
    case 'snoozed':
      return { ok: true, text: r.source === 'hardcoded'
        ? `今天已经提醒过啦（版本依据本地缓存 v${latest}）`
        : `今天已经提醒过啦，明天再说（线上 v${latest}）` };
    case 'dismissed':
      return { ok: true, text: `你之前选了「稍后再说」，v${latest} 不再自动提醒（想装随时手动检查）` };
    case 'already_shown':
      return { ok: true, text: `本次已提示过新版本 v${latest}` };
    case 'fetch_failed':
      return {
        ok: false,
        text: `检查失败：${r.detail || '网络不可达'}`,
        detail: r.detail || '',
      };
    default:
      return { ok: false, text: `检查失败：${(r && r.reason) || '未知原因'}` };
  }
}

/** 启动版本检测：App 启动 + 从后台回到前台 */
export function initUpdate() {
  // 启动即检测一次
  checkUpdate().catch(() => {});
  // 从后台回到前台再检测一次（用户去微信聊天回来，可能正好发了新版）
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkUpdate().catch(() => {});
  });
}
