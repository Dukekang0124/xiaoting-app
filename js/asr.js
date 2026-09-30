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

import { ASR, apiBase } from './config.js';
import { getState } from './store.js';
import * as diag from './diag.js';

/* ==================== 能力探测 ==================== */

/** 端点解析：原生容器里必须拼绝对基址（见 config.js 的 HOSTED_ORIGIN 注释）——
 *  WebView 的源是 https://localhost，相对路径的 /api/* 永远打不到真服务端。 */
const url = (path) => apiBase() + path;

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

/** 探一次服务端：'ready' 可用 / 'unconfigured' 未配密钥 / 'unavailable' 没这个服务（纯静态托管）。 */
export async function probeCloud(force = false) {
  if (!force && cloudState.state !== 'unknown' && Date.now() - cloudState.checkedAt < 60000) return cloudState.state;
  const t = Date.now();
  const dseq = diag.begin('asr', 'probe', { detail: '探测服务端识别能力 ' + url(ASR.health) });
  try {
    const r = await fetch(url(ASR.health), { method: 'GET', cache: 'no-store' });
    const j = await r.json();
    cloudState = {
      state: j && j.asr === 'ready' ? 'ready' : 'unconfigured',
      checkedAt: Date.now(),
      version: (j && j.version) || '',
    };
    diag.end(dseq, {
      ok: r.ok, ms: Date.now() - t,
      detail: `http=${r.status} 结果=${cloudState.state} 后端版本=${cloudState.version || '-'}`,
    });
  } catch (e) {
    cloudState = { state: 'unavailable', checkedAt: Date.now(), version: '' };
    diag.end(dseq, { ok: false, code: 'network', ms: Date.now() - t, detail: `服务端不可达：${String(e && e.message || e).slice(0, 80)}` });
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
  if (b64.length > ASR.maxB64Len) {
    diag.end(dseq, { ok: false, code: 'too_long', ms: Date.now() - t0, detail: `编码后 ${b64.length} 字符 > 上限 ${ASR.maxB64Len}` });
    return { ok: false, code: 'too_long', hint: '这段说得有点久，我们分开说两段好吗' };
  }
  diag.note('asr', 'encoded', { ok: true, detail: `16k WAV base64 ${b64.length} 字符，编码耗时 ${Date.now() - t0}ms` });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ASR.timeoutMs);
  if (signal && signal.addEventListener) {
    try { signal.addEventListener('abort', () => ctrl.abort()); } catch (e) { /* ignore */ }
  }

  let res;
  try {
    res = await fetch(url(ASR.endpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ speech: b64, lang }),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const code = e && e.name === 'AbortError' ? 'timeout' : 'network';
    diag.end(dseq, { ok: false, code, ms: Date.now() - t0, detail: `请求未返回：${String(e && e.message || e).slice(0, 80)}` });
    return {
      ok: false,
      code,
      hint: e && e.name === 'AbortError' ? '识别等太久了' : '网络好像不太顺',
      uploadMs: Date.now() - t0,
    };
  }
  clearTimeout(timer);

  let j = null;
  try { j = await res.json(); } catch (e) { j = null; }
  if (j && j.ok && String(j.text || '').trim()) {
    const text = String(j.text).trim();
    diag.end(dseq, {
      ok: true, ms: Date.now() - t0,
      detail: `识别成功 engine=${j.engine || 'cloud'} 服务端耗时=${j.ms || 0}ms 文本="${text.slice(0, 40)}"`,
    });
    return { ok: true, text, engine: j.engine || 'cloud', ms: j.ms || 0, totalMs: Date.now() - t0 };
  }
  const code = (j && j.error) || ('http_' + res.status);
  diag.end(dseq, {
    ok: false, code, ms: Date.now() - t0,
    detail: `识别失败 http=${res.status} err_no=${(j && j.err_no) || '-'} ${(j && j.hint) || ''}`,
    raw: j ? JSON.stringify(j).slice(0, 300) : String(res.status),
  });
  return {
    ok: false,
    code,
    errNo: j && j.err_no,
    hint: (j && j.hint) || describeError(code),
    totalMs: Date.now() - t0,
  };
}

/** 错误码 → 人话。手机端只显示这一句，不显示技术细节。 */
export function describeError(code) {
  switch (code) {
    case 'asr_not_configured': return '云端识别还没配置好';
    case 'rate_limited': return '识别次数有点多，歇一会儿再试';
    case 'audio_too_long': return '这段说得有点久，我们分开说两段好吗';
    case 'asr_failed': return '没能听清这段录音';
    case 'encode_failed': return '这段录音没能处理成功';
    case 'network': return '网络好像不太顺';
    case 'timeout': return '识别等太久了';
    case 'auth_failed': return '识别服务鉴权失败';
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

