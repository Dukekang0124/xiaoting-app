// 墨小溟 · 语音识别层（v0.5.0）
//
// 【为什么要有这一层】
// 之前「按住说」依赖浏览器内置的 Web Speech API。它在桌面 Chrome 能用，但：
//   · iOS Safari / 微信内置浏览器（WKWebView）根本不暴露 SpeechRecognition；
//   · Android 系统 WebView 能构造对象，start() 必失败；
//   · 国内网络下 Chrome 的识别走后端服务，也常常直接失败。
// 结果就是「按住说了半天，一个字没出来」——这是内测期最致命的一处体验断点。
//
// 【怎么解决】录音 → 浏览器内解码重采样成 16k 单声道 WAV → 发给同源 /api/asr →
//   服务端拿密钥去调专业云端 ASR → 拿回文字。密钥全程在服务端，前端碰不到。
//
// 【三级降级，永不白屏】
//   ① 云端 ASR（首选，所有现代浏览器都可用，含 iOS/微信）
//   ② 浏览器内置识别（云端不可用时，把它当兜底；桌面 Chrome 上体验依然顺）
//   ③ 打字（前两者都拿不到文字时，直接把用户送到文本输入，并说明原因）
//
// 【复用来源】重采样与 WAV 编码（含 ASR 预处理：去直流 + 预加重 + 峰值归一化）对齐
//   「英语开口练」已线上验证的实现（index.html encodeWav16kBase64 / preprocessForAsr），不重造。

import { ASR, CLOUD_ASR, apiBase } from './config.js';
import { getState } from './store.js';
import * as diag from './diag.js';

/* ==================== 能力探测 ==================== */

/** 端点解析：原生容器里必须拼绝对基址（见 config.js 的 HOSTED_ORIGIN 注释）——
 *  WebView 的源是 https://localhost，相对路径的 /api/* 永远打不到真服务端。 */
const url = (path) => apiBase() + path;

/**
 * 云端 ASR 端点（v1.4.1）。
 * 与上面 url() 的区别：这个是**跨域**的，所以永远拼绝对地址，不经过 apiBase()。
 * 契约与同源 /api/asr 完全一致（{speech, lang} → {ok, text, engine, ms}），
 * 换端点不需要改任何解析逻辑 —— 这是当初对接时就定下的，现在兑现了。
 */
const cloudUrl = (path) => CLOUD_ASR.origin + path;
export function cloudEndpoint() { return cloudUrl(CLOUD_ASR.endpoint); }

const AC = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;
const OFFLINE = typeof window !== 'undefined' ? (window.OfflineAudioContext || window.webkitOfflineAudioContext) : null;
const SR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;

export function capability() {
  return {
    getUserMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
    mediaRecorder: typeof window !== 'undefined' && typeof window.MediaRecorder !== 'undefined',
    audioContext: !!AC,
    offlineAudioContext: !!OFFLINE,
    webSpeech: !!SR,
    // 云端通路需要的全部前置条件（不含服务端密钥状态，那个靠 probeCloud 探）
    canRecord: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia
      && typeof window !== 'undefined' && typeof window.MediaRecorder !== 'undefined' && AC && OFFLINE),
  };
}

/**
 * 造一个「浏览器内置识别」实例，拿不到就返回 null。
 *
 * 为什么把这件事放在 ASR 层而不是 app.js：调用方只需要"给我一个能用的识别器"，
 * 不需要知道它叫 SpeechRecognition 还是 webkitSpeechRecognition。更重要的是，
 * 让 app.js 里不再出现一个"自己没声明、靠全局变量蒙对"的构造器标识符 ——
 * 那种错 node --check 查不出来（引用未定义变量语法合法），还会被 try/catch 吞掉，
 * 只在真机行为上显形。本项目就真的这么翻过一次车。
 */
export function createWebSpeech({ lang = 'zh-CN' } = {}) {
  if (!SR) return null;
  try {
    const sr = new SR();
    sr.lang = lang;
    sr.continuous = true;
    sr.interimResults = true;
    return sr;
  } catch (e) { return null; }
}

/** 挑一个当前浏览器支持的录音容器。Safari 只给 mp4，Chrome 给 webm，两者都能被自己解码。 */
export function pickMime() {
  if (typeof window === 'undefined' || typeof window.MediaRecorder === 'undefined') return '';
  const cands = ['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/webm;codecs=opus'];
  for (const m of cands) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) { /* 继续试 */ }
  }
  return '';
}

/* ==================== 云端可用性探测 ==================== */

let cloudState = { state: 'unknown', checkedAt: 0, version: '' };

/**
 * 探一次云端后端：'ready' 可用 / 'unavailable' 不可用。
 *
 * v1.4.1：探测目标从同源 /api/health 换到 Cloudflare 的 /api/health。
 * 旧目标在线上（纯静态托管）恒 404 —— 也就是说这个探针过去每次都返回 unavailable，
 * 「云端 ASR 优先」这条链路实际上从未生效过。
 *
 * 判定要点：CF 的 health 用 `ok` + `ai_binding` 表达（不是本地的 `asr:'ready'`）。
 * 服务在但**没绑 AI** 时必须判 unavailable —— 那样识别必然 503，
 * 若判成 unconfigured 会让上层误以为"值得试一次"，白白多等一个超时。
 */
export async function probeCloud(force = false) {
  if (!force && cloudState.state !== 'unknown' && Date.now() - cloudState.checkedAt < 60000) return cloudState.state;
  const t = Date.now();
  const ep = cloudUrl(CLOUD_ASR.health);
  const dseq = diag.begin('asr', 'probe', { detail: '探测云端识别能力 ' + ep });
  // 🔴 探测自带超时。裸 fetch 在网络挂起（半开连接 / 慢 DNS / 弱网）时会永久 pending，
  //    而 app.js:436 与 :461 两处都是 `await asr.probeCloud()` 才决定走不走云端 ——
  //    探不到就等于把整条识别链停在这一行，用户看到的是「按住说完，什么都没发生」。
  //    所以超时一律判 unavailable（≈探不到），立刻落内置识别兜底，绝不让人等。
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CLOUD_ASR.probeTimeoutMs);
  try {
    const r = await fetch(ep, { method: 'GET', cache: 'no-store', signal: ctrl.signal });
    const j = await r.json().catch(() => null);
    const ready = !!(r.ok && j && j.ok === true && j.ai_binding === true);
    cloudState = {
      state: ready ? 'ready' : 'unavailable',
      checkedAt: Date.now(),
      version: (j && j.build) || (j && j.model) || '',
    };
    diag.end(dseq, {
      ok: ready, ms: Date.now() - t,
      detail: `http=${r.status} 结果=${cloudState.state} 后端=${(j && j.service) || '-'} build=${(j && j.build) || '-'} ai_binding=${!!(j && j.ai_binding)}`,
    });
  } catch (e) {
    const aborted = !!(e && e.name === 'AbortError');
    cloudState = { state: 'unavailable', checkedAt: Date.now(), version: '' };
    diag.end(dseq, {
      ok: false, code: aborted ? 'timeout' : 'network', ms: Date.now() - t,
      detail: aborted
        ? `云端探测超时（${CLOUD_ASR.probeTimeoutMs}ms）⇒ 按不可用处理，落内置识别兜底`
        : `云端不可达：${String(e && e.message || e).slice(0, 80)}`,
    });
  } finally {
    clearTimeout(timer);
  }
  return cloudState.state;
}


/* ==================== 音频：解码 → 重采样 → 16k 单声道 WAV → base64 ==================== */

function decodeAudioDataCompat(ctx, arrayBuffer) {
  return new Promise((resolve, reject) => {
    try {
      const p = ctx.decodeAudioData(arrayBuffer, resolve, reject);
      if (p && typeof p.then === 'function') p.then(resolve, reject);
    } catch (e) { reject(e); }
  });
}

/**
 * ASR 友好预处理：去直流偏移 → 预加重（抬清辅音高频）→ 峰值归一化（防音量过小导致低置信）。
 * 纯数值、无依赖。实测对「小声说话」与手机远场录音的识别率有可见提升。
 */
export function preprocessForAsr(pcm) {
  const n = pcm.length;
  if (!n) return pcm;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += pcm[i];
  mean /= n;
  const PRE = 0.97;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = pcm[i] - mean;
    out[i] = (i === 0) ? v : v - PRE * (pcm[i - 1] - mean);
  }
  let peak = 0;
  for (let i = 0; i < n; i++) { const a = Math.abs(out[i]); if (a > peak) peak = a; }
  if (peak > 0 && peak < 0.99) {
    const g = 0.99 / peak;
    for (let i = 0; i < n; i++) out[i] *= g;
  }
  return out;
}

/** 重采样 + 编码成 16kHz / 单声道 / 16bit WAV，返回 base64。 */
export function encodeWav16kBase64(audioBuffer) {
  const RATE = 16000;
  if (!OFFLINE) return Promise.reject(new Error('no_offline_ctx'));
  const frames = Math.max(1, Math.ceil(audioBuffer.duration * RATE));
  const offline = new OFFLINE(1, frames, RATE);
  const src = offline.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(offline.destination);
  src.start(0);
  const render = offline.startRendering();
  return Promise.resolve(render).then((rendered) => {
    const pcm = preprocessForAsr(rendered.getChannelData(0));
    const n = pcm.length;
    const total = 44 + n * 2;
    const ab = new ArrayBuffer(total);
    const dv = new DataView(ab);
    let p = 0;
    const tag = (s) => { for (let i = 0; i < s.length; i++) dv.setUint8(p++, s.charCodeAt(i)); };
    tag('RIFF'); dv.setUint32(p, total - 8, true); p += 4;
    tag('WAVE'); tag('fmt ');
    dv.setUint32(p, 16, true); p += 4;        // fmt chunk 长度
    dv.setUint16(p, 1, true); p += 2;         // PCM
    dv.setUint16(p, 1, true); p += 2;         // 单声道
    dv.setUint32(p, RATE, true); p += 4;      // 采样率
    dv.setUint32(p, RATE * 2, true); p += 4;  // 字节率
    dv.setUint16(p, 2, true); p += 2;         // 块对齐
    dv.setUint16(p, 16, true); p += 2;        // 位深
    tag('data'); dv.setUint32(p, n * 2, true); p += 4;
    for (let i = 0; i < n; i++) {
      const v = Math.max(-1, Math.min(1, pcm[i]));
      dv.setInt16(p, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      p += 2;
    }
    // 分块转换：长录音一次性 apply 整个数组会爆调用栈
    const u8 = new Uint8Array(ab);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < u8.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  });
}

export function blobToWav16kBase64(blob) {
  if (!AC) return Promise.reject(new Error('no_audio_ctx'));
  let ctx;
  try { ctx = new AC(); } catch (e) { return Promise.reject(e); }
  const cleanup = () => { try { ctx.close(); } catch (e) { /* ignore */ } };
  return blob.arrayBuffer()
    .then((ab) => decodeAudioDataCompat(ctx, ab))
    .then((buf) => encodeWav16kBase64(buf))
    .then((b64) => { cleanup(); return b64; }, (e) => { cleanup(); throw e; });
}

/* ==================== 幻觉过滤（v1.6.11） ==================== */
//
// 真机实测：把静音 / 近空音频交给 Whisper，它会「幻觉」出与用户所说完全无关的文本，
// 典型的是字幕组署名（如「字幕志愿者 杨茜茜」）或口播套话（「请不吝点赞、订阅」）。
// 这不是用户说的话，绝不能填进输入框污染情绪分析 —— 必须当「没听清」处理。
// 前端兜两层：① 时长太短直接不发（见 recognize 的 minAudioMs）；② 返回文本命中已知幻觉模式 ⇒ 判空。
const HALLUCINATION_RE = /(字幕|志愿者|翻译|校对|听写|请不吝|点赞|订阅|关注|转发|打赏|充电|一键三连|明镜与点点|感谢(您)?观看|谢谢观看|由.{0,8}提供|字幕由|小助理|下期再见|MING\s*PAO|Subtitle|Subscribe|Amara\.org|Transcription)/i;

/** 判断一段 ASR 结果是否为「静音幻觉」。真情绪倾诉通常较长；幻觉多为短句套话。 */
export function isLikelyHallucination(text) {
  const t = String(text || '').replace(/\s+/g, '');
  if (!t) return true;
  if (t.length > 40) return false;          // 长句不判，避免误杀真实长倾诉
  return HALLUCINATION_RE.test(t);
}

/* ==================== 云端识别 ==================== */

/**
 * 把一段音频交给自己的服务端做识别。
 * @returns {Promise<{ok:true, text:string, engine:string, ms:number}|{ok:false, code:string, hint:string}>}
 */
export async function recognize(blob, { lang = ASR.lang, signal } = {}) {
  const t0 = Date.now();
  const dseq = diag.begin('asr', 'recognize', {
    detail: `blob=${(blob && blob.size) || 0}B type=${(blob && blob.type) || '-'} lang=${lang}`,
  });
  let b64;
  try {
    b64 = await blobToWav16kBase64(blob);
  } catch (e) {
    diag.end(dseq, { ok: false, code: 'encode_failed', ms: Date.now() - t0, detail: '录音在浏览器里解码失败' });
    return { ok: false, code: 'encode_failed', hint: '这段录音在浏览器里解码失败' };
  }
  if (!b64 || b64.length < ASR.minB64Len) {
    diag.end(dseq, { ok: false, code: 'too_short', ms: Date.now() - t0, detail: `编码后 ${(b64 || '').length} 字符 < 下限 ${ASR.minB64Len}` });
    return { ok: false, code: 'too_short', hint: '太短了，好像没听到声音' };
  }
  // v1.6.11：按解码后的**真实时长**判空（比只看 base64 长度准得多）——
  //   16k / 16bit / 单声道 WAV：samples = (bytes - 44) / 2，越短越可能是静音。
  const _samples = Math.max(0, Math.floor((b64.length * 3 / 4 - 44) / 2));
  const _audioMs = Math.round(_samples / 16000 * 1000);
  console.log('[ASR] 音频时长 ' + _audioMs + 'ms, base64 ' + b64.length + ' chars');
  if (_audioMs < ASR.minAudioMs) {
    diag.end(dseq, { ok: false, code: 'too_short', ms: Date.now() - t0, detail: `解码时长 ${_audioMs}ms < 下限 ${ASR.minAudioMs}ms（判为没录到）` });
    return { ok: false, code: 'too_short', hint: '太短了，好像没听到声音' };
  }
  if (b64.length > ASR.maxB64Len) {
    diag.end(dseq, { ok: false, code: 'too_long', ms: Date.now() - t0, detail: `编码后 ${b64.length} 字符 > 上限 ${ASR.maxB64Len}` });
    return { ok: false, code: 'too_long', hint: '这段说得有点久，我们分开说两段好吗' };
  }
  diag.note('asr', 'encoded', { ok: true, detail: `16k WAV base64 ${b64.length} 字符，编码耗时 ${Date.now() - t0}ms` });

  // v1.4.1：端点从同源 /api/asr 换到 Cloudflare 云端（同源那个在线上恒 404，从未生效）。
  // 契约完全一致，所以下面除了地址，没有任何解析逻辑需要改。
  const reqHeaders = { 'Content-Type': 'application/json' };
  const ep = cloudUrl(CLOUD_ASR.endpoint);

  // —— 带重试的请求循环 ——
  // 实测该后端有两类**瞬态**失败：403/1010（Cloudflare 风控）与 3030（解码失败），
  // 表现都是「同一份输入原封不动再发一次就成功」。不重试的话，偶发抖动会被用户
  // 直接判定成「语音识别坏了」——这正是这次要把底层打通的意义所在。
  // 反过来说，请求本身有问题（空音频、超时长度、方法不对）重试毫无意义，立即返回。
  let last = null;
  let usedAttempts = 0;
  for (let attempt = 1; attempt <= CLOUD_ASR.maxAttempts; attempt++) {
    usedAttempts = attempt;
    const one = await attemptRecognizeOnce(ep, b64, lang, reqHeaders, signal, attempt);
    if (one.kind === 'ok') {
      // v1.6.11：静音幻觉拦截 —— 命中即判空，绝不让假文本进输入框
      if (isLikelyHallucination(one.text)) {
        console.warn('[ASR] 命中幻觉黑名单，判空：' + one.text);
        diag.end(dseq, { ok: false, code: 'asr_empty', ms: Date.now() - t0, detail: `疑似 Whisper 幻觉（"${one.text.slice(0, 24)}"）⇒ 判空不发` });
        return { ok: false, code: 'asr_empty', hint: '没听到说话声，靠近一点再说一次', totalMs: Date.now() - t0 };
      }
      diag.end(dseq, {
        ok: true, ms: Date.now() - t0,
        detail: `识别成功（第 ${attempt} 次）engine=${one.engine} 服务端耗时=${one.serverMs}ms 文本="${one.text.slice(0, 40)}"`,
      });
      return {
        ok: true, text: one.text, engine: one.engine,
        ms: one.serverMs, attempts: attempt, totalMs: Date.now() - t0,
      };
    }
    last = one;
    if (one.kind !== 'transient') break;
    if (attempt < CLOUD_ASR.maxAttempts) {
      diag.note('asr', 'retry', {
        detail: `瞬态失败，${CLOUD_ASR.backoffMs * attempt}ms 后重试：${one.code} ${(one.detail || '').slice(0, 80)}`,
      });
      await sleep(CLOUD_ASR.backoffMs * attempt);
    }
  }

  diag.end(dseq, {
    ok: false, code: last.code, ms: Date.now() - t0,
    detail: `识别失败（共 ${usedAttempts} 次）http=${last.http || '-'} code=${last.code} ${(last.detail || '').slice(0, 120)}`,
    raw: (last.raw || '').slice(0, 300),
  });
  return {
    ok: false,
    code: last.code,
    hint: last.hint || describeError(last.code),
    attempts: usedAttempts,
    totalMs: Date.now() - t0,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 单次识别请求。把「发一次」和「要不要再发一次」分开，
 * 重试策略才写得清楚、也才测得了（见 _selftest/probe-cloud-asr-retry.cjs）。
 *
 * @returns kind: 'ok' 成功 | 'transient' 瞬态失败（值得重试）| 'fail' 确定性失败（别重试）
 */
async function attemptRecognizeOnce(ep, b64, lang, headers, signal, attempt) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CLOUD_ASR.timeoutMs);
  if (signal && signal.addEventListener) {
    try { signal.addEventListener('abort', () => ctrl.abort()); } catch (e) { /* ignore */ }
  }
  const t1 = Date.now();
  console.log('[ASR] 请求 Worker 地址: ' + ep + ' 第 ' + attempt + '/' + CLOUD_ASR.maxAttempts + ' 次，speech_base64_len=' + b64.length);
  diag.note('asr', 'request', {
    detail: `POST ${ep} 第 ${attempt}/${CLOUD_ASR.maxAttempts} 次 speech_base64_len=${b64.length} lang=${lang}`,
  });

  let res;
  try {
    res = await fetch(ep, { method: 'POST', headers, body: JSON.stringify({ speech: b64, lang }), signal: ctrl.signal });
  } catch (e) {
    clearTimeout(timer);
    const aborted = !!(e && e.name === 'AbortError');
    return {
      kind: 'transient', code: aborted ? 'timeout' : 'network',
      detail: String((e && e.message) || e).slice(0, 120), ms: Date.now() - t1,
    };
  }
  clearTimeout(timer);

  // 先取文本再解析：Pages 对未匹配路径会回落 index.html 并返回 200，
  // 直接 res.json() 会把 HTML 吞成一个解析异常，看不出到底是哪个环节坏了。
  const raw = await res.text().catch(() => '');
  console.log('[ASR] 返回的原始 JSON: ' + raw.slice(0, 300));
  let j = null;
  try { j = JSON.parse(raw); } catch (e) { j = null; }

  if (j && j.ok && String(j.text || '').trim()) {
    return {
      kind: 'ok', text: String(j.text).trim(), engine: j.engine || 'cf-whisper',
      serverMs: j.ms || 0, ms: Date.now() - t1,
    };
  }

  const code = (j && j.error) ? String(j.error) : ('http_' + res.status);
  const detail = (j && j.detail) ? String(j.detail) : (j ? '' : `非 JSON 响应：${raw.slice(0, 60)}`);
  const transient = isTransient(res.status, code, detail, raw);
  return {
    kind: transient ? 'transient' : 'fail',
    code, detail, http: res.status, raw: raw.slice(0, 300),
    hint: transient ? '' : describeError(code), ms: Date.now() - t1,
  };
}

/**
 * 判定「值不值得重试」。这是本次接入里最容易做错的一处：
 * - 403 / 5xx / 3030 / 网络层 / 超时 ⇒ **瞬态**，重试有意义（实测都能靠重试救回来）
 * - 400 空音频、413 太长、200 但没识别到语音 ⇒ **确定性**失败，
 *   重试只会让用户多等两轮，把「本来能马上改的行为」拖成「一直转圈」。
 */
export function isTransient(status, code, detail, raw) {
  if (code === 'timeout' || code === 'network') return true;
  if (status === 403) return true;          // Cloudflare 风控 error code: 1010
  if (status >= 500) return true;
  if (/\b3030\b/.test(detail || '')) return true;  // Failed to decode audio file（实测瞬态）
  if (/error code:\s*1010/.test(raw || '')) return true;
  return false;
}

/** 错误码 → 人话。手机端只显示这一句，不显示技术细节。 */
export function describeError(code) {
  switch (code) {
    case 'asr_not_configured': return '云端识别还没配置好';
    case 'rate_limited': return '识别次数有点多，歇一会儿再试';
    case 'audio_too_long': return '这段说得有点久，我们分开说两段好吗';
    case 'asr_failed': return '没能听清这段录音';
    // v1.4.1 云端后端（Cloudflare Whisper）的错误码
    case 'asr_empty': return '没听到说话声，靠近一点再说一次';
    case 'empty_audio': return '没有录到声音，再试一次好吗';
    case 'bad_body': return '录音数据没能正确上传';
    case 'use_post': return '识别请求格式不对';
    case 'encode_failed': return '这段录音没能处理成功';
    case 'network': return '网络好像不太顺';
    case 'timeout': return '识别等太久了';
    case 'auth_failed': return '识别服务鉴权失败';
    case '3301': return '这段录音质量不太行，换个安静点的地方再说一次';
    case '3302': return '这段音频格式不太对，换台设备试试';
    default: return '识别没能成功';
  }
}

/* ==================== 埋点（v1.3 §4 的地基；只发计数与错误码，不发用户正文） ==================== */

const queue = [];
let flushTimer = null;

function dev() {
  try {
    return (localStorage.getItem('xiaoting:dev') || '').slice(0, 40);
  } catch (e) { return ''; }
}

export function logEvent(name, data = {}) {
  try {
    const st = getState();
    queue.push({
      name,
      ts: Date.now(),
      sid: (st.draft && st.draft.recordId) || '',
      dev: dev(),
      ver: (typeof window !== 'undefined' && window.APP_VERSION) || '',
      data,
    });
  } catch (e) { return; }
  if (queue.length >= 8) return flushEvents();
  if (!flushTimer) flushTimer = setTimeout(flushEvents, 5000);
}

export function flushEvents() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!queue.length) return Promise.resolve();
  const events = queue.splice(0, 50);
  return fetch(url(ASR.events), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events }),
    keepalive: true,
  }).catch(() => {
    // v1.1.8：远端 /api/events 不可达（纯静态托管下本就不存在）时，别把用户行为数据直接丢进黑洞。
    // 先回退存进 localStorage 环形缓冲，保证「至少本地可留存、可在「关于」页导出分析」，且不伤用户链路。
    stashLocalEvents(events);
  });
}

/* ── 本地埋点兜底：远端不可用时也不丢数据（P1-1） ── */
const EVENTS_KEY = 'xiaoting:events';
const EVENTS_MAX = 500;

// 把没发成功的事件存进 localStorage，最多保留最近 500 条（环形缓冲）。
export function stashLocalEvents(events) {
  try {
    const raw = localStorage.getItem(EVENTS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    for (const e of events) arr.push(e);
    while (arr.length > EVENTS_MAX) arr.shift();
    localStorage.setItem(EVENTS_KEY, JSON.stringify(arr));
  } catch (e) { /* localStorage 也写不了就彻底放弃，绝不抛错 */ }
}

// 给「关于」页的导出按钮用：返回本地留存的全部事件。
export function getLocalEvents() {
  try {
    const raw = localStorage.getItem(EVENTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}

