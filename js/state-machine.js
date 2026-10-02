// 墨小溟 · IP 情绪状态机与视觉联动调度层（v1.3.0 视觉基建）
// ===================================================================
// 职责（纯函数为主，便于单元测试；不依赖 DOM）：
//   1. §一 反馈节点时序：idle / listening / receiving / emotion_render / ai_reply / danger
//   2. §二 情绪强度分级与色彩配置（10 态 JSON，前端直接读取，SSOT）
//   3. §三 过渡规则：0.6~1.2s ease-in-out（由 CSS @property 承担）、3 分钟回归、手动重置、高危截断
//   4. 把中文情绪词（ai.js 的 EMOTION_LEX / 模型 ip_state）映射到调色板键
//
// 设计约束（对接既有骨架，不破坏 v1.2.0 的路由态）：
//   - 现有 store.deriveIpState(route,risk) 继续负责「路由/风险 → 内部态」（thinking/listening/idle/happy/empathy/tender/worried 等）。
//   - 本模块在其之上叠加「情绪调色板」：当一轮倾诉分析出情绪后，情绪渲染/AI 回复节点用检测到的情绪态 + 调色板色，
//     而非恒为 empathy。颜色通过 inline --ip-* 覆盖 CSS 类默认值，使 L1/L2/L3 真正生效。
//   - resolveRender() 返回的 state 一定是合法的 .mascot--<state> 类名（joy/sad/angry/anxious/tired/lonely/mixed/vague/danger 为新增姿态类）。

/* ===================== 一、反馈节点（FSM） ===================== */

/** 6 个反馈节点：idle/listening/receiving/emotion_render/ai_reply/danger */
export const NODES = ['idle', 'listening', 'receiving', 'emotion_render', 'ai_reply', 'danger'];

/** 节点 → 气泡文案（emotion_render / ai_reply / danger 无独立气泡，由情绪本身表达） */
export const NODE_BUBBLE = {
  idle: '',
  listening: '我在听',
  receiving: '正在接住你的情绪',
  emotion_render: '',
  ai_reply: '',
  danger: '',
};

/** §三 过渡/回归硬约束 */
export const TRANSITION = {
  minMs: 600,        // 0.6s 最短渐变
  maxMs: 1200,       // 1.2s 最长渐变（CSS transition 取中值 .55s~1s，落在此区间）
  idleTimeoutMs: 180000, // 3 分钟无交互 → 平滑回归 idle
  receivingMs: 800,  // 提交后「接收情绪」保持时长
};

/* ===================== 二、情绪调色板（指令 JSON，SSOT） ===================== */

// 直接来自《IP情绪状态机完整方案包》§二，前端读取即渲染。
export const PALETTE = {
  default: { emotion_label: '平静', main_color: '#9d7cd8', animation_id: 'idle_breath', bg_effect: 'steady_water', desc: '基础状态，触手缓慢呼吸式起伏' },
  joy: {
    emotion_label: '喜悦', color_config: { L1: '#b8a0e2', L2: '#b5c7ff', L3: '#c8d8ff' },
    animation_id: 'relax_sway', bg_effect: 'bright_bubble', desc: '身体舒展，触手轻柔左右摆动，气泡上浮',
  },
  sad: {
    emotion_label: '悲伤', color_config: { L1: '#9e9ebf', L2: '#8c8cad', L3: '#747494' },
    animation_id: 'shrink_slow', bg_effect: 'dark_ink_sink', desc: '身体微微收缩下沉，水流变慢，墨色缓缓向下沉淀',
  },
  angry: {
    emotion_label: '愤怒', color_config: { L1: '#7b5b8a', L2: '#6b4a7a', L3: '#543461' },
    animation_id: 'tentacles_tight', bg_effect: 'heavy_ink_surge', desc: '触手向内收紧，深色墨浪缓慢翻涌，无激烈冲击',
  },
  anxious: {
    emotion_label: '焦虑', color_config: { L1: '#8b81b8', L2: '#7a6fa8', L3: '#60538c' },
    animation_id: 'fast_small_wiggle', bg_effect: 'more_ripple', desc: '触手小幅快速摆动，水面细碎波纹不断扩散',
  },
  tired: {
    emotion_label: '疲惫', color_config: { L1: '#9c97b0', L2: '#8f8aa3', L3: '#7c778f' },
    animation_id: 'droop', bg_effect: 'dim_bg', desc: '触手自然垂落，背景亮度降低，水流缓慢',
  },
  lonely: {
    emotion_label: '孤单', color_config: { L1: '#98a8c0', L2: '#8aa0b5', L3: '#70889c' },
    animation_id: 'slow_drift', bg_effect: 'empty_bubble', desc: '墨鱼静静漂浮，零星孤单气泡慢慢消散',
  },
  mixed: {
    emotion_label: '矛盾/复合情绪', gradient_color: ['#a78bfa', '#60a5fa'],
    animation_id: 'dual_sway', bg_effect: 'two_color_ink_blend', desc: '双色渐变，触手交替摆动，两种水墨慢慢交融',
  },
  vague: {
    emotion_label: '模糊情绪', color_config: { L1: '#a8acb8', L2: '#9ca3af', L3: '#868c99' },
    animation_id: 'idle_floating', bg_effect: 'fog_ink', desc: '淡淡的雾感水墨，墨鱼安静悬浮，轻微浮动',
  },
  danger: {
    emotion_label: '高危预警', main_color: '#442c50', animation_id: 'silent_warn', bg_effect: 'soft_warning_ring',
    desc: '停止情绪动画，柔和警示光圈，触发安全弹窗',
  },
};

export const PALETTE_KEYS = Object.keys(PALETTE);

/** 调色板键 → CSS mascot 姿态类名（joy/sad/tired/lonely/mixed/vague/danger 为 v1.3.0 新增姿态类） */
export const EMOTION_RENDER_STATE = {
  default: 'idle',
  joy: 'joy',
  sad: 'sad',
  angry: 'angry',
  anxious: 'anxious',
  tired: 'tired',
  lonely: 'lonely',
  mixed: 'mixed',
  vague: 'vague',
  danger: 'danger',
};

/* ===================== 三、中文情绪词 / 模型态 → 调色板键 ===================== */

// 对接 ai.js 的 EMOTION_LEX 输出（委屈/愤怒/焦虑/羞耻/悲伤/恐惧/孤独/无力/内疚/嫉妒/开心/平静）
// 以及模型可能直接返回的 ip_state，统一收敛到 10 个调色板键。
export const EMOTION_KEY_ALIASES = {
  // 喜悦
  开心: 'joy', 喜悦: 'joy', 高兴: 'joy', 快乐: 'joy',
  // 悲伤系（收缩下沉，不夸张流泪）
  悲伤: 'sad', 难过: 'sad', 委屈: 'sad', 伤心: 'sad', 沮丧: 'sad',
  // 愤怒（墨浪翻涌、触手收紧，不狰狞）
  愤怒: 'angry', 生气: 'angry', 火大: 'angry', 气愤: 'angry',
  // 焦虑系
  焦虑: 'anxious', 恐惧: 'anxious', 紧张: 'anxious', 害怕: 'anxious', 慌: 'anxious',
  // 疲惫系（无力/乏）
  疲惫: 'tired', 累: 'tired', 乏力: 'tired', 无力: 'tired', 倦: 'tired',
  // 孤单系
  孤独: 'lonely', 孤单: 'lonely', 寂寞: 'lonely',
  // 模糊/说不清
  模糊: 'vague', 说不清: 'vague', 复杂: 'vague',
  // 羞耻 / 内疚：无专属键，归入模糊（安静悬浮更贴切，避免误贴负面强色）
  羞耻: 'vague', 内疚: 'vague', 愧疚: 'vague',
  // 嫉妒：矛盾/复杂，归 mixed 的双色交融更贴切
  嫉妒: 'mixed',
  // 平静系
  平静: 'default', 安心: 'default', 温柔: 'default', 放松: 'default',
  // 模型直接返回的 ip_state（既有内部态）做容错映射
  happy: 'joy', empathy_tears: 'sad', empathy: 'default', tender: 'default',
  calm: 'default', worried: 'anxious', thinking: 'default', listening: 'default',
  idle: 'default',
};

/* ===================== 四、纯函数：强度 / 选色 / 解析 ===================== */

/** 强度（0~10）→ 分级 L1(轻微) / L2(中等) / L3(强烈) */
export function intensityTier(intensity) {
  const v = Number(intensity);
  if (!isFinite(v)) return 'L2';
  if (v <= 3) return 'L1';
  if (v <= 7) return 'L2';
  return 'L3';
}

/**
 * 选色：调色板键 + 强度 → 写入 --ip-* 的颜色对象（仅返回本模块负责的色，路由态返回 {} 走 CSS 默认）。
 * - default / danger：单 main_color（body-in/out 同色，靠 @property 平滑晕染）
 * - mixed：gradient_color[0]→in，[1]→out（双色交融，CSS 另加 ip-mixed 渐变层）
 * - 其余：按 L1/L2/L3 取 color_config 对应档
 */
export function selectColors(emotionKey, intensity) {
  const e = PALETTE[emotionKey] || PALETTE.default;
  if (emotionKey === 'mixed') {
    const [a, b] = e.gradient_color || ['#a78bfa', '#60a5fa'];
    return { '--ip-body-in': a, '--ip-body-out': b, gradient: true };
  }
  if (emotionKey === 'default' || emotionKey === 'danger') {
    return { '--ip-body-in': e.main_color, '--ip-body-out': e.main_color };
  }
  const tier = intensityTier(intensity);
  const c = (e.color_config && e.color_config[tier]) || e.color_config && e.color_config.L2 || '#9d7cd8';
  return { '--ip-body-in': c, '--ip-body-out': c };
}

/**
 * 把分析对象（或裸情绪键）解析为调色板键。
 * 优先级：explicitKey > analysis.ip_state > emotion_primary > emotion[0] > 复合（primary+secondary 都非空且不同 → mixed）
 */
export function resolveEmotionKey(analysis, explicitKey) {
  if (explicitKey && PALETTE[explicitKey]) return explicitKey;
  const a = analysis || {};
  // 复合情绪：主+次都非空且不一致 → mixed（双色交融）
  const p = a.emotion_primary || (Array.isArray(a.emotion) && a.emotion[0]) || '';
  const s = a.emotion_secondary || (Array.isArray(a.emotion) && a.emotion[1]) || '';
  if (p && s && p !== s && !a.emotion_primary?.includes(s) && !s.includes(p)) return 'mixed';
  const candidates = [a.ip_state, p, ...(Array.isArray(a.emotion) ? a.emotion : [])];
  for (const c of candidates) {
    if (!c) continue;
    const k = EMOTION_KEY_ALIASES[c];
    if (k && PALETTE[k]) return k;
  }
  return 'default';
}

/**
 * 由情绪键 + 强度解析出「情绪渲染」完整描述符（供 app.js 渲染）。
 * 返回 { key, label, state, colors, bgEffect, animation_id, mixed, desc }
 */
export function resolveRender(emotionKey, intensity) {
  const key = PALETTE[emotionKey] ? emotionKey : 'default';
  const e = PALETTE[key];
  const colors = selectColors(key, intensity);
  return {
    key,
    label: e.emotion_label,
    state: EMOTION_RENDER_STATE[key],
    colors,
    bgEffect: e.bg_effect,
    animation_id: e.animation_id,
    mixed: key === 'mixed',
    desc: e.desc,
  };
}

/* ===================== 五、节点 FSM 调度 ===================== */

function makeDescriptor(node, state, extra = {}) {
  return Object.assign({ node, state, colors: {}, bgEffect: 'steady_water', bubble: NODE_BUBBLE[node] || '', danger: false, mixed: false }, extra);
}

/** danger 节点：停所有水墨特效，只保留柔和警示光圈，气泡交由安全弹窗 */
function renderDanger() {
  const e = PALETTE.danger;
  return makeDescriptor('danger', 'danger', {
    colors: { '--ip-body-in': e.main_color, '--ip-body-out': e.main_color },
    bgEffect: e.bg_effect,
    danger: true,
  });
}

/** receiving 节点：保留情绪/平静底色，叠墨汁波纹 + 气泡「正在接住你的情绪」 */
function renderReceiving(emotionKey, intensity) {
  const r = resolveRender(emotionKey || 'default', intensity);
  return makeDescriptor('receiving', r.state, {
    colors: r.colors,
    bgEffect: 'ink_ripple', // 墨汁波纹（CSS 叠加层，不覆盖情绪底色）
    bubble: NODE_BUBBLE.receiving,
    mixed: r.mixed,
  });
}

/**
 * 解析「当前应渲染的反馈节点描述符」。app.js 在渲染 IP 时调用。
 * @param {object} ctx
 *   route          当前路由名（say/record/analyzing/followup/gentle/confirm/timeline/risk/me…）
 *   riskLevel      风险等级 none|low|medium|high|critical
 *   emotionKey     已解析的情绪调色板键（无则 null）
 *   intensity      情绪强度 0~10
 *   receivingUntil 接收阶段截止时间戳（now < 此值 → receiving 节点）
 *   now            当前时间戳
 *   lastInteractionAt 最近一次交互时间戳（用于 3 分钟回归 idle）
 *   aiReplying     AI 是否正在逐字输出（叠加 ai_reply 微动作）
 *   danger         是否已触发高危截断（显式优先）
 *   happy          首页 toast 态（say 路由下是否显示 happy）
 * @returns {node,state,colors,bgEffect,bubble,danger,mixed}
 */
export function resolveNode(ctx = {}) {
  const {
    route = 'say', riskLevel = 'none', emotionKey = null, intensity = 5,
    receivingUntil = 0, now = Date.now(), lastInteractionAt = now,
    aiReplying = false, danger = false, happy = false,
  } = ctx;

  // 高危截断（§三.3）：强制打断当前动画，切 danger，停所有水墨特效
  if (danger || riskLevel === 'high' || riskLevel === 'critical') return renderDanger();

  // 接收情绪（§一.2）：提交后 0.8s 内、且仍在「分析中」页时，叠墨汁波纹 + 气泡。
  // 一旦进入 followup/confirm 等情绪渲染页，receiving 窗口即视为结束——避免旧窗口残留盖住情绪态。
  if (now < receivingUntil && route === 'analyzing') return renderReceiving(emotionKey, intensity);

  // 倾听（§一.1）：用户打字/按住语音未发送
  if (route === 'record') return makeDescriptor('listening', 'listening', { bubble: NODE_BUBBLE.listening });

  // 分析思考中：thinking 路由态（非调色板态，沿用 v1.2.0 姿态 + 默认底水）
  if (route === 'analyzing') return makeDescriptor('listening', 'thinking', {});

  // 首页：完成一句的 happy 庆祝；否则继承上一轮倾诉的情绪色彩（v1.3.2 安静模式/首页情绪联动），无情绪则 idle
  if (route === 'say') {
    if (happy) return makeDescriptor('idle', 'happy', {});
    if (emotionKey && emotionKey !== 'default') {
      const r = resolveRender(emotionKey, intensity);
      return makeDescriptor('idle', r.state, { colors: r.colors, bgEffect: r.bgEffect, mixed: r.mixed });
    }
    return makeDescriptor('idle', 'idle', {});
  }

  // 以下路由（followup/gentle/confirm/timeline/risk 等）：有情绪键 → 情绪渲染/AI 回复（含显式 default=平静→idle 系）
  if (emotionKey) {
    const r = resolveRender(emotionKey, intensity);
    return makeDescriptor(aiReplying ? 'ai_reply' : 'emotion_render', r.state, {
      colors: r.colors, bgEffect: r.bgEffect, mixed: r.mixed,
    });
  }
  // 无任何情绪键兜底：温和 empathy（沿用既有暖态，不破坏体验）
  return makeDescriptor(aiReplying ? 'ai_reply' : 'emotion_render', 'empathy', {});
}

/** §三.4 超时回归：超过 idleTimeoutMs 无交互 → 情绪缓慢回归 idle（返回 true 表示应回退） */
export function isIdleTimeout(lastInteractionAt, now = Date.now(), timeoutMs = TRANSITION.idleTimeoutMs) {
  if (!lastInteractionAt) return false;
  return now - lastInteractionAt > timeoutMs;
}

/* ===================== 六、用户可控开关（与 store.settings 对齐） ===================== */

// IP 相关设置的**唯一默认值来源（SSOT）**：store.js 直接 spread 本对象建初始 settings，
//   「我的」页设置区的五个开关全部归口在这里；改默认值只改这里。
//   ipMotion:   动效总开关，false → 关闭全部色彩/动画/特效（body.ip-motion-off）
//   ipIntensity:'gentle' | 'standard'（柔和/标准 两档，body.ip-intensity-gentle 减速减幅）
//   soundOn:    轻音效开关，默认 true（Web Audio 合成水墨/气泡轻音，零素材；v1.6.6 由默认关改为默认开）
//   ipTouch:    触碰互动总开关（点击/长按的动画与气泡）
//   ipBubble:   气泡文字开关（关掉只留动画）
export const IP_SETTINGS_DEFAULT = {
  // 🔴 soundOn 默认**开**（v1.6.6 改）：方案 §15 把待机底噪写成「循环、不间断、音量 8%」，
  //    且点击/情绪/场景各有音效 —— 是"常驻"描述，不是"默认静音"。此前默认 false，
  //    用户打开 App 完全无声，与方案不符（也和"做了音效"这件事自相矛盾）。
  //    仍受设置页开关控制，想安静随时可关；自动播放策略下需用户首次手势才真正出声。
  ipMotion: true, ipIntensity: 'standard', soundOn: true, ipTouch: true, ipBubble: true,
};

/** 非 IP 类设置默认值（与 IP 设置合并成完整 settings；同样只在这里定义一次） */
export const BASE_SETTINGS_DEFAULT = {
  // v1.6.15：删掉 autoDeleteAudio / ttsHint —— 这两个键此前全仓只有这一处定义，
  // 0 处读取、0 处 UI（autoDeleteAudio 对应的开关早在 v0.5.0 就删了）。留着只是两个
  // 「存了但没人接」的钩子：哪天出现一个按 Object.keys(settings) 遍历的通用配置面板，
  // 它们就会以「能显示、拨了没反应」的形态复活。宁缺勿假。
  cloudAsr: true, memory_on: true, notify_on: false,
};

/** 总开关门禁：关掉 → 强制回退到中性 idle 静态（色彩/动画/特效全停） */
export function gateByMotion(descriptor, ipMotion) {
  if (ipMotion === false) {
    return Object.assign({}, descriptor, {
      state: 'idle', colors: {}, bgEffect: 'steady_water', mixed: false,
      bubble: descriptor.bubble || '', danger: descriptor.danger,
    });
  }
  return descriptor;
}

/* ===================== 七、测试导出 ===================== */

export const __test__ = {
  NODES, NODE_BUBBLE, PALETTE, PALETTE_KEYS, EMOTION_RENDER_STATE, EMOTION_KEY_ALIASES,
  TRANSITION, IP_SETTINGS_DEFAULT, BASE_SETTINGS_DEFAULT,
  intensityTier, selectColors, resolveEmotionKey, resolveRender, resolveNode, isIdleTimeout, gateByMotion, renderDanger, renderReceiving,
};
