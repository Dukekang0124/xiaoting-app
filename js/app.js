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
import * as diag from './diag.js';
import { parseHash, go, onChange } from './router.js';
import { COPY, greetByHour, findForbidden, pickRiskScript, pickEmotionResponse, pickSilence, pickBy } from './prompts.js';
import { AI, ASR, isNativeApp } from './config.js';

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
  const lvl = rec.volumeProbe ? rec.volumeProbe.getLevel() : 0;
  try { document.documentElement.style.setProperty('--ip-vol', String(lvl)); } catch (e) { /* ignore */ }
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
  if (rec.active) return;
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
  document.body.classList.add('recording');
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
  }

  // 录音都没建起来（没设备 / 拒绝授权）→ 立刻说清楚并送去打字。
  // 这一条是端到端测试逼出来的：旧写法会让人对着一个假按钮说半分钟，最后只得到一句"没听清"，
  // 用户会以为是自己没说清楚 —— 这是最伤人的一种失败。
  if (rec.mode !== 'native' && !rec.media) {
    rec.active = false;
    document.body.classList.remove('recording');
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

  // 原生模式：向设备收尾，拿它转写好的文字
  let nativeRes = null;
  if (rec.mode === 'native' && rec.native) {
    try { rec.native.stop(); } catch (e) { /* ignore */ }
    nativeRes = await rec.native.done;
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
  const label = document.getElementById('talkLabel');
  // 隐私设置真的生效：关掉「允许把录音发给云端转写」后，这段音频一个字都不上传。
  const cloudAllowed = store.getState().user.settings.cloudAsr !== false;

  if (nativeRes && nativeRes.ok && nativeRes.text) {
    text = nativeRes.text;   // 设备识别结果优先：它不需要网络往返，也最贴近设备麦克风的实际采样
    diag.note('asr', 'native', { ok: true, ms: Date.now() - (rec.t0 || Date.now()), detail: `设备识别完成，${text.length} 字` });
    asr.logEvent('asr_ok', { engine: 'native', ms: 0, totalMs: Date.now() - (rec.t0 || Date.now()), chars: text.length });
  } else if (nativeRes && !nativeRes.ok) {
    fail = { code: nativeRes.code || 'native_failed' };
    diag.note('asr', 'native', { ok: false, code: fail.code, ms: Date.now() - (rec.t0 || Date.now()), detail: `设备识别未给出文本（${fail.code}）` });
    asr.logEvent('asr_fail', { engine: 'native', code: fail.code, totalMs: Date.now() - (rec.t0 || Date.now()) });
  } else if (blob && blob.size > 0 && cloudAllowed && (await asr.probeCloud()) !== 'unavailable') {
    if (label) label.textContent = '识别中…';
    setLiveText(COPY.analyzing[0]);
    const r = await asr.recognize(blob);
    if (r.ok) {
      text = r.text; // 云端结果优先：内置转写只是兜底，不该覆盖更准的那个
      asr.logEvent('asr_ok', { engine: 'cloud', ms: r.ms || 0, totalMs: r.totalMs || 0, chars: text.length });
    } else {
      fail = r;
      asr.logEvent('asr_fail', { engine: 'cloud', code: r.code || '', errNo: r.errNo || 0, totalMs: r.totalMs || 0 });
    }
  } else if (blob && blob.size > 0 && !cloudAllowed) {
    asr.logEvent('asr_skipped', { reason: 'cloud_disabled_by_user' });
  }

  if (label) label.textContent = '按住说';
  if (!text) {
    asr.logEvent('asr_empty', { reason: fail ? (fail.code || 'failed') : (blob ? 'no_speech' : 'no_audio'),
      had_sr: srText ? 1 : 0, mode: rec.mode });
    store.setState({ ipState: 'idle' });
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
  const last = s.cards[0];
  const sessionUser = (s.sessionLog || []).filter((m) => m.role === 'user' && m.text).length;
  return `
  <section class="say">
    <header class="say__head">
      <div class="say__date">${todayText()}</div>
      <h1 class="say__greet">${greetByHour()}</h1>
    </header>
    <div class="say__mascot">${mascot(s.toast ? 'happy' : 'idle', 200)}</div>
    <div class="say__action">
      <button class="talkbtn" id="talkbtn" type="button">
        <span class="talkbtn__label" id="talkLabel">按住说</span>
        <span class="talkbtn__timer" id="recTimer">0.0s</span>
        ${wave('wave--btn')}
      </button>
      <p class="say__hint">不用组织语言，想到哪说到哪</p>
      ${sessionUser ? `<button class="endvent-btn" id="endVent" type="button">结束倾诉</button>` : ''}
      <a class="say__type" href="#/record?mode=text">不方便说？打字也行</a>
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
    </a>` : `<div class="empty-hint">还没有卡片。说一次，就会有一张。</div>`}
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
    <div class="record__mascot">${mascot('listening', 140)}</div>
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
      const text = (input.value || '').trim();
      if (!text) { store.toast('还没说话呢'); return; }
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
    <div class="stage-mascot">${mascot('thinking', 190)}</div>
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
    <div class="fu-mascot">${mascot('empathy', 130)}</div>
    ${d.empathy ? `<p class="fu-empathy">${esc(d.empathy)}</p>` : ''}
    <div class="fu-lead">${esc(COPY.followupLead[idx] || COPY.followupLead[0])}</div>
    <div class="fu-question" data-q="${esc(d.currentQuestion || '')}">${esc(d.currentQuestion || '再多说一点？')}</div>
    <textarea class="big-input" id="fuInput" placeholder="不想说也可以跳过……"></textarea>
    <button class="primary" id="fuNext" type="button">回答</button>
    <div class="row-center"><button class="linkbtn" id="fuSkip" type="button">跳过这个问题</button></div>
    ${a.summary ? `<p class="fu-note">${esc(a.summary)}</p>` : ''}
  </section>`;
}

function bindFollowup() {
  const next = document.getElementById('fuNext');
  const skip = document.getElementById('fuSkip');
  const skipTop = document.getElementById('fuSkipTop');
  const input = document.getElementById('fuInput');
  if (next) next.addEventListener('click', () => advanceFollowup(input.value));
  if (skip) skip.addEventListener('click', () => advanceFollowup('不想说，跳过'));
  if (skipTop) skipTop.addEventListener('click', () => advanceFollowup('不想说，跳过'));
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
    <div class="gentle__mascot">${mascot('empathy', 150)}</div>
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
    <div class="cf-mascot catch-in">${mascot(c.ip_state || 'empathy', 112)}</div>
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

/** 时间线正文（有情绪）：柔和曲线 + 节点说明 + 小结 + 微小停靠提示 */
function timelineBody(tl) {
  const nodes = tl.nodes || [];
  const rows = nodes.map((nd, i) => {
    const emo = (nd.emotions && nd.emotions.length) ? nd.emotions.join(' + ') : '（没捕捉到明显情绪）';
    const tail = nd.merged && nd.count > 1 ? `　（后面 ${nd.count} 轮合在这里）` : '';
    return `<div class="tl-node">
      <div class="tl-node__no">第 ${i + 1} 段</div>
      <div class="tl-node__emo">${esc(emo)}</div>
      <div class="tl-node__cap">${esc(nd.text || '')}${tail}</div>
    </div>`;
  }).join('');
  const hint = tl.actionHint || {};
  return `
    <div class="tl-card">
      <div class="tl-corner">${miniFace('empathy', 26)}</div>
      ${timelineCurve(nodes)}
      <div class="tl-nodes">${rows}</div>
      <div class="tl-summary">${esc(tl.summary || '')}</div>
      ${hint.title ? `<div class="tl-hint">
        <div class="tl-hint__label">一个很小的停靠（不强制）</div>
        <div class="tl-hint__title">${esc(hint.title)}</div>
        <div class="tl-hint__step">${esc(hint.step || '')}</div>
        ${hint.note ? `<div class="tl-hint__note">${esc(hint.note)}</div>` : ''}
      </div>` : ''}
    </div>
    <p class="tl-disclaimer">${esc(TIMELINE_DISCLAIMER)}</p>
    ${timelineActions(tl)}`;
}

/** 时间线正文（全程无情绪）：简化卡，只留一句说明 */
function timelineEmptyBody(tl) {
  return `
    <div class="tl-card tl-card--empty">
      <div class="tl-corner">${miniFace('idle', 26)}</div>
      <div class="tl-summary">${esc(tl.summary || '本次对话更多是陈述事件，没有捕捉到明显情绪')}</div>
    </div>
    <p class="tl-disclaimer">${esc(TIMELINE_DISCLAIMER)}</p>
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
    <h2 class="tl-title">${tl.id ? '深海情绪记录' : '本次深海情绪记录'}</h2>
    <p class="tl-sub">情绪本来就会起伏波动，没有好坏${when}</p>
    ${body}
  </section>`;
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
  return `<section class="weekly" id="weeklyRoot"><div class="loading">正在整理这一周……</div></section>`;
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
  return `
  <section class="me">
    <div class="page-title center">我</div>
    <div class="me__head">
      <div class="me__face">${avatar('idle', 62)}</div>
      <div>
        <div class="me__name">${esc(s.user.nickname || '你')}</div>
        <div class="me__meta">已记录 ${s.cards.length} 张情绪卡片</div>
      </div>
    </div>
    <nav class="mlist">
      <a class="mrow mrow--weekly" href="#/weekly">
        <span class="mrow__ico">${ICON.weekly}</span>
        <span class="mrow__txt">本周情绪体检<span class="mrow__sub">看看这周的情绪走向</span></span>
        <i class="mrow__arrow">›</i>
      </a>
      <a class="mrow mrow--cards" href="#/cards">
        <span class="mrow__ico">${ICON.cards}</span>
        <span class="mrow__txt">我的卡片<span class="mrow__sub">${s.cards.length ? `共 ${s.cards.length} 张，都是你说过的` : '还没有卡片，去说一次吧'}</span></span>
        <i class="mrow__arrow">›</i>
      </a>
      <a class="mrow mrow--timelines" href="#/timelines">
        <span class="mrow__ico">${ICON.timeline}</span>
        <span class="mrow__txt">情绪时间线<span class="mrow__sub">${(s.timelines || []).length ? `已保存 ${s.timelines.length} 次倾诉的起伏` : '还没有保存过，结束倾诉时可以存一张'}</span></span>
        <i class="mrow__arrow">›</i>
      </a>
      <a class="mrow mrow--settings" href="#/settings">
        <span class="mrow__ico">${ICON.settings}</span>
        <span class="mrow__txt">设置与隐私<span class="mrow__sub">记录存本机，随时可删</span></span>
        <i class="mrow__arrow">›</i>
      </a>
      <a class="mrow mrow--about" href="#/changelog">
        <span class="mrow__ico">${ICON.about}</span>
        <span class="mrow__txt">关于墨小溟<span class="mrow__sub">版本更新与更新历史</span></span>
        <i class="mrow__arrow">›</i>
      </a>
    </nav>
    <p class="foot-note">墨小溟不会诊断，也不是心理医生。<br/>它只是陪你把心事说出来。</p>
  </section>`;
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
    <p class="foot-note">墨小溟 MVP · v${esc(window.APP_VERSION || '1.1.5')}</p>
  </section>`;
}

function bindSettings() {
  // v0.5.0：原来的「分析后自动删除录音」是个死开关 —— 它只写进 store，没有任何地方读，
  // 无论开关状态录音都不会被保存在任何地方。对一个主打"敢说真话"的产品，
  // 一个不起作用的隐私开关比没有开关更糟，所以这里换成真正生效的控制：
  // 关掉就不再上传录音（endCapture 会读这个设置）。
  const cb = document.getElementById('setCloudAsr');
  if (cb) cb.addEventListener('change', () => store.setSetting('cloudAsr', cb.checked));
  const wipe = document.getElementById('wipe');
  if (wipe) wipe.addEventListener('click', async () => {
    if (window.confirm('确定删除全部数据吗？此操作不可恢复。')) {
      await api.userDataDelete();
      store.toast('已删除全部数据');
      go('say');
    }
  });
}

/* ---------------- 页面：关于墨小溟 / 更新历史 ---------------- */

function pageChangelog() {
  return `
  <section class="changelog">
    <div class="page-head"><a class="ghost" href="#/me">返回</a><div class="page-title">关于墨小溟</div><span style="width:48px"></span></div>
    <div class="changelog__ip">${avatar('happy', 64)}</div>
    <div class="changelog__ver">当前版本 v${esc(window.APP_VERSION || '1.1.5')}</div>
    <div class="about-persona">${esc(COPY.about.persona)}</div>
    <p class="changelog__desc">${esc(COPY.about.intro)}</p>
    <p class="changelog__desc">${esc(COPY.about.pronunciation)}</p>
    <div class="disclaimer-box">${esc(COPY.about.disclaimer)}</div>
    <div class="changelog__list" id="clList"><p class="set-sub">正在加载更新历史…</p></div>
    <button class="primary" id="clCheck" type="button">检查更新</button>
    <p class="foot-note">墨小溟 · v${esc(window.APP_VERSION || '1.1.5')}</p>
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
    el.innerHTML = '<p class="set-sub">更新历史加载失败，请稍后再试。</p>';
  }
  const check = document.getElementById('clCheck');
  if (check) check.addEventListener('click', () => {
    // 手动检查：总是尝试弹（除非已无新版）
    update.checkUpdate({ manual: true }).catch(() => {});
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
    <div class="risk__mascot">${mascot('worried', 160)}</div>
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
      <div class="risk-modal__ip">${mascot('worried', 150)}</div>
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
    <header class="page__head">
      <h1 class="page__title">链路诊断</h1>
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

    <div class="diag-card">
      <div class="diag-card__t">各阶段耗时与成败</div>
      ${sum.length ? sum.map((s) => `
        <div class="diag-kv"><span>${esc(s.stage)}</span><b>${s.calls} 次 · 成功 ${s.ok} · 失败 ${s.fail} · 均值 ${Math.round(s.ms / s.calls)}ms · 峰值 ${s.maxMs}ms${Object.keys(s.models).length ? ' · ' + esc(Object.keys(s.models).join('/')) : ''}</b></div>`).join('') : '<p class="diag-empty">还没有调用记录。</p>'}
    </div>

    <div class="diag-actions">
      <button class="primary" id="diagRun" type="button">用「我今天很烦。」跑一次真实链路</button>
      <button class="ghost" id="diagCopy" type="button">复制日志</button>
      <button class="ghost" id="diagExport" type="button">导出 .txt</button>
      <button class="ghost" id="diagClear" type="button">清空</button>
    </div>
    <div id="diagRunning" class="diag-running" hidden>正在跑：<span id="diagStage">…</span></div>

    <pre class="diag-log" id="diagLog">${esc(diag.text())}</pre>
    <p class="foot-note">日志只存在本机，不会上传。</p>
  </section>`;
}

function bindDiag() {
  const logEl = document.getElementById('diagLog');
  const refresh = () => { if (logEl) logEl.textContent = diag.text(); };

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
  me: { render: pageMe, tab: 'me', nav: true },
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

  const ip = store.deriveIpState(p.name, store.getState().risk);
  store.getState().ipState = ip;

  document.body.dataset.route = p.name;
  document.body.classList.toggle('has-nav', page.nav !== false);

  const v = $view();
  if (v) {
    v.innerHTML = page.render(p);
    // 柔和淡入淡出：先摘掉再强制回流，保证同一动画能重放
    v.classList.remove('view--enter');
    void v.offsetWidth;
    v.classList.add('view--enter');
    v.scrollTop = 0;
    window.scrollTo(0, 0);
  }
  renderTabs(page.tab || '');

  if (page.bind) page.bind(p);
  if (page.mount) page.mount(p);

  renderToast();
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

/* ---------------- 首次欢迎弹窗（墨小溟 · §3.3 / §4.3 版本1） ---------------- */

const WELCOME_KEY = 'moxiaoming:welcomed_v1';

function showWelcome() {
  let shown = false;
  try { shown = localStorage.getItem(WELCOME_KEY) === '1'; } catch (e) {}
  if (shown) return;
  const overlay = document.createElement('div');
  overlay.className = 'welcome-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.innerHTML = `
    <div class="welcome-card">
      <div class="welcome-ip">${mascot('idle', 120)}</div>
      <div class="welcome-badge">${esc(COPY.welcome.badge)}</div>
      <div class="welcome-lines">${COPY.welcome.lines.map((l) => `<p>${esc(l)}</p>`).join('')}</div>
      <button class="primary" id="welcomeStart" type="button">${esc(COPY.welcome.button)}</button>
      <p class="welcome-foot">墨小溟不会诊断，也不是心理医生。它只是陪你把心事说出来。</p>
    </div>`;
  document.body.appendChild(overlay);
  const start = document.getElementById('welcomeStart');
  if (start) start.addEventListener('click', () => {
    try { localStorage.setItem(WELCOME_KEY, '1'); } catch (e) {}
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    store.toast(COPY.opening); // IP 开场白
  });
}

/* ---------------- 启动 ---------------- */

export function boot() {
  store.initStore();
  // v1.1.4：先把上一次会话的诊断日志接回来，再打本次环境快照。
  // 之前 persist() 每步都在写，但 restore() 全仓没有任何调用点 ⇒ 日志写着却永远读不回来，
  // 刷新一次就断——「复现完了再看」这个用法等于没实现。
  diag.restore();
  // 环境快照要打在第一条链路日志之前：没有「我是谁、什么环境、什么通道」这一行，
  // 后面的耗时与错误码在离开这台机器之后就没有上下文了。
  diag.snapshot({ platform: isNativeApp() ? 'Android(APK)' : 'Web', provider: api.aiStatus().provider });
  store.subscribe(() => { renderToast(); });
  onChange(() => render());
  if (!location.hash) location.hash = '#/say';
  render();
  showWelcome();
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
  }
  // 启动即探一次 ASR 服务端。两个作用：
  // ① 把「这次到底能不能用语音」提前问清楚，而不是等用户说了半天才发现不行；
  // ② 服务端会顺手预热百度 access_token，让第一次识别少一次取 token 的往返（约 0.3-0.8s）。
  asr.probeCloud().catch(() => {});
  // v0.7.0：启动版本检测（打开 App 第一时间知道有新版）+ 回到前台再检测一次
  update.initUpdate();
  // 离开页面时把没发完的埋点送出去（keepalive，不阻塞卸载）
  window.addEventListener('pagehide', () => { asr.flushEvents(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) asr.flushEvents(); });
}

// 供自测与调试使用
export const __test__ = { findForbidden, COPY, api, asr, rec, CAP, store, extractPartialSummary };
