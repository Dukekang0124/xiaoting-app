// 墨小溟 · 状态管理（单一 store + 订阅 + localStorage 持久化）
// 对应技术设计 §5。无第三方依赖。

const KEY = 'xiaoting:v1';
const listeners = new Set();

/** @type {{user:any,draft:any,cards:any[],risk:any,route:string,ipState:string,toast:any}} */
let state = {
  user: {
    id: 'local-user',
    nickname: '',
    createdAt: Date.now(),
    settings: { autoDeleteAudio: true, ttsHint: true, cloudAsr: true },
  },
  // draft: { recordId, transcript, safety, analysis, asked[], currentQuestion, empathy, card, round, createdAt }
  draft: null,
  // conversation: 当前这次倾诉的对话流（用户原话 + 墨小溟回应 / 安全同步），用于 v1.1 §3.3 对话区同步输出
  conversation: [],
  cards: [],
  // risk: { level:none|low|medium|high|critical, action:continue|gentle_check|refer|emergency, hit, evidence }
  risk: { level: 'none', action: 'continue', hit: false, evidence: '' },
  route: 'say',
  ipState: 'idle',
  toast: null,
};

const freshUser = () => ({ id: 'local-user', nickname: '', createdAt: Date.now(), settings: { autoDeleteAudio: true, ttsHint: true, cloudAsr: true } });
const freshRisk = () => ({ level: 'none', action: 'continue', hit: false, evidence: '' });

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify({ user: state.user, cards: state.cards, draft: state.draft }));
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

export function setRoute(route) { setState({ route }); }

/** IP 状态为派生状态：由路由/风险推导 */
export function deriveIpState(route, risk) {
  if (risk && (risk.level === 'high' || risk.level === 'critical')) return 'worried';
  switch (route) {
    case 'record': return 'listening';
    case 'analyzing': return 'thinking';
    case 'followup': return 'empathy';
    case 'gentle': return 'empathy';
    case 'confirm': return 'empathy';
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
    // 一次新的倾诉：清空旧对话，记录用户原话作为对话区首条（§3.3 对话区同步输出）
    conversation: [{ role: 'user', text: transcript, at: Date.now() }],
  });
}

/** 向对话区追加一条消息（role: 'user' | 'ai'），§3.3 强制弹窗时同步输出安抚文字用 */
export function appendConvo(role, text) {
  if (!text) return;
  state.conversation = [...(state.conversation || []), { role, text, at: Date.now() }];
  emit();
}

export function clearConvo() { state.conversation = []; emit(); }

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

/* ---------- 隐私 ---------- */

export function deleteAllData() {
  try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
  state.cards = [];
  state.draft = null;
  state.risk = freshRisk();
  state.conversation = [];
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
