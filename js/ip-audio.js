// 墨小溟 · IP 轻音效（v1.3.0）
// 纯 Web Audio 合成：水墨/气泡轻音，零素材文件。受「音效开关」独立控制（默认关）。
// 设计：所有音色极轻（gain ≤ 0.05）、柔和包络、无突兀起止 —— 不喧宾夺主，不触发光敏/声敏不适。

let ctx = null;
let enabled = false;

function ensureCtx() {
  if (!ctx) {
    try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { ctx = null; }
  }
  if (ctx && ctx.state === 'suspended') { ctx.resume().catch(() => {}); }
  return ctx;
}

/** 单音：柔和包络（缓起缓落），可滑音 */
function tone({ freq = 440, freq2 = null, dur = 0.5, type = 'sine', gain = 0.05, delay = 0 }) {
  const c = ensureCtx();
  if (!c || !enabled) return;
  const t0 = c.currentTime + delay;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (freq2) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq2), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.08);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(c.destination);
  o.start(t0);
  o.stop(t0 + dur + 0.03);
}

/* 噪声源：白噪 buffer。振荡器只能做"有音高"的音，水底白噪 / 水流必须是噪声经过低通滤波。
   🔴 没有这一层，方案里那整套"水底低频白噪 / 水流浸润 / 气泡串"是合成不出来的（只有 4 个单音）。 */
let noiseBuf = null;
function getNoise(c) {
  const c2 = c || ensureCtx();
  if (!c2) return null;
  if (noiseBuf && noiseBuf.sampleRate === c2.sampleRate) return noiseBuf;
  try {
    const len = Math.floor(c2.sampleRate * 2);          // 2 秒，循环播放听不出接缝
    const buf = c2.createBuffer(1, len, c2.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;                   // 棕噪：低通后更像"深水"，不是嘶嘶的电视雪花
      d[i] = last * 3.2;
    }
    noiseBuf = buf;
  } catch (e) { noiseBuf = null; }
  return noiseBuf;
}

/** 一段滤波噪声：水流 / 白噪 / 浸润声都靠它 */
function noise({ dur = 1.2, gain = 0.03, cutoff = 420, type = 'lowpass', q = 0.6, delay = 0, loop = false, sweepTo = null }) {
  const c = ensureCtx();
  if (!c || !enabled) return;
  const buf = getNoise(c);
  if (!buf) return;
  const t0 = c.currentTime + delay;
  const src = c.createBufferSource();
  src.buffer = buf; src.loop = true;
  const flt = c.createBiquadFilter();
  flt.type = type; flt.frequency.setValueAtTime(cutoff, t0); flt.Q.value = q;
  if (sweepTo) flt.frequency.exponentialRampToValueAtTime(Math.max(60, sweepTo), t0 + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + Math.min(0.35, dur * 0.3));   // 缓起
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);                       // 缓落，杜绝"啪"的一头一尾
  src.connect(flt).connect(g).connect(c.destination);
  src.start(t0);
  const stopAt = t0 + dur + (loop ? 0 : 0.05);
  src.stop(stopAt);
}

/** 单颗气泡：短促上滑，柔、不脆 */
function bubble({ dur = 0.22, gain = 0.04, from = 380, to = 760, delay = 0 }) {
  tone({ freq: from, freq2: to, dur, gain, type: 'sine', delay });
}

/** 各场景轻音：低饱和、不刺耳。
    ⚠ 加 cue 只加名字与参数，别加新的"感觉"——整套声音设计是"水"，不是"电子"。 */
const CUES = {
  // —— 既有（app.js 已经在用，别改名）——
  emotion: () => { tone({ freq: 320, freq2: 520, dur: 0.6, gain: 0.05 }); },
  receive: () => { tone({ freq: 540, freq2: 300, dur: 0.3, gain: 0.045 }); },
  calm: () => { tone({ freq: 392, dur: 0.5, gain: 0.04 }); },
  danger: () => { tone({ freq: 190, freq2: 150, dur: 0.9, gain: 0.05, type: 'sine' }); },

  // —— 点击互动（方案 click_interact.sound）——
  bubble_soft_1: () => { bubble({ dur: 0.2, gain: 0.04, from: 360, to: 720 }); },
  water_soft_short: () => { noise({ dur: 0.7, gain: 0.03, cutoff: 520, sweepTo: 240 }); },
  water_long_heal: () => { noise({ dur: 2.2, gain: 0.035, cutoff: 300, sweepTo: 620 }); bubble({ dur: 0.5, from: 300, to: 520, delay: 0.25 }); },
  bubble_series_tiny: () => { bubble({ dur: 0.16, gain: 0.03, from: 420, to: 820, delay: 0 }); bubble({ dur: 0.16, gain: 0.03, from: 460, to: 880, delay: 0.22 }); bubble({ dur: 0.16, gain: 0.03, from: 400, to: 760, delay: 0.46 }); },

  // —— 情绪（方案 emotion_motion_map.sound）——
  bubble_happy_light: () => { bubble({ dur: 0.18, gain: 0.04, from: 520, to: 940 }); bubble({ dur: 0.2, gain: 0.035, from: 620, to: 1080, delay: 0.14 }); },
  water_deep_calm: () => { noise({ dur: 2.6, gain: 0.032, cutoff: 220, sweepTo: 150 }); tone({ freq: 196, dur: 2.2, gain: 0.028, type: 'sine' }); },
  water_stable_short: () => { noise({ dur: 0.9, gain: 0.03, cutoff: 340, q: 1.1 }); },
  water_tiny_steady: () => { noise({ dur: 1.4, gain: 0.024, cutoff: 900, sweepTo: 500 }); },
  whisper_noise_low: () => { noise({ dur: 3.2, gain: 0.02, cutoff: 260 }); },
  bubble_intermittent: () => { bubble({ dur: 0.16, gain: 0.03, from: 400, to: 760, delay: 0 }); bubble({ dur: 0.16, gain: 0.03, from: 340, to: 620, delay: 0.5 }); },
  base_comfort_low: () => { tone({ freq: 174, dur: 1.6, gain: 0.035, type: 'sine' }); noise({ dur: 1.8, gain: 0.022, cutoff: 200 }); },

  // —— 场景（方案 scene_effect）——
  bubble_single_soft: () => { bubble({ dur: 0.26, gain: 0.038, from: 340, to: 680 }); },
  water_card_pop: () => { noise({ dur: 0.5, gain: 0.03, cutoff: 420, sweepTo: 700 }); bubble({ dur: 0.18, from: 420, to: 820, delay: 0.1 }); },
  underwater_loop_very_low: () => { noise({ dur: 4, gain: 0.016, cutoff: 180 }); },
  water_long_heal_full: () => { noise({ dur: 3.4, gain: 0.034, cutoff: 240, sweepTo: 560 }); bubble({ dur: 0.6, from: 280, to: 520, delay: 0.6 }); },
};

let ambSrc = null, ambGain = null, muted = false;

/** 待机环境音：水底低频白噪，循环、极轻（默认 8%），用户开始倾诉/打字即静音（方案 §2.6）。 */
function startAmbient(vol = 0.08) {
  const c = ensureCtx();
  if (!c || !enabled || ambSrc || muted) return false;
  try {
    const buf = getNoise(c);
    if (!buf) return false;
    ambSrc = c.createBufferSource();
    ambSrc.buffer = buf; ambSrc.loop = true;
    const flt = c.createBiquadFilter();
    flt.type = 'lowpass'; flt.frequency.value = 260; flt.Q.value = 0.5;
    ambGain = c.createGain();
    ambGain.gain.setValueAtTime(0.0001, c.currentTime);
    ambGain.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), c.currentTime + 1.2); // 1.2s 淡入，不做"啪"
    ambSrc.connect(flt).connect(ambGain).connect(c.destination);
    ambSrc.start();
    return true;
  } catch (e) { ambSrc = null; return false; }
}
function stopAmbient() {
  if (!ambSrc) return;
  try {
    const c = ensureCtx();
    if (ambGain && c) {
      const t = c.currentTime;
      ambGain.gain.cancelScheduledValues(t);
      ambGain.gain.setValueAtTime(Math.max(0.0001, ambGain.gain.value || 0.0001), t);
      ambGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    }
    ambSrc.stop(c ? c.currentTime + 0.7 : 0);
  } catch (e) { /* 已经停了 */ }
  ambSrc = null; ambGain = null;
}

export const ipAudio = {
  /** 由设置开关驱动；开启即尝试解锁音频上下文 */
  setEnabled(v) {
    enabled = !!v;
    if (enabled) { ensureCtx(); startAmbient(); } else { stopAmbient(); }
  },
  isEnabled() { return enabled; },
  /** 触发一种轻音（哑音时直接吞掉，不排队） */
  cue(kind) { if (muted) return false; const f = CUES[kind]; if (f) { f(); return true; } return false; },
  /** 待机环境音 */
  startAmbient, stopAmbient,
  isAmbient() { return !!ambSrc; },
  /** 倾诉 / 打字时静音（保住"低频浸润"不抢用户的声音） */
  setMuted(v) {
    muted = !!v;
    if (muted) stopAmbient();
    return muted;
  },
  isMuted() { return muted; },
};

// 浏览器自动播放策略：首次用户手势后解锁 AudioContext
if (typeof window !== 'undefined') {
  const unlock = () => { ensureCtx(); };
  window.addEventListener('pointerdown', unlock, { once: false });
  window.addEventListener('keydown', unlock, { once: false });
}

/** 全部音效名清单——反向断言用它当"真源"：配置里引用了不存在的 sound 必须红，
 *  不能让"写了名字但没这个音"变成静默失效（用户点下去没声音，只会以为坏了）。 */
export const CUE_NAMES = Object.keys(CUES);

export default ipAudio;
