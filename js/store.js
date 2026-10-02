// 墨小溟 · 状态管理（单一 store + 订阅 + localStorage 持久化）
// 对应技术设计 §5。无第三方依赖。

import { IP_SETTINGS_DEFAULT, BASE_SETTINGS_DEFAULT } from './state-machine.js';
import { sanitizeSermon } from './prompts.js'; // v1.6.17 G7：AI 文本统一过说教守门

const KEY = 'xiaoting:v1';
const listeners = new Set();

/** settings 的完整默认值：IP 类与非 IP 类分别由 state-machine 单点定义，这里只做合并（防止默认值两处漂移） */
const SETTINGS_DEFAULT = Object.assign({}, BASE_SETTINGS_DEFAULT, IP_SETTINGS_DEFAULT);

/** @type {{user:any,draft:any,cards:any[],risk:any,route:string,ipState:string,toast:any}} */
let state = {
  user: {
    id: 'local-user',
    nickname: '',
    createdAt: Date.now(),
    settings: Object.assign({}, SETTINGS_DEFAULT),
  },
  // draft: { recordId, transcript, safety, analysis, asked[], currentQuestion, empathy, card, round, createdAt }
  draft: null,
  // conversation: 当前这次倾诉的对话流（用户原话 + 墨小溟回应 / 安全同步），用于 v1.1 §3.3 对话区同步输出
  conversation: [],
  // sessionLog: 本次会话累积的用户原话（每轮 startDraft 追加），是情绪时间线卡片的数据源；只保留本次会话、不跨会话合并
  sessionLog: [],
  // sessionAt: 本次会话开始时间戳。sessionLog 会持久化（防刷新丢），但超过 SESSION_TTL 视为新会话自动清空，
  //           以此守住「只保留本次会话、不跨会话合并」这条蓝图边界。
  sessionAt: 0,
  // timelines: 已保存的情绪时间线卡片（完全本地，隐私优先）
  timelines: [],
  // timeline: 当前正在查看的时间线卡片（瞬时，不持久化）
  timeline: null,
  cards: [],
  // risk: { level:none|low|medium|high|critical, action:continue|gentle_check|refer|emergency, hit, evidence }
  risk: { level: 'none', action: 'continue', hit: false, evidence: '' },
  route: 'say',
  ipState: 'idle',
  // v1.3.0 IP 情绪视觉引擎：当前检测到的情绪键 + 强度 + 接收阶段截止 + 最近交互时间
  emotionKey: null,
  emotionIntensity: 5,
  receivingUntil: 0,
  lastInteractionAt: Date.now(),
  aiReplying: false,
  // v1.3.0：首页「刚收下卡片」的开心庆祝窗口。
  // 🔴 必须用显式时间戳，不能用「有没有 toast」当信号 —— 导出/清空/断网等任何 toast
  //    都会让首页 IP 变成开心，情绪与事实相反（那是比没有动效更糟的失真）。
  happyUntil: 0,
  // v1.3.1/1.3.2/1.3.3：安静陪伴模式 + 首页问候（会话内固定，重开 App 才轮换）+ 历史情绪偏向
  quietMode: false,
  quietTitle: '',
  quietSmall: '',
  quietCardHint: '',
  greeting: '',
  greetingSmall: '',
  cardHint: '',
  toast: null,
};

const freshUser = () => ({ id: 'local-user', nickname: '', createdAt: Date.now(), settings: Object.assign({}, SETTINGS_DEFAULT) });
const freshRisk = () => ({ level: 'none', action: 'continue', hit: false, evidence: '' });

/** 一次「会话」的有效期：超过就当作新会话，清空 sessionLog（6 小时） */
export const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify({
      user: state.user, cards: state.cards, draft: state.draft, timelines: state.timelines,
      sessionLog: state.sessionLog, sessionAt: state.sessionAt,
    }));
  } catch (e) { /* 隐私模式等场景静默失败 */ }
}

function restore() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data.user) state.user = { ...state.user, ...data.user, settings: { ...state.user.settings, ...(data.user.settings || {}) } };
    if (Array.isArray(data.cards)) state.cards = data.cards;
    if (data.draft) state.draft = data.draft;
    if (Array.isArray(data.timelines)) state.timelines = data.timelines;
    // sessionLog 持久化是为了「中途刷新不白说」，但必须按 TTL 判定是否还算同一次会话
    if (Array.isArray(data.sessionLog)) {
      const at = Number(data.sessionAt) || 0;
      const fresh = at && Date.now() - at < SESSION_TTL_MS;
      state.sessionLog = fresh ? data.sessionLog : [];
      state.sessionAt = fresh ? at : 0;
    }

    /* 一次性迁移：音效默认值由「关」改成「开」（v1.6.6）。
     * 🔴 为什么必须迁移：改 SETTINGS_DEFAULT 只对**新用户**有效 —— 老用户的 localStorage 里
     *    已经持久化了旧默认 `soundOn:false`，升级后仍然完全无声（改了个寂寞）。
     *    这里把新默认应用到「还没迁移过」的用户一次；之后用户自己关掉，因为标记已打，
     *    不会被再打开 —— 只纠正默认值，不覆盖用户的显式选择。 */
    const st = state.user && state.user.settings;
    if (st && st.soundOn === false && !st.soundDefaultMigrated) {
      st.soundOn = true;
      st.soundDefaultMigrated = true;
      persist();
    }
  } catch (e) { /* ignore */ }
}

export function getState() { return state; }

export function setState(patch) {
  Object.assign(state, patch);
  persist();
  emit();
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() { listeners.forEach((fn) => { try { fn(state); } catch (e) { console.error(e); } }); }

/* ---------- 路由 ---------- */

/** IP 状态为派生状态：由路由/风险推导 */
export function deriveIpState(route, risk) {
  if (risk && (risk.level === 'high' || risk.level === 'critical')) return 'worried';
  switch (route) {
    case 'record': return 'listening';
    case 'analyzing': return 'thinking';
    case 'followup': return 'empathy';
    case 'gentle': return 'empathy';
    case 'confirm': return 'empathy';
    case 'timeline': return 'tender';
    case 'risk': return 'worried';
    case 'say': return state.toast ? 'happy' : 'idle';
    default: return 'idle';
  }
}

/* ---------- 草稿（全程可退出，自动保存） ---------- */

export function startDraft(transcript, recordId) {
  setState({
    draft: {
      recordId,
      transcript,
      safety: null,
      analysis: null,
      asked: [],
      currentQuestion: '',
      empathy: '',
      card: null,
      round: 0,
      createdAt: Date.now(),
    },
    risk: freshRisk(),
    // v1.3.0：提交即进入「接收情绪」节点（墨汁波纹 + 气泡，保持 0.8s）；同时清掉上一轮情绪，避免停留旧态
    receivingUntil: Date.now() + 800,
    emotionKey: null,
    emotionIntensity: 5,
    aiReplying: false,
    quietMode: false, // v1.3.2：开始倾诉即退出安静陪伴模式
    // 一次新的倾诉（本轮）：清空本轮对话区，记录用户原话作为对话区首条（§3.3 对话区同步输出）
    conversation: [{ role: 'user', text: transcript, at: Date.now() }],
    // 本次会话累积：追加用户原话，作为情绪时间线卡片的数据源（v1.1.0）
    sessionLog: [...(state.sessionLog || []), { role: 'user', text: transcript, at: Date.now() }],
    sessionAt: state.sessionAt || Date.now(),
  });
}

/** 向对话区追加一条消息（role: 'user' | 'ai'），§3.3 强制弹窗时同步输出安抚文字用 */
export function appendConvo(role, text) {
  if (!text) return;
  // v1.6.17 G7：所有要给用户看的 AI 句子都过这一道说教守门（黑名单命中 → 换中性说法或兜底共情句）。
  // 只守 AI 那一路：用户自己打的字一个字都不许动，那是他的原话，动一个字都是冒犯。
  const out = role === 'ai' ? sanitizeSermon(text) : String(text);
  state.conversation = [...(state.conversation || []), { role, text: out, at: Date.now() }];
  emit();
}

/** 开启一段全新会话：清空轮次对话、会话累积与临时时间线（不碰已保存的时间线与卡片）
 *  注意：刻意保留 emotionKey —— v1.3.2 要求安静模式/首页继承「上一轮倾诉的情绪色彩」，结束会话不等于清空情绪底色。 */
export function startSession() {
  setState({ conversation: [], sessionLog: [], sessionAt: 0, draft: null, risk: freshRisk(), timeline: null, receivingUntil: 0, aiReplying: false });
}

/** v1.3.0：分析完成后写入检测到的情绪（键 + 强度），供情绪渲染节点消费 */
export function setEmotion(emotionKey, intensity) {
  // 情绪刚写入 = 一次有效交互，重置 3 分钟回归计时（§三.4）
  setState({ emotionKey: emotionKey || null, emotionIntensity: Number(intensity) || 5, lastInteractionAt: Date.now() });
}

/** §三.4 3 分钟无交互 → 回归 idle 的计时基准。任何一次真实用户动作都应调用它。
 *  注意：绝不能在 render() 里无条件写 lastInteractionAt —— 那会让计时器永远差 0ms、永远不触发。 */
export function touchInteraction() {
  state.lastInteractionAt = Date.now();
}

/** v1.3.0：首页「刚收下卡片」的开心窗口（显式时间戳，其它 toast 不会误触发开心） */
export function setHappy(ms = 4000) {
  setState({ happyUntil: Date.now() + (Number(ms) || 4000) });
}

/* ---------- v1.3.1/1.3.2/1.3.3：安静陪伴模式 + 首页问候 ---------- */

/* 🔴 v1.7.5（P2-2）：上面那三个「导出即终点」的 setter（setQuietMode / setGreeting /
   setHistoryBias）全仓零调用 —— 安静模式由 app.js 直接 store.setState({ quietMode:true/false })，
   问候文案同理（initGreeting 直接写），历史偏向这个字段更是只写不读。
   留着它们是「假接口」：调用方以为有这个入口，实际谁也没调（调用点即是定义行本身）。
   真状态 quietMode / greeting / greetingSmall / cardHint 都是**真读**的，一个没删。 */

/** 删除一条已保存的情绪时间线（本地数据，用户自主要求） */
export function removeTimeline(id) {
  setState({ timelines: (state.timelines || []).filter((t) => t.id !== id) });
}

/** v1.3.4：清除全部情绪卡片（记录管理，二次确认后由调用方触发） */
export function clearCards() {
  setState({ cards: [] });
}

export function patchDraft(patch) {
  if (!state.draft) return;
  setState({ draft: { ...state.draft, ...patch } });
}

export function addAnswer(answer) {
  if (!state.draft) return;
  const answers = [...(state.draft.answers || []), answer];
  setState({ draft: { ...state.draft, answers } });
}

export function addAsked(question) {
  if (!state.draft || !question) return;
  const asked = [...(state.draft.asked || []), question];
  setState({ draft: { ...state.draft, asked } });
}

/* ---------- 卡片 ---------- */

export function addCard(card) {
  const full = {
    ...card,
    id: 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    created_at: new Date().toISOString(),
  };
  setState({ cards: [full, ...state.cards], draft: null });
  return full;
}

export function getCard(id) { return state.cards.find((c) => c.id === id) || null; }

/** v1.6.17 G3：单张卡片删除。此前只有「清空全部卡片」—— 存了 20 张想删一张，连入口都没有。 */
export function deleteCard(id) {
  setState({ cards: (state.cards || []).filter((c) => c.id !== id) });
}

/**
 * v1.6.17 G3：给单张卡片翻标记（fav 收藏 / archived 归档）。
 * 用白名单 flag 而不是任意键：避免出现 `toggleCardFlag(id,'__proto__')` 这种把状态表写脏的野路子。
 */
export function toggleCardFlag(id, flag) {
  if (flag !== 'fav' && flag !== 'archived') return null;
  setState({ cards: (state.cards || []).map((c) => (c.id === id ? { ...c, [flag]: !c[flag] } : c)) });
  return getCard(id) || null;
}

/** 保存一张情绪时间线卡片到本机（隐私优先，完全本地，不自动分享） */
export function addTimeline(tl) {
  const full = {
    ...tl,
    id: 'tl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    saved_at: new Date().toISOString(),
  };
  setState({ timelines: [full, ...(state.timelines || [])] });
  return full;
}

/* ---------- 隐私 ---------- */

export function deleteAllData() {
  try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
  state.cards = [];
  state.draft = null;
  state.risk = freshRisk();
  state.conversation = [];
  state.sessionLog = [];
  state.timelines = [];
  state.timeline = null;
  state.emotionKey = null;
  state.emotionIntensity = 5;
  state.receivingUntil = 0;
  state.aiReplying = false;
  state.user = freshUser();
  persist();
  emit();
}

export function setSetting(key, value) {
  setState({ user: { ...state.user, settings: { ...state.user.settings, [key]: value } } });
}

/* ---------- 反馈 ---------- */

export function toast(msg, ms = 2200) {
  const until = Date.now() + ms;
  setState({ toast: { msg, at: Date.now(), until } });
  // 到期清除；渲染侧另有 TTL 兜底，二者独立双保险
  setTimeout(() => {
    const t = state.toast;
    if (t && t.until <= Date.now()) setState({ toast: null });
  }, ms + 60);
}

export function setRisk(risk) {
  setState({
    risk: {
      level: risk.level || 'none',
      action: risk.action || 'continue',
      hit: ['high', 'critical'].includes(risk.level),
      evidence: risk.evidence || '',
    },
  });
}

export function initStore() { restore(); }
