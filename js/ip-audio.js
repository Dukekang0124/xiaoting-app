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

/** 各场景轻音：低饱和、不刺耳 */
const CUES = {
  // 情绪浮现：温柔的水滴上滑（像墨滴落水）
  emotion: () => { tone({ freq: 320, freq2: 520, dur: 0.6, gain: 0.05 }); },
  // 接收情绪：轻轻一「啵」（短促下潜）
  receive: () => { tone({ freq: 540, freq2: 300, dur: 0.3, gain: 0.045 }); },
  // 平静：单音轻叹
  calm: () => { tone({ freq: 392, dur: 0.5, gain: 0.04 }); },
  // 高危：低沉、缓慢、柔和的一次轻鸣（不做尖锐警报，避免惊吓）
  danger: () => { tone({ freq: 190, freq2: 150, dur: 0.9, gain: 0.05, type: 'sine' }); },
};

export const ipAudio = {
  /** 由设置开关驱动；开启即尝试解锁音频上下文 */
  setEnabled(v) { enabled = !!v; if (enabled) ensureCtx(); },
  isEnabled() { return enabled; },
  /** 触发一种轻音 */
  cue(kind) { const f = CUES[kind]; if (f) f(); },
};

// 浏览器自动播放策略：首次用户手势后解锁 AudioContext
if (typeof window !== 'undefined') {
  const unlock = () => { ensureCtx(); };
  window.addEventListener('pointerdown', unlock, { once: false });
  window.addEventListener('keydown', unlock, { once: false });
}

export default ipAudio;
