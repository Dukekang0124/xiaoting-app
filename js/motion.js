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
 *    既没有消费方、样式表里也没有对应 @keyframes ⇒ 整块配置是死的（改了不生效，比没有更糟）。
 *    现在：真挂类、真写变量、关掉总开关或高危定格时真收手。
 *
 * 挂载点选 IP 的**外层包裹元素**（.say__mascot / .cf-mascot / .fu-mascot）：
 * 外层承载情绪位移，内层继续跑待机浮沉 —— 两层嵌套 transform，互不覆盖。
 * 状态色（.mascot--x）仍由 ip.js 的渲染负责，这里**不碰**，避免两处抢同一个类。
 */
export function setState(state) {
  if (typeof document === 'undefined') return null;
  const em = (cfg && cfg.emotion_motion_map) || {};
  const el = document.querySelector('.say__mascot')
    || document.querySelector('.cf-mascot')
    || document.querySelector('.fu-mascot')
    || document.querySelector('.mascot');
  if (!el) return null;
  // 先摘掉上一次的情绪动画类：换情绪时不能留着旧位移，也不能两层叠加
  Object.values(em).forEach((v) => { const a = (v || {}).ip_anim; if (a) el.classList.remove(a); });
  const spec = state ? em[state] : null;
  if (!spec) return null;
  const lock = spec.lock_motion === true;               // danger：只定格，不做活泼位移
  if (enabled && !lock && spec.ip_anim) {
    void el.offsetWidth;                                // 强制重排，让同一动画能重头播
    el.classList.add(spec.ip_anim);
  }
  try {
    const r = document.documentElement;
    r.style.setProperty('--mm-particle', String(spec.particle || 'none'));
    r.dataset.particle = String(spec.particle || 'none');
  } catch (e) { /* ignore */ }
  return { state, ip_state: spec.ip_state, ip_anim: spec.ip_anim, particle: spec.particle, lock };
}

export function onChange(fn) { if (typeof fn === 'function') listeners.add(fn); }

export default {
  load, mount, getConfig, setEnabled, isEnabled, setIntensity, playTap, setState, onChange,
};
