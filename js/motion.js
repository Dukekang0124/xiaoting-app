// 墨小溟 · 动效/音效编排层（v1.6.3）
// 唯一职责：把 moxiaoming_motion_sound_config.json 里的参数**真正写进** CSS 自定义属性与触手分组，
// 并提供 setEnabled / setIntensity / playTap / setState 四个入口。
//
// 🔴 为什么必须有这一层：配置如果只是"给人看的文档"，改了不生效，就是假配置——
//    和「先加了个开关但没人接」是同一类静默失效。这里所有参数都落到真实的 CSS 变量 /
//    内联 animation-delay 上，反向断言 _selftest/motion-sound-config.cjs 会逐条比对「配置写了什么」
//    与「CSS 变量实际是什么」，对不上就红。
//
// 失败一律降级、不抛错：配置读不到 ⇒ 用 CSS 里的默认值（视觉与现在完全一致），
// 动效继续跑，只是不可调。绝不能因为配置丢了就把 IP 冻住。

const DEFAULT_URL = 'moxiaoming_motion_sound_config.json';

let cfg = null;
let enabled = true;
let scale = 1;                 // 来自 ipIntensity：gentle .6 / standard 1 / full 1.3
const listeners = new Set();

const root = () => (typeof document === 'undefined' ? null : document.documentElement);
const px = (n) => `${Number(n) || 0}px`;
const ms = (n) => `${Number(n) || 0}ms`;
const scaled = (n) => (Number(n) || 0) * scale;

/** 读取配置（同源 fetch，失败返回 null，不抛）。 */
export async function load(url = DEFAULT_URL) {
  if (typeof fetch !== 'function') return null;
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) return null;
    cfg = await res.json();
  } catch (e) {
    cfg = null;
  }
  if (cfg) mount(cfg);
  return cfg;
}

export function getConfig() { return cfg; }

/** 把配置写进真实的 CSS 变量 / 内联延迟——改这里即改动效外观。 */
export function mount(config = cfg) {
  if (!config) return;
  const r = root();
  if (!r) return;
  const idle = config.idle_standby || {};
  const g = (config.global_setting || {}).motion_scales || {};

  // 待机主周期：浮动 + 呼吸 + 微光 + 垂须（原本 5.6/4.4/6.4/4.8s 四套不齐，统一成一个 6s 呼吸）
  r.style.setProperty('--mm-float-ms', ms(idle.float_cycle_ms));
  r.style.setProperty('--mm-breathe-ms', ms(idle.float_cycle_ms));
  r.style.setProperty('--mm-wisp-ms', ms((idle.tentacle_anim || {}).group_cycle_ms));
  r.style.setProperty('--mm-float-range', px(scaled(idle.vertical_range_px)));
  r.style.setProperty('--mm-breathe-scale', String((scale * (idle.float_cycle_ms ? 0.035 : 0.035)).toFixed(4)));

  // 垂须分组：振幅走 CSS 变量（keyframes 里消费），延迟走内联样式
  const t = idle.tentacle_anim || {};
  r.style.setProperty('--mm-wisp-amp', `${scaled((t.group1 || {}).amp_deg ?? 3)}deg`);
  r.style.setProperty('--mm-wisp-tiny-amp', px(scaled((t.group3 || {}).amp_px ?? 2)));
  r.style.setProperty('--mm-wisp-still-amp', `${scaled((t.group4 || {}).amp_deg ?? 1)}deg`);
  document.querySelectorAll('.tentacle').forEach((el) => {
    const n = Number((el.getAttribute('class') || '').match(/tentacle--([1-8])/)?.[1] || 0);
    const gate = Object.values(t).find((grp) => (grp || {}).ids && grp.ids.includes(n));
    if (gate && gate.delay_ms) el.style.animationDelay = ms(gate.delay_ms);
    if (gate && gate.opacity != null && el.classList.contains('tentacle--g4')) el.style.opacity = String(gate.opacity);
  });

  // 运动强度档位写进根变量，供 CSS 按档位二次缩放
  r.style.setProperty('--mm-motion-scale', String(g.scale || 1));
  applyEnabled();
  listeners.forEach((fn) => fn(cfg));
}

/** 总开关：关掉后 IP 保留静态画面、停所有动效与粒子（省电极简模式）。 */
export function setEnabled(v) { enabled = !!v; applyEnabled(); }
export function isEnabled() { return enabled; }

function applyEnabled() {
  // 🔴 复用既有 body.ip-motion-off（app.js 里唯一的总开关），不另造 class：
  //    两个 class 管同一件事 = 一边关了另一边还在动，用户看到的就是"开关坏了"。
  if (typeof document === 'undefined') return;
  document.body.classList.toggle('ip-motion-off', !enabled);
}

/** 运动强度：复用既有设置项 ipIntensity，不新造开关。 */
export function setIntensity(level) {
  const g = ((cfg && cfg.global_setting) || {}).motion_scales || {};
  scale = Number(g[level]) || 1;
  if (cfg) mount(cfg);
}

/** 点击互动：1/2/3/≥4 连击四分支，动画名与时长全部来自配置。 */
export function playTap(count) {
  if (!enabled || !cfg) return null;
  const ci = cfg.click_interact || {};
  const key = count >= 4 ? 'tap_more' : (count <= 0 ? 'tap1' : `tap${count}`);
  const spec = ci[key] || ci.tap1;
  if (!spec) return null;
  const el = document.querySelector('.say__mascot') || document.querySelector('.mascot');
  if (!el) return null;
  const cls = `${spec.anim}`;
  el.classList.remove('ip-tap1', 'ip-tap2', 'ip-tap3', 'ip-tap-over');
  void el.offsetWidth;                       // 强制重排，让同一动画能重头播
  el.style.animationDuration = ms(spec.duration_ms);
  el.classList.add(cls);
  window.setTimeout(() => el.classList.remove(cls), Number(spec.duration_ms) + 60);
  return { key, cls, duration_ms: spec.duration_ms, sound: spec.sound };
}

/**
 * 情绪状态切换（v1.6.13 **真落地**）。
 *
 * 🔴 改之前这里只有 `return { state }` —— 一个空壳，且全仓零调用。
 *    而配置 emotion_motion_map 给七种情绪各声明了 ip_anim / particle：
 *    particle 那一半既没有消费方、样式表里也没有对应 @keyframes ⇒ 死配置（改了不生效，比没有更糟），
 *    已在 v1.7.5 随 CSS 侧一并删掉；ip_anim 那半是真跑的（见下）。
 *    现在：真挂类、真写变量、关掉总开关或高危定格时真收手。
 *
 * 挂载点选 IP 的**外层包裹元素**（.say__mascot / .cf-mascot / .fu-mascot）：
 * 外层承载情绪位移，内层继续跑待机浮沉 —— 两层嵌套 transform，互不覆盖。
 * 状态色（.mascot--x）仍由 ip.js 的渲染负责，这里**不碰**，避免两处抢同一个类。
 */
/* ===================== G4 情绪稳定窗（v1.6.17） =====================
 *
 * 痛点：情绪识别在相邻轮次间会来回跳（sad→angry→sad 常常只是采样噪声，不是用户真的换了情绪）。
 * 旧实现每次 setState 都**当场**换掉 IP 上的动画类和粒子变量 ⇒ 一轮分析里连着跳三五次，
 * 视觉上是"抽搐"，而不是"情绪变了"； moreover 每次都要 `void el.offsetWidth` 强制重排，
 * 频繁重排还会把待机呼吸的连续感打断。
 *
 * 现在：同一情绪必须**持续 STABLE_MS 才真正下发**动效；窗口内来回跳只会把窗口推倒重来
 * （短时波动 = 不切）。danger（emotion_motion_map.danger.lock_motion=true）**不受此窗约束**，
 * 立刻定格 —— 安全信号迟 2.5s 到，等于没做。
 *
 * 兜底 MAX_WAIT：若情绪以「永远填不满 2.5s」的节奏无限交替，防抖会把切换无限推迟。
 * 这里压一个时间上限，到点强制刷出**当时**的最新状态，宁可早切也不让用户等成一个死动画。
 */
const EMOTION_STABLE_MS = 2500;
const STABLE_MAX_WAIT_MS = 6000;

let appliedState = null;   // 已真正落地的动效状态
let lastEl = null;         // 上次落地动效时挂类的那个 IP 节点（换页后它会被销毁）
let pendingState = null;   // 窗口里蹲着的最新（候选）状态
let pendingSince = 0;
let stableTimer = null;
let maxWaitTimer = null;

function clearPending() {
  if (stableTimer) { clearTimeout(stableTimer); stableTimer = null; }
  if (maxWaitTimer) { clearTimeout(maxWaitTimer); maxWaitTimer = null; }
  pendingState = null;
  pendingSince = 0;
}

/** 真正落地一次动效（= 旧 setState 的主体，唯一的下发出口）。 */
function applyState(state) {
  if (typeof document === 'undefined') return null;
  const em = (cfg && cfg.emotion_motion_map) || {};
  const el = document.querySelector('.say__mascot')
    || document.querySelector('.cf-mascot')
    || document.querySelector('.fu-mascot')
    || document.querySelector('.mascot');
  if (!el) return null;
  lastEl = el;
  // 先摘掉上一次的情绪动画类：换情绪时不能留着旧位移，也不能两层叠加
  Object.values(em).forEach((v) => { const a = (v || {}).ip_anim; if (a) el.classList.remove(a); });
  const spec = state ? em[state] : null;
  if (!spec) return null;
  const lock = spec.lock_motion === true;               // danger：只定格，不做活泼位移
  if (enabled && !lock && spec.ip_anim) {
    void el.offsetWidth;                                // 强制重排，让同一动画能重头播
    el.classList.add(spec.ip_anim);
  }
  // 🔴 v1.7.5（P2-1）：这里原来还会写 `--mm-particle` / `data-particle`，但 styles.css 里
  //    0 处消费（没有 var() 引用、没有 [data-particle] 选择器）⇒ 写了就是白写，
  //    配置里那套 particle_count/alpha/color 和七种情绪的 particle 字段同样零读。
  //    死配置比没有更糟（改了不生效），按「宁缺勿假」整块删掉，不留悬空字段。
  const out = { applied: true, state, ip_state: spec.ip_state, ip_anim: spec.ip_anim, lock };
  appliedState = state;
  return out;
}

/** 把窗口里蹲着的最新状态立刻落地（同步返回真实结果，供需要即时断言的场景用）。 */
export function flush() {
  if (!pendingState) return null;
  const target = pendingState;
  clearPending();
  return applyState(target);
}

/** 当前窗口状态（给探针/诊断读，不产生副作用）。 */
export function getStability() {
  return {
    stable_ms: EMOTION_STABLE_MS,
    applied: appliedState,
    pending: pendingState,
    pending_ms: pendingSince ? Math.max(0, Date.now() - pendingSince) : 0,
  };
}

export function setState(state, opts = {}) {
  const em = (cfg && cfg.emotion_motion_map) || {};
  const spec = state ? em[state] : null;
  // 高危定格 / 显式要求即时：越过稳定窗，直接落地（安全优先）
  if (opts.immediate === true || (spec && spec.lock_motion === true)) {
    clearPending();
    return applyState(state);
  }
  if (state === appliedState) {
    clearPending();
    // 🔴 换页后 IP 节点是全新的（render() 整块 innerHTML 重写，动画类随旧节点一起没了）。
    //    此时若照旧 return null，就变成「第二次进同一情绪页，IP 一动不动」——v1.6.13 自己引入的静默失效。
    //    节点还连在文档里才是"没变化"；节点已被换掉 ⇒ 新节点老老实实重新挂一次。
    if (lastEl && lastEl.isConnected) return null;
    return applyState(state);
  }
  if (state === pendingState) return null;                       // 已知在途，不重复计时
  // 换了新情绪：窗口推倒重来 —— 这就是"短时波动不切"的定义
  pendingState = state;
  pendingSince = Date.now();
  if (stableTimer) clearTimeout(stableTimer);
  if (maxWaitTimer) clearTimeout(maxWaitTimer);
  stableTimer = setTimeout(() => {
    stableTimer = null;
    const target = pendingState;
    pendingState = null;
    pendingSince = 0;
    if (target) applyState(target);
  }, EMOTION_STABLE_MS);
  maxWaitTimer = setTimeout(() => {
    maxWaitTimer = null;
    if (!pendingState) return;               // 已被正常窗口刷掉
    const target = pendingState;
    clearPending();
    applyState(target);
  }, STABLE_MAX_WAIT_MS);
  return { applied: false, pending: true, state, wait_ms: EMOTION_STABLE_MS };
}

export function onChange(fn) { if (typeof fn === 'function') listeners.add(fn); }

export default {
  load, mount, getConfig, setEnabled, isEnabled, setIntensity, playTap, setState, flush, getStability, onChange,
};
