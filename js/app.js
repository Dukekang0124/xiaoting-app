// 墨小溟 · 页面渲染与交互（核心流程编排）
// 调用顺序：ASR → 安全识别 → (continue) 主分析 → 追问(≤3) → 卡片 → 保存；周报按周聚合。
// 安全分支：continue / gentle_check(温和确认) / refer(转介) / emergency(紧急)

import * as store from './store.js';
import { appendConvo } from './store.js';
import { mascot, miniFace, avatar } from './ip.js';
import { api, isBlockingAction } from './api.js';
import * as asr from './asr.js';
import * as voice from './voice.js';
import * as update from './update.js';
import * as nativeAsr from './native-asr.js';
import * as ipSM from './state-machine.js'; // v1.3.0 IP 情绪状态机
import ipAudio from './ip-audio.js'; // v1.3.0 IP 轻音效（Web Audio 合成，零素材）
import motion from './motion.js'; // v1.6.3 动效编排层（配置 → CSS 变量）
import * as cw from './copywriting.js'; // v1.3.1~1.3.4 文案库
import { createIpInteraction, tapAnimClass } from './interaction.js'; // v1.3.1 IP 点击轻互动
import * as diag from './diag.js';
import { parseHash, go, onChange } from './router.js';
import {
  COPY, greetByHour, findForbidden, pickRiskScript, pickEmotionResponse, pickSilence, pickBy,
  emotionScoreFor, cardThemeFor, // v1.6.0 文档 §一.1：时间线卡 UI 字段（源在 prompts.js，不另存一份）
} from './prompts.js';
import { AI, ASR, isNativeApp } from './config.js';
import * as memory from './memory.js';
import * as notify from './notify.js'; // v1.4.1 轻提醒（修复「允许轻提醒」死开关）
import * as monthly from './monthly.js'; // v1.6.2 月度情绪复盘（文档 §追加模块3）

const $view = () => document.getElementById('view');
const $tabbar = () => document.getElementById('tabbar');
const $toast = () => document.getElementById('toast');

/* ---------------- 小图标（线性，细笔触） ---------------- */
// 我的页列表用：心电图 / 卡片 / 锁。stroke 由 CSS 的辅助色决定。
const ICON = {
  weekly: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h3.2l1.8-4.4 2.6 8.6 2.2-6 1.7 3.8H21"/></svg>`,
  cards: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="13" rx="3"/><path d="M6.5 3.4h11"/><path d="M7.4 11h5"/></svg>`,
  settings: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4.5" y="10.5" width="15" height="9.5" rx="2.6"/><path d="M8.2 10.5V8a3.8 3.8 0 0 1 7.6 0v2.5"/></svg>`,
  about: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="7.6" r="1.05" fill="currentColor" stroke="none"/></svg>`,
  // 时间线：一条起伏的水流曲线（与卡片图标区分）
  timeline: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 15.5c3 0 3.4-7 6.4-7s3.4 7 6.4 7 3.4-4.5 5.2-4.5"/></svg>`,
  // 记忆：一束缠绕的脑波/丝线（深海带状记忆意象）
  memory: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12c2.5 0 2.5-5 5-5s2.5 10 5 10 2.5-5 4-5"/><circle cx="5" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>`,
  // 支持：一双手托住一颗心的托举意象（与「设置」的锁形区分）
  support: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-6.4-3.9-6.4-8.2A3.6 3.6 0 0 1 12 9.4a3.6 3.6 0 0 1 6.4 2.4C18.4 16.1 12 20 12 20Z"/></svg>`,
};

/** 录音波形（7 根柱子，CSS 驱动起伏） */
const wave = (cls = '') => `<span class="wave ${cls}" aria-hidden="true">${'<i></i>'.repeat(7)}</span>`;

/* ---------------- 小工具 ---------------- */

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtDate = (iso) => { const d = new Date(iso); return `${d.getMonth() + 1}月${d.getDate()}日`; };
const fmtDateTime = (iso) => { const d = new Date(iso); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const todayText = () => { const d = new Date(); return `${d.getMonth() + 1}月${d.getDate()}日 · 周${'日一二三四五六'[d.getDay()]}`; };
const pickIdx = (arr) => arr[Math.abs(Date.now()) % arr.length];

/**
 * v1.5 §2.2 流式摘要提取：从（可能尚未完成的）模型流式输出里，安全取出「温柔总结 summary」的可见正文。
 * 设计铁律 —— 绝不泄漏 JSON 结构：只读到 summary 字段自己的闭合引号为止，不碰它后面的其他字段。
 * 即便模型不按模板顺序输出，也只取「"summary":"」到其下一个未转义引号之间的内容，所以永远不会把
 * `, "needs_followup":...` 这类结构字符暴露给用户。模型未流到 summary 时返回空串（前端据此隐藏该层）。
 * @param {string} text 已累积的流式文本（完整或半截的 JSON）
 * @returns {string} summary 可见正文（未写完时为其前缀）；取不到返回 ''
 */
function extractPartialSummary(text) {
  if (!text) return '';
  const key = '"summary":"';
  const idx = text.lastIndexOf(key);
  if (idx < 0) return '';
  let s = text.slice(idx + key.length);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') { out += s[i] + (s[i + 1] || ''); i++; continue; } // 转义字符（如 \"）算正文一部分，不当成闭合引号
    if (ch === '"') break; // 第一个未转义的引号 = summary 值结束
    out += ch;
  }
  // 仅做最轻量的展示层反转义，避免把 \" 之类展示到界面上
  return out.replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\n/g, '\n').replace(/\\t/g, ' ');
}

/* ---------------- 定时器管理 ---------------- */

let timers = [];
const clearTimers = () => { timers.forEach((f) => { try { f(); } catch (e) {} }); timers = []; };
const later = (fn, ms) => { const id = setTimeout(fn, ms); timers.push(() => clearTimeout(id)); return id; };
const every = (fn, ms) => { const id = setInterval(fn, ms); timers.push(() => clearInterval(id)); return id; };

/* ---------------- 录音 ----------------
 *
 * v0.5.0 三条通路，按优先级降级，永不白屏：
 *   ① 云端 ASR（首选）：录音 → 16k WAV → 同源 /api/asr → 服务端调专业云端识别。
 *      iOS Safari / 微信内置浏览器都能走这条，这是本次要解决的核心场景。
 *   ② 浏览器内置识别（兜底）：云端不可用时用它，桌面 Chrome 上体验依然顺。
 *   ③ 打字：前两者都拿不到文字时，把用户送到文本输入并说明原因。
 *
 * 约束（都是踩过的坑）：
 *   · MediaRecorder 无 timeslice 时音频在 stop 之后才给，必须等 onstop 再取 blob；
 *   · 必须先拿完 blob 再停音轨，顺序反了会拿到空音频；
 *   · 内置识别只是"实时字幕 + 兜底"，云端结果优先，避免被低质量转写覆盖。
 */
const CAP = asr.capability();
const rec = {
  active: false, sr: null, media: null, stream: null, chunks: [],
  t0: 0, iv: null, hintIv: null, maxTimer: null,
  transcript: '', srText: '', mime: '', stopWait: null,
  volumeProbe: null, volIv: 0,
  lowSince: 0, breathing: false, stuckTimer: null, silentState: null,
  // v1.1.2：'native' = 走设备自带语音识别；'web' = 录音 + 服务端 ASR（旧链路）
  mode: 'web', native: null,
};

/** 柔和提示（v1.1.2）：原来是黑条系统警告，真机上很吓人；现在走柔和气泡样式 */
function softSay(msg) { store.toast(msg, 3200); }

/** 首页录音硬复位（v1.6.11）：任何路径下都能把 rec 清回可再次录音的干净态，
 *  用于「上一次录音因异常/挂起没复位」时自愈，避免第二次按住永久无反应。 */
function hardResetRec(reason) {
  rec.active = false;
  try { document.body.classList.remove('recording'); } catch (e) { /* ignore */ }
  if (window.ipAudio) { try { window.ipAudio.setMuted(false); } catch (e) { /* ignore */ } }
  if (rec.iv) clearInterval(rec.iv);
  if (rec.hintIv) clearInterval(rec.hintIv);
  if (rec.maxTimer) clearTimeout(rec.maxTimer);
  rec.iv = rec.hintIv = rec.maxTimer = null;
  if (rec.volIv) { try { cancelAnimationFrame(rec.volIv); } catch (e) {} rec.volIv = 0; }
  if (rec.volumeProbe) { try { rec.volumeProbe.stop(); } catch (e) {} rec.volumeProbe = null; }
  try { if (rec.sr) rec.sr.stop(); } catch (e) { /* ignore */ }
  try { if (rec.native) rec.native.stop(); } catch (e) { /* ignore */ }
  try { if (rec.media && rec.media.state !== 'inactive') rec.media.stop(); } catch (e) { /* ignore */ }
  try { if (rec.stream) rec.stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
  rec.sr = null; rec.media = null; rec.stream = null; rec.native = null; rec.chunks = [];
  const btn = document.getElementById('talkbtn'); if (btn) btn.classList.remove('talkbtn--live');
  const label = document.getElementById('talkLabel'); if (label) label.textContent = '按住说';
  try { document.documentElement.style.setProperty('--ip-vol', '0'); } catch (e) { /* ignore */ }
  if (reason) console.warn('[ASR] 首页录音硬复位: ' + reason);
}

/** 等 MediaRecorder 把最后一块数据交出来（onstop 之后 chunks 才是完整的） */
function waitForBlob(media) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        resolve(rec.chunks.length ? new Blob(rec.chunks, { type: rec.mime || 'audio/webm' }) : null);
      } catch (e) { resolve(null); }
    };
    media.onstop = finish;
    try { if (media.state !== 'inactive') media.stop(); else finish(); } catch (e) { finish(); }
    setTimeout(finish, 1500); // 兜底：onstop 万一不来，也不能把整个流程卡死
  });
}

/**
 * 录音期间实时把音量写到 CSS 变量 --ip-vol（0..1），供墨小溟触角随音量发光/摆动。
 * 仅在录音激活时循环；endCapture 会取消并归零。
 */
function volumeTick() {
  if (!rec.active) return;
  const p = rec.volumeProbe;
  const lvl = p ? p.getLevel() : 0;
  const pitchHz = p ? p.getPitch() : 0;
  const rate = p ? p.getRate() : 0;
  const tension = p ? p.getTension() : 0;
  const root = document.documentElement.style;
  try {
    // 音量 / 音高 / 语速 / 张力 → 实时驱动墨小溟（@property 让这些变量平滑过渡，不硬跳）
    root.setProperty('--ip-vol', String(lvl));
    root.setProperty('--ip-pitch', String(Math.min(1, Math.max(0, (pitchHz - 100) / 250))));
    root.setProperty('--ip-rate', String(rate));
    root.setProperty('--ip-tension', String(tension));
    // 收缩：音量低 + 静默累积 ⇒ 身体微微收缩（准备进入共情，克制，不是真的下结论）
    const shrink = lvl < 0.05 ? Math.min(1, (rec.lowSince ? (Date.now() - rec.lowSince) / 8000 : 0)) : 0;
    root.setProperty('--ip-shrink', String(shrink));
  } catch (e) { /* ignore */ }
  const now = Date.now();
  if (lvl < 0.05) {
    if (!rec.lowSince) rec.lowSince = now;
    const silentMs = now - rec.lowSince;
    // 呼吸引导：连续静音 >3s ⇒ 让墨小溟带着用户慢慢呼吸（音量恢复即退出）
    if (silentMs > 3000 && !rec.breathing) {
      rec.breathing = true;
      try { document.body.classList.add('recording--breath'); } catch (e) { /* ignore */ }
    }
    // 沉默 / 欲言又止：按静默时长给引导短句（§4.6）。
    // 仅在「静默档位」切换时更新文案，避免逐帧（rAF ~60fps）随机跳词。
    let guide = null, state = null;
    if (silentMs > 10000) { guide = pickSilence('longSilence'); state = 'long'; }
    else if (silentMs > 5000) { guide = pickSilence('encourage'); state = 'enc'; }
    else if (silentMs > 3000) { guide = pickSilence('light'); state = 'light'; }
    if (guide && state !== rec.silentState) {
      rec.silentState = state;
      if (rec.hintIv) { clearInterval(rec.hintIv); rec.hintIv = null; }
      setLiveText(guide);
    }
  } else {
    rec.lowSince = 0;
    rec.silentState = null;
    if (rec.breathing) {
      rec.breathing = false;
      try { document.body.classList.remove('recording--breath'); } catch (e) { /* ignore */ }
    }
    // 重新开口 ⇒ 恢复安抚话术轮播
    if (!rec.hintIv && rec.active) {
      let i = 0;
      setLiveText(COPY.recording[0]);
      rec.hintIv = setInterval(() => { setLiveText(COPY.recording[++i % COPY.recording.length]); }, 2500);
    }
  }
  rec.volIv = (typeof requestAnimationFrame !== 'undefined') ? requestAnimationFrame(volumeTick) : 0;
}

function setLiveText(s) { const el = document.getElementById('liveText'); if (el) el.textContent = s; }

async function beginCapture() {
  if (rec.active) {
    // v1.6.11 自愈：上一次若卡住（active=true 却没有活着的录音），硬复位后继续，避免永久死锁
    if (!rec.media) { console.warn('[ASR] beginCapture 重入且无活录音，硬复位'); hardResetRec('reentrant'); }
    else return;
  }
  rec.mode = 'web';
  rec.native = null;

  // ⓪ 原生容器优先：设备自带语音识别（不需要服务端、不需要密钥，录音与转写都在设备上）
  if (nativeAsr.nativeSpeechPresent() && (await nativeAsr.nativeSpeechAvailable())) {
    const perm = await nativeAsr.nativeSpeechPermission();
    if (perm === 'denied') {
      asr.logEvent('native_asr_denied', {});
      softSay('需要麦克风权限，墨小溟才听得到你。可以在系统设置里打开，或者先打字告诉我。');
      go('record?mode=text');
      return;
    }
    rec.mode = 'native';
    rec.native = nativeAsr.nativeListen({
      lang: 'zh-CN',
      onPartial: (t) => setLiveText(t || COPY.recording[0]),
    });
    diag.note('mic', 'mode', { ok: true, detail: '原生容器设备识别（录音与转写都在设备上，不需要服务端）' });
  } else if (!CAP.canRecord) {
    // 连录音都做不到（极老的 iOS / 拿不到麦克风权限）→ 直接送打字，并说清为什么
    store.toast('这个环境拿不到麦克风，我们打字聊好吗');
    go('record?mode=text');
    return;
  }
  rec.active = true;
  rec.transcript = ''; rec.srText = ''; rec.chunks = []; rec.t0 = Date.now();
  console.log('[ASR] 录音开始（首页）');
  document.body.classList.add('recording');
  if (window.ipAudio) window.ipAudio.setMuted(true); // 倾诉开始：待机环境音立刻让位（方案 §2.6）
  const btn = document.getElementById('talkbtn');
  if (btn) btn.classList.add('talkbtn--live');
  const label = document.getElementById('talkLabel');
  if (label) label.textContent = '松手结束';
  const timer = document.getElementById('recTimer');
  rec.iv = setInterval(() => { if (timer) timer.textContent = ((Date.now() - rec.t0) / 1000).toFixed(1) + 's'; }, 100);

  // ① 录音（云端识别的原料）。原生模式已经在设备层录音了，这里跳过 Web 录制。
  let micErr = null;
  if (rec.mode !== 'native') {
    try {
      rec.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      rec.mime = asr.pickMime();
      rec.media = rec.mime ? new MediaRecorder(rec.stream, { mimeType: rec.mime }) : new MediaRecorder(rec.stream);
      rec.media.ondataavailable = (e) => { if (e.data && e.data.size) rec.chunks.push(e.data); };
      rec.media.start();
      diag.note('mic', 'open', { ok: true, detail: `getUserMedia 成功，容器=${rec.mime || '默认'}，采样已开始` });
    } catch (e) {
      rec.media = null;
      micErr = e;
      diag.note('mic', 'open', { ok: false, code: String((e && e.name) || 'unknown'), detail: `拿不到麦克风：${String((e && e.message) || e).slice(0, 80)}` });
    }
  } else {
    // v1.4.4 · 云端回落原料：原生模式并行录一份 Web 音频。
    // 🔴 为什么必须有这一份：设备识别（SpeechRecognizer）的"可用性检查"会说谎——
    //   不少国产 ROM 返回 available=true，实际识别服务残缺（说完话 partialResults 一直空）。
    //   旧逻辑此时直接判死：「水里有点吵」且**永不自愈**，因为 native 模式没录音频，
    //   就算想回落云端也没有原料（blob=null）。并行录一份（best-effort，失败静默不影响
    //   native 主链路），native 吐不出字时用它走云端回落 —— 这才是「三级降级」本来的样子。
    try {
      rec.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      rec.mime = asr.pickMime();
      rec.media = rec.mime ? new MediaRecorder(rec.stream, { mimeType: rec.mime }) : new MediaRecorder(rec.stream);
      rec.media.ondataavailable = (e) => { if (e.data && e.data.size) rec.chunks.push(e.data); };
      rec.media.start();
      diag.note('mic', 'parallel_record', { ok: true, detail: `原生模式并行录音就绪（云端回落原料），容器=${rec.mime || '默认'}` });
    } catch (e) {
      rec.media = null; rec.stream = null;
      diag.note('mic', 'parallel_record', { ok: false, detail: `并行录音不可用（回落链将无原料）：${String((e && e.message) || e).slice(0, 80)}` });
    }
  }

  // 录音都没建起来（没设备 / 拒绝授权）→ 立刻说清楚并送去打字。
  // 这一条是端到端测试逼出来的：旧写法会让人对着一个假按钮说半分钟，最后只得到一句"没听清"，
  // 用户会以为是自己没说清楚 —— 这是最伤人的一种失败。
  if (rec.mode !== 'native' && !rec.media) {
    rec.active = false;
    document.body.classList.remove('recording');
  if (window.ipAudio) window.ipAudio.setMuted(false);
    if (rec.iv) clearInterval(rec.iv);
    if (rec.hintIv) clearInterval(rec.hintIv);
    if (rec.maxTimer) clearTimeout(rec.maxTimer);
    rec.iv = rec.hintIv = rec.maxTimer = null;
    rec.sr = null; rec.stream = null;
    const liveBtn = document.getElementById('talkbtn');
    if (liveBtn) liveBtn.classList.remove('talkbtn--live');
    if (label) label.textContent = '按住说';
    asr.logEvent('mic_fail', { name: String((micErr && micErr.name) || 'unknown') });
    store.toast(micErr && micErr.name === 'NotAllowedError'
      ? '麦克风没拿到权限，我们打字聊好吗'
      : '这个环境拿不到麦克风，我们打字聊好吗');
    go('record?mode=text');
    return;
  }

  // ②b 实时音量探针（只读 tap 录音流，不接 destination ⇒ 不影响录音链路），驱动墨小溟触角随音量发光/摆动。
  //     原生模式下没有 Web 流（设备在录），探针拿不到数据也必须安全返回，不能抛错。
  if (rec.mode !== 'native') {
    rec.volumeProbe = voice.createVolumeProbe(rec.stream);
    rec.volIv = (typeof requestAnimationFrame !== 'undefined') ? requestAnimationFrame(volumeTick) : 0;
  }

  // ②b-2 首页「按住说」浮层里的墨小溟切到倾听态（录音页本身已是倾听态，这里只处理首页浮层）；复位静音/呼吸追踪
  rec.lowSince = 0;
  rec.breathing = false;
  const homeMascot = document.querySelector('.say__mascot .mascot');
  if (homeMascot) {
    homeMascot.setAttribute('data-state', 'listening');
    homeMascot.classList.remove('mascot--idle', 'mascot--happy');
    homeMascot.classList.add('mascot--listening');
  }

  // ② 屏幕反馈：先放安抚话术轮播，有实时字幕就被字幕覆盖。
  //    两种情况都要轮播 —— 因为「SR 存在但一条结果都吐不出来」（国内网络下 Chrome 就是这样）
  //    和「SR 根本不存在」（iOS/微信）对用户是一模一样的：都盯着一个死的占位符。
  let hintI = 0;
  setLiveText(COPY.recording[0]);
  rec.hintIv = setInterval(() => { setLiveText(COPY.recording[++hintI % COPY.recording.length]); }, 2500);

  // ③ 内置识别：有就做实时字幕（顺带当兜底），没有也不影响主链路。
  //    原生模式已经由设备识别在跑，不要再叠一层 Web Speech（会抢麦、也会给出第二份互相打架的字幕）。
  const sr = (rec.mode === 'native') ? null : asr.createWebSpeech();
  if (sr) {
    sr.onresult = (ev) => {
      let s = '';
      for (let i = 0; i < ev.results.length; i++) s += ev.results[i][0].transcript;
      rec.srText = s;
      if (s) {
        if (rec.hintIv) { clearInterval(rec.hintIv); rec.hintIv = null; }
        setLiveText(s);
      }
    };
    sr.onerror = () => {};
    try { sr.start(); rec.sr = sr; } catch (e) { rec.sr = null; }
  }

  // ④ 到点自动停：超过上限会被服务端拒（百度硬限 60 秒），我们自己先收
  rec.maxTimer = setTimeout(() => { if (rec.active) endCapture(); }, ASR.maxSeconds * 1000);
}

async function endCapture() {
  if (!rec.active) return;
  rec.active = false;
  document.body.classList.remove('recording');
  if (window.ipAudio) window.ipAudio.setMuted(false);
  if (rec.iv) clearInterval(rec.iv);
  if (rec.hintIv) clearInterval(rec.hintIv);
  if (rec.maxTimer) clearTimeout(rec.maxTimer);
  rec.iv = rec.hintIv = rec.maxTimer = null;
  const btn = document.getElementById('talkbtn');
  if (btn) btn.classList.remove('talkbtn--live');

  const srText = (rec.srText || '').trim();
  try { rec.sr && rec.sr.stop(); } catch (e) { /* ignore */ }
  const media = rec.media;
  const blob = media ? await waitForBlob(media) : null;   // 先取音频
  // 麦克风这一段必须留痕：真机上「按住说没反应」到底是没录到字节、还是录到了但识别失败，
  // 全靠这一条区分 —— 没有它，两个完全不同的故障会长得一模一样。
  diag.note('mic', 'captured', {
    ok: !!(blob && blob.size > 0),
    ms: Math.max(0, Date.now() - (rec.t0 || Date.now())),
    detail: `模式=${rec.mode} 录音字节=${(blob && blob.size) || 0} 时长=${((Date.now() - (rec.t0 || Date.now())) / 1000).toFixed(1)}s` +
      (srText ? ` 内置字幕="${srText.slice(0, 30)}"` : ''),
  });
  console.log('[ASR] 音频大小: ' + ((blob && blob.size) || 0) + ' bytes（首页 模式=' + rec.mode + '）');

  // 原生模式：向设备收尾，拿它转写好的文字
  let nativeRes = null;
  if (rec.mode === 'native' && rec.native) {
    try { rec.native.stop(); } catch (e) { /* ignore */ }
    // v1.6.11：native.done 可能永不结算 ⇒ 加 3s 超时，绝不卡在释放麦克风之前
    try { nativeRes = await Promise.race([rec.native.done, new Promise((r) => setTimeout(() => r(null), 3000))]); }
    catch (e) { nativeRes = null; }
    rec.native = null;
  }
  try { rec.stream && rec.stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ } // 再关音轨
  rec.sr = null; rec.media = null; rec.stream = null;

  // ②b 收尾：停掉实时音量探针与 rAF，归零音量变量（音轨已停，探针不再有数据）
  if (rec.volIv) { try { cancelAnimationFrame(rec.volIv); } catch (e) {} rec.volIv = 0; }
  if (rec.volumeProbe) { try { rec.volumeProbe.stop(); } catch (e) {} rec.volumeProbe = null; }
  try { document.documentElement.style.setProperty('--ip-vol', '0'); } catch (e) {}

  let text = srText;
  let fail = null;
  let nativeFailCode = '';
  const label = document.getElementById('talkLabel');
  // 隐私设置真的生效：关掉「允许把录音发给云端转写」后，这段音频一个字都不上传。
  const cloudAllowed = store.getState().user.settings.cloudAsr !== false;

  if (nativeRes && nativeRes.ok && nativeRes.text) {
    text = nativeRes.text;   // 设备识别结果优先：它不需要网络往返，也最贴近设备麦克风的实际采样
    diag.note('asr', 'native', { ok: true, ms: Date.now() - (rec.t0 || Date.now()), detail: `设备识别完成，${text.length} 字` });
    asr.logEvent('asr_ok', { engine: 'native', ms: 0, totalMs: Date.now() - (rec.t0 || Date.now()), chars: text.length });
  } else {
    // v1.4.4 · 原生识别失败/为空 ⇒ **不再判死，自动回落云端**。
    // 🔴 根因（真机截图实证）：设备识别的可用性检查会说谎（国产 ROM 返回 available=true 但识别服务
    //   残缺，说完话 partialResults 一直空 ⇒ code:'empty'）。旧逻辑走到这里直接 softSay「水里有点吵」，
    //   而且因为 native 模式不录音（blob=null），云端分支的条件 `blob && blob.size>0` 也不成立 ⇒
    //   **这类设备上语音识别永久不可用**。现在：native 失败后用并行录的音频走云端——
    //   这才是 asr.js 注释里「三级降级 ① 云端 ② 内置 ③ 打字」本来的样子。
    if (nativeRes && !nativeRes.ok) {
      nativeFailCode = nativeRes.code || 'native_failed';
      diag.note('asr', 'native', { ok: false, code: nativeFailCode, ms: Date.now() - (rec.t0 || Date.now()), detail: `设备识别未给出文本（${nativeFailCode}）⇒ 自动回落云端` });
      asr.logEvent('asr_fail', { engine: 'native', code: nativeFailCode, totalMs: Date.now() - (rec.t0 || Date.now()) });
    }
    if (blob && blob.size > 0 && cloudAllowed && (await asr.probeCloud()) !== 'unavailable') {
      if (label) label.textContent = '识别中…';
      setLiveText(COPY.analyzing[0]);
      const r = await asr.recognize(blob);
      if (r.ok) {
        text = r.text; // 云端结果优先：内置转写只是兜底，不该覆盖更准的那个
        asr.logEvent('asr_ok', { engine: 'cloud_fallback', ms: r.ms || 0, totalMs: r.totalMs || 0, chars: text.length });
        diag.note('asr', 'cloud_fallback', { ok: true, ms: r.ms || 0, detail: `原生失败（${nativeFailCode || '无'}）后云端识别成功，${text.length} 字` });
      } else {
        fail = r;
        asr.logEvent('asr_fail', { engine: 'cloud', code: r.code || '', errNo: r.errNo || 0, totalMs: r.totalMs || 0 });
      }
    } else if (blob && blob.size > 0 && !cloudAllowed) {
      asr.logEvent('asr_skipped', { reason: 'cloud_disabled_by_user' });
    }
  }

  if (label) label.textContent = '按住说';
  if (!text) {
    asr.logEvent('asr_empty', { reason: fail ? (fail.code || 'failed') : (blob ? 'no_speech' : 'no_audio'),
      had_sr: srText ? 1 : 0, mode: rec.mode });
    store.setState({ ipState: 'idle' });
    // v1.1.9：APK 上若原生识别本就不可用（设备无识别服务 / 插件未注册），云端 ASR 在静态托管下又永远
    // 404，再弹「水里有点吵」是在骗用户——那条路永远听不清。改成直说，并把用户送到打字，
    // 而不是让他对着一个必然失败的按钮反复按。只有「真录上了但云端/原生都没吐字」才走原来的温和提示。
    const cloudViable = cloudAllowed && (await asr.probeCloud()) !== 'unavailable';
    if (isNativeApp() && rec.mode !== 'native' && !cloudViable) {
      softSay('这台设备暂时没有可用的语音识别服务，墨小溟听不到语音。你可以先打字告诉我，或者换一台装了语音服务的设备。');
      go('record?mode=text');
      return;
    }
    // v1.1.2：原来这里弹的是黑色系统警告条，真机上很吓人。改成墨小溟的柔和提示，
    // 并区分「压根没录上」和「录上了但没听清」—— 前者是自责感最强的失败，必须说得具体。
    const durMs = Date.now() - (rec.t0 || Date.now());
    softSay(durMs < 1000
      ? '好像没录上，再按一下试试'
      : '水里有点吵，我没听清，你愿意再说一次或者打字告诉我吗？');
    render();
    return;
  }
  diag.note('input', 'transcript', { ok: true, detail: `进入 AI 链路的文本（${text.length} 字）`, raw: text });

  // ②c 语音物理特征：从「音频 + 文本」提炼 user_voice_features，作为辅助参数送主分析。
  //   即使音频解析失败也返回结构完整的对象（volume_peak=0），绝不阻塞主流程。
  const durationMs = Math.max(0, Date.now() - (rec.t0 || Date.now()));
  let voiceFeatures = null;
  if (blob && blob.size > 0) {
    try {
      voiceFeatures = await voice.extractVoiceFeatures(blob, text, durationMs);
    } catch (e) { voiceFeatures = null; }
    asr.logEvent('voice_features', voiceFeatures ? {
      rate: voiceFeatures.speech_rate_chars_per_sec,
      pauses: voiceFeatures.pause_count_over_2s,
      vol: voiceFeatures.volume_peak,
      fillers: voiceFeatures.filler_count,
    } : { failed: 1 });
  }
  store.startDraft(text, 'r_' + Date.now().toString(36));
  if (voiceFeatures) store.patchDraft({ voiceFeatures });
  asr.logEvent('draft_start', { chars: text.length, via: fail ? 'sr_fallback' : 'cloud', has_voice: voiceFeatures ? 1 : 0 });
  go('analyzing');
}


/* ---------------- 页面：首页 / 说 ---------------- */

function pageSay() {
  const s = store.getState();
  const quiet = !!s.quietMode;
  const last = s.cards[0];
  const sessionUser = (s.sessionLog || []).filter((m) => m.role === 'user' && m.text).length;
  /* 🔴 方案 §8 约束 2：高危情绪状态要自动切换安全引导文案、停用普通问候。
     此前 pageSay 只区分 quiet，高危用户回到首页看到的仍是一句普通问候
     —— 与产品「安全边界」的对外承诺不一致（不是崩，是话术没跟上状态）。 */
  const rk = s.risk || {};
  const isDanger = rk.level === 'high' || rk.level === 'critical'
    || rk.action === 'refer' || rk.action === 'emergency';
  const dangerGreet = (((COPY.risk && COPY.risk.scripts && COPY.risk.scripts.suicide) || {}).title)
    || '我很担心你，先陪你待一会儿。';
  const dangerHint = '不着急，我在这里。想说的话慢慢说。';
  // v1.3.3 首页问候（会话内固定）；v1.3.2 安静模式替换专属标题/小字/卡片提示
  let greet;
  let hint;
  if (isDanger) {
    greet = dangerGreet;
    hint = dangerHint;
  } else if (quiet) {
    greet = s.quietTitle || cw.pick(cw.QUIET_COPY.titles);
    hint = s.quietSmall || cw.pick(cw.QUIET_COPY.smallTexts);
  } else {
    greet = s.greeting || greetByHour();
    hint = s.greetingSmall || '不用组织语言，想到哪说到哪';
  }
  const cardHint = quiet ? (s.quietCardHint || cw.pick(cw.QUIET_COPY.cardHints)) : (s.cardHint || '还没有卡片。说一次，就会有一张。');
  return `
  <section class="say${quiet ? ' say--quiet' : ''}">
    <header class="say__head">
      <div class="say__date">${todayText()}</div>
      <h1 class="say__greet">${esc(greet)}</h1>
    </header>
    <div class="say__mascot" id="ipTouch">${ipMascot(200)}<div class="ip-bubble" id="ipBubble" hidden></div></div>
    <div class="say__action">
      <button class="talkbtn" id="talkbtn" type="button">
        <span class="talkbtn__label" id="talkLabel">按住说</span>
        <span class="talkbtn__timer" id="recTimer">0.0s</span>
        ${wave('wave--btn')}
      </button>
      <p class="say__hint">${esc(hint)}</p>
      ${!quiet && sessionUser ? `<button class="endvent-btn" id="endVent" type="button">结束倾诉</button>` : ''}
      ${!quiet ? `<a class="say__type" href="#/record?mode=text">不方便说？打字也行</a>` : ''}
    </div>
    <div class="say__live" id="liveWrap" hidden><div class="live-label">正在听</div><div class="live-text" id="liveText">……</div></div>
    ${renderConvo(s.conversation)}
    ${last ? `
    <a class="recent" href="#/card/${esc(last.id)}">
      <div class="recent__label">最近一张卡片</div>
      <div class="recent__row">
        <div class="recent__face">${miniFace(last.ip_state || 'empathy', 34)}</div>
        <div class="recent__main">
          <div class="recent__title">${esc(last.title || last.event || '一张情绪卡片')}</div>
          <div class="recent__meta">${fmtDate(last.created_at)} · ${esc((last.emotion || []).join('、'))} · 强度 ${esc(last.intensity)}</div>
        </div>
      </div>
    </a>` : `<div class="empty-hint">${esc(cardHint)}</div>`}
  </section>`;
}

/** 渲染对话区（§3.3）：用户原话 + 墨小溟回应 / 安全同步文字 */
function renderConvo(convo) {
  if (!convo || !convo.length) return '';
  const rows = convo.map((m) => {
    const role = m.role === 'user' ? 'convo__user' : 'convo__ai';
    const who = m.role === 'user' ? '我' : '墨小溟';
    return `<div class="convo__row ${role}"><div class="convo__who">${esc(who)}</div><div class="convo__bubble">${esc(m.text)}</div></div>`;
  }).join('');
  return `<div class="convo" id="convo">${rows}</div>`;
}

function bindSay() {
  const btn = document.getElementById('talkbtn');
  const liveWrap = document.getElementById('liveWrap');
  if (!btn) return;
  const endVent = document.getElementById('endVent');
  if (endVent) endVent.addEventListener('click', onEndVent);
  const start = (e) => {
    e.preventDefault();
    // v1.3.2：安静模式下点「按住说」→ 先退出安静，再进入语音倾诉
    if (store.getState().quietMode) { store.setState({ quietMode: false }); try { document.body.classList.remove('quiet-mode'); } catch (er) { /* ignore */ } }
    btn.classList.add('talkbtn--press');
    // 判断依据从「有没有内置识别」改成「能不能录音」：
    // 旧逻辑在 iOS Safari / 微信里一按就被踢去打字页，正是 v1.3 要破的那个卡点。
    if (!CAP.canRecord) { go('record?mode=text'); return; }
    liveWrap.hidden = false;
    beginCapture();
  };
  const stop = (e) => { e.preventDefault(); btn.classList.remove('talkbtn--press'); endCapture(); };
  btn.addEventListener('pointerdown', start);
  btn.addEventListener('pointerup', stop);
  btn.addEventListener('pointercancel', stop);
  btn.addEventListener('pointerleave', () => { btn.classList.remove('talkbtn--press'); if (rec.active) endCapture(); });
  btn.addEventListener('click', (e) => { if (!CAP.canRecord) e.preventDefault(); });

  // v1.3.1 IP 点击轻互动（仅 IP 本体触发；对话/回复/高危时失效）
  bindIpInteraction();
}

/* ---------- v1.3.1/1.3.2：IP 点击轻互动 + 安静陪伴模式 ---------- */

let sayIpCtl = null;
let suppressTapUntil = 0; // 长按进入安静模式后重渲染，松手的 pointerup 会落到新控制器上，短暂抑制以免多计一次点击

/** 点击互动是否失效（前置边界判断）：触碰总开关 / 非首页 / AI回复中 / 高危 时禁用；安静模式仍生效 */
function ipInteractionDisabled() {
  const st = store.getState();
  if (st.user.settings.ipTouch === false) return true;
  if (st.quietMode) return false;
  if ((parseHash().name || 'say') !== 'say') return true;
  if (st.aiReplying) return true;
  if (st.risk && (st.risk.level === 'high' || st.risk.level === 'critical')) return true;
  if (typeof document !== 'undefined' && document.querySelector('.risk-modal')) return true;
  return false;
}

function bindIpInteraction() {
  // 事件绑在「IP 本体（svg）」上，而非全宽容器：点容器留白/气泡即视为「点空白」（用于退出安静模式）
  const el = document.querySelector('#ipTouch .mascot') || document.getElementById('ipTouch');
  if (!el) return;
  if (sayIpCtl) { try { sayIpCtl.destroy(); } catch (e) { /* ignore */ } sayIpCtl = null; }
  sayIpCtl = createIpInteraction({
    el,
    isDisabled: ipInteractionDisabled,
    onTap: (count) => handleIpTap(count, el),
    onLongPress: () => enterQuietMode(),
    onTapAway: (e) => {
      if (!store.getState().quietMode) return;
      if (e && e.target && e.target.closest && e.target.closest('.say__action')) return; // 按住说/按钮不算空白
      exitQuietMode();
    },
  });
}

function handleIpTap(count, el) {
  // 抑制长按松手泄漏出的那次点击；同时把计数归零，避免"被抑制的这一次"仍推进连击计数
  if (Date.now() < suppressTapUntil) { if (sayIpCtl && sayIpCtl.reset) sayIpCtl.reset(); return; }
  if (ipInteractionDisabled()) return;
  store.touchInteraction(); // §三.4：点一下 IP 算有效交互，重置 3 分钟回归计时
  const st = store.getState();
  const text = st.quietMode ? cw.quietTapBubble(count) : cw.normalTapBubble(count, st.emotionKey);
  const _m = (window.motion && window.motion.playTap) ? window.motion.playTap(count) : null;
  const cls = (_m && _m.cls) || tapAnimClass(count);
  const target = (el && el.closest && el.closest('.say__mascot')) || el; // 动画类挂到容器（CSS 选择器 .say__mascot.ip-tapN）
  if (!target) return;
  target.classList.remove('ip-tap1', 'ip-tap2', 'ip-tap3', 'ip-tap-over');
  void target.offsetWidth;
  target.classList.add(cls);
  setTimeout(() => { try { target.classList.remove(cls); } catch (e) { /* ignore */ } }, 1700);
  if (st.user.settings.ipBubble !== false) showIpBubble(text, count >= 4 ? 2200 : 2000);
  /* 🔴 修（v1.6.6）：点击音效走**配置里指定的名字**，不再硬编码 receive/calm ——
     否则方案 §15 那套「单击=单气泡 / 双击=柔水流 / 三连击=绵长浸润 / 四连+=连续气泡」
     的四档区分等于没接上：改不改配置，听到的都是同一类音。 */
  if (window.ipAudio && _m && _m.sound) window.ipAudio.cue(_m.sound);
}

function showIpBubble(text, ms = 2000) {
  const b = document.getElementById('ipBubble');
  if (!b || !text) return;
  b.textContent = text;
  b.hidden = false;
  b.classList.remove('ip-bubble--on');
  void b.offsetWidth;
  b.classList.add('ip-bubble--on');
  if (showIpBubble._t) clearTimeout(showIpBubble._t);
  showIpBubble._t = setTimeout(() => { try { b.hidden = true; b.classList.remove('ip-bubble--on'); } catch (e) { /* ignore */ } }, ms);
}

/** 长按进入安静陪伴模式：替换文案、继承情绪色、背景更柔；不产生卡片、不调模型 */
function enterQuietMode() {
  const st = store.getState();
  if (st.user.settings.ipTouch === false) return;
  if ((parseHash().name || 'say') !== 'say') return;
  if (st.quietMode) return;
  suppressTapUntil = Date.now() + 500; // 抑制长按松手泄漏的点击
  store.setState({
    quietMode: true,
    quietTitle: cw.pick(cw.QUIET_COPY.titles),
    quietSmall: cw.pick(cw.QUIET_COPY.smallTexts),
    quietCardHint: cw.pick(cw.QUIET_COPY.cardHints),
  });
  if (window.ipAudio) window.ipAudio.cue('calm');
  render();
  showIpBubble(cw.pick(cw.QUIET_COPY.enterBubble), 3400);
}

/** 退出安静陪伴模式：点空白处 / 点按住说（后者由 talkbtn 自行放行到语音流程） */
function exitQuietMode() {
  if (!store.getState().quietMode) return;
  store.setState({ quietMode: false });
  render();
  showIpBubble(cw.pick(cw.QUIET_COPY.exitBubble), 2600);
}

/**
 * 「结束倾诉」→ 生成情绪时间线卡片（v1.1.2）。
 * 铁律：对话过程中绝不自动弹出，只有用户主动点「结束倾诉」才生成；
 *      若本次会话命中高危阻断（自伤/伤人高危），不生成时间线卡，只保留危机提示与热线。
 */
async function onEndVent() {
  const st = store.getState();
  const log = (st.sessionLog || []).filter((m) => m.role === 'user' && m.text);
  if (!log.length) { go('say'); return; }
  // 🔴 v1.1.2 修复：阻断判定不能只看 store.risk —— startDraft 每轮都会把 risk 重置回 continue，
  // 高危后再倾诉一轮就会漏判，时间线卡照样生成（违反蓝图「触发危机弹窗不生成时间线」）。
  // 改为双保险：risk 命中 **或** 本次会话任一用户轮次本地复检命中高危，都走危机提示。
  const { safetyCheck } = await import('./ai.js');
  const sessionHit = log.some((m) => isBlockingAction((safetyCheck(m.text) || {}).action));
  if (isBlockingAction((st.risk || {}).action) || sessionHit) { go('risk?level=high'); return; }
  let tl;
  try {
    tl = await api.timelineGenerate({ conversation: log });
  } catch (e) {
    const { buildTimeline } = await import('./ai.js');
    tl = buildTimeline(log); // 降级：本地规则引擎，绝不让流程断在这里
  }
  store.setState({ timeline: tl });
  // v1.3.0 记忆地基：结构化提取 + 去重合并入库（受 memory_on 总开关控制）。
  // 这里可能与 runAnalysisAndContinue 的入库互斥（「结束倾诉」与「说完了」是两条不同入口），
  // 但分析 JSON 在此处通常不可得（直接点「结束倾诉」时还没分析 / 走完卡片后 draft 已清），
  // 所以退化到本地规则引擎 analyzeMain 派生基础分析——绝不空手，也绝不依赖模型。
  // 失败静默：记忆是增强项，绝不能因为 IndexedDB 写不进而卡住主流程或弹错。
  try {
    if ((st.user.settings.memory_on) !== false) {
      const transcript = log.map((m) => m.text).join('\n');
      const { analyzeMain } = await import('./ai.js');
      const analysis = (st.draft && st.draft.analysis) || analyzeMain(transcript);
      memory.saveSessionWithMemory({
        session: { id: (st.draft && st.draft.recordId) || ('sess_' + Date.now().toString(36)) },
        analysis,
        transcript,
        timeline: tl,
        dateISO: new Date().toISOString(),
      }).catch(() => {});
    }
  } catch (e) { /* 记忆入库失败不影响主流程 */ }
  go('timeline');
}

/* ---------------- 页面：录音 / 输入 ---------------- */

function pageRecord(p) {
  const mode = p.q.mode || 'text';
  return `
  <section class="record">
    <div class="page-head">
      <button class="ghost" id="recBack" type="button">取消</button>
      <div class="page-title">${mode === 'text' ? '打字说' : '正在听'}</div>
      <span style="width:48px"></span>
    </div>
    <div class="record__mascot">${mascot('listening', 140)}<div class="ip-bubble ip-bubble--static">${esc(ipSM.NODE_BUBBLE.listening)}</div></div>
    <div class="rec-hint" id="recHint">${COPY.recording[0]}</div>
    ${mode === 'text' ? `
      <textarea class="big-input" id="recInput" placeholder="想到哪说到哪，不用组织语言……"></textarea>
      <div class="row-end">
        <button class="linkbtn" id="fillDemo" type="button">用示例填一句</button>
      </div>
      <button class="primary" id="recDone" type="button">说完了</button>
    ` : `
      <div class="rec-live">${wave('wave--live')}<span id="recTimer">0.0s</span></div>
      <div class="live-text" id="liveText">……</div>
      <button class="primary" id="recToggle" type="button">开始</button>
    `}
    ${CAP.canRecord ? `<div class="row-center"><a class="linkbtn" href="#/record?mode=${mode === 'text' ? 'voice' : 'text'}">${mode === 'text' ? '改用语音说' : '改用打字'}</a></div>` : ''}
  </section>`;
}

function bindRecord(p) {
  const mode = p.q.mode || 'text';
  // 录音中提示轮播（§6.2）
  let i = 0;
  every(() => { const n = document.getElementById('recHint'); if (n) n.textContent = COPY.recording[++i % COPY.recording.length]; }, 2600);

  const back = document.getElementById('recBack');
  if (back) back.addEventListener('click', onRecordCancel);

  if (mode === 'text') {
    const input = document.getElementById('recInput');
    const done = document.getElementById('recDone');
    const fill = document.getElementById('fillDemo');
    if (fill) fill.addEventListener('click', () => { input.value = '今天又和男朋友吵架了，他很晚才回我消息，我觉得他根本不在乎我。'; input.focus(); });
    if (done) done.addEventListener('click', () => {
      if (done.disabled) return; // v1.1.10：防重复点击，避免连点生成多张草稿
      const text = (input.value || '').trim();
      if (!text) { store.toast('还没说话呢'); return; }
      done.disabled = true;
      store.startDraft(text, 'r_' + Date.now().toString(36));
      go('analyzing');
    });
    // 打字反复删改 / 超 15 秒未发 ⇒ 犹豫引导，最多提示一次（§4.6）
    if (input) bindTextHesitate(input);
  } else {
    const toggle = document.getElementById('recToggle');
    if (toggle) toggle.addEventListener('click', () => {
      if (!rec.active) { beginCapture(); toggle.textContent = '说完了'; return; }
      // 收敛到唯一的收尾函数：旧版这里抄了一份 endCapture 的手工版，
      // 于是「首页按住说」和「录音页按钮」两条入口行为不一致（一边走云端识别、一边不走）。
      toggle.textContent = '开始';
      endCapture();
    });
  }
}

/**
 * 打字模式「反复删改 / 超 15 秒未发」的犹豫引导（§4.6）。
 * 检测：15 秒内既输入过又删除过（net 编辑来回），或停留 ≥15s 仍留有内容 ⇒ 给【反复犹豫】文案，仅提示一次。
 */
function bindTextHesitate(input) {
  let maxLen = 0;
  let edited = false; // 出现过「删改」（长度回落）
  let shown = false;
  input.addEventListener('input', () => {
    const len = input.value.length;
    if (len < maxLen) edited = true;
    if (len > maxLen) maxLen = len;
  });
  later(() => {
    const stillHere = document.getElementById('recInput');
    if (stillHere && !shown && (edited || (input.value && input.value.trim().length))) {
      shown = true;
      store.toast(pickSilence('hesitate'));
    }
  }, 15000);
}

/**
 * 录音 / 输入页「取消」：用户主动退出（§4.6）。
 * · 打字有内容但未点「说完了」→ 作为一次有效倾诉保存并继续（「保存现有记录为一次有效倾诉」）。
 * · 语音已转写出文字（endCapture 已建 draft）→ 作为有效倾诉，安抚退出。
 * · 纯退出（无内容）→ 安抚后回首页。
 */
async function onRecordCancel() {
  if (rec.active) { await endCapture(); } // 有语音→建 draft 并 go('analyzing')；无语音→留 record 并 toast 没听清
  const d = store.getState().draft;
  const txt = (document.getElementById('recInput') || {}).value || '';
  if (d) {
    // 已有倾诉内容（语音转写）→ 作为有效倾诉，给「中途不想讲」安抚
    store.toast(pickSilence('cancel'));
  } else if (txt.trim()) {
    // 打字有内容未提交 → 保存为一次有效倾诉
    store.startDraft(txt.trim(), 'r_' + Date.now().toString(36));
    store.toast(pickSilence('cancel'));
    go('analyzing');
  } else {
    store.toast(pickSilence('cancel'));
    go('say');
  }
}

/* ---------------- 页面：AI 分析中 ---------------- */

let analyzingToken = 0;
function pageAnalyzing() {
  return `
  <section class="center-stage">
    <div class="stage-mascot">${mascot('thinking', 190)}<div class="ip-ripple" id="recvRipple"></div></div>
    <div class="ip-recv-bubble" id="recvBubble" hidden>${esc(ipSM.NODE_BUBBLE.receiving)}</div>
    <div class="stage-copy" id="analyzingCopy">${COPY.analyzing[0]}</div>
    <div class="stage-summary" id="analyzingSummary"></div>
    <div class="stuck-bubble" id="stuckBubble">我在认真听，别急～</div>
  </section>`;
}

function mountAnalyzing() {
  const token = ++analyzingToken;
  let i = 0;
  every(() => { const n = document.getElementById('analyzingCopy'); if (n) n.textContent = COPY.analyzing[++i % COPY.analyzing.length]; }, 1000);

  (async () => {
    const t0 = Date.now();
    const d = store.getState().draft;
    if (!d) { go('say'); return; }

    // 防呆气泡：分析等待 >10s 时，墨小溟主动说一句安心的话（离开分析页会在 render 里清掉）
    rec.stuckTimer = setTimeout(() => {
      if (token === analyzingToken) { try { document.body.classList.add('thinking--stuck'); } catch (e) { /* ignore */ } }
    }, 10000);

    // v1.3.0 §一.2 接收情绪节点：提交后 0.8s 内显示「正在接住你的情绪」气泡 + 墨汁波纹
    const recvUntil = store.getState().receivingUntil;
    if (recvUntil && Date.now() < recvUntil) {
      const bubble = document.getElementById('recvBubble');
      const ripple = document.getElementById('recvRipple');
      if (bubble) bubble.hidden = false;
      if (ripple) { ripple.classList.remove('is-on'); void ripple.offsetWidth; ripple.classList.add('is-on'); }
      if (window.ipAudio) window.ipAudio.cue('receive');
    }

    let safety;
    try {
      // 第一步：安全识别。这一步无论成功还是失败都必须拿到一个结果（失败即保守策略），
      // 不允许把流程挂在这里，也不允许直接跳到主分析。
      safety = await api.safety({ transcript: d.transcript });
    } catch (e) {
      safety = { risk_level: 'medium', reason: '安全识别异常，按保守策略处理', action: 'gentle_check' };
      store.setRisk({ level: safety.risk_level, action: safety.action, evidence: d.transcript.slice(0, 60) });
    }
    if (token !== analyzingToken) return;
    store.patchDraft({ safety });
    // 内测埋点（§4）：记录风险判定分布与是否为降级判定。
    // degraded 非空 = 这一条不是模型给的，是保守兜底或本地规则引擎给的，复核时要区别看待。
    asr.logEvent('risk', { level: safety.risk_level || 'none', action: safety.action || 'continue',
      degraded: safety.degraded ? 1 : 0 });

    // 「我在听」至少停留一会儿，别一闪而过；真实模型耗时通常远大于此
    const rest = AI.minThinkingMs - (Date.now() - t0);
    if (rest > 0) await wait(rest);
    if (token !== analyzingToken) return;

    // §4.7 / §3.3：高危阻断 → 强制弹窗（我已了解 必点关闭）+ 对话区同步输出
    if (isBlockingAction(safety.action)) { handleBlocking(safety); return; }
    // §4.8：索要诊断/开药、过度依赖 → 非强制弹窗，正常走对话流（墨小溟输出边界话术后继续）
    if (safety.action === 'reject_diagnosis' || safety.action === 'dependency_redirect') {
      const script = pickRiskScript(safety.action);
      appendConvo('ai', (script.title ? script.title + ' ' : '') + script.line);
      // 继续主分析流程，正常产出卡片
    }
    if (safety.action === 'gentle_check') { go('gentle'); return; }

    await runAnalysisAndContinue();
  })();
}

/** 主分析 → 追问 / 直接生成卡片 */
async function runAnalysisAndContinue() {
  const d = store.getState().draft;
  if (!d) { go('say'); return; }

  let analysis;
  try {
    // v1.5 §2.2 流式输出：主分析一边生成，一边把「温柔总结」逐字回显到分析页，抵消等待感。
    // 模型未流到 summary 字段时提取为空，前端隐藏该层 —— 不会泄漏任何 JSON 结构字符。
    const onProgress = (acc) => {
      const el = document.getElementById('analyzingSummary');
      if (el) el.textContent = extractPartialSummary(acc);
    };
    analysis = await api.analyze({ transcript: d.transcript, onProgress, voiceFeatures: (d.voiceFeatures || null) });
  } catch (e) {
    store.toast('刚刚没接上，再说一次好吗');
    go('say');
    return;
  }
  store.patchDraft({ analysis });
  // v1.3.0 情绪渲染：分析完成后写入检测到的情绪键 + 强度，供情绪渲染/AI 回复节点消费（L1/L2/L3 由 state-machine 选色）
  // v1.3.4 开场回应：第一条倾诉后，墨小溟先接住情绪（简短克制，随情绪状态机同步色彩）——只作开场第一句
  try {
    const emoKey = ipSM.resolveEmotionKey(analysis);
    store.setEmotion(emoKey, analysis.intensity || 5);
    if (window.ipAudio) window.ipAudio.cue(emoKey === 'danger' ? 'danger' : (emoKey && emoKey !== 'default' ? 'emotion' : 'calm'));
    const opening = cw.openingFor(emoKey);
    if (opening) { appendConvo('ai', opening); store.patchDraft({ opening }); }
  } catch (e) { /* ignore */ }
  // v1.3.0 记忆地基：主分析产出后即入库（结构化提取 + 去重合并）。
  // 这是分析 JSON 唯一可靠可得的点——后续卡片保存会清空 draft，
  // 且无论用户是否走完「卡片 / 结束倾诉」，这一次倾诉的核心洞察都被记下。受 memory_on 控制。
  try {
    if ((store.getState().user.settings.memory_on) !== false) {
      const d2 = store.getState().draft;
      memory.saveSessionWithMemory({
        session: { id: (d2 && d2.recordId) || ('sess_' + Date.now().toString(36)) },
        analysis,
        transcript: (d2 && d2.transcript) || '',
        timeline: null,
        dateISO: new Date().toISOString(),
      }).catch(() => {});
    }
  } catch (e) { /* 记忆是增强项，失败不影响主流程 */ }
  if (!analysis.needs_followup) { await toConfirm(); return; }

  let fu;
  try {
    fu = await api.followup({ analysis, asked: [], userAnswer: '', round: 0 });
  } catch (e) {
    fu = { ready_for_card: true };
  }
  if (fu.ready_for_card) { await toConfirm(); return; }
  store.patchDraft({ currentQuestion: fu.question, empathy: fu.empathy });
  store.addAsked(fu.question);
  asr.logEvent('followup_round', { round: 1 });
  go('followup');
}

/** 追问结束 → 卡片生成 → 确认页 */
async function toConfirm() {
  const d = store.getState().draft;
  if (!d) { go('say'); return; }
  let card;
  try {
    card = await api.cardGenerate({
      analysis: d.analysis,
      followup: d.asked || [],
      extra: (d.answers || []).filter(Boolean).join(' / '),
      transcript: d.transcript || '',
    });
  } catch (e) {
    store.toast('卡片没生成出来，素材先留着');
    go('say');
    return;
  }
  store.patchDraft({ card, cardShown: true });
  // 对话区同步：墨小溟的情绪回应（承接矛盾/反转）+ 收尾短句（§4.4 / §4.5），用户原话已在 startDraft 写入
  appendConvo('ai', buildConvoResponse(card));
  appendConvo('ai', pickBy(COPY.closing));
  go('confirm');
}

/**
 * 墨小溟在确认页前的对话回应：矛盾/复杂情绪用「一边…一边…」句式承接（蓝图 §一），其余走分情绪回应。
 * 这是「对话先行、跟随情绪流动、不强行归类」在文本层的落地。
 */
function buildConvoResponse(card) {
  if (card && card.card_type === 'see') {
    const a = card.emotion_primary || '轻松';
    const b = card.emotion_secondary || '难受';
    return `一边${a}，一边${b}，两种感受同时存在，是很正常的。`;
  }
  return pickEmotionResponse(card && card.emotion_primary);
}

/* ---------------- 页面：AI 追问 ---------------- */

function pageFollowup() {
  const d = store.getState().draft || {};
  const askedCount = (d.asked || []).length || 1;
  const a = d.analysis || {};
  const idx = Math.min(askedCount - 1, COPY.followupLead.length - 1);
  return `
  <section class="followup">
    <div class="page-head">
      <button class="ghost" id="fuSkipTop" type="button">跳过</button>
      <div class="page-title">第 ${Math.min(askedCount, 3)} / 3 个问题</div>
      <span style="width:48px"></span>
    </div>
    <div class="fu-mascot" id="fuMascot">${ipMascot(130)}</div>
    ${d.opening && askedCount === 1 ? `<p class="fu-opening">${esc(d.opening)}</p>` : ''}
    ${d.empathy ? `<p class="fu-empathy">${esc(d.empathy)}</p>` : ''}
    <div class="fu-lead">${esc(COPY.followupLead[idx] || COPY.followupLead[0])}</div>
    <div class="fu-question" data-q="${esc(d.currentQuestion || '')}">${esc(d.currentQuestion || '再多说一点？')}</div>
    <div class="fu-voice">
      <button class="talkbtn talkbtn--mini" id="fuTalk" type="button">
        <span class="talkbtn__label" id="fuTalkLabel">按住说</span>
        <span class="talkbtn__timer" id="fuTalkTimer">0.0s</span>
      </button>
      <div class="fu-voice__hint" id="fuTalkHint"></div>
    </div>
    <textarea class="big-input" id="fuInput" placeholder="不想说也可以跳过……"></textarea>
    <button class="primary" id="fuNext" type="button">回答</button>
    <div class="row-center"><button class="linkbtn" id="fuSkip" type="button">跳过这个问题</button></div>
    ${a.summary ? `<p class="fu-note">${esc(a.summary)}</p>` : ''}
  </section>`;
}

/* ---------------- v1.4.5 · 追问页「按住说」（语音优先、文字兜底） ----------------
 * 复用 v1.4.4 验证过的识别链路（设备识别 → 云端回落），但目的地不同：
 * 首页松手 → 直接进分析页；追问页松手 → 文本填进输入框，用户可改再点「回答」。
 * 🔴 不自动提交（安全边界）：识别偏差会一路污染情绪分析，让用户过目一眼再提交更稳。
 * IP 联动：录音 listening（触角随音量起伏）→ 识别中 thinking → 结束恢复本页派生态。
 * IP 用「局部替换 SVG」而不是全局 render——追问页 textarea 里已有内容，整页重渲染会把话冲掉。 */
const fuRec = { active: false, mode: 'web', media: null, stream: null, chunks: [], mime: '', t0: 0,
  native: null, probe: null, volIv: 0, timerIv: 0, nativeFailCode: '', startWatchdog: null };
// v1.6.11：启动看门狗阈值 —— 超过它还没拿到 MediaRecorder 就判启动失败并硬复位
const FU_START_TIMEOUT_MS = 3500;

function fuMascotSwap(state) {
  const box = document.getElementById('fuMascot');
  if (box) box.innerHTML = mascot(state, 130);
}
function fuMascotRestore() {
  const box = document.getElementById('fuMascot');
  if (box) box.innerHTML = ipMascot(130);   // 回到本页派生态（empathy / 高危 worried 等）
}
function fuHint(s) { const el = document.getElementById('fuTalkHint'); if (el) el.textContent = s || ''; }

function fuVolTick() {
  if (!fuRec.active) return;
  const p = fuRec.probe;
  try { document.documentElement.style.setProperty('--ip-vol', String(p ? p.getLevel() : 0)); } catch (e) { /* ignore */ }
  fuRec.volIv = (typeof requestAnimationFrame !== 'undefined') ? requestAnimationFrame(fuVolTick) : 0;
}

function fuUiReset(label) {
  const btn = document.getElementById('fuTalk');
  const lb = document.getElementById('fuTalkLabel');
  const next = document.getElementById('fuNext');
  if (btn) btn.classList.remove('talkbtn--live', 'talkbtn--press', 'talkbtn--cancel');
  if (lb) lb.textContent = label || '按住说';
  const t = document.getElementById('fuTalkTimer');
  if (t) t.textContent = '0.0s';
  if (next) next.disabled = false;
}

function fuStopStreams() {
  if (fuRec.startWatchdog) { clearTimeout(fuRec.startWatchdog); fuRec.startWatchdog = null; }
  if (fuRec.timerIv) { clearInterval(fuRec.timerIv); fuRec.timerIv = 0; }
  if (fuRec.volIv) { try { cancelAnimationFrame(fuRec.volIv); } catch (e) { /* ignore */ } fuRec.volIv = 0; }
  try { document.documentElement.style.setProperty('--ip-vol', '0'); } catch (e) { /* ignore */ }
  if (fuRec.probe) { try { fuRec.probe.stop(); } catch (e) { /* ignore */ } fuRec.probe = null; }
  try { if (fuRec.native) fuRec.native.stop(); } catch (e) { /* ignore */ }
  // 🔴 v1.6.11：麦克风必须彻底释放（MediaRecorder.stop + track.stop）。
  //    只停其一，第二次按下时浏览器/WebView 可能拒绝再次授权 ⇒ 表现为「完全没反应」。
  try { if (fuRec.media && fuRec.media.state !== 'inactive') fuRec.media.stop(); } catch (e) { /* ignore */ }
  try { if (fuRec.stream) fuRec.stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
  fuRec.stream = null;
  console.log('[ASR] 录音资源已释放（追问页）');
}

/**
 * 追问页录音「硬复位」（v1.6.11）：把状态彻底清干净，任何路径下都可调用。
 * 这是「第二次按住完全没反应」的根治手段 —— 上一次若因异常/挂起没复位，active 卡在 true，
 * 后续所有按下都被 `if (fuRec.active) return` 静默吞掉。这里保证回到可再次录音的干净态。
 */
function fuHardReset(reason) {
  fuRec.active = false;
  fuStopStreams();
  fuRec.media = null; fuRec.chunks = []; fuRec.native = null; fuRec.mode = 'web';
  fuMascotRestore(); fuUiReset('按住说');
  try { document.documentElement.style.setProperty('--ip-vol', '0'); } catch (e) { /* ignore */ }
  if (reason) console.warn('[ASR] 追问页录音硬复位: ' + reason);
}

/** 同步中止（跳过 / 离开页面时用）：立刻停音轨与计时器并复位 UI，不做任何识别 */
function fuAbort() {
  if (!fuRec.active) return;
  fuRec.active = false;
  fuStopStreams();
  fuRec.media = null; fuRec.chunks = []; fuRec.native = null;
  fuMascotRestore();
  fuUiReset('按住说');
  fuHint('');
}

async function fuBeginCapture() {
  const btn = document.getElementById('fuTalk');
  const lb = document.getElementById('fuTalkLabel');
  const next = document.getElementById('fuNext');
  // 🔴 v1.6.11 卡死自愈：若上一次因异常/挂起没复位（active 仍为 true 但没有活着的录音），
  //    先硬复位再继续 —— 否则这一按会被下面的 return 吞掉，就是用户说的「第二次完全没反应」。
  if (fuRec.active) {
    console.warn('[ASR] fuBeginCapture 被重入（active=true），执行硬复位后继续');
    fuHardReset('reentrant');
  }
  if (!CAP.canRecord) {
    if (btn) btn.classList.remove('talkbtn--press');
    fuHint('这个环境拿不到麦克风，直接打字告诉我也可以');
    return;
  }
  fuRec.active = true;
  fuRec.mode = 'web'; fuRec.native = null; fuRec.chunks = []; fuRec.mime = ''; fuRec.nativeFailCode = '';
  fuRec.t0 = Date.now();
  if (btn) btn.classList.add('talkbtn--live');
  if (lb) lb.textContent = '松手结束';
  if (next) next.disabled = true;   // 防呆：录音期间禁用「回答」，防重复提交
  fuHint('');
  fuMascotSwap('listening');        // 状态机联动：倾听
  const tEl = document.getElementById('fuTalkTimer');
  fuRec.timerIv = setInterval(() => { if (tEl) tEl.textContent = ((Date.now() - fuRec.t0) / 1000).toFixed(1) + 's'; }, 100);
  console.log('[ASR] 录音开始（追问页）');
  // 看门狗：启动链路里任何一步 await 挂起，都要在超时后放行/复位，绝不让 active 永久卡住
  fuRec.startWatchdog = setTimeout(() => {
    if (fuRec.active && !fuRec.media) {
      fuHardReset('start_timeout');
      fuHint('刚才没启动起来，再按住说一次试试');
    }
  }, FU_START_TIMEOUT_MS);
  try {
    // 模式选择与首页同款判据；native 模式也并行录一份 Web 音频（v1.4.4 的云端回落原料）
    // 原生探测一律 catch —— 任何异常都不能让它把 active 卡住
    let nativeOk = false;
    try { nativeOk = nativeAsr.nativeSpeechPresent() && (await nativeAsr.nativeSpeechAvailable()); } catch (e) { nativeOk = false; }
    if (!fuRec.active) return;                       // 启动期间用户已松手/取消
    if (nativeOk) {
      let perm = 'unknown';
      try { perm = await nativeAsr.nativeSpeechPermission(); } catch (e) { perm = 'unknown'; }
      if (perm === 'denied') {
        fuHardReset('native_denied');
        fuHint('需要麦克风权限才能说话，可以直接打字回答');
        return;
      }
      fuRec.mode = 'native';
      fuRec.native = nativeAsr.nativeListen({ lang: 'zh-CN', onPartial: (t) => fuHint(t ? `「${t}」` : '') });
      asr.logEvent('fu_native_start', {});
    }
    if (!fuRec.active) return;                       // 再次确认未被取消
    fuRec.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (!fuRec.active) { try { fuRec.stream.getTracks().forEach((t) => t.stop()); } catch (e) {} fuRec.stream = null; return; }
    fuRec.mime = asr.pickMime();
    fuRec.media = fuRec.mime ? new MediaRecorder(fuRec.stream, { mimeType: fuRec.mime }) : new MediaRecorder(fuRec.stream);
    fuRec.media.ondataavailable = (e) => { if (e.data && e.data.size) fuRec.chunks.push(e.data); };
    fuRec.media.start();
    fuRec.probe = voice.createVolumeProbe(fuRec.stream);
    fuVolTick();
    if (fuRec.startWatchdog) { clearTimeout(fuRec.startWatchdog); fuRec.startWatchdog = null; }
    diag.note('mic', 'fu_open', { ok: true, detail: `追问页录音就绪 模式=${fuRec.mode} 容器=${fuRec.mime || '默认'}` });
  } catch (e) {
    fuHardReset('start_failed');
    if (fuRec.mode !== 'native') {
      asr.logEvent('fu_mic_fail', { name: String((e && e.name) || 'unknown') });
      fuHint('麦克风没拿到权限，直接打字告诉我也可以');
    } else {
      // native 模式下并行录音失败不致命：设备识别还有机会，只是云端回落会缺原料
      diag.note('mic', 'fu_parallel', { ok: false, detail: `追问页并行录音不可用：${String((e && e.message) || e).slice(0, 60)}` });
      // 但 native 链路还在跑，重新进入倾听态与计时
      fuRec.active = true; fuMascotSwap('listening');
      if (lb) lb.textContent = '松手结束';
      if (next) next.disabled = true;
    }
  }
}

async function fuFinishCapture(cancelled) {
  if (!fuRec.active) return;
  fuRec.active = false;
  const input = document.getElementById('fuInput');
  const durMs = Date.now() - fuRec.t0;
  const lb = document.getElementById('fuTalkLabel');

  // 🔴 v1.6.11：收尾必须先无条件释放麦克风。native.done 可能永不结算 ⇒ 加 3s 超时兜底，
  //    绝不能让整个收尾卡在这条 await 上（真机上就表现为「第二次按住没反应」）。
  let nativeRes = null;
  if (fuRec.mode === 'native' && fuRec.native) {
    try {
      nativeRes = await Promise.race([
        fuRec.native.done,
        new Promise((r) => setTimeout(() => r(null), 3000)),
      ]);
    } catch (e) { nativeRes = null; }
    fuRec.native = null;
  }
  const media = fuRec.media;
  fuRec.media = null;
  let blob = null;
  try {
    blob = media ? await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true;
        try { resolve(fuRec.chunks.length ? new Blob(fuRec.chunks, { type: fuRec.mime || 'audio/webm' }) : null); } catch (e) { resolve(null); } };
      media.onstop = finish;
      try { if (media.state !== 'inactive') media.stop(); else finish(); } catch (e) { finish(); }
      setTimeout(finish, 1500);
    }) : null;
  } catch (e) { blob = null; }
  fuStopStreams();
  fuRec.chunks = [];
  console.log('[ASR] 音频大小: ' + ((blob && blob.size) || 0) + ' bytes（追问页 时长 ' + Math.round(durMs) + 'ms）');

  if (cancelled) {
    fuMascotRestore(); fuUiReset('按住说');
    fuHint('已取消这次录音，想说再按住说，或者直接打字');
    asr.logEvent('fu_voice_cancel', { ms: durMs });
    return;
  }

  // 状态机联动：识别中 → thinking
  fuMascotSwap('thinking');
  if (lb) lb.textContent = '识别中…';

  let text = '';
  try {
    const cloudAllowed = store.getState().user.settings.cloudAsr !== false;
    if (nativeRes && nativeRes.ok && nativeRes.text) {
      text = nativeRes.text;
      diag.note('asr', 'fu_native', { ok: true, detail: `追问页设备识别 ${text.length} 字` });
    } else {
      if (nativeRes && !nativeRes.ok) fuRec.nativeFailCode = nativeRes.code || 'native_failed';
      if (blob && blob.size > 0 && cloudAllowed && (await asr.probeCloud()) !== 'unavailable') {
        const r = await asr.recognize(blob);
        if (r.ok) {
          text = r.text;
          asr.logEvent('asr_ok', { engine: 'fu_cloud_fallback', ms: r.ms || 0, totalMs: r.totalMs || 0, chars: text.length });
          diag.note('asr', 'fu_cloud_fallback', { ok: true, detail: `追问页云端识别 ${text.length} 字${fuRec.nativeFailCode ? `（设备识别失败 ${fuRec.nativeFailCode} 后回落）` : ''}` });
        } else {
          asr.logEvent('asr_fail', { engine: 'fu_cloud', code: r.code || '', totalMs: r.totalMs || 0 });
          fuRec.nativeFailCode = r.code || fuRec.nativeFailCode;
        }
      }
    }
  } catch (e) {
    console.warn('[ASR] 追问页识别异常，已兜底为未识别: ' + String((e && e.message) || e));
    text = '';
  } finally {
    fuMascotRestore(); fuUiReset('按住说');   // 回归本页派生态（empathy）；异常路径也必须复位
  }

  if (text) {
    if (input) { input.value = text; input.dispatchEvent(new Event('input', { bubbles: true })); }
    store.touchInteraction();
    fuHint('已经帮你写进输入框，改一改再点「回答」也可以');
  } else {
    fuHint('水里有点吵，我没听清，你愿意打字告诉我吗？');
  }
}

function bindFollowup() {
  const next = document.getElementById('fuNext');
  const skip = document.getElementById('fuSkip');
  const skipTop = document.getElementById('fuSkipTop');
  const input = document.getElementById('fuInput');
  if (next) next.addEventListener('click', () => { if (fuRec.active) fuAbort(); advanceFollowup(input.value); });
  // 防呆：录音中点「跳过」→ 先停录音再跳过（不提交任何音频）
  const guardSkip = () => { if (fuRec.active) fuAbort(); advanceFollowup('不想说，跳过'); };
  if (skip) skip.addEventListener('click', guardSkip);
  if (skipTop) skipTop.addEventListener('click', guardSkip);
  // v1.4.5 · 追问页「按住说」：松手 → 识别 → 填入输入框（可改再回答）
  // v1.6.11 加固：① setPointerCapture —— 松手事件必定落在按钮上（不会因手抖丢事件）；
  //              ② 取消判定改看「松手时手指在不在按钮内」（24px 容差），比 pointerleave 抗手抖；
  //              ③ 300ms 防抖 —— 上一次刚结束的误触忽略，避免把状态机搞乱。
  const fuTalk = document.getElementById('fuTalk');
  if (fuTalk) {
    let lastEndAt = 0;
    fuTalk.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (Date.now() - lastEndAt < 300) return;
      try { fuTalk.setPointerCapture(e.pointerId); } catch (err) { /* 老浏览器忽略 */ }
      fuTalk.classList.remove('talkbtn--cancel');
      fuTalk.classList.add('talkbtn--press');
      fuBeginCapture();
    });
    const end = (e) => {
      e.preventDefault();
      lastEndAt = Date.now();
      fuTalk.classList.remove('talkbtn--press');
      if (!fuRec.active) return;
      const r = fuTalk.getBoundingClientRect();
      const pad = 24;
      const inside = e.clientX >= r.left - pad && e.clientX <= r.right + pad
        && e.clientY >= r.top - pad && e.clientY <= r.bottom + pad;
      if (e.type === 'pointercancel' || !inside) { fuTalk.classList.add('talkbtn--cancel'); fuFinishCapture(true); }
      else fuFinishCapture(false);
      try { if (fuTalk.hasPointerCapture(e.pointerId)) fuTalk.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    };
    fuTalk.addEventListener('pointerup', end);
    fuTalk.addEventListener('pointercancel', end);
    fuTalk.addEventListener('click', (e) => e.preventDefault()); // 点一下不算说话
  }
  // 追问后超 20 秒未回复 ⇒ 长时间静默兜底，不再追问（§4.6）
  // 离开本页（回答 / 跳过 / 导航）都会触发 render→clearTimers 清掉此计时器，
  // 因此「fuInput 仍在 DOM」即等同于用户仍停留且尚未推进流程，无需额外标记字段。
  later(() => {
    const stillHere = document.getElementById('fuInput');
    if (stillHere) store.toast(pickSilence('longSilence'));
  }, 20000);
}

async function advanceFollowup(answer) {
  const d = store.getState().draft;
  if (!d) { go('say'); return; }
  if (answer && answer.trim() && !/跳过/.test(answer)) store.addAnswer(answer.trim());

  const cur = store.getState().draft;
  let fu;
  try {
    fu = await api.followup({
      analysis: cur.analysis,
      asked: cur.asked || [],
      userAnswer: answer || '',
      round: (cur.asked || []).length,
    });
  } catch (e) {
    fu = { ready_for_card: true }; // 追问环节任何异常都收敛到「直接出卡片」
  }
  if (fu.ready_for_card) { await toConfirm(); return; }

  store.patchDraft({ currentQuestion: fu.question, empathy: fu.empathy });
  store.addAsked(fu.question);
  asr.logEvent('followup_round', { round: (cur.asked || []).length + 1 });
  render();
}

/* ---------------- 页面：温和确认（中风险 gentle_check） ---------------- */

function pageGentle() {
  return `
  <section class="gentle">
    <div class="gentle__mascot">${ipMascot(150)}</div>
    <h2 class="gentle__title">${esc(COPY.gentle.title)}</h2>
    <p class="gentle__body">${esc(COPY.gentle.body)}</p>
    <button class="primary" id="gMore" type="button">${esc(COPY.gentle.more)}</button>
    <button class="ghost-btn" id="gProceed" type="button">${esc(COPY.gentle.proceed)}</button>
    <button class="ghost-btn" id="gRefer" type="button">${esc(COPY.gentle.refer)}</button>
  </section>`;
}

function bindGentle() {
  const more = document.getElementById('gMore');
  const proceed = document.getElementById('gProceed');
  const refer = document.getElementById('gRefer');
  if (more) more.addEventListener('click', () => go('record?mode=text'));
  if (proceed) proceed.addEventListener('click', async () => { await runAnalysisAndContinue(); });
  if (refer) refer.addEventListener('click', () => go('risk?level=high'));
}

/* ---------------- 页面：确认卡片 ---------------- */

function pageConfirm() {
  const d = store.getState().draft || {};
  const c = d.card || {};
  const field = (label, id, val, ph = '') => `
    <label class="fld">
      <span class="fld__label">${label}</span>
      <input class="fld__input" id="${id}" value="${esc(val || '')}" placeholder="${esc(ph)}"/>
    </label>`;
  return `
  <section class="confirm">
    <div class="page-head">
      <button class="ghost" id="cfBack" type="button">返回</button>
      <div class="page-title">墨小溟留了张卡片</div>
      <span style="width:48px"></span>
    </div>
    <div class="cf-mascot catch-in">${ipMascot(112)}</div>
    <h2 class="cf-lead catch-in">我听到的是这些，你看对不对？</h2>
    <div class="cf-card catch-in">
      <div class="cf-card__badge">${esc(c.card_layer || '')} · ${esc(c.card_name || '情绪卡片')}</div>
      <h3 class="cf-card__title">${esc(c.title || '')}</h3>
      <p class="cf-card__body">${esc(c.card_body || '')}</p>
      ${c.action_step ? `<div class="cf-card__action">
        <div class="cf-card__action-label">可以试一个很小的动作</div>
        <div class="cf-card__action-step">${esc(c.action_step)}</div>
        ${c.action_note ? `<div class="cf-card__action-note">${esc(c.action_note)}</div>` : ''}
      </div>` : ''}
      <div class="cf-card__btns">
        <button class="primary cf-keep" id="cfKeep" type="button">先收下卡片</button>
        <button class="ghost-btn cf-continue" id="cfContinue" type="button">继续倾诉</button>
      </div>
      <p class="cf-card__hint">不强制你做任何动作。也可以只收下，不行动。</p>
    </div>
    <p class="cf-sub catch-in">它是对话的补充，不是评判。下面的记录你可以改，改完再收下。</p>
    <details class="cf-more">
      <summary>完整记录（可改，留着以后回看）</summary>
      <div class="cf-more__body">
        ${field('卡片标题', 'f_title', c.title)}
        ${field('发生了什么', 'f_event', c.event)}
        <label class="fld">
          <span class="fld__label">我的情绪（用「、」分隔）</span>
          <input class="fld__input" id="f_emotion" value="${esc((c.emotion || []).join('、'))}"/>
        </label>
        <label class="fld">
          <span class="fld__label">强度（0-10）：<b id="f_int_v">${esc(c.intensity || 0)}</b></span>
          <input class="fld__range" id="f_intensity" type="range" min="0" max="10" value="${esc(c.intensity || 0)}"/>
        </label>
        ${field('我当时的想法', 'f_thought', c.thought)}
        ${field('我真正在意的', 'f_need', (c.need || []).join('、'))}
        ${field('我做了什么', 'f_behavior', c.behavior)}
        ${field('下次可以试什么', 'f_experiment', c.experiment)}
        ${field('标签（用「、」分隔）', 'f_tags', (c.tags || []).join('、'))}
        <div class="kv"><span>身体感受</span><b>${esc((c.body || []).join('、') || '—')}</b></div>
        <div class="kv"><span>结果</span><b>${esc(c.result || '—')}</b></div>
        <div class="kv"><span>重复的模式</span><b>${esc(c.pattern || '—')}</b></div>
        <div class="kv"><span>墨小溟想说</span><b>${esc(c.summary || '—')}</b></div>
      </div>
    </details>
  </section>`;
}

function bindConfirm() {
  const r = document.getElementById('f_intensity');
  const rv = document.getElementById('f_int_v');
  if (r && rv) r.addEventListener('input', () => { rv.textContent = r.value; });
  const back = document.getElementById('cfBack');
  if (back) back.addEventListener('click', () => go('followup'));
  const keep = document.getElementById('cfKeep');
  if (keep) keep.addEventListener('click', () => saveCardFromForm());
  const cont = document.getElementById('cfContinue');
  if (cont) cont.addEventListener('click', () => { store.toast('我先在这里陪着你。'); go('say'); });
}

/** 从表单（可编辑的完整记录）保存卡片：标题默认场景文案，用户可改 */
async function saveCardFromForm() {
  const val = (id) => (document.getElementById(id) || {}).value || '';
  const split = (s) => s.split(/[、,，\/\s]+/).map((x) => x.trim()).filter(Boolean);
  const c = store.getState().draft.card || {};
  const edited = {
    ...c,
    title: val('f_title').trim(),
    event: val('f_event').trim(),
    emotion: split(val('f_emotion')),
    intensity: Number(val('f_intensity')) || 0,
    thought: val('f_thought').trim(),
    need: split(val('f_need')),
    behavior: val('f_behavior').trim(),
    experiment: val('f_experiment').trim(),
    tags: split(val('f_tags')),
  };
  await api.cardCreate(edited);
  asr.logEvent('card_saved', { intensity: edited.intensity, emotion_n: (edited.emotion || []).length, card_type: c.card_type });
  store.toast(pickIdx(COPY.cardDone));
  store.setHappy(4500); // v1.3.0：回到首页时 IP 开心一下（显式窗口，不靠 toast 触发）
  later(() => { if (store.getState().happyUntil) store.setState({ happyUntil: 0 }); render(); }, 4700); // 窗口结束收回开心，避免停在开心态
  go('say');
}

/* ---------------- 页面：情绪时间线卡片（v1.1.2） ----------------
 * 复盘载体：对话结束后生成，可视化「情绪本来就是流动、矛盾、来回摇摆的」。
 * 底线：不是心理评估、不打分，只做记录与呈现。 */

/** 柔和曲线路径：用三次贝塞尔（C）连接各节点，水平出入，像水流而非尖锐折线 */
/** 曲线几何：三次贝塞尔，水平出入 —— 页面曲线与导出海报共用同一份算法，保证两处长得一样 */
function timelineGeom(nodes, W = 320, H = 140, padX = 30, baseY = H / 2 + 6, amp = 18) {
  const list = Array.isArray(nodes) ? nodes : [];
  if (!list.length) return { xs: [], ys: [], d: '' };
  const n = list.length;
  const xs = list.map((_, i) => (n === 1 ? W / 2 : padX + (W - 2 * padX) * (i / (n - 1))));
  const ys = list.map((_, i) => (n === 1 ? baseY : baseY - amp * Math.sin((Math.PI * i) / Math.max(1, n - 1))));
  let d = `M ${xs[0].toFixed(1)} ${ys[0].toFixed(1)}`;
  for (let i = 1; i < n; i++) {
    const cx = ((xs[i - 1] + xs[i]) / 2).toFixed(1);
    d += ` C ${cx} ${ys[i - 1].toFixed(1)} ${cx} ${ys[i].toFixed(1)} ${xs[i].toFixed(1)} ${ys[i].toFixed(1)}`;
  }
  return { xs, ys, d };
}

function timelineCurve(list) {
  // 兜底：空节点直接不画（P0 防护，正常路径不该走到，但绝不让页面崩在这里）
  const nodes = Array.isArray(list) ? list : [];
  if (!nodes.length) return '';
  const W = 320, H = 140, padX = 30, baseY = H / 2 + 6, amp = 18;
  const { xs, ys, d } = timelineGeom(nodes, W, H, padX, baseY, amp);
  const dots = xs.map((x, i) => {
    const emo = (nodes[i].emotions && nodes[i].emotions.length) ? nodes[i].emotions[0] : '·';
    return `<circle class="tl-dot" cx="${x.toFixed(1)}" cy="${ys[i].toFixed(1)}" r="7"/>`
      + `<circle class="tl-dot--inner" cx="${x.toFixed(1)}" cy="${ys[i].toFixed(1)}" r="2.6"/>`
      + `<text x="${x.toFixed(1)}" y="${(ys[i] + 22).toFixed(1)}" text-anchor="middle">${esc(emo)}</text>`;
  }).join('');
  return `<svg class="tl-curve" viewBox="0 0 ${W} ${H}" role="img" aria-label="情绪时间线">
    <path d="${d}" stroke-linecap="round" stroke-linejoin="round"/>
    ${dots}
  </svg>`;
}

const TIMELINE_DISCLAIMER = '提示：这只是本次倾诉过程中情绪的简单记录，不是心理评估。情绪会随场景变化，仅供你自我看见。';

/** 底部按钮区：未保存 → 【保存卡片】【重新倾诉】；已保存 → 按钮变「已保存 ✓」并出现「保存为图片」 */
function timelineActions(tl) {
  const saved = !!(tl && tl.id);
  return `<div class="tl-btns">
    <button class="primary tl-save" id="tlSave" type="button"${saved ? ' disabled' : ''}>${saved ? '已保存 ✓' : '保存卡片'}</button>
    ${saved
      ? `<button class="ghost-btn tl-export" id="tlExport" type="button">保存为图片</button>`
      : `<button class="ghost-btn tl-restart" id="tlRestart" type="button">重新倾诉</button>`}
  </div>
  ${saved ? `<div class="tl-saveline">
    <button class="linkbtn" id="tlRestart" type="button">重新倾诉</button>
    <button class="linkbtn tl-del" id="tlDelete" type="button">删除这条记录</button>
  </div>` : ''}`;
}

/** 时间线正文（有情绪）：柔和曲线 + 节点说明 + 小结 + 微小停靠提示
 *  v1.2.1：优先渲染标准化 timeline_list（emotion_text 支持「喜悦 + 委屈」双情绪并列 + desc_text ≤15 字）；
 *          旧数据无 timeline_list 时回退到 legacy nodes。 */
function timelineBody(tl) {
  const nodes = tl.nodes || [];
  const list = (tl.timeline_list && tl.timeline_list.length)
    ? tl.timeline_list
    : (nodes || []).map((n, i) => ({
        node_index: i + 1,
        emotion_text: (n.emotions && n.emotions.length) ? n.emotions.join(' + ') : '（没捕捉到明显情绪）',
        desc_text: (n.text || ''),
      }));
  const rows = list.map((it) => {
    const emo = it.emotion_text || ((it.emotions && it.emotions.length) ? it.emotions.join(' + ') : '（没捕捉到明显情绪）');
    const no = it.node_index || '';
    const desc = (it.desc_text != null && it.desc_text !== '') ? it.desc_text : (it.text || '');
    const tail = (it.merged && it.count > 1) ? `　（后面 ${it.count} 轮合在这里）` : '';
    const dual = / \+ /.test(emo); // 双情绪并列节点（如「喜悦 + 委屈」）
    // v1.6.0 文档 §一.1：逐节点主题 + 高危标记（旧数据缺字段时兜底成紫，不炸）
    const nScore = it.emotion_score != null ? it.emotion_score : emotionScoreFor(it.emotions);
    const nRisk = !!it.is_high_risk;
    const nTheme = it.card_theme || cardThemeFor(nScore, nRisk);
    return `<div class="tl-node tl-node--${nTheme}${nRisk ? ' tl-node--risk' : ''}">
      // node_label：可选。月度复盘卡复用时间线结构，但它的节点是「高频情绪」不是「倾诉分段」，
      // 不给标签就会一律渲染成「第 1 段」，读起来像月度总结在分段。
      ${(it.node_label != null && it.node_label !== '') ? `<div class="tl-node__no">${esc(String(it.node_label))}</div>` : `<div class="tl-node__no">第 ${no} 段</div>`}
      <div class="tl-node__emo${dual ? ' tl-node__emo--dual' : ''}">${esc(emo)}</div>
      <div class="tl-node__cap">${esc(desc)}${tail}</div>
    </div>`;
  }).join('');
  const hint = tl.actionHint || {};
  const summaryTxt = tl.summary_text || tl.summary || '';
  const footer = tl.footer_note || TIMELINE_DISCLAIMER;
  // 整卡主题（v1.6.0）：紫/蓝/暖/灰；旧数据缺字段一律兜底成紫
  const theme = tl.card_theme || cardThemeFor(tl.emotion_score, tl.is_high_risk);
  const risk = !!tl.is_high_risk;
  return `
    <div class="tl-card tl-card--${theme}${risk ? ' tl-card--risk' : ''}" data-theme="${esc(theme)}" data-risk="${risk ? '1' : '0'}">
      <div class="tl-corner">${miniFace('empathy', 26)}</div>
      ${timelineCurve(nodes)}
      <div class="tl-nodes">${rows}</div>
      <div class="tl-summary">${esc(summaryTxt || '')}</div>
      ${hint.title ? `<div class="tl-hint">
        <div class="tl-hint__label">一个很小的停靠（不强制）</div>
        <div class="tl-hint__title">${esc(hint.title)}</div>
        <div class="tl-hint__step">${esc(hint.step || '')}</div>
        ${hint.note ? `<div class="tl-hint__note">${esc(hint.note)}</div>` : ''}
      </div>` : ''}
    </div>
    <p class="tl-disclaimer">${esc(footer)}</p>
    ${timelineActions(tl)}`;
}

/** 时间线正文（全程无情绪）：简化卡，只留一句说明 */
function timelineEmptyBody(tl) {
  const footer = tl.footer_note || TIMELINE_DISCLAIMER;
  return `
    <div class="tl-card tl-card--empty">
      <div class="tl-corner">${miniFace('idle', 26)}</div>
      <div class="tl-summary">${esc(tl.summary_text || tl.summary || '本次对话更多是陈述事件，没有捕捉到明显情绪')}</div>
    </div>
    <p class="tl-disclaimer">${esc(footer)}</p>
    ${timelineActions(tl)}`;
}

/** 支持 #/timeline?id=xxx 回看已保存的时间线（v1.1.2 补：否则存了永远看不到） */
function currentTimeline(p) {
  const id = (p && p.q && p.q.id) || '';
  const s = store.getState();
  if (id) return (s.timelines || []).find((t) => t.id === id) || null;
  return s.timeline;
}

function pageTimeline(p) {
  const tl = currentTimeline(p);
  if (!tl || !tl.type) {
    return `<section class="timeline"><div class="page-title center">情绪时间线</div>
      <div class="empty-state">${mascot('idle', 120)}<p>还没有可以回看的这一次倾诉。<br/>先回首页说一次吧。</p>
      <a class="primary small" href="#/say">去说一次</a></div></section>`;
  }
  const body = tl.type === 'no-emotion' ? timelineEmptyBody(tl) : timelineBody(tl);
  const when = tl.saved_at ? `　${esc(String(tl.saved_at).slice(0, 10))}` : '';
  return `
  <section class="timeline">
    <div class="page-title center">情绪时间线</div>
    <h2 class="tl-title">${esc(tl.card_title || (tl.id ? '深海情绪记录' : '本次深海情绪记录'))}</h2>
    <p class="tl-sub">${esc(tl.card_subtitle || '情绪本来就会起伏波动，没有好坏')}${when}</p>
    ${body}
  </section>`;
}

/* ==================== 月度情绪复盘（文档 §追加模块3）====================
 * 两个入口：①每月 1 号启动自动生成并弹窗；②设置页「生成本月情绪复盘」手动触发。
 * 🔴 硬约束：当月记录 < 3 条**不生成**，只给一句「记录还不够多」—— 不硬凑、不假称。
 * 🔴 已弹过的月份写进 localStorage（monthly:done），否则 1 号一天能弹八次。
 */
const MONTHLY_DONE_KEY = 'monthly:done';
const monthlyDone = (ym) => { try { return !!localStorage.getItem(MONTHLY_DONE_KEY + '_' + ym); } catch (e) { return false; } };
const monthlyMark = (ym) => { try { localStorage.setItem(MONTHLY_DONE_KEY + '_' + ym, String(Date.now())); } catch (e) {} };

/** 通用小弹窗（不是 confirm：复盘是「送给你看的东西」，不该长得像二次确认） */
function showMonthlyModal(opt) {
  const o = opt || {};
  const btns = (o.buttons || []).map(function (b, i) {
    return '<button class="' + (b.cls || 'ghost') + '" type="button" data-mi="' + i + '">' + esc(b.text) + '</button>';
  }).join('');
  const overlay = document.createElement('div');
  overlay.className = 'monthly-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.innerHTML =
    `<div class="monthly-card">` +
      `<div class="monthly-card__ip">${mascot(o.mood || 'empathy', 78)}</div>` +
      `<div class="monthly-card__title">${esc(o.title || '')}</div>` +
      `<div class="monthly-card__body">${o.body || ''}</div>` +
      `<div class="monthly-card__btns">${btns}</div>` +
    `</div>`;
  document.body.appendChild(overlay);
  overlay.querySelectorAll('[data-mi]').forEach((el) => {
    el.addEventListener('click', () => {
      const b = (o.buttons || [])[Number(el.getAttribute('data-mi'))] || {};
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (typeof b.act === 'function') b.act();
    });
  });
  const first = overlay.querySelector('[data-mi]');
  if (first) first.focus();
  return overlay;
}

/** 复盘卡 → 可渲染的 timeline 结构（复用时间线 UI，只换主题与字段） */
function monthlyCardView(rev) {
  const list = (rev.top_emotion_tags || []).map((t, i) => ({
    node_index: i + 1,
    emotion_text: t,
    desc_text: '',
    node_label: '高频情绪 ' + (i + 1),
  }));
  return {
    type: 'timeline',
    id: rev.card_id,
    saved_at: rev.create_time,
    card_title: rev.target_month + ' 月度情绪复盘',
    // 高频情绪交给节点显示（node_label），这里不重复一遍
    card_subtitle: '这个月你一共说了 ' + rev.record_count + ' 次',
    timeline_list: list,
    nodes: [],
    summary_text: rev.emotion_trend_desc || '',
    footer_note: TIMELINE_DISCLAIMER,
    emotion_trend_desc: rev.emotion_trend_desc || '',
    insight_text: rev.insight_text || '',
    monthly_tip: rev.monthly_tip || '',
    timeline_group: rev.timeline_group,
    is_high_risk: false,
    card_theme: rev.card_theme,
    actionHint: { title: '', step: '', note: '' },
  };
}

/** 生成并保存本月复盘；不足 minRecords 条时走「记录还不够多」提示 */
function generateMonthlyReview(opt) {
  const o = opt || {};
  const now = o.now || new Date();
  const ym = monthly.monthKey(now);
  const MC = COPY.monthly || {};
  const UI = MC.ui || {};
  const min = Number(MC.trigger && MC.trigger.minRecords) || 3;
  if (monthly.monthRecords(store.getState().timelines, ym).length < min) {
    if (!o.silent) {
      showMonthlyModal({
        title: UI.insTitle || '暂时无法生成月度复盘',
        body: '<p>' + esc(UI.insBody || '记录还不够多，再多记录一些心情，再来生成月度复盘') + '</p>',
        buttons: [{ text: UI.insBtn || '知道了', cls: 'primary small' }],
      });
    }
    return null;
  }
  if (monthlyDone(ym) && !o.force) return null; // 本月已经弹过（自动入口不该重复打扰）
  const rev = monthly.buildMonthlyReview(store.getState().timelines, { now });
  if (!rev) return null;
  const view = monthlyCardView(rev);
  const saved = store.addTimeline(view);
  // 🔴 addTimeline 会把 id 盖成时间戳；复盘卡要用业务 id（emo_month_202610），
  //    否则回看时按 id 找得到、导出与去重却对不上号。
  saved.id = rev.card_id;
  store.setState({ timeline: saved, route: '#/timeline' });
  const openIt = () => { try { go('#/timeline'); } catch (e) {} };
  showMonthlyModal({
    title: UI.autoTitle || '你的月度情绪复盘已生成✨',
    body: '<p>' + esc(rev.target_month) + '　记录 ' + rev.record_count + ' 条</p>' +
      (rev.insight_text ? '<p class="monthly-card__insight">' + esc(rev.insight_text) + '</p>' : ''),
    buttons: [
      { text: UI.autoSecondary || '稍后再看', cls: 'ghost', act: null },
      { text: UI.autoPrimary || '查看复盘', cls: 'primary small', act: openIt },
    ],
  });
  monthlyMark(ym);
  return rev;
}

/** 每月 1 号启动：自动生成一次复盘并弹窗（不是每天弹） */
function autoMonthlyReview() {
  try {
    if (!monthly.shouldAutoReview(new Date())) return;
    const ym = monthly.monthKey(new Date());
    if (monthlyDone(ym)) return;
    generateMonthlyReview({ force: true });
  } catch (e) { /* 复盘是锦上添花，任何异常都不许拖住启动 */ }
}

function bindMonthly() {
  const btn = document.getElementById('setMonthly');
  if (!btn) return;
  btn.addEventListener('click', () => { generateMonthlyReview({ force: true }); });
}
function bindTimeline(p) {
  const tl0 = currentTimeline(p);

  const save = document.getElementById('tlSave');
  if (save) save.addEventListener('click', async () => {
    const tl = currentTimeline(p);
    if (!tl || tl.id) return;               // 已保存过就不再重复存（v1.1.2：防连点存出 N 份）
    const full = await api.saveTimeline(tl);
    store.setState({ timeline: full });     // 让当前页立刻认领 id，按钮原地变「已保存 ✓」
    store.toast('已保存到本地，只有你能看到');
    render();
  });

  const exp = document.getElementById('tlExport');
  if (exp) exp.addEventListener('click', async () => {
    const tl = currentTimeline(p) || tl0;
    if (!tl) return;
    try {
      await exportTimelinePng(tl);
      store.toast('图片已生成，看看下载里');
    } catch (e) {
      store.toast('这台设备不支持直接导出，可以截屏保存');
    }
  });

  const del = document.getElementById('tlDelete');
  if (del) del.addEventListener('click', () => {
    const tl = currentTimeline(p);
    if (!tl || !tl.id) return;
    store.removeTimeline(tl.id);
    store.toast('已删除这条记录');
    go('timelines');
  });

  const restart = document.getElementById('tlRestart');
  if (restart) restart.addEventListener('click', () => { store.startSession(); go('say'); });
}

/* ---------------- 页面：时间线列表（已保存的复盘卡回看入口） ---------------- */

function pageTimelines() {
  const list = store.getState().timelines || [];
  if (!list.length) {
    return `<section class="timelines"><div class="page-head">
        <a class="ghost" href="#/me">返回</a><div class="page-title">情绪时间线</div><span style="width:48px"></span>
      </div>
      <div class="empty-state">${mascot('idle', 120)}<p>还没有保存过时间线。<br/>倾诉完点「结束倾诉」，就能存下这一次的起伏。</p>
      <a class="primary small" href="#/say">去说一次</a></div></section>`;
  }
  const rows = list.map((t) => {
    const emos = (t.nodes || []).map((n) => (n.emotions && n.emotions.length ? n.emotions.join('+') : '·'));
    const flow = t.type === 'no-emotion' ? '这次更多是陈述事件' : emos.join(' → ');
    return `<a class="tlrow" href="#/timeline?id=${esc(t.id)}">
      <span class="tlrow__ico">${ICON.timeline}</span>
      <span class="tlrow__txt">${esc(String(t.saved_at || '').slice(0, 10)) || '未标注时间'}
        <span class="tlrow__sub">${esc(flow)}</span></span>
      <i class="tlrow__arrow">›</i>
    </a>`;
  }).join('');
  return `
  <section class="timelines">
    <div class="page-head">
      <a class="ghost" href="#/me">返回</a><div class="page-title">情绪时间线</div><span style="width:48px"></span>
    </div>
    <p class="tl-note">这里只放你主动保存过的记录，全部存在这台设备上。</p>
    <nav class="tl-list">${rows}</nav>
    <p class="tl-disclaimer">${esc(TIMELINE_DISCLAIMER)}</p>
  </section>`;
}

/* ---------------- 时间线卡片导出为图片（零依赖：SVG → canvas → PNG） ---------------- */

/** 把卡片重绘成一张独立的 SVG 海报，用于导出 PNG（不依赖 html2canvas） */
function timelinePosterSvg(tl) {
  const W = 720, padX = 56;
  const textW = W - padX * 2;
  // 按字号估算每行可容纳的字符数（CJK 字宽≈字号），超出换行 —— SVG text 不自动折行
  const wrap = (s, size, maxLines = 4) => {
    const per = Math.max(8, Math.floor(textW / size));
    const lines = [];
    let cur = String(s || '');
    while (cur.length && lines.length < maxLines) {
      lines.push(cur.slice(0, per));
      cur = cur.slice(per);
    }
    if (cur.length) lines[lines.length - 1] = lines[lines.length - 1].slice(0, per - 1) + '…';
    return lines;
  };
  const textLines = (s, size, fill, y0, lineH) => wrap(s, size).map((l, i) =>
    `<text x="${padX}" y="${(y0 + i * lineH).toFixed(0)}" font-size="${size}" fill="${fill}" font-family="${F}">${esc(l)}</text>`
  ).join('');

  const nodes = tl.nodes || [];
  const curveH = 200;
  const rowH = 40;
  const nodesH = nodes.length * rowH;
  const hintH = (tl.actionHint && tl.actionHint.title) ? 118 : 0;
  const summaryLines = wrap(tl.summary || '', 26);
  const disclaimerLines = wrap(TIMELINE_DISCLAIMER, 19);
  const sumH = summaryLines.length * 38;
  const discH = disclaimerLines.length * 30;
  const H = 176 + sumH + 20 + curveH + nodesH + hintH + 40 + discH + 110;
  const F = "system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif";

  const geom = timelineGeom(nodes, textW, curveH, 40, curveH / 2 + 10, 34);
  const ox = padX, oy = 176 + sumH + 60;
  const path = geom.d ? `<path d="${geom.d}" transform="translate(${ox},${oy})" fill="none" stroke="#8B7BE8" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>` : '';
  const dots = geom.xs.map((x, i) => {
    const emo = (nodes[i].emotions && nodes[i].emotions.length) ? nodes[i].emotions[0] : '·';
    return `<circle cx="${(ox + x).toFixed(1)}" cy="${(oy + geom.ys[i]).toFixed(1)}" r="9" fill="#FFF" stroke="#8B7BE8" stroke-width="3"/>`
      + `<text x="${(ox + x).toFixed(1)}" y="${(oy + geom.ys[i] + 34).toFixed(1)}" text-anchor="middle" font-size="22" fill="#5B5470" font-family="${F}">${esc(emo)}</text>`;
  }).join('');

  const rowText = nodes.map((nd, i) => {
    const emo = (nd.emotions && nd.emotions.length) ? nd.emotions.join(' + ') : '（没捕捉到明显情绪）';
    return `<text x="${padX}" y="${(oy + curveH + 44 + i * rowH).toFixed(0)}" font-size="22" fill="#6B6482" font-family="${F}">第 ${i + 1} 段　${esc(emo)}</text>`;
  }).join('');

  const yHint = oy + curveH + 64 + nodesH;
  const hint = tl.actionHint || {};
  const hintSvg = hint.title ? `
    <text x="${padX}" y="${yHint}" font-size="20" fill="#9A93AE" font-family="${F}">一个很小的停靠（不强制）</text>
    <text x="${padX}" y="${yHint + 34}" font-size="23" fill="#4A4360" font-family="${F}">${esc(hint.title)}</text>
    ${textLines(hint.step || '', 20, '#6B6482', yHint + 70, 30)}` : '';

  const yDisc = yHint + hintH;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="${W}" height="${H}" fill="#F7F5FF"/>
    <text x="${padX}" y="96" font-size="38" font-weight="600" fill="#3D3654" font-family="${F}">${tl.id ? '深海情绪记录' : '本次深海情绪记录'}</text>
    <text x="${padX}" y="140" font-size="24" fill="#8A83A0" font-family="${F}">情绪本来就会起伏波动，没有好坏</text>
    ${textLines(tl.summary || '', 26, '#5B5470', 186, 38)}
    ${path}${dots}${rowText}${hintSvg}
    ${textLines(TIMELINE_DISCLAIMER, 19, '#A29BB6', yDisc + 30, 30)}
  </svg>`;
}

async function exportTimelinePng(tl) {
  const svg = timelinePosterSvg(tl);
  const w = Number((svg.match(/width="(\d+)"/) || [])[1]) || 720;
  const h = Number((svg.match(/height="(\d+)"/) || [])[1]) || 900;
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const scale = 2;
    const cv = document.createElement('canvas');
    cv.width = w * scale; cv.height = h * scale;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#F7F5FF';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
    if (!blob) throw new Error('toBlob failed');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `墨小溟-情绪时间线-${new Date().toISOString().slice(0, 10)}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ---------------- 页面：卡片列表 ---------------- */

function pageCards() {
  const cards = store.getState().cards;
  if (!cards.length) {
    return `<section class="cards"><div class="page-title center">卡片</div>
      <div class="empty-state">
        ${mascot('idle', 128)}
        <p>你的情绪卡片会出现在这里。<br/>先回首页说一次吧。</p>
        <div class="ghost-card" aria-hidden="true">
          <div class="ghost-card__face">${miniFace('empathy', 34)}</div>
          <div class="ghost-card__bar ghost-card__bar--t"></div>
          <div class="ghost-card__bar ghost-card__bar--s"></div>
          <div class="ghost-card__tags">
            <span class="ghost-card__tag"></span>
            <span class="ghost-card__tag ghost-card__tag--o"></span>
            <span class="ghost-card__tag ghost-card__tag--b"></span>
          </div>
          <p class="ghost-card__note">以后这里会是一张卡片</p>
        </div>
        <a class="primary small" href="#/say">去说一次</a>
      </div></section>`;
  }
  return `<section class="cards">
    <div class="page-title center">卡片 · 共 ${cards.length} 张</div>
    <div class="card-list">
      ${cards.map((c) => `
        <a class="mcard" href="#/card/${esc(c.id)}">
          <div class="mcard__face">${miniFace(c.ip_state || 'empathy', 30)}</div>
          <div class="mcard__main">
            <div class="mcard__date">${fmtDate(c.created_at)}</div>
            <div class="mcard__title">${esc(c.title || c.event || '一张情绪卡片')}</div>
            <div class="mcard__tags">${(c.emotion || []).map((e) => `<span class="tag">${esc(e)}</span>`).join('')}<span class="tag tag--i">强度 ${esc(c.intensity)}</span></div>
          </div>
        </a>`).join('')}
    </div>
  </section>`;
}

/* ---------------- 页面：卡片详情 ---------------- */

function pageCardDetail(p) {
  const c = store.getCard(p.param);
  if (!c) return `<section class="center-stage"><div class="stage-copy">这张卡片找不到了</div><a class="linkbtn" href="#/cards">回到卡片列表</a></section>`;
  const kv = (k, v) => v ? `<div class="kv"><span>${k}</span><b>${esc(v)}</b></div>` : '';
  return `
  <section class="detail">
    <div class="page-head">
      <button class="ghost" id="dBack" type="button">返回</button>
      <div class="page-title">情绪卡片</div>
      <span style="width:48px"></span>
    </div>
    <div class="detail-card catch-in">
      <div class="dc__face">${mascot(c.ip_state || 'empathy', 100)}</div>
      <div class="dc__date">${fmtDateTime(c.created_at)}</div>
      <h2 class="dc__title">${esc(c.title || c.event || '一张情绪卡片')}</h2>
      <div class="dc__tags">${(c.emotion || []).map((e) => `<span class="tag">${esc(e)}</span>`).join('')}<span class="tag tag--i">强度 ${esc(c.intensity)}/10</span></div>
      ${(c.tags || []).length ? `<div class="dc__tags" style="margin-top:8px">${c.tags.map((t) => `<span class="tag tag--soft">#${esc(t)}</span>`).join('')}</div>` : ''}
    </div>
    <div class="detail-body">
      ${kv('触发事件', c.event)}
      ${kv('身体感受', (c.body || []).join('、'))}
      ${kv('脑中想法', c.thought)}
      ${kv('深层需求', (c.need || []).join('、'))}
      ${kv('行为与结果', [c.behavior, c.result].filter(Boolean).join(' → '))}
      ${kv('重复的模式', c.pattern)}
      ${kv('下次实验', c.experiment)}
    </div>
    ${c.summary ? `<div class="voice-box"><div class="voice-label">墨小溟说</div><p>${esc(c.summary)}</p></div>` : ''}
  </section>`;
}

function bindCardDetail() {
  const b = document.getElementById('dBack');
  if (b) b.addEventListener('click', () => go('cards'));
}

/* ---------------- 页面：周报 ---------------- */

function pageWeekly() {
  return `<section class="weekly" id="weeklyRoot"><div class="loading"><span class="spinner"></span>正在整理这一周……</div></section>`;
}

function mountWeekly() {
  (async () => {
    const root0 = document.getElementById('weeklyRoot');
    if (!root0) return;
    let r;
    try {
      r = await api.reportWeekly();
    } catch (e) {
      // 周报失败也不能停在「正在整理这一周……」——降级为本地聚合结果
      const { weeklyReport } = await import('./ai.js');
      r = weeklyReport(store.getState().cards);
    }
    const root = document.getElementById('weeklyRoot');
    if (!root) return;
    const rows = (arr, fmt, emptyTxt) => (arr && arr.length && arr.some((x) => (x.count == null ? true : x.count)))
      ? arr.map((x) => `<li><span>${esc(fmt(x))}</span>${x.count ? `<b>${x.count} 次</b>` : '<b>—</b>'}</li>`).join('')
      : `<li class="muted">${emptyTxt}</li>`;
    root.innerHTML = `
      <div class="page-title center">本周情绪体检</div>
      <div class="wk-note">${esc(r.week_start)} ~ ${esc(r.week_end)} · 共 ${esc(r.cards_count)} 张卡片</div>
      <div class="wk-block wk-block--lead">
        <div class="wk-label">本周概览</div>
        <p class="wk-headline">${esc(r.headline)}</p>
        <p>${esc(r.summary)}</p>
      </div>
      <div class="wk-block"><div class="wk-label">Top 3 触发点</div><ul class="wk-list">${rows(r.top_triggers, (x) => `${x.trigger}${x.emotion ? `（${x.emotion}）` : ''}`, '本周还没有足够的触发点')}</ul></div>
      <div class="wk-block"><div class="wk-label">最常出现的人 / 场景</div><ul class="wk-list">${rows(r.top_people, (x) => `${x.person}${x.avg_intensity ? `（均强 ${x.avg_intensity}）` : ''}`, '暂未识别到明显的人或场景')}</ul></div>
      <div class="wk-block"><div class="wk-label">可能的关联</div>${(r.correlations || []).length
        ? `<ul class="wk-corrs">${r.correlations.map((x) => `<li><b>${esc(x.factor)}</b><span>${esc(x.observation)}</span></li>`).join('')}</ul>`
        : '<ul class="wk-list"><li class="muted">样本还少，暂未看出稳定关联</li></ul>'}</div>
      <div class="wk-block"><div class="wk-label">哪种应对方式有效</div>${(r.effective_coping || []).length
        ? `<ul class="wk-corrs">${r.effective_coping.map((x) => `<li><b>${esc(x.action)}</b><span>${esc(x.result || '')}</span></li>`).join('')}</ul>`
        : '<ul class="wk-list"><li class="muted">还没有记录到明显的有效应对</li></ul>'}</div>
      <div class="wk-block wk-block--action"><div class="wk-label">下周一个实验</div><p>${esc(r.experiment)}</p></div>
      <div class="voice-box"><div class="voice-label">墨小溟说</div><p>${esc(pickIdx(COPY.weeklyClosing))}</p></div>`;
  })();
}

/* ---------------- 页面：我 ---------------- */

function pageMe() {
  const s = store.getState();
  const st = s.user.settings;
  const M = cw.ME_COPY;
  return `
  <section class="me">
    <header class="me-head2">
      <div class="me__face">${avatar('idle', 62)}</div>
      <h1 class="me__title2">${esc(M.title)}</h1>
      <p class="me__sub2">${esc(M.subtitle)}</p>
    </header>

    <div class="mblock">
      <div class="mblock__t">${esc(M.overview.title)}</div>
      <p class="mblock__d">${esc(M.overview.desc)}</p>
      <a class="mrow mrow--cards" href="#/cards">
        <span class="mrow__ico">${ICON.cards}</span>
        <span class="mrow__txt">${esc(M.overview.button)}<span class="mrow__sub">${s.cards.length ? `共 ${s.cards.length} 张` : '还没有卡片，去说一次吧'}</span></span>
        <i class="mrow__arrow">›</i>
      </a>
      <a class="mrow mrow--weekly" href="#/weekly">
        <span class="mrow__ico">${ICON.weekly}</span>
        <span class="mrow__txt">本周情绪体检<span class="mrow__sub">看看这周的情绪走向</span></span>
        <i class="mrow__arrow">›</i>
      </a>
      <a class="mrow mrow--timelines" href="#/timelines">
        <span class="mrow__ico">${ICON.timeline}</span>
        <span class="mrow__txt">情绪时间线<span class="mrow__sub">${(s.timelines || []).length ? `已保存 ${s.timelines.length} 次倾诉的起伏` : '还没有保存过'}</span></span>
        <i class="mrow__arrow">›</i>
      </a>
      <p class="mblock__n">${esc(M.overview.note)}</p>
    </div>

    <div class="mblock">
      <div class="mblock__t">${esc(M.memory.title)}</div>
      <p class="mblock__d">${esc(M.memory.viewDesc)}</p>
      <a class="mrow mrow--memory" href="#/memory">
        <span class="mrow__ico">${ICON.memory}</span>
        <span class="mrow__txt">${esc(M.memory.viewBtn)}<span class="mrow__sub">可编辑、可删除单条</span></span>
        <i class="mrow__arrow">›</i>
      </a>
      <label class="switch">
        <span>${esc(M.memory.toggle)}</span>
        <input type="checkbox" id="meMemory" ${st.memory_on !== false ? 'checked' : ''}/>
      </label>
      <p class="mblock__n">${esc(M.memory.toggleDesc)}</p>
      <button class="danger-link" id="meClearMemory" type="button">清空全部记忆</button>
    </div>

    <div class="mblock">
      <div class="mblock__t">${esc(M.settingsTitle)}</div>
      <a class="mrow mrow--settings" href="#/settings">
        <span class="mrow__ico">${ICON.settings}</span>
        <span class="mrow__txt">互动设置<span class="mrow__sub">触碰动画 / 气泡 / 强度 / 音效</span></span>
        <i class="mrow__arrow">›</i>
      </a>
      <label class="switch">
        <span>${esc(M.notify.toggle)}</span>
        <input type="checkbox" id="meNotify" ${st.notify_on ? 'checked' : ''}/>
      </label>
      <p class="mblock__n">${esc(M.notify.desc)}</p>
    </div>

    <div class="mblock">
      <div class="mblock__t">${esc(M.storage.title)}</div>
      <button class="ghost me-export" id="meExport" type="button">${esc(M.storage.exportBtn)}</button>
      <p class="mblock__n">${esc(M.storage.exportDesc)}</p>
      <button class="danger-link" id="meClearCards" type="button">${esc(M.storage.clearBtn)}</button>
    </div>

    <div class="mblock mblock--quiet">
      <div class="mblock__t">${esc(M.boundary.title)}</div>
      <p class="mblock__n">${esc(M.boundary.text)}</p>
    </div>

    <div class="mblock">
      <div class="mblock__t">${esc(M.support.title)}</div>
      <a class="mrow mrow--support" href="#/risk">
        <span class="mrow__ico">${ICON.support}</span>
        <span class="mrow__txt">紧急心理热线<span class="mrow__sub">需要时，请优先联系专业支持</span></span>
        <i class="mrow__arrow">›</i>
      </a>
      ${M.support.faq.map((f) => `<details class="faq"><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('')}
    </div>

    <div class="mblock">
      <div class="mblock__t">${esc(M.about.title)}</div>
      <p class="mblock__n">${esc(M.about.text)}</p>
    </div>

    <div class="mblock">
      <div class="mblock__t">${esc(M.legal.title)}</div>
      <p class="mblock__n">${esc(M.legal.text)}</p>
      <a class="mrow mrow--about" href="#/changelog">
        <span class="mrow__ico">${ICON.about}</span>
        <span class="mrow__txt">用户协议 / 隐私政策<span class="mrow__sub">版本与更新历史</span></span>
        <i class="mrow__arrow">›</i>
      </a>
    </div>

    <div class="mblock">
      <button class="danger" id="wipe" type="button">清除本地数据</button>
      <p class="mblock__n">${esc(M.wipe.confirm)}</p>
    </div>

    <p class="foot-note">墨小溟不会诊断，也不是心理医生。<br/>它只是陪你把心事说出来。</p>
  </section>`;
}

function bindMe() {
  const mem = document.getElementById('meMemory');
  if (mem) mem.addEventListener('change', () => store.setSetting('memory_on', mem.checked));
  // v1.4.1：这个开关以前只 store.setSetting 一下就完了 —— 存了值，但全仓没人读它，
  // 拨动它什么都不会发生。现在真的同步到系统通知；环境不支持时也要给用户明确回话，
  // 并把开关拨回去，绝不留一个"开了但没生效"的假象。
  const nt = document.getElementById('meNotify');
  if (nt) {
    nt.addEventListener('change', async () => {
      const on = nt.checked;
      store.setSetting('notify_on', on);
      const r = await notify.sync(on);
      if (r.ok) {
        store.toast(r.action === 'scheduled' ? `好，每晚 ${r.hour} 点左右轻轻问候你` : '已关闭轻提醒');
      } else {
        // 失败就把开关拨回原状：不让 UI 显示"已开启"而实际没有
        nt.checked = !on;
        store.setSetting('notify_on', !on);
        store.toast(r.reason === 'permission_denied' ? '需要允许通知权限才能提醒你' : '当前设备暂时不支持轻提醒');
      }
    });
    // 渲染完再确认一次环境：不支持就地禁用并说明，别让人白拨一次。
    notify.isSupported().then((ok) => {
      if (ok || !nt.isConnected) return;
      nt.disabled = true;
      const desc = document.querySelector('#meNotify') && nt.closest('.mblock')
        ? nt.closest('.mblock').querySelector('.mblock__n') : null;
      if (desc) desc.textContent = '当前环境不支持轻提醒（需安装 App 后使用）。';
    }).catch(() => {});
  }
  const cm = document.getElementById('meClearMemory');
  if (cm) cm.addEventListener('click', async () => {
    if (!window.confirm(cw.ME_COPY.memory.clearAll)) return;
    try { await memory.clearMemory(); } catch (e) { /* ignore */ }
    store.toast('已清空全部记忆');
  });
  const ex = document.getElementById('meExport');
  if (ex) ex.addEventListener('click', exportAllData);
  const cc = document.getElementById('meClearCards');
  if (cc) cc.addEventListener('click', () => {
    if (!window.confirm(cw.ME_COPY.storage.clearConfirm)) return;
    store.clearCards();
    store.toast('已清除全部卡片');
    render();
  });
  const wipe = document.getElementById('wipe');
  if (wipe) wipe.addEventListener('click', async () => {
    if (window.confirm(cw.ME_COPY.wipe.confirm)) { await api.userDataDelete(); store.toast('已删除全部数据'); go('say'); }
  });
}

/** v1.3.4：导出全部情绪记录为 JSON（本地下载，不上传） */
function exportAllData() {
  try {
    const s = store.getState();
    const payload = { exported_at: new Date().toISOString(), cards: s.cards || [], timelines: s.timelines || [] };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `墨小溟-情绪记录-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); if (a.parentNode) a.parentNode.removeChild(a); }, 300);
    store.toast('已导出情绪记录');
  } catch (e) { store.toast('导出失败'); }
}

/* ---------------- 页面：设置与隐私 ---------------- */

/** 设置页用：把当前 AI 通道说人话（不暴露任何服务端信息） */
function aiChannelText() {
  const s = api.aiStatus();
  if (s.provider === 'mock') return '本地规则引擎（当前没连模型，功能不受影响）。';
  const called = s.ok ? `本次已成功调用 ${s.ok} 次` : '等待首次调用';
  return `云服务免密钥模型：${s.model || '按可用列表自动选择'}，${called}。`;
}

function pageSettings() {
  const st = store.getState().user.settings;
  return `
  <section class="settings">
    <div class="page-head"><a class="ghost" href="#/me">返回</a><div class="page-title">设置与隐私</div><span style="width:48px"></span></div>
    <div class="set-block">
      <label class="switch">
        <span>允许把录音发给云端转写</span>
        <input type="checkbox" id="setCloudAsr" ${st.cloudAsr !== false ? 'checked' : ''}/>
      </label>
      <p class="set-sub">开启后，录音会上传到墨小溟的服务端、由专业云端识别转成文字，转写完成后不会留存音频。关闭后不再上传任何录音，改用浏览器本地识别或打字。</p>
    </div>
    <div class="set-block">
      <label class="switch">
        <span>允许墨小溟记住我说过的事</span>
        <input type="checkbox" id="setMemory" ${(st.memory_on !== false) ? 'checked' : ''}/>
      </label>
      <p class="set-sub">开启后，墨小溟会记下你倾诉中出现的「人物 / 事件 / 心结」结构化摘要（不保存原话），下次开口时轻轻呼应。关闭后不再新增与召回，已存记忆可到「我的记忆」里管理或删除。</p>
    </div>
    <div class="set-block">
      <div class="set-title">IP 情绪动效</div>
      <label class="switch">
        <span>开启 IP 情绪动效</span>
        <input type="checkbox" id="setIpMotion" ${st.ipMotion !== false ? 'checked' : ''}/>
      </label>
      <p class="set-sub">关掉后，墨小溟停止所有色彩、动画与背景水墨特效，只留安静的静态形象（适合低电量或光敏敏感时一键关闭）。</p>
      <label class="switch">
        <span>IP 触碰互动（点击 / 长按）</span>
        <input type="checkbox" id="setIpTouch" ${st.ipTouch !== false ? 'checked' : ''}/>
      </label>
      <label class="switch">
        <span>气泡文字</span>
        <input type="checkbox" id="setIpBubble" ${st.ipBubble !== false ? 'checked' : ''}/>
      </label>
      <p class="set-sub">关闭「触碰互动」后，点墨小溟不再有任何动画或气泡；关闭「气泡文字」仅保留动画、不显示文字。</p>
      <div class="seg" id="setIpIntensity">
        <span class="seg__label">动画强度</span>
        <div class="seg__opts">
          <button type="button" data-v="gentle" class="${st.ipIntensity === 'gentle' ? 'seg--on' : ''}">柔和</button>
          <button type="button" data-v="standard" class="${st.ipIntensity === 'standard' ? 'seg--on' : ''}">标准</button>
        </div>
      </div>
      <label class="switch">
        <span>水墨 / 气泡轻音效</span>
        <input type="checkbox" id="setSound" ${st.soundOn ? 'checked' : ''}/>
      </label>
      <p class="set-sub">独立开关，默认开启：情绪变化、接收、点墨小溟、生成卡片时会有极轻的水墨 / 气泡合成音，首屏还有一层几乎听不见的水底底噪（你说第一句话时会自动让位）。不依赖任何音频素材文件，想安静随时关掉。</p>
    </div>
    <div class="set-block">
      <div class="set-title">月度情绪复盘</div>
      <p class="set-sub">每个月 1 号会自动为你汇总上个月的心情记录，生成一张月度复盘卡。现在也可以自己看一眼本月。</p>
      <button class="primary small" id="setMonthly" type="button">生成本月情绪复盘</button>
    </div>
    <div class="set-block">
      <div class="set-title">数据安全</div>
      <p class="set-sub">录音只用于这一次转写：音频会发到墨小溟自己的服务端，由专业云端识别转成文字，转写完成后不做留存。转写出的文字会经加密通道发送给大模型（第三方 AI 服务）进行处理，用于生成这一次的分析、追问与卡片。墨小溟不做账号与身份绑定，不要求你提供姓名、手机号或地址。卡片、草稿与设置只存在本机浏览器，可随时一键删除。</p>
    </div>
    <div class="set-block">
      <div class="set-title">AI 通道</div>
      <p class="set-sub">${esc(aiChannelText())}</p>
      <a class="ghost set-diaglink" href="#/diag">查看链路诊断日志 →</a>
    </div>
    <div class="set-block">
      <div class="set-title">一键删除全部数据</div>
      <p class="set-sub">删除后不可恢复：所有卡片、草稿与设置将被清空。</p>
      <button class="danger" id="wipe" type="button">删除全部数据</button>
    </div>
    <div class="set-block">
      <div class="set-title">重要声明</div>
      <p class="set-sub">${esc(COPY.about.disclaimer)}</p>
    </div>
    <div class="privacy-box">
      <div class="privacy__title">${esc((COPY.privacyFull || {}).title || '隐私说明')}</div>
      <p class="privacy__line privacy__meta" data-privacy="updated">${esc((COPY.privacyFull || {}).updated || '')}</p>
      ${((COPY.privacyFull || {}).sections || []).map((s) => {
        if (!s || !s.t) return '';
        return `<div class="privacy__sec" data-privacy="${esc(s.k || '')}">
          <div class="privacy__h">${esc(s.h || '')}</div>
          <p class="privacy__line">${esc(s.t)}</p>
        </div>`;
      }).join('')}
      ${(privacyLink((COPY.privacyFull || {}).link))}
    </div>
    <p class="foot-note">墨小溟 MVP · v${esc(window.APP_VERSION || '1.6.11')}</p>
  </section>`;
}

/* 隐私说明里的反馈入口：必须是**真实可达**的地址。
 * 文档 §7 写的是「App 内帮助通道」，但 App 里没有这个入口 —— 写进去就是个空头承诺，
 * 对隐私说明来说，空头入口比不留入口更伤信任（同「死开关比没开关更糟」）。 */
function privacyLink(link) {
  if (!link || !link.href) return '';
  return `<a class="privacy__link" href="${esc(link.href)}" target="_blank" rel="noopener noreferrer">${esc(link.label || link.href)}</a>`;
}

function bindSettings() {
  // v0.5.0：原来的「分析后自动删除录音」是个死开关 —— 它只写进 store，没有任何地方读，
  // 无论开关状态录音都不会被保存在任何地方。对一个主打"敢说真话"的产品，
  // 一个不起作用的隐私开关比没有开关更糟，所以这里换成真正生效的控制：
  // 关掉就不再上传录音（endCapture 会读这个设置）。
  // v1.6.2 月度情绪复盘：设置页手动入口（挂在 bindSettings，和其余设置开关一起绑）
  try { bindMonthly(); } catch (e) { /* 复盘按钮挂了不该连累其他设置项 */ }
  const cb = document.getElementById('setCloudAsr');
  if (cb) cb.addEventListener('change', () => store.setSetting('cloudAsr', cb.checked));
  const mem = document.getElementById('setMemory');
  if (mem) mem.addEventListener('change', () => store.setSetting('memory_on', mem.checked));
  // v1.3.0 IP 情绪动效三个开关
  const ipMotion = document.getElementById('setIpMotion');
  if (ipMotion) ipMotion.addEventListener('change', () => { store.setSetting('ipMotion', ipMotion.checked); document.body.classList.toggle('ip-motion-off', !ipMotion.checked); if (window.motion) window.motion.setEnabled(ipMotion.checked); });
  const ipInt = document.getElementById('setIpIntensity');
  if (ipInt) ipInt.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    const v = b.dataset.v;
    store.setSetting('ipIntensity', v);
    ipInt.querySelectorAll('button').forEach((x) => x.classList.toggle('seg--on', x === b));
    document.body.classList.toggle('ip-intensity-gentle', v === 'gentle');
    if (window.motion) window.motion.setIntensity(v);
  }));
  const snd = document.getElementById('setSound');
  if (snd) snd.addEventListener('change', () => { store.setSetting('soundOn', snd.checked); if (window.ipAudio) window.ipAudio.setEnabled(snd.checked); });
  const ipTouch = document.getElementById('setIpTouch');
  if (ipTouch) ipTouch.addEventListener('change', () => store.setSetting('ipTouch', ipTouch.checked));
  const ipBubble = document.getElementById('setIpBubble');
  if (ipBubble) ipBubble.addEventListener('change', () => store.setSetting('ipBubble', ipBubble.checked));
  const wipe = document.getElementById('wipe');
  if (wipe) wipe.addEventListener('click', async () => {
    if (window.confirm('确定删除全部数据吗？此操作不可恢复。')) {
      await api.userDataDelete();
      store.toast('已删除全部数据');
      go('say');
    }
  });
}

/* ---------------- 页面：我的记忆（V1.1 记忆地基 / app v1.3.0） ---------------- */

let _memUnits = [];

function pageMemory() {
  const on = (store.getState().user.settings.memory_on) !== false;
  return `
  <section class="memory">
    <div class="page-head"><a class="ghost" href="#/me">返回</a><div class="page-title">我的记忆</div><span style="width:48px"></span></div>
    ${on ? `
      <p class="set-sub">墨小溟只记下你说过的「人物 / 事件 / 心结」结构化摘要，不保存原话，存在本机、可随时编辑或删除。下次开口会轻轻呼应相关的记忆。</p>
      <div id="memList" class="mem-list">加载中……</div>
    ` : `
      <p class="set-sub">记忆功能已关闭。开启后，墨小溟会在你倾诉时记下结构化摘要，并在之后轻轻呼应。已存的记忆不会被删除，只是不再新增与召回。</p>
      <div id="memList" class="mem-list"></div>
    `}
  </section>`;
}

const MEM_TAG = { person: '人物', event: '事件', knot: '心结' };

function memRow(u) {
  const tag = MEM_TAG[u.type] || '记忆';
  const emo = (u.emotion_tags || []).map((e) => `<span class="mem-tag">${esc(e)}</span>`).join('');
  const date = fmtDate(u.created_at);
  return `
  <div class="mem-row" data-mem="${esc(u.id)}">
    <div class="mem-row__top">
      <span class="mem-type mem-type--${esc(u.type)}">${tag}</span>
      <button class="mem-star ${u.important ? 'is-on' : ''}" data-act="star" type="button" title="标记重要">${u.important ? '★' : '☆'}</button>
    </div>
    <div class="mem-title">${esc(u.title)}</div>
    ${u.summary ? `<div class="mem-summary">${esc(u.summary)}</div>` : ''}
    <div class="mem-meta">${emo}<span class="mem-date">${date}</span></div>
    <div class="mem-acts">
      <button class="linkbtn" data-act="edit" type="button">编辑</button>
      <button class="linkbtn danger-link" data-act="del" type="button">删除</button>
    </div>
  </div>`;
}

function renderMemList() {
  const list = document.getElementById('memList');
  if (!list) return;
  if (!_memUnits.length) { list.innerHTML = '<p class="mem-empty">还没有记下任何记忆。去说一次，墨小溟会慢慢认识你。</p>'; return; }
  const sorted = [..._memUnits].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  list.innerHTML = sorted.map(memRow).join('') + '<div class="mem-foot"><button class="danger small" id="memClear" type="button">清空全部记忆</button></div>';
  sorted.forEach(bindMemRow);
}

function bindMemRow(u) {
  const row = document.querySelector('.mem-row[data-mem="' + CSS.escape(u.id) + '"]');
  if (!row) return;
  const star = row.querySelector('[data-act="star"]');
  if (star) star.onclick = async () => {
    await memory.markMemoryImportant(u.id, !u.important);
    u.important = !u.important;
    renderMemList();
  };
  const del = row.querySelector('[data-act="del"]');
  if (del) del.onclick = async () => {
    if (window.confirm('删除这条记忆吗？删除后不可恢复。')) {
      await memory.deleteMemory(u.id);
      _memUnits = _memUnits.filter((x) => x.id !== u.id);
      renderMemList();
    }
  };
  const edit = row.querySelector('[data-act="edit"]');
  if (edit) edit.onclick = () => openMemEdit(row, u);
}

function openMemEdit(row, u) {
  row.innerHTML = `
    <div class="mem-edit">
      <input class="mem-edit-title" type="text" value="${esc(u.title)}" maxlength="60" placeholder="标题"/>
      <textarea class="mem-edit-summary" maxlength="200" placeholder="摘要（可选）">${esc(u.summary || '')}</textarea>
      <div class="mem-edit-acts">
        <button class="linkbtn" data-act="cancel" type="button">取消</button>
        <button class="primary small" data-act="save" type="button">保存</button>
      </div>
    </div>`;
  row.querySelector('[data-act="cancel"]').onclick = () => renderMemList();
  row.querySelector('[data-act="save"]').onclick = async () => {
    const title = row.querySelector('.mem-edit-title').value.trim();
    const summary = row.querySelector('.mem-edit-summary').value;
    if (!title) { store.toast('标题不能为空'); return; }
    await memory.editMemory(u.id, { title, summary });
    Object.assign(u, { title, summary, user_edited: true });
    renderMemList();
    store.toast('已保存');
  };
}

async function bindMemory() {
  const list = document.getElementById('memList');
  if (!list) return;
  if ((store.getState().user.settings.memory_on) === false) { list.innerHTML = ''; return; }
  try { _memUnits = await memory.loadMemory(); } catch (e) { _memUnits = []; }
  renderMemList();
  const clear = document.getElementById('memClear');
  if (clear) clear.onclick = async () => {
    if (window.confirm('清空全部记忆吗？此操作不可恢复，已存记忆会被删除。')) {
      await memory.clearMemory();
      _memUnits = [];
      renderMemList();
    }
  };
}

/* ---------------- 页面：关于墨小溟 / 更新历史 ---------------- */

function pageChangelog() {
  return `
  <section class="changelog">
    <div class="page-head"><a class="ghost" href="#/me">返回</a><div class="page-title">关于墨小溟</div><span style="width:48px"></span></div>
    <div class="changelog__ip">${avatar('happy', 64)}</div>
    <div class="changelog__ver">当前版本 v${esc(window.APP_VERSION || '1.6.11')}</div>
    <div class="about-persona">${esc(COPY.about.persona)}</div>
    <p class="changelog__desc">${esc(COPY.about.intro)}</p>
    <p class="changelog__desc">${esc(COPY.about.pronunciation)}</p>
    <div class="disclaimer-box">${esc(COPY.about.disclaimer)}</div>
    <div class="changelog__list" id="clList"><p class="set-sub">正在加载更新历史…</p></div>
    <button class="primary" id="clCheck" type="button">检查更新</button>
    ${isNativeApp() ? '' : '<a class="cl-dl" id="clDl" href="/apk/xiaoting-latest.apk" download>下载安卓安装包（.apk）</a>'}
    <button class="ghost" id="clExport" type="button">导出本地行为数据</button>
    <p class="foot-note">墨小溟 · v${esc(window.APP_VERSION || '1.6.11')}</p>
  </section>`;
}

async function bindChangelog() {
  const el = document.getElementById('clList');
  try {
    const data = await update.fetchHistory();
    const versions = (data && data.versions) || [];
    if (!versions.length) {
      el.innerHTML = '<p class="set-sub">暂无更新历史。</p>';
    } else {
      el.innerHTML = versions.map((v) => `
        <div class="cl-item">
          <div class="cl-item__head"><b>v${esc(v.version)}</b><span>${esc(v.date || '')}</span></div>
          ${v.title ? `<div class="cl-item__title">${esc(v.title)}</div>` : ''}
          <ul class="cl-item__notes">${(v.notes || []).map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
        </div>`).join('');
    }
  } catch (e) {
    // v1.1.10：网络拉取失败不再报生硬「加载失败」，改为温柔提示，并保留下方「检查更新」按钮可手动重试。
    // v1.2.1 攻坚·战役三：降级文案统一为「深海信号微弱，请检查网络再试」，把"失败感"从"产品坏了"改写成"网络问题"。
    el.innerHTML = '<p class="set-sub">深海信号微弱，请检查网络再试。</p>';
  }
  const check = document.getElementById('clCheck');
  if (check) check.addEventListener('click', async () => {
    // 🔴 v1.4.0：手动检查**必须永远有回话**。
    //   起因：原先这里是 `update.checkUpdate({manual:true}).catch(()=>{})`，
    //   而 checkUpdate 在「已是最新版」时只返回 {reason:'no_update'} —— 没有 else 分支，
    //   于是用户点了「检查更新」页面**一字不变**，体感就是"更新功能坏了/连不上"。
    //   实测接口其实是通的（/version.json 三通道 200 + 合法 JSON），坏的是"没有回话"。
    //   现在：检查中 → 结果行（含真实错误原因与耗时，可直接截图）→ 恢复按钮。
    const old = check.textContent;
    check.disabled = true;
    check.textContent = '检查中…';
    let res = document.getElementById('clCheckResult');
    if (!res) {
      res = document.createElement('p');
      res.id = 'clCheckResult';
      res.className = 'set-sub cl-check__result';
      check.insertAdjacentElement('afterend', res);
    }
    res.dataset.state = 'pending';
    res.textContent = '正在连接线上版本清单…';
    const t0 = Date.now();
    try {
      const r = await update.checkUpdate({ manual: true });
      const d = update.describeCheckResult(r);
      const ms = Date.now() - t0;
      res.dataset.state = d.ok ? 'ok' : 'fail';
      res.textContent = (d.ok ? '✓ ' : '✗ ') + d.text + `（${ms}ms）`;
      diag.note('update', d.ok ? 'manual_check_ok' : 'manual_check_fail',
        d.ok ? { ok: true, ms, detail: d.text } : { ok: false, ms, code: 'fetch_failed', detail: d.text });
    } catch (e) {
      res.dataset.state = 'fail';
      res.textContent = '✗ 检查失败：' + String((e && e.message) || e);
      diag.note('update', 'manual_check_fail', { ok: false, code: 'exception', detail: String((e && e.message) || e) });
    } finally {
      check.disabled = false;
      check.textContent = old;
    }
  });
  // P1-1：远端 /api/events 不可用时，本地兜底存了行为数据；这里提供导出入口（本地可读，解决「只写不读」）。
  const exp = document.getElementById('clExport');
  if (exp) exp.addEventListener('click', () => {
    const events = asr.getLocalEvents();
    if (!events.length) { store.toast('本地还没有留存的行为数据'); return; }
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), count: events.length, events }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `xiaoting-events-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    store.toast(`已导出 ${events.length} 条本地行为数据`);
  });
}

/* ---------------- 页面：高风险转介 / 紧急 ---------------- */

function pageRisk(p) {
  const st = store.getState().risk || {};
  const action = p.q.action || st.action || 'refer';
  const emergency = action === 'emergency' || (p.q.level || st.level) === 'critical';
  const ev = st.evidence || '';
  const script = pickRiskScript(action);
  const contactLabel = emergency ? '立即联系专业帮助' : '联系专业帮助';
  return `
  <section class="risk ${emergency ? 'risk--emergency' : ''}">
    <div class="risk__mascot">${mascot('danger', 160)}</div>
    <h2 class="risk__title">${esc(script.title)}</h2>
    <p class="risk__lead">${esc(script.line)}</p>
    ${ev ? `<p class="risk__ev">你刚才提到：「${esc(ev)}……」</p>` : ''}
    <p class="risk__lead">如果可以，请让一个真实的人陪着你。下面这些电话是免费的、会有人接的：</p>
    <div class="risk__list">
      ${COPY.risk.hotlines.map((h) => `<a class="risk__item" href="tel:${esc(h.tel)}"><span>${esc(h.name)}</span><b>${esc(h.tel)}</b></a>`).join('')}
    </div>
    <button class="primary" id="riskBack" type="button">${esc(contactLabel)}</button>
    <p class="risk__footer">${esc(COPY.risk.footer)}</p>
    <p class="foot-note">墨小溟不是心理医生，不提供诊断。你值得被认真对待。</p>
  </section>`;
}

function bindRisk() {
  const b = document.getElementById('riskBack');
  if (b) b.addEventListener('click', () => {
    store.setState({ risk: { level: 'none', action: 'continue', hit: false, evidence: '' }, draft: null });
    go('say');
  });
}

/* ---------------- 高危阻断 · 强制弹窗（v1.1 §3.3 / §4.7） ---------------- */

/**
 * 触发高危阻断：立刻阻断常规流程（不调用主分析、不生成卡片），对话区同步输出安抚文字，
 * 并居中弹出强制「温馨提示」卡片（低饱和暗紫底色），用户必须点击【我已了解】才能关闭并继续对话。
 * IP 切换为「担心」状态（弹窗内墨小溟为担忧态）。
 * 版本映射：A=自伤/轻生(emergency/refer)，B=伤害他人(harm_others)，C=长期重度痛苦无轻生(redirect_professional)。
 */
function handleBlocking(safety) {
  const action = safety.action || 'emergency';
  const version = action === 'harm_others' ? 'B' : (action === 'redirect_professional' ? 'C' : 'A');
  const script = pickRiskScript(action);
  const evidence = (store.getState().draft && store.getState().draft.transcript) || '';
  // 对话区同步输出对应版本安抚与引导文字（§3.3 第 3 条）
  appendConvo('ai', script.line);
  // v1.6.0 文档 §一.3：弹窗触发后，对话区必须**同步**附带这一句。
  // （只放弹窗里 = 用户点掉「我已了解」话就没了；这是文档点名要求的约束，不是可选项）
  appendConvo('ai', (COPY.risk && COPY.risk.carer_line) || '我很担心你，请一定好好照顾自己。');
  // 记录风险态（供兜底 / 埋点）
  store.setRisk({
    level: action === 'harm_others' ? 'high' : (action === 'redirect_professional' ? 'medium' : 'critical'),
    action,
    evidence: evidence.slice(0, 60),
  });
  // 回到对话页（对话区已含同步文字），再弹强制卡片
  go('say');
  setTimeout(() => showRiskModal(version, script, evidence), 60);
}

/**
 * 强制「温馨提示」弹窗（低饱和暗紫底色，绝不使用红色/爆炸/警报）。
 * 仅能通过点击【我已了解】关闭（不响应背景点击），关闭后用户回到对话继续。
 */
function showRiskModal(version, script, evidence) {
  // 若已存在则先移除，避免重复
  const old = document.getElementById('riskModal');
  if (old && old.parentNode) old.parentNode.removeChild(old);

  const overlay = document.createElement('div');
  overlay.className = 'risk-modal';
  overlay.id = 'riskModal';
  overlay.setAttribute('role', 'alertdialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.innerHTML = `
    <div class="risk-modal__card">
      <div class="risk-modal__ip">${mascot('danger', 150)}</div>
      <div class="risk-modal__badge">温馨提示</div>
      <div class="risk-modal__title">${esc(script.title)}</div>
      ${evidence ? `<div class="risk-modal__ev">你刚才提到：「${esc(evidence.slice(0, 40))}……」</div>` : ''}
      <div class="risk-modal__body">${esc(script.line)}</div>
      <div class="risk-modal__hotlines">
        <a class="risk-modal__item" href="tel:400-161-9995"><span>全国24小时心理危机咨询热线</span><b>400-161-9995</b></a>
        <a class="risk-modal__item" href="tel:010-82951332"><span>北京心理危机研究与干预中心</span><b>010-82951332</b></a>
      </div>
      <button class="risk-modal__confirm" id="riskModalConfirm" type="button">我已了解</button>
      <div class="risk-modal__foot">你的痛苦是真实的，请一定好好保护自己。</div>
    </div>`;
  document.body.appendChild(overlay);
  const btn = document.getElementById('riskModalConfirm');
  if (btn) btn.addEventListener('click', () => {
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    // 关闭后保持对话页；风险态保留供后续路由派生（不自动清零，避免重复弹窗）
  });
}

/* ---------------- 链路诊断页（v1.1.3） ----------------
 *
 * 存在的理由：以前要回答「AI 到底有没有真的跑」只能靠猜。现在每一步都写在 js/diag.js 里，
 * 这一页把它读出来给人看：麦克风拿到多少字节、ASR 用了多久什么错误码、安全识别放行还是拦截、
 * 主分析用的哪个模型多久返回了什么 JSON、追问与卡片有没有生成。
 * 还有一颗「跑一次真实链路」按钮 —— 用一句固定的话把整条链路真跑一遍，结果立刻出现在下面。
 */

function pageDiag() {
  const env = diag.environment();
  const sum = diag.summary();
  return `
  <section class="page page--diag">
    <div class="page-head"><a class="ghost" href="#/settings">返回</a><div class="page-title">链路诊断</div><span style="width:48px"></span></div>
    <header class="page__head">
      <p class="page__sub">这一页记录真实发生过的每一步，不是模拟，也不是占位。</p>
    </header>

    <div class="diag-card">
      <div class="diag-card__t">环境</div>
      <div class="diag-kv"><span>应用版本</span><b>${esc(env.appVersion || '-')}</b></div>
      <div class="diag-kv"><span>平台</span><b>${esc(env.platform || (isNativeApp() ? 'Android' : 'Web'))}</b></div>
      <div class="diag-kv"><span>页面源</span><b>${esc(env.origin || location.origin)}</b></div>
      <div class="diag-kv"><span>网络</span><b>${env.online === false ? '离线' : '在线'}</b></div>
      <div class="diag-kv"><span>AI 通道</span><b>${esc(String(env.provider || '-'))}</b></div>
    </div>

    <div class="diag-card" id="asrCapCard">
      <div class="diag-card__t">语音识别能力（本机实测）</div>
      <div id="asrCapBody"><p class="diag-empty">正在探测本机 ASR 通道…</p></div>
      <button class="ghost" id="asrProbeBtn" type="button" style="margin-top:8px">重新探测语音识别能力</button>
      <p class="foot-note">这一块能区分「插件没注册」「设备没识别服务」「云端不可用」三种不同的失败，是定位真机识别失败的关键。</p>
    </div>

    <div class="diag-card">
      <div class="diag-card__t">各阶段耗时与成败</div>
      ${sum.length ? sum.map((s) => `
        <div class="diag-kv"><span>${esc(s.stage)}</span><b>${s.calls} 次 · 成功 ${s.ok} · 失败 ${s.fail} · 均值 ${Math.round(s.ms / s.calls)}ms · 峰值 ${s.maxMs}ms${Object.keys(s.models).length ? ' · ' + esc(Object.keys(s.models).join('/')) : ''}</b></div>`).join('') : '<p class="diag-empty">还没有调用记录。</p>'}
    </div>

    <div class="diag-actions">
      <button class="primary" id="diagReport" type="button">一键复制诊断报告</button>
      <button class="primary" id="diagRun" type="button">用「我今天很烦。」跑一次真实链路</button>
      <button class="ghost" id="diagCopy" type="button">复制日志</button>
      <button class="ghost" id="diagExport" type="button">导出 .txt</button>
      <button class="ghost" id="diagClear" type="button">清空</button>
    </div>
    <p class="foot-note">真机上遇到「按住说没反应」「检查更新失败」时：先复现一次，再点「一键复制诊断报告」，
      把整段发给开发者即可定位 —— 里面含 ASR 通道实测、最近一次录音链路、更新接口的真实错误。</p>
    <div id="diagRunning" class="diag-running" hidden>正在跑：<span id="diagStage">…</span></div>

    <pre class="diag-log" id="diagLog">${esc(diag.text())}</pre>
    <p class="foot-note">日志只存在本机，不会上传。</p>
  </section>`;
}

/**
 * 采集本机 ASR 事实（v1.4.0 抽出）。
 * 抽出的理由：UI 面板与「一键复制诊断报告」需要**同一份**探测结果，
 * 两处各写一份必然漂移（这个仓已经因为"两处各写一份默认值"踩过坑）。
 */
async function collectAsrFacts() {
  const native = isNativeApp();
  const present = nativeAsr.nativeSpeechPresent();
  let available = false, perm = 'unknown', raw = '-';
  if (present) {
    try { available = await nativeAsr.nativeSpeechAvailable(); } catch (e) { available = false; }
    try { perm = await nativeAsr.nativeSpeechPermission(); } catch (e) { perm = 'unknown'; }
    try {
      const p = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.SpeechRecognition;
      raw = (p && p.available) ? JSON.stringify(await p.available()) : '无 available()';
    } catch (e) { raw = 'available() 抛错: ' + String((e && e.message) || e); }
  }
  const cap = asr.capability();
  let cloud = '-';
  try { cloud = await asr.probeCloud(true); } catch (e) { cloud = '探测异常'; }
  return { native, present, available, perm, raw, cap, cloud };
}

/** ASR 事实 → 一句结论（UI 与报告共用） */
function asrVerdict(f) {
  if (!f.native) {
    return f.cap.canRecord
      ? '浏览器环境：优先云端 ASR，云端不可用时用 Web Speech，都失败才打字。'
      : '浏览器环境且拿不到麦克风：只能打字。';
  }
  if (f.available) return 'APK + 设备识别可用：正常走原生识别，无需网络，这是最理想的状态。';
  if (f.cloud === 'ready') return 'APK 但设备无识别服务，且云端 ASR 可用：将走云端识别。';
  return '⚠️ APK 且无任何可用识别通道（设备无识别服务 + 云端不可用）：按住说必失败，只能打字。' +
    '要让它真能用，只有两条路：① 部署云端 ASR 后端（server.cjs + 真实 ASR 密钥，全设备通用）；' +
    '② 内置离线识别引擎（Vosk/FunASR，不依赖 GMS）。或换一台装了 Google 语音服务的设备。';
}

/**
 * 本机 ASR 通道实测（v1.1.9）。
 * 把「插件是否注册 / 设备是否有识别服务 / 云端是否可用」一次性摆出来，
 * 让真机上「按住说没反应」到底是哪一种失败，一眼看穿，不用猜。
 */
async function probeAsrCapability() {
  const kv = (k, v, note) =>
    `<div class="diag-kv"><span>${esc(k)}</span><b>${esc(String(v))}` +
    `${note ? ` <i style="opacity:.6;font-weight:400">${esc(note)}</i>` : ''}</b></div>`;

  const f = await collectAsrFacts();
  const native = f.native, present = f.present, available = f.available, perm = f.perm, raw = f.raw;
  const cap = f.cap, cloud = f.cloud;

  const rows = [
    kv('运行环境', native ? 'Android(APK)' : 'Web', native ? '原生容器' : '浏览器'),
    kv('语音插件是否就位', present ? '是' : '否', present ? 'SpeechRecognition 插件已注册' : '插件未注册 ⇒ 原生通道根本不存在'),
    kv('设备识别服务可用', available ? '是' : '否', available ? '系统 SpeechRecognizer 可用' : '系统无可用识别服务（常见于无 GMS 的国产 ROM）'),
    kv('插件 available() 原始返回', raw, ''),
    kv('麦克风授权', perm, ''),
    kv('Web 录音能力', cap.canRecord ? '是' : '否', ''),
    kv('Web Speech', cap.webSpeech ? '是' : '否', cap.webSpeech ? '' : '安卓 WebView 不支持'),
    kv('云端 ASR 通道', cloud, cloud === 'unavailable' ? '静态托管下无后端 ⇒ 不可用' : (cloud === 'ready' ? '可用' : '未配置')),
  ];

  const verdict = asrVerdict(f);
  return rows.join('') +
    `<div class="diag-kv" style="margin-top:8px"><span>结论</span><b style="white-space:normal">${esc(verdict)}</b></div>`;
}

/**
 * 一键生成「真机诊断报告」（v1.4.0，Task #143）。
 *
 * 为什么需要：开发者（我）看不到用户真机，而"按住说没反应""检查更新连不上"这类问题
 * 只有真机现场数据才能定位。本函数把散落各处的事实**实时采集**后拼成一段可直接粘贴的文本：
 *   ① 环境（版本/平台/页面源/网络/AI 通道）
 *   ② 语音识别能力实测（插件是否就位 / 设备是否有识别服务 / 云端通道）
 *   ③ 返回键与侧滑返回（Capacitor 桥 / App 插件 / 监听是否真绑定 —— v1.4.0 新增）
 *   ④ 版本更新链路（本地版本 / 线上版本 / 检查结果 / 上次失败原因）
 *   ⑤ 各阶段耗时与成败
 *   ⑥ 最近 60 条原始日志
 * 隐私：只含设备与链路信息；用户正文在日志里本来就只留截断片段（diag.js 的 MAX_TEXT），
 *       报告末尾会明确写出这一点，避免用户误以为自己在"上传聊天记录"。
 */
async function buildDiagReport() {
  const L = [];
  const env = diag.environment();
  const sep = '─'.repeat(46);
  L.push('════════ 墨小溟 · 真机诊断报告 ════════');
  L.push(`生成时间：${new Date().toLocaleString('zh-CN')}`);
  L.push(`应用版本：${env.appVersion || window.APP_VERSION || '-'}`);
  L.push(`平台：${env.platform || (isNativeApp() ? 'Android(APK)' : 'Web')}`);
  L.push(`页面源：${location.origin}`);
  L.push(`网络：${navigator.onLine === false ? '离线' : '在线'}`);
  L.push(`AI 通道：${env.provider || '-'}`);

  // ① ASR 能力（实时）
  L.push('', sep, '① 语音识别能力（实时探测）', sep);
  let f = null;
  try {
    f = await collectAsrFacts();
    L.push(`语音插件是否就位：${f.present ? '是' : '否'}`);
    L.push(`设备识别服务可用：${f.available ? '是' : '否'}`);
    L.push(`插件 available() 原始返回：${f.raw}`);
    L.push(`麦克风授权：${f.perm}`);
    L.push(`Web 录音能力：${f.cap.canRecord ? '是' : '否'}`);
    L.push(`Web Speech：${f.cap.webSpeech ? '是' : '否'}`);
    L.push(`云端 ASR 通道：${f.cloud}`);
    L.push(`结论：${asrVerdict(f)}`);
  } catch (e) {
    L.push('探测异常：' + String((e && e.message) || e));
  }

  // ② 返回键 / 侧滑返回（v1.4.0 新增：这条链路最容易"看着接上了其实没接"）
  L.push('', sep, '② 返回键与侧滑返回（本机实测）', sep);
  const bw = backWiringFacts();
  L.push(`Capacitor 桥：${bw.capBridge ? '有' : '无'}`);
  L.push(`App 插件（@capacitor/app）：${bw.appPlugin ? '已注册' : '未注册'}`);
  L.push(`backButton 监听：${bw.bound ? '已绑定' : '未绑定'}`);
  L.push(`应用内左边缘侧滑：${bw.swipeBound ? '已启用' : '未启用'}`);
  if (bw.err) L.push(`接线异常：${bw.err}`);
  L.push(`结论：${backVerdict(bw)}`);

  // ②b 左边缘手势实测（v1.4.2）：区分「系统把手势吃了」与「我们自己没认」——
  //     两者的修法相反，不量就只能猜。真机上请在子页面从左边缘向右滑 1~3 次再复制报告。
  const ep = edgeProbeFacts();
  L.push('', sep, '②b 左边缘侧滑实测（是否被系统手势拦截）', sep);
  L.push(`采样次数：${ep.total}（被取消 ${ep.lost}，正常送达 ${ep.received}）`);
  L.push(`当前起手区：x ${ep.min}~${ep.max}px${ep.autoMin ? `（已自动避开系统区，原为 0~28）` : ''}`);
  if (ep.last) {
    L.push(`最近一次：起点 x=${ep.last.x}px，事件 ${ep.last.kind}，` +
      `${ep.last.canceled ? '中途被取消' : '正常结束'}，${ep.last.ours ? '我们的手势已接住' : '我们的手势未接住'}`);
  }
  if (ep.samples && ep.samples.length) {
    L.push(`样本：${ep.samples.map((s) => `x${s.x}${s.canceled ? '✗' : '✓'}${s.ours ? '·ours' : ''}`).join('  ')}`);
  }
  L.push(`结论：${ep.verdict}`);

  // ③ 最近一次录音/识别链路（从日志里捞 mic/asr 两条 stage 的真实字段）
  L.push('', sep, '③ 最近一次录音与识别链路', sep);
  const all = diag.entries();
  const micAsr = all.filter((e) => e.stage === 'mic' || e.stage === 'asr').slice(-14);
  if (micAsr.length) {
    for (const e of micAsr) {
      L.push(`${e.ts}  ${e.stage}/${e.event}  ok=${e.ok}  ${e.ms != null ? e.ms + 'ms' : '-'}` +
        `${e.code ? `  code=${e.code}` : ''}${e.detail ? `  ${e.detail}` : ''}` +
        `${e.raw ? `\n     raw: ${e.raw}` : ''}`);
    }
  } else {
    L.push('（本次会话还没有录音/识别记录 —— 请先在首页「按住说」一次再生成报告）');
  }

  // ④ 更新链路（实时探一次）
  L.push('', sep, '④ 版本更新链路（实时探测）', sep);
  L.push(`本地版本(APP_VERSION)：${window.APP_VERSION || '-'}`);
  try {
    const r = await update.checkUpdate({ manual: true });
    const d = update.describeCheckResult(r);
    L.push(`线上版本：${r.latest || '-'}`);
    L.push(`检查结果：${d.ok ? 'OK' : 'FAIL'} — ${d.text}`);
    L.push(`reason：${r.reason || '-'}`);
  } catch (e) {
    L.push(`检查结果：FAIL — ${String((e && e.message) || e)}`);
  }
  L.push(`上次失败原因(lastError)：${update.lastFetchError() || '（无）'}`);
  L.push(`静态清单候选路径：/api/version/latest → /version.json（前者在纯静态托管下恒 404，属预期）`);

  // ⑤ 阶段摘要
  L.push('', sep, '⑤ 各阶段耗时与成败', sep);
  const sum = diag.summary();
  if (sum.length) {
    for (const s of sum) {
      L.push(`${s.stage}：${s.calls} 次 · 成功 ${s.ok} · 失败 ${s.fail} · 均值 ${Math.round(s.ms / s.calls)}ms · 峰值 ${s.maxMs}ms` +
        `${Object.keys(s.models).length ? ' · ' + Object.keys(s.models).join('/') : ''}`);
    }
  } else {
    L.push('（还没有调用记录）');
  }

  // ⑥ 原始日志
  L.push('', sep, `⑥ 最近 ${Math.min(60, all.length)} 条原始日志`, sep);
  const tail = all.slice(-60);
  if (tail.length) {
    for (const e of tail) {
      const tag = e.ok === true ? '[OK]  ' : e.ok === false ? '[FAIL]' : '[ -- ]';
      L.push(`${tag} ${e.ts} +${String(e.dt).padStart(6)}ms ${e.stage}/${e.event}` +
        `${e.ms != null ? ` ${e.ms}ms` : ''}${e.model ? ` model=${e.model}` : ''}${e.code ? ` code=${e.code}` : ''}`);
      if (e.detail) L.push(`      ${e.detail}`);
      if (e.raw) L.push(`      raw: ${e.raw}`);
    }
  } else {
    L.push('（本机会话暂无日志）');
  }

  L.push('', '════════ 报告结束 ════════');
  L.push('说明：本报告只含设备与链路信息，不上传任何内容；');
  L.push('你倾诉的正文在日志里只保留截断片段，用于定位链路问题。');
  return L.join('\n');
}

function bindDiag() {
  const logEl = document.getElementById('diagLog');
  const refresh = () => { if (logEl) logEl.textContent = diag.text(); };

  // 本机 ASR 通道探测：进页面自动跑一次，按钮可重跑
  const probeBtn = document.getElementById('asrProbeBtn');
  const probeBody = document.getElementById('asrCapBody');
  const runProbe = async () => {
    if (probeBody) probeBody.innerHTML = '<p class="diag-empty">探测中…</p>';
    if (probeBtn) probeBtn.disabled = true;
    try {
      if (probeBody) probeBody.innerHTML = await probeAsrCapability();
      diag.note('asr', 'capability_probe', { ok: true, detail: '已在链路诊断页输出本机 ASR 通道实测' });
    } catch (e) {
      if (probeBody) probeBody.innerHTML = '<p class="diag-empty">探测失败：' + esc(String((e && e.message) || e)) + '</p>';
    }
    if (probeBtn) probeBtn.disabled = false;
  };
  if (probeBtn) probeBtn.addEventListener('click', runProbe);
  runProbe();

  const runBtn = document.getElementById('diagRun');
  if (runBtn) runBtn.addEventListener('click', async () => {
    const stageEl = document.getElementById('diagStage');
    const runningEl = document.getElementById('diagRunning');
    if (runningEl) runningEl.hidden = false;
    runBtn.disabled = true;
    try {
      diag.clear();
      diag.snapshot({ platform: isNativeApp() ? 'Android(APK)' : 'Web' });
      const T = '我今天很烦。';

      if (stageEl) stageEl.textContent = '安全识别…';
      const safety = await api.safety({ transcript: T });
      refresh();

      if (stageEl) stageEl.textContent = '主分析…';
      const analysis = await api.analyze({ transcript: T });
      refresh();

      let follow = null;
      if (safety.action === 'continue' || safety.risk_level === 'none') {
        if (stageEl) stageEl.textContent = '追问…';
        follow = await api.followup({ analysis, asked: [], userAnswer: '', round: 0 });
        refresh();
      }

      if (stageEl) stageEl.textContent = '卡片生成…';
      const card = await api.cardGenerate({ analysis, followup: follow ? [follow] : [], extra: '', transcript: T });
      refresh();

      if (stageEl) stageEl.textContent = '情绪时间线…';
      // 给一段真有情绪起伏的对话：只有一句「我今天很烦。」时，时间线会正确地给出"无明显情绪"简版，
      // 那是正确行为，但看不出时间线到底会不会生成 —— 自检要证明的是「能生成」，所以这里补一句转折。
      const tl = await api.timelineGenerate({
        conversation: [
          { role: 'user', text: '今天一早还挺高兴的，出门前还哼了两句歌。' },
          { role: 'ai', text: '听起来开头不错，后来呢？' },
          { role: 'user', text: '中午开会的时候被领导当众说了一顿，特别难堪。' },
          { role: 'ai', text: (follow && follow.question) || '那之后你怎么样？' },
          { role: 'user', text: '后来就一直很烦，晚上回到家还是闷的。' },
        ],
      });
      refresh();

      // 「有没有生成」用各自阶段的产出特征判断，不能用同一个字段：
      // 时间线在无明显情绪时会正确地返回 {type:'no-emotion'}（没有 title），
      // 只认 title 会把「正确生成的简版」误报成「没生成」。
      const tlOk = !!(tl && (tl.title || tl.type || tl.summary));
      diag.note('diag', 'selfrun', {
        ok: true,
        detail: `自检完成：安全=${safety.risk_level}/${safety.action}；主分析情绪=${(analysis.emotion || []).join('、')} 强度=${analysis.intensity}；` +
          `追问=${follow && follow.question ? '已生成' : '未生成'}；卡片=${card && card.summary ? '已生成' : '未生成'}；` +
          `时间线=${tlOk ? '已生成' + (tl && tl.nodes && tl.nodes.length ? `（${tl.nodes.length} 个节点）` : '（无明显情绪·简版）') : '未生成'}`,
      });
    } catch (e) {
      diag.note('diag', 'selfrun', { ok: false, code: 'exception', detail: String((e && e.message) || e) });
    }
    if (stageEl) stageEl.textContent = '完成';
    if (runningEl) runningEl.hidden = true;
    runBtn.disabled = false;
    refresh();
  });

  // 一键复制诊断报告（v1.4.0 / Task #143）：真机排障的主入口
  const reportBtn = document.getElementById('diagReport');
  if (reportBtn) reportBtn.addEventListener('click', async () => {
    const old = reportBtn.textContent;
    reportBtn.disabled = true;
    reportBtn.textContent = '正在采集…';
    let text = '';
    try {
      text = await buildDiagReport();
    } catch (e) {
      reportBtn.disabled = false;
      reportBtn.textContent = old;
      softSay('生成报告失败：' + String((e && e.message) || e));
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      diag.note('diag', 'report_copied', { ok: true, detail: `${text.length} 字` });
      softSay('诊断报告已复制，整段发给开发者即可');
    } catch (e) {
      // 剪贴板被拒（非 https / 权限）：退化成"把报告铺到页面上，长按选中复制" —— 不能让排障卡在这一步
      diag.note('diag', 'report_copy_fallback', { ok: false, code: 'clipboard', detail: String((e && e.message) || e) });
      softSay('复制失败，报告已显示在下方，可长按选中复制');
    }
    if (logEl) logEl.textContent = text || diag.text();
    reportBtn.disabled = false;
    reportBtn.textContent = old;
  });

  const copyBtn = document.getElementById('diagCopy');
  if (copyBtn) copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(diag.text());
      softSay('日志已复制');
    } catch (e) {
      softSay('复制失败，可以长按选中日志手动复制');
    }
  });

  const expBtn = document.getElementById('diagExport');
  if (expBtn) expBtn.addEventListener('click', () => {
    try {
      const blob = new Blob([diag.text()], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `墨小溟-链路诊断-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.txt`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); if (a.parentNode) a.parentNode.removeChild(a); }, 300);
    } catch (e) { softSay('导出失败'); }
  });

  const clrBtn = document.getElementById('diagClear');
  if (clrBtn) clrBtn.addEventListener('click', () => { diag.clear(); refresh(); });
}

/* ---------------- 路由表 ---------------- */

const PAGES = {
  say: { render: pageSay, bind: bindSay, tab: 'say', nav: true },
  record: { render: pageRecord, bind: bindRecord, nav: false },
  analyzing: { render: pageAnalyzing, mount: mountAnalyzing, nav: false },
  followup: { render: pageFollowup, bind: bindFollowup, nav: false },
  gentle: { render: pageGentle, bind: bindGentle, nav: false },
  confirm: { render: pageConfirm, bind: bindConfirm, nav: false },
  timeline: { render: pageTimeline, bind: bindTimeline, nav: false },
  timelines: { render: pageTimelines, nav: false },
  cards: { render: pageCards, tab: 'cards', nav: true },
  card: { render: pageCardDetail, bind: bindCardDetail, nav: true },
  weekly: { render: pageWeekly, mount: mountWeekly, nav: true },
  me: { render: pageMe, bind: bindMe, tab: 'me', nav: true },
  memory: { render: pageMemory, bind: bindMemory, nav: true },
  settings: { render: pageSettings, bind: bindSettings, nav: true },
  changelog: { render: pageChangelog, bind: bindChangelog, nav: false },
  risk: { render: pageRisk, bind: bindRisk, nav: false },
  diag: { render: pageDiag, bind: bindDiag, nav: false },
};

/* ---------------- 渲染 ---------------- */

function renderTabs(active) {
  const bar = $tabbar();
  if (!bar) return;
  const items = [
    { k: 'say', label: '说', href: '#/say' },
    { k: 'cards', label: '卡片', href: '#/cards' },
    { k: 'me', label: '我', href: '#/me' },
  ];
  bar.innerHTML = items.map((it) => `<a class="tab ${active === it.k ? 'tab--on' : ''}" href="${it.href}"><span>${it.label}</span></a>`).join('');
}

function render() {
  const p = parseHash();
  const page = PAGES[p.name] || PAGES.say;

  clearTimers();

  // v0.8.0 收尾：离开分析页 / 录音页时清掉防呆计时器与生命感联动类（避免残留）
  if (rec.stuckTimer) { clearTimeout(rec.stuckTimer); rec.stuckTimer = null; }
  try { document.body.classList.remove('thinking--stuck', 'recording--breath'); } catch (e) { /* ignore */ }
  // v1.4.5：离开追问页时若「按住说」还在录，立刻同步中止（停音轨/计时器/IP 复位，不提交）
  if (typeof fuRec !== 'undefined' && fuRec.active) fuAbort();

  const s = store.getState();
  // 🔴 这里**不能**写 s.lastInteractionAt = Date.now()：那样 isIdleTimeout 永远差 0ms、3 分钟回归永不触发。
  //    交互时间戳只由真实用户动作推进（store.touchInteraction()：导航、IP 点击、提交、写入情绪）。
  // v1.3.0 AI 回复微动作：followup/gentle/confirm 且对话区末尾是 AI 回应时，叠加「缓缓靠近」呼吸
  s.aiReplying = ['followup', 'gentle', 'confirm'].includes(p.name) && (s.conversation || []).slice(-1)[0] && (s.conversation || []).slice(-1)[0].role === 'ai';
  // v1.3.0 §三.4 超时回归：3 分钟无交互 → 情绪缓慢回归 idle（emotionKey 置空，CSS 过渡平滑回退）
  const idleOut = ipSM.isIdleTimeout(s.lastInteractionAt);
  const desc = ipSM.gateByMotion(ipSM.resolveNode({
    route: p.name,
    riskLevel: s.risk.level,
    emotionKey: idleOut ? null : s.emotionKey,
    intensity: s.emotionIntensity,
    receivingUntil: s.receivingUntil,
    now: Date.now(),
    aiReplying: s.aiReplying,
    happy: Date.now() < (s.happyUntil || 0),
  }), s.user.settings.ipMotion !== false);
  currentIpDesc = desc;
  store.getState().ipState = desc.state;
  // §三.4 真正的回归计时器：只在「有情绪底色」时挂一次，到点自动清空洞色并重渲染。
  //   缺了它，isIdleTimeout 只在 render() 那一刻被求值一次 ⇒ 用户不动页面就永远停在情绪色（等于没实现）。
  scheduleIdleRevert();

  document.body.dataset.route = p.name;
  document.body.classList.toggle('has-nav', page.nav !== false);
  // v1.3.0 开关门禁：IP 动效总开关 / 动画强度档（柔和）
  document.body.classList.toggle('ip-motion-off', s.user.settings.ipMotion === false);
  document.body.classList.toggle('ip-intensity-gentle', s.user.settings.ipIntensity === 'gentle');
  // v1.3.2 安静陪伴模式：背景更柔、视觉降噪
  document.body.classList.toggle('quiet-mode', !!s.quietMode);

  const v = $view();
  if (v) {
    // v1.3.5 色彩过渡修复（补 v1.3.4 遗漏）：render() 是整块 innerHTML 重写，IP 节点每次都是全新的、
    //   出生即带目标色 ⇒ @property 过渡永不触发（探针实测：8 次采样全为目标值 = 硬切）。
    //   这里先记下上一帧的真实（可能正插值中的）颜色，替换后让新节点从它平滑走过去。
    const prevIpColors = readIpColors(v.querySelector('.mascot'));
    v.innerHTML = page.render(p);
    replayIpColors(v.querySelector('.mascot'), prevIpColors);
    // 柔和淡入淡出：先摘掉再强制回流，保证同一动画能重放
    v.classList.remove('view--enter');
    void v.offsetWidth;
    v.classList.add('view--enter');
    v.scrollTop = 0;
    window.scrollTo(0, 0);
  }
  applyIpBg(desc);
  renderTabs(page.tab || '');

  if (page.bind) page.bind(p);
  if (page.mount) page.mount(p);

  renderToast();
}

/* v1.3.0 IP 情绪视觉引擎：当前渲染描述符（render() 计算，各页 ipMascot 读取） */
let currentIpDesc = null;

/* ---------- v1.3.5：色彩过渡重放（让 @property 插值真的发生） ----------
 * 问题：render() 整块重写 #view ⇒ IP 节点是新建的，出生就把 inline --ip-* 写成目标色，
 *       浏览器的 @property 过渡需要一个「起始值 → 目标值」的变化才会跑，全新节点等于没有变化 ⇒ 硬切。
 * 做法：替换前读上一帧的真实色（可能是插值中的中间色），插入后先把新节点压回旧色，
 *       再**跨帧**（双 rAF）写回目标色 —— 过渡就在第二帧真正跑起来（0.8s，落 §三 的 0.6~1.2s 区间）。
 * 🔴 必须跨帧：`设置起点 → getBoundingClientRect() 强制回流 → 设置目标` 这个经典写法在自定义属性上**不成立**，
 *   浏览器会把同一任务内的两次赋值合并（实测直接从更早的颜色往目标插值，中间色被整个吞掉 ⇒ 仍是硬切）。
 * 门禁：ip-motion-off（总开关关）时直接跳过，不做任何动画（规格要求此时零动效）。 */
const IP_COLOR_VARS = [
  '--ip-body-in', '--ip-body-mid', '--ip-body-out', '--ip-antenna', '--ip-tip',
  '--ip-glow', '--ip-glow-2', '--ip-eye-top', '--ip-eye', '--ip-halo', '--ip-wet', '--ip-blush',
];

function readIpColors(el) {
  if (!el || !el.style) return null;
  // 只用于**替换前的旧节点**：优先读计算值（无情绪时节点没有 inline 色，走 .mascot 的 CSS 默认；
  // 过渡进行中读到的就是插值中的中间色，正好用作继续插值的起点 → 视觉连续）。
  let cs = null;
  try { cs = getComputedStyle(el); } catch (e) { cs = null; }
  const out = {};
  IP_COLOR_VARS.forEach((k) => {
    let v = '';
    if (cs) v = String(cs.getPropertyValue(k) || '').trim();
    if (!v) v = el.style.getPropertyValue(k).trim();
    if (v) out[k] = v;
  });
  return Object.keys(out).length ? out : null;
}

/** 只读**内联**色 —— 给刚创建的新节点用。
 *  🔴 绝对不要在新节点上调用 getComputedStyle：那会强制一次样式解析，把「目标色」登记成该元素的
 *     起始样式，于是紧接着写旧色反而触发一次「目标→旧」的过渡，再写目标色就没有变化了 ⇒ 仍然是硬切。 */
function readIpInlineColors(el) {
  if (!el || !el.style) return null;
  const out = {};
  IP_COLOR_VARS.forEach((k) => { const v = el.style.getPropertyValue(k).trim(); if (v) out[k] = v; });
  return Object.keys(out).length ? out : null;
}

function writeIpColors(el, colors) {
  if (!el || !el.style || !colors) return;
  Object.keys(colors).forEach((k) => el.style.setProperty(k, colors[k]));
}

function replayIpColors(node, from) {
  if (!node || !from) return;
  if (store.getState().user.settings.ipMotion === false) return;
  // 目标色 = mascot() 刚写进新节点的 inline 值（只读属性，不触发样式解析）
  const target = readIpInlineColors(node);
  if (!target) return;
  // 起点只取「两边都有」的变量（selectColors 只产 --ip-body-in/out 两个），不污染其它变量
  const start = {};
  let changed = false;
  Object.keys(target).forEach((k) => {
    if (from[k]) { start[k] = from[k]; changed = true; }
  });
  if (!changed) return;
  writeIpColors(node, start);
  // 强制一次样式解析 ⇒ 让「旧色」成为该新节点的初始样式（新元素没有 before-change 样式，
  // 必须先把起点落定，下一次改写入才会被浏览器读作「一次变化」并启动过渡）
  void node.getBoundingClientRect();
  // 跨帧写目标色（双 rAF）：同一任务内连写两次会被合并，过渡不会发生
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (node.isConnected) writeIpColors(node, target);
  }));
}

/* ---------- v1.3.5：§三.4 3 分钟无交互 → 情绪缓慢回归 idle ---------- */
let idleRevertTimer = null;

function scheduleIdleRevert() {
  if (idleRevertTimer) { clearTimeout(idleRevertTimer); idleRevertTimer = null; }
  const s = store.getState();
  // 只在「有情绪底色、且不在高危截断/接收窗口」时挂计时器；否则无事可回归
  const hasEmotion = !!s.emotionKey && s.emotionKey !== 'default';
  if (!hasEmotion || s.risk.level === 'high' || s.risk.level === 'critical') return;
  const elapsed = Date.now() - (s.lastInteractionAt || Date.now());
  const remain = Math.max(1000, ipSM.TRANSITION.idleTimeoutMs - elapsed);
  idleRevertTimer = setTimeout(() => {
    idleRevertTimer = null;
    const cur = store.getState();
    if (!cur.emotionKey || cur.emotionKey === 'default') return;
    // 期间有交互（点了 IP / 换了页）→ 不回归，按新基准重新排一次（否则这次静默失效后就再没人排了）
    if (!ipSM.isIdleTimeout(cur.lastInteractionAt)) { scheduleIdleRevert(); return; }
    store.setEmotion(null, 0); // 清空洞色（CSS 过渡平滑回退），随后重渲染
    render();
  }, remain);
  timers.push(() => { if (idleRevertTimer) { clearTimeout(idleRevertTimer); idleRevertTimer = null; } });
}

/** 渲染当前情绪态 IP：用 state-machine 解析出的姿态 + 内联调色板色 + 节点附加类 */
function ipMascot(size) {
  const d = currentIpDesc || ipSM.resolveNode({ route: (parseHash().name || 'say') });
  return mascot(d.state, size, d.colors, (d.mixed ? 'ip-mixed ' : '') + 'ip-node-' + d.node);
}

/** 把解析描述符落到背景水墨层（#ipBg） */
function applyIpBg(desc) {
  const bg = document.getElementById('ipBg');
  if (bg) bg.className = 'ip-bg ip-bg--' + (desc.danger ? 'soft_warning_ring' : (desc.bgEffect || 'steady_water'));
}

/* v1.3.3 首页问候：会话内固定、重开 App 才轮换；老用户按历史情绪偏向匹配（来自记忆地基） */
function historyBiasFrom(rows) {
  const MAP = {
    委屈: 'sad', 悲伤: 'sad', 难过: 'sad', 孤独: 'sad', 羞耻: 'sad', 内疚: 'sad', 沮丧: 'sad',
    疲惫: 'tired', 倦: 'tired', 无力: 'tired', 累: 'tired', 乏力: 'tired',
    焦虑: 'anxious', 恐惧: 'anxious', 紧张: 'anxious', 愤怒: 'anxious', 生气: 'anxious', 烦躁: 'anxious', 火大: 'anxious',
    开心: 'joy', 喜悦: 'joy', 高兴: 'joy', 快乐: 'joy', 平静: 'joy', 安心: 'joy',
  };
  const count = {};
  let total = 0;
  (rows || []).forEach((r) => (r.emotion_tags || []).forEach((t) => { const c = MAP[String(t).trim()]; if (c) { count[c] = (count[c] || 0) + 1; total++; } }));
  if (!total) return null;
  const sorted = Object.entries(count).sort((a, b) => b[1] - a[1]);
  if (total >= 4 && sorted[0][1] / total < 0.5 && sorted.length >= 3) return 'mixed';
  return sorted[0][0];
}

async function initGreeting() {
  let rows = [];
  try { rows = await memory.loadMemory(); } catch (e) { rows = []; }
  const bias = historyBiasFrom(rows);
  store.setState({
    historyBias: bias,
    greeting: cw.greetingFor({ hour: new Date().getHours(), hasHistory: !!bias, bias }),
    greetingSmall: cw.pick(cw.GREETING_SMALL_TEXT),
    cardHint: cw.pick(cw.CARD_HINT),
  });
}

function renderToast() {
  const t = $toast();
  if (!t) return;
  const s = store.getState();
  const alive = s.toast && (!s.toast.until || Date.now() < s.toast.until);
  if (alive) { t.textContent = s.toast.msg; t.classList.add('toast--on'); }
  else {
    t.classList.remove('toast--on');
    if (s.toast) store.setState({ toast: null });
  }
}

/* ---------------- 全局返回 / 退出 + 离线浮条（v1.1.10） ---------------- */

/**
 * 子页面 → 上一级映射。首页级（say/cards/me）不入表，走「双击退出」。
 * diag 从「设置」进入 ⇒ 回到 settings；card 回到 cards；其余回到各自入口。
 */
const BACK_PARENT = {
  record: 'say', analyzing: 'say', followup: 'say', gentle: 'say', confirm: 'say', risk: 'say',
  timeline: 'me', timelines: 'me', weekly: 'me', settings: 'me', changelog: 'me', diag: 'settings',
  card: 'cards', memory: 'me',
};
let _exitArmed = false;
let _exitTimer = null;

/** 是否处于「倾诉进行中」——录音中或分析中，离开需温柔确认 */
function _isBusy() {
  if (rec.active) return true;
  return parseHash().name === 'analyzing';
}
function _parentOf(name) { return BACK_PARENT[name] || 'say'; }

/** 温柔确认框（替代浏览器原生 confirm，走墨小溟紫色主题）。返回 Promise<boolean> */
function gentleConfirm(message, opts) {
  const o = opts || {};
  const okText = o.okText || '确定离开';
  const cancelText = o.cancelText || '再想想';
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'gentle-confirm';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML =
      '<div class="gentle-confirm__card">' +
        '<div class="gentle-confirm__ip">' + mascot('empathy', 84) + '</div>' +
        '<p class="gentle-confirm__msg">' + esc(message) + '</p>' +
        '<div class="gentle-confirm__btns">' +
          '<button class="ghost" id="gcCancel" type="button">' + esc(cancelText) + '</button>' +
          '<button class="primary small" id="gcOk" type="button">' + esc(okText) + '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    const close = (val) => { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); resolve(val); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
    const ok = document.getElementById('gcOk');
    const cancel = document.getElementById('gcCancel');
    if (ok) ok.addEventListener('click', () => close(true));
    if (cancel) cancel.addEventListener('click', () => close(false));
  });
}

/**
 * 全局硬件返回键处理：供 Android 物理返回键 / 系统侧滑手势（Capacitor App 插件）与浏览器自测调用。
 * · 子页面 → 返回上一级；倾诉进行中则先弹温柔确认。
 * · 首页级 → 仅 APK 双击退出；浏览器首页级返回无操作（避免误关整页）。
 */
export function handleHardwareBack() {
  const name = parseHash().name;
  if (BACK_PARENT[name]) {
    if (_isBusy()) {
      gentleConfirm('现在离开的话，这次倾诉的内容会留在这里哦，确定要离开吗？').then((ok) => {
        if (!ok) return;
        if (rec.active) { endCapture().then(() => go(_parentOf(name))); }
        else go(_parentOf(name));
      });
      return;
    }
    go(_parentOf(name));
    return;
  }
  if (isNativeApp()) {
    if (_exitArmed) {
      _exitArmed = false;
      if (_exitTimer) clearTimeout(_exitTimer);
      try { const App = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App; if (App && App.exitApp) App.exitApp(); } catch (e) {}
      return;
    }
    _exitArmed = true;
    softSay('再按一次退出小溟');
    _exitTimer = setTimeout(() => { _exitArmed = false; }, 2000);
  }
}

/**
 * 返回键接线状态（v1.4.0 新增，用于真机自证）。
 *
 * 为什么必须留痕：`@capacitor/app` 没装时 `Capacitor.Plugins.App` 是 undefined，
 * 监听**静默失效**——按钮在、函数在、代码全绿，真机按返回键却直接退出 App。
 * 本仓已经因为同类「接线了但没接上」吃过一次亏（v1.1.6 的 isApk 恒 false），
 * 所以这里把接线事实记下来，真机诊断报告里直接读得到。
 */
const _backWiring = { tried: false, capBridge: false, appPlugin: false, bound: false, err: '' };
let _swipeBound = false;

/** 注册 Android 物理/手势返回键监听（仅原生容器有效；浏览器无此插件则忽略） */
function registerBackHandler() {
  _backWiring.tried = true;
  try {
    _backWiring.capBridge = !!window.Capacitor;
    const App = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
    _backWiring.appPlugin = !!App;
    if (App && typeof App.addListener === 'function') {
      App.addListener('backButton', () => { handleHardwareBack(); });
      _backWiring.bound = true;
    }
  } catch (e) { _backWiring.err = String((e && e.message) || e); }
}

/** 供诊断报告与自测读取（切勿在 UI 里直接展示给用户，属排障信息） */
export function backWiringFacts() {
  return Object.assign({}, _backWiring, { swipeBound: _swipeBound });
}

/** 返回键接线事实 → 一句结论（诊断报告用） */
function backVerdict(f) {
  if (!f.tried) return '尚未初始化（页面未完成启动）。';
  if (!f.capBridge) return '浏览器环境：返回键交给浏览器历史，无需原生接管。';
  if (!f.appPlugin) {
    return '⚠️ 物理返回键 / 系统侧滑**不会被接管**：原生壳里没有 @capacitor/app 插件' +
      '（Capacitor.Plugins.App 不存在）。表现通常是按返回键直接退出 App、' +
      '子页面无法返回上一级。修法：把 @capacitor/app 加进 package.json 依赖后重新打包。';
  }
  if (!f.bound) return '⚠️ App 插件在，但 backButton 监听未绑定成功' + (f.err ? `（${f.err}）` : '') + '。';
  return '已接管：物理返回键与系统侧滑手势都会走「子页面返回上一级 / 首页双击退出」。' +
    (f.swipeBound ? '应用内左边缘侧滑（跟手视差）也已启用。' : '应用内左边缘侧滑未启用。');
}

/* ---------------- 左滑返回手势（v1.2.1 攻坚 · 战役二） ---------------- */
/* 复刻原生 Android 返回手势「从左边缘向右拖」：
   · 仅在左边缘（x<EDGE）起手、且横向位移 > 纵向时才判定为「想返回」；
   · 拖动时 #view 跟手右移（parallax），并叠一层随进度加深的暗色；
   · 松手超过阈值 ⇒ 滑出并回到父级；否则回弹；
   · 倾诉进行中（录音/分析中）⇒ 先弹「正在为你保存这片深海的记忆…」温柔确认，确认后再保存并离开；
   · 与既有 Android 物理返回键（registerBackHandler）共用同一套父级映射与确认逻辑。 */
let _swipeHint = null;
function showSwipeHint(prog) {
  if (!_swipeHint) {
    _swipeHint = document.createElement('div');
    _swipeHint.id = 'swipeHint';
    _swipeHint.setAttribute('aria-hidden', 'true');
    _swipeHint.textContent = '‹';
    document.body.appendChild(_swipeHint);
  }
  _swipeHint.style.opacity = String(Math.min(1, prog * 1.4));
}
function hideSwipeHint() { if (_swipeHint) _swipeHint.style.opacity = '0'; }
function resetSwipe(view) {
  view.style.transform = '';
  view.style.willChange = '';
  view.style.removeProperty('--swipe-dim');
  view.classList.remove('swipe-release');
  document.body.classList.remove('swiping');
  hideSwipeHint();
}

/* ---------------- 左边缘手势探针（v1.4.2 · 用数据代替猜） ----------------
 *
 * 为什么必须先量再改：「左滑没反应」有**两种成因完全相反**的可能，不测就只能猜：
 *   ① 被 Android 系统返回手势吃了 —— 表现为页面**根本收不到**事件，或中途收到 cancel；
 *   ② 我们自己的阈值不对 —— 事件收到了，只是起点超出 EDGE 被我们 `return` 掉了。
 * 两者的修法相反：①要把起手区**往右挪**避开系统区；②反而是要放宽阈值。
 * 盲改 40px 可能修好 ①，也可能把 ② 弄得更糟 ⇒ 先量，再改，且改完自动生效。
 */
const _edgeProbe = { samples: [], autoMin: 0, min: 0, max: 28 };
const EDGE_PROBE_ZONE = 72;   // 只记录这个范围内的起手，更右侧的与系统手势无关
let _probeCur = null;

function probePush(s) {
  _edgeProbe.samples.push(s);
  if (_edgeProbe.samples.length > 8) _edgeProbe.samples.shift();
  maybeAdaptEdge();
}

/**
 * 自适应：连续 3 次「在左边缘起手、还没完成就被 cancel」⇒ 判定该区间被系统接管，
 * 把起手区的**下限**抬到被吃掉的最右点 + 8px（上限同步放宽，保证仍然好划）。
 * 只上调下限、不动上限方向 —— 抬下限是"避开系统区"，放宽上限是"别让人划不中"。
 */
function maybeAdaptEdge() {
  const lost = _edgeProbe.samples.filter((s) => s.canceled && !s.ours);
  if (lost.length < 3) return;
  const maxX = Math.max.apply(null, lost.map((s) => s.x));
  const wantMin = Math.min(56, Math.round(maxX) + 8);
  if (wantMin > _edgeProbe.min) {
    _edgeProbe.min = wantMin;
    _edgeProbe.max = Math.max(120, wantMin + 90);
    _edgeProbe.autoMin = wantMin;
  }
}

/** 当前生效的起手区（x 需落在这个区间内） */
function edgeZone() { return { min: _edgeProbe.min, max: _edgeProbe.max }; }

/** 供诊断报告与自测读取 */
export function edgeProbeFacts() {
  const ss = _edgeProbe.samples;
  const lost = ss.filter((s) => s.canceled && !s.ours);
  const got = ss.filter((s) => !s.canceled);
  const z = edgeZone();
  let verdict = '还没有采到左边缘滑动的样本（请在子页面从左边缘向右滑一次）。';
  if (ss.length) {
    if (lost.length >= 3) {
      verdict = `⚠️ 疑似被系统手势拦截：${lost.length}/${ss.length} 次在最左侧就被取消` +
        `（最右被吃点 x=${Math.max.apply(null, lost.map((s) => s.x))}）。已自动把起手区改为 ${z.min}~${z.max}px 避开。`;
    } else if (lost.length) {
      verdict = `有 ${lost.length}/${ss.length} 次被取消，尚未达到自动调整阈值（需 3 次）。`;
    } else if (got.length) {
      verdict = `事件正常送达（${got.length} 次未被取消），起手区 ${z.min}~${z.max}px 可用。`;
    }
  }
  return {
    total: ss.length, lost: lost.length, received: got.length,
    min: z.min, max: z.max, autoMin: _edgeProbe.autoMin,
    last: ss.length ? ss[ss.length - 1] : null,
    samples: ss.slice(-4), verdict,
  };
}

/** 独立注册探针：即使侧滑逻辑没启用，也能量到"系统到底放不放事件进来" */
export function initEdgeProbe() {
  const xOf = (e) => {
    if (e.clientX != null) return e.clientX;
    const t = e.touches && e.touches[0];
    return t ? t.clientX : -1;
  };
  const onStart = (e) => {
    if (_probeCur) return;                       // pointer 与 touch 会双发，只记一次
    const x = xOf(e);
    if (x < 0 || x > EDGE_PROBE_ZONE) return;
    _probeCur = { x: Math.round(x), kind: e.type, ours: false, canceled: false, t: Date.now() };
  };
  const onCancel = () => { if (_probeCur) { _probeCur.canceled = true; probePush(_probeCur); _probeCur = null; } };
  const onEnd = () => { if (_probeCur) { probePush(_probeCur); _probeCur = null; } };
  const opt = { capture: true, passive: true };
  document.addEventListener('pointerdown', onStart, opt);
  document.addEventListener('touchstart', onStart, opt);
  document.addEventListener('pointercancel', onCancel, opt);
  document.addEventListener('touchcancel', onCancel, opt);
  document.addEventListener('pointerup', onEnd, opt);
  document.addEventListener('touchend', onEnd, opt);
  window.__edgeProbeMarkOurs = () => { if (_probeCur) _probeCur.ours = true; };
}

export function initSwipeBack() {
  const view = $view();
  if (!view) return;
  const THRESH = 0.34;    // 超过屏宽 34% 才真正返回
  const MIN_DX = 12;      // 超过此水平位移才判定为返回意图（区别于点击 / 竖向滚动）

  let startX = 0, startY = 0, active = false, decided = false, dir = 0;

  const onDown = (e) => {
    const name = parseHash().name;
    if (!BACK_PARENT[name]) return;                 // 首页级无父级 ⇒ 不启用侧滑返回
    const t = e.target;
    if (t && t.closest && t.closest('button,a,input,textarea,select,[contenteditable]')) return;
    const z = edgeZone();
    if (e.clientX < z.min || e.clientX > z.max) return;   // 只认起手区内（区间可随实测自适应）
    startX = e.clientX; startY = e.clientY;
    active = true; decided = false; dir = 0;
    // 标记"这次事件我们接住了"：探针据此区分"被系统吃掉"与"我们自己没认"
    if (window.__edgeProbeMarkOurs) window.__edgeProbeMarkOurs();
  };

  const onMove = (e) => {
    if (!active) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (!decided) {
      if (Math.abs(dx) < MIN_DX && Math.abs(dy) < MIN_DX) return;
      if (Math.abs(dx) > Math.abs(dy) && dx > 0) {
        decided = true; dir = 1;
        document.body.classList.add('swiping');
        view.style.willChange = 'transform';
      } else { active = false; return; }             // 竖向 / 反向 ⇒ 交还页面（滚动等）
    }
    if (dir !== 1) return;
    e.preventDefault();                              // 已判定为返回手势 ⇒ 阻止页面滚动
    const w = window.innerWidth || 360;
    const pulled = Math.min(dx, w * 0.92);
    const prog = Math.max(0, Math.min(1, pulled / (w * THRESH)));
    view.style.transform = 'translateX(' + pulled + 'px)';
    view.style.setProperty('--swipe-dim', (prog * 0.28).toFixed(3));
    showSwipeHint(prog);
  };

  const onUp = (e) => {
    if (!active) return;
    const dx = e.clientX - startX;
    finish(dx > (window.innerWidth || 360) * THRESH);
  };
  const onCancel = () => finish(false);

  const finish = (commit) => {
    if (!active) return;
    active = false;
    if (!decided || dir !== 1) { resetSwipe(view); return; }
    const name = parseHash().name;
    document.body.classList.remove('swiping');
    view.classList.add('swipe-release');
    if (commit && _isBusy()) {
      // 倾诉进行中：温柔提示并先保存，再离开（与物理返回键共用同一确认语义）
      resetSwipe(view);
      gentleConfirm('正在为你保存这片深海的记忆… 现在离开，这次倾诉会留在这里，确定离开吗？')
        .then((ok) => {
          if (!ok) return;
          if (rec.active) { endCapture().then(() => go(_parentOf(name))); }
          else go(_parentOf(name));
        });
      return;
    }
    if (commit) {
      const w = window.innerWidth || 360;
      view.style.transform = 'translateX(' + w + 'px)';
      let done = false;
      const after = () => {
        if (done) return; done = true;
        view.removeEventListener('transitionend', after);
        go(_parentOf(name)); resetSwipe(view);
      };
      view.addEventListener('transitionend', after);
      setTimeout(after, 340);                        // 兜底：transitionend 万一不来
    } else {
      view.style.transform = 'translateX(0)';
      let done = false;
      const after = () => {
        if (done) return; done = true;
        view.removeEventListener('transitionend', after); resetSwipe(view);
      };
      view.addEventListener('transitionend', after);
      setTimeout(after, 340);
    }
  };

  view.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove, { passive: false });
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  _swipeBound = true;
}

/** 离线浮条：断网时浮动提示，恢复后自动隐藏 */
function updateOfflineBar() {
  const bar = document.getElementById('offlineBar');
  if (!bar) return;
  const offline = navigator.onLine === false;
  bar.hidden = !offline;
  document.body.classList.toggle('is-offline', offline);
}

/* ---------------- 首次欢迎弹窗（墨小溟 · §3.3 / §4.3 版本1） ---------------- */

const WELCOME_KEY = 'moxiaoming:welcomed_v1';

/* v1.6.0 文档 §二：4 屏新手引导（首次打开触发，可跳过）
 * 原来只有 1 屏欢迎，文档要求 4 屏且**每屏可跳过**、走完弹问候气泡。
 * 关键点：
 *   1. 走完（或跳过）都要写 WELCOME_KEY —— 否则用户第二次打开被再问一遍，比不问更烦；
 *   2. 结束时要往**对话区**塞一句问候气泡（appendConvo），不是 toast ——
 *      toast 三秒就没，而文档要的是「引导结束后自动弹出首条问候气泡」，
 *      它得留在对话里，成为这段关系的第一句话；
 *   3. 第 3 屏的边界声明与热线必须真的能看到（tappable），不能只写在文案里当装饰。 */
function showWelcome() {
  let shown = false;
  try { shown = localStorage.getItem(WELCOME_KEY) === '1'; } catch (e) {}
  if (shown) return;
  const OB = COPY.onboarding || {};
  const screens = [OB.screen1, OB.screen2, OB.screen3, OB.screen4].filter(Boolean);
  if (screens.length < 4) return; // 文案不齐就别弹（半截引导比不引导更糟）
  let i = 0;

  const overlay = document.createElement('div');
  overlay.className = 'welcome-overlay welcome-overlay--steps';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  document.body.appendChild(overlay);

  const dots = () => screens.map((_, k) => `<i class="wdot${k === i ? ' wdot--on' : ''}"></i>`).join('');
  const face = () => (i === 2 ? mascot('danger', 120) : mascot('idle', 120));

  // 🔴 这函数以前叫 render()，把**模块级的页面 render 遮蔽**了 —— finish() 里写的
  //    render() 其实调的是这个画浮层的局部函数 ⇒ 页面一动不动（问候进了 state，屏幕没字）。
  //    现在改叫 paint()（只画浮层），finish() 里才能调到真正的页面 render()。
  function paint() {
    const s = screens[i];
    const last = i === screens.length - 1;
    overlay.innerHTML = `
      <div class="welcome-card">
        <div class="welcome-progress">${dots()}</div>
        <div class="welcome-ip">${face()}</div>
        <div class="welcome-badge">${esc(OB.done ? (i === 2 ? '重要提醒' : (last ? OB.done : COPY.welcome.badge)) : COPY.welcome.badge)}</div>
        <div class="welcome-title">${esc(s.title)}</div>
        <div class="welcome-lines">${esc(s.body)}</div>
        <button class="primary" id="wNext" type="button">${esc(last || !OB.next ? OB.done : OB.next)}</button>
        <div class="welcome-btns">
          ${i > 0 ? `<button class="linkbtn" id="wBack" type="button">${esc(OB.back)}</button>` : ''}
          <button class="linkbtn" id="wSkip" type="button">${esc(OB.skip)}</button>
        </div>
      </div>`;
    const next = document.getElementById('wNext');
    const back = document.getElementById('wBack');
    const skip = document.getElementById('wSkip');
    if (next) next.addEventListener('click', () => { if (last) finish(); else { i += 1; paint(); } });
    if (back) back.addEventListener('click', () => { if (i > 0) { i -= 1; paint(); } });
    if (skip) skip.addEventListener('click', finish);
  }

  function finish() {
    try { localStorage.setItem(WELCOME_KEY, '1'); } catch (e) {}
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    // 文档点名：结束弹的是**问候气泡**（留在对话区），不是一闪而过的 toast
    appendConvo('ai', (COPY.onboardingDone && COPY.onboardingDone) || COPY.opening);
    // 🔴 v1.6.0 缺陷修复：store.subscribe 只挂了 renderToast，**state 变了不会自动重绘**。
    //    少了这一行，问候语进的是 state.conversation、页面上却一个字都没有 ——
    //    数据层断言全绿（doc-closure 验的就是数据层），肉眼却看不到任何气泡。
    //    这类「状态对了、屏幕没动」的缺陷只有真跑浏览器才抓得到。
    //    注意这里要调的是**模块级页面 render**（paint 只画浮层，shadow 过一轮才看清）。
    render();
  }

  paint();
}

/* ---------------- 启动 ---------------- */

export function boot() {
  store.initStore();
  // v1.3.0 记忆地基：首次启动把既有 localStorage 时间线卡播种进 IndexedDB（一次性，
  // 用 settings.migrated 守卫，已迁过就不再跑）。失败静默。
  memory.migrateFromLocalStorage(store.getState()).catch(() => {});
  // v1.1.4：先把上一次会话的诊断日志接回来，再打本次环境快照。
  // 之前 persist() 每步都在写，但 restore() 全仓没有任何调用点 ⇒ 日志写着却永远读不回来，
  // 刷新一次就断——「复现完了再看」这个用法等于没实现。
  diag.restore();
  // 环境快照要打在第一条链路日志之前：没有「我是谁、什么环境、什么通道」这一行，
  // 后面的耗时与错误码在离开这台机器之后就没有上下文了。
  diag.snapshot({ platform: isNativeApp() ? 'Android(APK)' : 'Web', provider: api.aiStatus().provider });
  store.subscribe(() => { renderToast(); });
  // 路由切换 = 一次真实用户动作：推进交互时间戳，重置 §三.4 的 3 分钟回归计时
  onChange(() => { store.touchInteraction(); render(); });
  if (!location.hash) location.hash = '#/say';
  render();
  // v1.3.3：异步取历史情绪偏向 → 生成首页问候（首帧先用时段问候兜底，取到后重渲染）
  initGreeting().then(() => { try { if ((parseHash().name || 'say') === 'say') render(); } catch (e) { /* ignore */ } });
  showWelcome();
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
  }
  // 启动即探一次 ASR 服务端。两个作用：
  // ① 把「这次到底能不能用语音」提前问清楚，而不是等用户说了半天才发现不行；
  // ② 服务端会顺手预热百度 access_token，让第一次识别少一次取 token 的往返（约 0.3-0.8s）。
  asr.probeCloud().catch(() => {});
  // v1.6.2 月度情绪复盘：每月 1 号自动生成一次（1 号已过不再补弹，由手动入口兜住）
  autoMonthlyReview();
  // v0.7.0：启动版本检测（打开 App 第一时间知道有新版）+ 回到前台再检测一次
  update.initUpdate();
  // v1.1.10：全局硬件返回键（物理键 + 系统侧滑手势）+ 离线浮条
  registerBackHandler();
  // v1.2.1 攻坚：左滑返回手势（触摸层，与物理键共用父级映射）
  // v1.4.2：探针必须**先于**侧滑注册，才能量到"系统到底放不放事件进来"
  initEdgeProbe();
  initSwipeBack();
  // v1.3.0 IP 视觉引擎：轻音效接入全局 + 按开关初始化（默认关）
  window.ipAudio = ipAudio;
  ipAudio.setEnabled(store.getState().user.settings.soundOn === true);
  // v1.6.3 动效编排：读配置 → 写 CSS 变量（配置丢了也不许冻住 IP，见 motion.js）
  // 🔴 window.motion 必须先挂上：下面这三行、设置页两个联动、handleIpTap 全部走 window.motion 判定，
  //    漏了这一句 == 整条动效链路静默空转（import 拿得到、window 上没有 = 没人接），
  //    与 ipAudio 那句 window.ipAudio = ipAudio 是同一个必须显式挂全局的道理。
  window.motion = motion;
  try {
    if (window.motion) {
      window.motion.load().catch(() => {});
      window.motion.setEnabled(store.getState().user.settings.ipMotion !== false);
      window.motion.setIntensity(store.getState().user.settings.ipIntensity || 'standard');
    }
  } catch (e) { /* 动效配置失败不许影响主流程 */ }
  window.addEventListener('online', updateOfflineBar);
  window.addEventListener('offline', updateOfflineBar);
  updateOfflineBar();
  // 离开页面时把没发完的埋点送出去（keepalive，不阻塞卸载）
  window.addEventListener('pagehide', () => { asr.flushEvents(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) asr.flushEvents(); });
}

// 供自测与调试使用
export const __test__ = { findForbidden, COPY, api, asr, rec, CAP, store, extractPartialSummary,
  handleHardwareBack, gentleConfirm, updateOfflineBar, BACK_PARENT, _isBusy, _parentOf, initSwipeBack, ipSM, render, currentIpDesc: () => currentIpDesc,
  monthly, generateMonthlyReview, monthlyCardView, showMonthlyModal, autoMonthlyReview };
