// 墨小溟 · REST 接口层（v0.4.2：接入真实 AI + 情绪强度收口）
//
// 对外契约与 PRD §7.2 保持一致，调用方（app.js）无感。内部换成真实的模型调用：
//   Prompt（js/prompts.js 逐字模板）→ LLM（js/llm.js，走 WorkBuddy 云服务免密钥网关）
//   → 严格 JSON 解析 → 词表校验/归一 → validateShape 补字段 → 返回同结构
//
// 三条不可让步的纪律：
//   A. 安全识别失败 / 返回异常 / 等级与动作不匹配 → 一律按保守策略处理（至少 gentle_check），
//      绝不允许默认 continue。（v1.2 §2 明令）
//   B. 其余任何环节失败 → 降级到 js/ai.js 的本地规则引擎，流程照样走完，**不白屏**。
//   C. 情绪强度不允许由模型自由跳动：文本有负面情绪时最低 5，卡片必须锚定主分析。见 clampIntensity。
//
// 调用顺序：ASR → 安全识别 → 主分析 → 追问(≤3) → 卡片 → 周报

import {
  safetyCheck, analyzeMain, nextFollowup, generateCard, weeklyReport, validateShape,
  buildScenarioCard, selectCardType, pickActionVariant, buildTimeline, detectTimelineEmotions, isHighRiskText,
  withTimelineMeta, descForNode,
} from './ai.js';
import { callJson, isStructural, debug as llmDebug, stats as llmStats } from './llm.js';
import {
  SYSTEM, MODEL_CONFIG, buildSafetyPrompt, buildMainPrompt, buildFollowupPrompt,
  buildCardPrompt, buildWeeklyPrompt, buildTimelinePrompt, scrubForbidden, findForbidden, CARD_LIB, CARD_LAYER, TIMELINE_EMOTIONS,
  withPrefsHint,
} from './prompts.js';
import { AI } from './config.js';
import * as store from './store.js';
import * as diag from './diag.js';
import * as memory from './memory.js';

/**
 * v1.6.18（G2 补完）：把用户偏好注入 system 提示。
 *
 * 目前只有一条偏好走这条路 —— 「回复短一点」（`user.settings.reply_short`，
 * 由新手引导第 5 屏或设置页写入）。v1.6.17 只写不读（死配置 ⇒ 勾了没效果），
 * 这里接到真实链路。读取失败一律原样返回，偏好不能拖垮主流程。
 */
function sysWithPrefs(system) {
  try {
    const s = store.getState();
    const short = !!(s && s.user && s.user.settings && s.user.settings.reply_short === true);
    return withPrefsHint(system, { short });
  } catch (e) {
    return system;
  }
}

/* ==================== 词表（与 Prompt 里给定的一致，用来校验模型输出） ==================== */

const EMOTIONS = ['愤怒', '委屈', '焦虑', '羞耻', '悲伤', '恐惧', '孤独', '无力', '内疚', '嫉妒', '开心', '平静'];
const PATTERNS = ['绝对化', '灾难化', '读心', '以偏概全', '个人化', '应该化'];
const NEEDS = ['被重视', '被尊重', '安全感', '控制感', '公平', '被看见', '边界', '可预期', '被理解', '被爱'];
const BODIES = ['胸闷', '胃紧', '头痛', '想哭', '发抖', '失眠', '心跳快', '无感'];
const IP_STATES = ['idle', 'listening', 'thinking', 'empathy', 'empathy_tears', 'tender', 'worried', 'happy', 'calm', 'angry', 'anxious'];
/** 模型可能给出带下划线/中文/别名的 ip_state，统一收敛到上面的合法集合 */
const IP_STATE_ALIASES = {
  empathy_with_tears: 'empathy_tears', empathetic_tears: 'empathy_tears', tearful: 'empathy_tears', crying: 'empathy_tears',
  gentle_gaze: 'tender', tender_gaze: 'tender', soft_gaze: 'tender', warm_gaze: 'tender', tender_look: 'tender',
  concern: 'worried', worried_concern: 'worried', alarm: 'worried', worry: 'worried',
  lean: 'listening', lean_in: 'listening',
  anger: 'angry', mad: 'angry', rage: 'angry', furious: 'angry', irate: 'angry',
  anxiety: 'anxious', anxious: 'anxious', panic: 'anxious', nervous: 'anxious', scared: 'anxious', fear: 'anxious', uneasy: 'anxious',
};
/** 把模型给的任意 ip_state 字符串归一化到合法集合；不认识就回兜底 */
export function normalizeIpState(raw, fallback = 'empathy') {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!s) return fallback;
  if (IP_STATES.includes(s)) return s;
  if (IP_STATE_ALIASES[s]) return IP_STATE_ALIASES[s];
  const cleaned = s.replace(/[^a-z_]/g, ''); // 容忍中文/空格：只留字母与下划线
  if (IP_STATES.includes(cleaned)) return cleaned;
  if (IP_STATE_ALIASES[cleaned]) return IP_STATE_ALIASES[cleaned];
  return fallback;
}

const RISK_LEVELS = ['none', 'low', 'medium', 'high', 'critical'];
const ACTIONS = ['continue', 'gentle_check', 'refer', 'emergency', 'redirect_professional', 'reject_diagnosis', 'dependency_redirect', 'harm_others'];
const ACTION_BY_LEVEL = { none: 'continue', low: 'continue', medium: 'gentle_check', high: 'refer', critical: 'emergency' };
/** 触发「立即阻断常规流程 + 切到担忧态 + 弹应急卡片（强制·我已了解）」的动作集合（§3.2 / §4.7）
 *  注意：reject_diagnosis / dependency_redirect 按 §4.8 为非强制弹窗、正常走对话流，不阻断。 */
const BLOCKING_ACTIONS = ['refer', 'emergency', 'redirect_professional', 'harm_others'];
export const isBlockingAction = (a) => BLOCKING_ACTIONS.includes(a);

/* ==================== 小工具 ==================== */

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const arr = (v) => (Array.isArray(v)
  ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
  : (typeof v === 'string' && v.trim() ? [v.trim()] : []));

/** 只保留词表内的取值；一个都不剩就用兜底值（模型说错词时不让卡片变空） */
function pickFrom(v, allowed, fallback = [], limit = 3) {
  const got = arr(v).filter((x) => allowed.includes(x)).slice(0, limit);
  return got.length ? got : arr(fallback).slice(0, limit);
}
function num(v, lo, hi, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
}

/* ==================== 情绪强度收口（v0.4.2 §3）====================
 * 现象：同一段明显带情绪的倾诉，intensity 会在 8 / 7 / 0 之间乱跳，卡片视觉跟着乱。
 * 排查后确认两个真实根因，都不在"模型手感"上：
 *   ① MAIN_PROMPT 的 JSON 模板里写死了 "intensity": 0，模型倾向照抄示例（模板已改为 6，并补了评分锚点）；
 *   ② validateShape 会把模型【没给】的字段补成 DEFAULTS 里的 0，而 num() 只把"非有限值"当缺失，
 *      于是"模型没说"被当成了"模型说 0" —— 这里用 hasOwnProperty 把两者区分开。
 * 收口策略：以文本证据算一个下限，只往上钳、不往下压。用户来复盘时说的都是真难受的事，
 * 宁可偏高一分，也不能让一张"被领导当众骂了"的卡片显示强度 0。上限钳在 8：
 * 9-10 带有临床意味，那是模型和安全策略的领域，不该由一条字符串规则替它决定。
 */

const NEG_EMOTIONS = ['愤怒', '委屈', '焦虑', '羞耻', '悲伤', '恐惧', '孤独', '无力', '内疚', '嫉妒'];
const INTENSE_WORDS = ['很', '特别', '非常', '极其', '根本', '一直', '每次', '受够了', '彻底', '受不了', '崩溃', '撑不住', '快疯了', '绝望'];
const DOWNPLAY_WORDS = ['还好', '一点点', '有点', '没什么', '无所谓', '不生气'];
const INTENSITY_CAP = 8;

/** 文本证据推出的强度下限（0 = 不干预）。自测直接调它验钳制规则。 */
export function intensityFloor({ transcript = '', emotion = [] } = {}) {
  const t = str(transcript);
  const neg = arr(emotion).filter((e) => NEG_EMOTIONS.includes(e));
  if (!neg.length) return 0; // 没识别到负面情绪 → 不干预，让模型自己说
  // 用户自己在淡化（"有点烦"），且没有强化词 → 不抬下限，避免把轻声抱怨放大成剧烈情绪
  const downplaying = DOWNPLAY_WORDS.some((w) => t.includes(w));
  const intensified = INTENSE_WORDS.some((w) => t.includes(w));
  if (downplaying && !intensified) return 0;
  return Math.min(intensified ? 6 : 5, INTENSITY_CAP);
}

/** 模型到底给没给 intensity？"没给"≠"给了 0"，这两种情况必须分开处理。 */
function modelIntensity(raw, dflt) {
  if (!raw || typeof raw !== 'object' || !Object.prototype.hasOwnProperty.call(raw, 'intensity')) return dflt;
  const n = Number(raw.intensity);
  return Number.isFinite(n) ? Math.round(Math.max(0, Math.min(10, n))) : dflt;
}

const intensityFixes = [];

/** 归一化强度：先取"文本证据下限"与"上游锚点下限"的较大者，再钳成 0-10 整数，只上不下。
 *  导出是为了让自测能直接打靶这条规则（这是内测反馈「强度 8/7/0 乱跳」的收口点）。 */
export function clampIntensity(value, { transcript = '', emotion = [], anchor = null } = {}) {
  const floor = intensityFloor({ transcript, emotion });
  const a = Number(anchor);
  // 锚点：卡片沿用主分析的强度，允许 ±1 的下浮（留给追问补充的新信息）
  const anchorFloor = Number.isFinite(a) && a >= 5 ? Math.min(Math.round(a) - 1, INTENSITY_CAP) : 0;
  const effective = Math.max(floor, anchorFloor);
  const v = Math.round(num(value, 0, 10, effective || 5));
  if (effective && v < effective) {
    intensityFixes.push({ from: v, to: effective, floor, anchor: anchorFloor, at: Date.now() });
    return effective;
  }
  return v;
}

/** 本次会话里被强制抬高的强度（自测/排查用） */
export function intensityAdjustments() { return intensityFixes.slice(-40); }

/** 禁止话术闸门：模型输出也要过一遍 §6.8，命中就替换掉，并记账供自测核对 */
const guardLog = [];
function guard(text, where) {
  const raw = str(text);
  const hits = findForbidden(raw);
  if (hits.length) guardLog.push({ where, hits, at: Date.now() });
  return scrubForbidden(raw);
}

/** 本次会话里被拦下的禁止话术（自测/排查用） */
export function forbiddenHits() { return guardLog.slice(-40); }

/* ==================== 归一化：模型输出 → 前端契约 ==================== */

/**
 * 安全识别归一化。这里是最保守的一环：
 * - 没有结果 / 不是对象 → medium + gentle_check
 * - risk_level 不认识 → medium
 * - action 不认识 → 由 risk_level 推导
 * - 等级 ≥ medium 却给 continue → 强制按等级推导（只往更保守的方向纠正，不降级）
 */
function normalizeSafety(raw) {
  const broken = !raw || typeof raw !== 'object';
  let level = str(raw && raw.risk_level).toLowerCase();
  if (!RISK_LEVELS.includes(level)) level = 'medium';

  let action = str(raw && raw.action).toLowerCase();
  if (!ACTIONS.includes(action)) action = ACTION_BY_LEVEL[level];
  if (RISK_LEVELS.indexOf(level) >= RISK_LEVELS.indexOf('medium') && action === 'continue') {
    action = ACTION_BY_LEVEL[level];
  }
  // 仅当模型把高危等级却仍填 continue 时才向上纠正；明确的阻断类动作（含 harm_others 等）不覆盖。
  if (level === 'high' && action === 'continue') action = 'refer';
  if (level === 'critical') action = 'emergency';

  const reason = guard(raw && raw.reason, 'safety.reason').slice(0, 200)
    || (broken ? '安全识别未返回可用结果，按保守策略处理' : '安全识别未给出理由');

  return { risk_level: level, reason, action, degraded: broken ? 'no_json' : '' };
}

function normalizeAnalysis(raw, transcript) {
  const rule = analyzeMain(transcript); // 同时充当「模型缺字段时」的兜底字典
  const s = validateShape('main', raw || {});

  // 强度先算：它要同时吃"文本证据下限"，所以必须先定下 emotion 才能判断是否负面情绪
  const emotion = pickFrom(s.emotion, EMOTIONS, rule.emotion, 2);
  const emotionPrimary = str(s.emotion_primary) || (emotion[0] || rule.emotion_primary);
  const emotionSecondary = str(s.emotion_secondary) || rule.emotion_secondary;
  const emotionShift = guard(s.emotion_shift, 'analysis.emotion_shift');
  const shiftTrigger = guard(s.shift_trigger, 'analysis.shift_trigger');
  const hiddenNeed = guard(s.hidden_need, 'analysis.hidden_need') || rule.hidden_need;
  const intensity = clampIntensity(modelIntensity(raw, rule.intensity), { transcript, emotion });

  const out = {
    event: guard(s.event, 'analysis.event') || rule.event,
    people: arr(s.people).slice(0, 3),
    scene: guard(s.scene, 'analysis.scene'),
    emotion,
    intensity,
    body: pickFrom(s.body, BODIES, rule.body, 4),
    thought: guard(s.thought, 'analysis.thought'),
    cognitive_patterns: pickFrom(s.cognitive_patterns, PATTERNS, rule.cognitive_patterns, 3),
    need: pickFrom(s.need, NEEDS, rule.need, 3),
    behavior: guard(s.behavior, 'analysis.behavior'),
    result: guard(s.result, 'analysis.result') || rule.result,
    pattern: guard(s.pattern, 'analysis.pattern') || rule.pattern,
    experiment: guard(s.experiment, 'analysis.experiment') || rule.experiment,
    summary: guard(s.summary, 'analysis.summary') || rule.summary,
    emotion_primary: emotionPrimary,
    emotion_secondary: emotionSecondary,
    emotion_shift: emotionShift,
    shift_trigger: shiftTrigger,
    hidden_need: hiddenNeed,
    ip_state: normalizeIpState(raw && raw.ip_state, rule.ip_state),
    ip_action: str(s.ip_action) || rule.ip_action,
    needs_followup: typeof s.needs_followup === 'boolean' ? s.needs_followup : rule.needs_followup,
    followup_questions: [...new Set(arr(s.followup_questions))].slice(0, 3),
  };
  if (out.needs_followup && !out.followup_questions.length) out.followup_questions = rule.followup_questions;
  if (!out.needs_followup) out.followup_questions = [];
  return validateShape('main', out);
}

/** 追问归一化：轮次与「能否收尾」由前端说了算，不信模型 —— 3 轮上限是产品约束，不是模型自由度 */
function normalizeFollowup(raw, { round = 0, asked = [] } = {}) {
  if (round >= 3) {
    return validateShape('followup', { empathy: '', question: '', round: 3, can_skip: true, ready_for_card: true });
  }
  const next = round + 1;
  const empathy = guard(raw && raw.empathy, 'followup.empathy').slice(0, 30);
  const question = guard(raw && raw.question, 'followup.question').slice(0, 60);
  // 空问题 或 与已问重复 → 直接收尾，不硬凑第 N 问
  if (!question || asked.includes(question)) {
    return validateShape('followup', { empathy: '', question: '', round: next, can_skip: true, ready_for_card: true });
  }
  return validateShape('followup', { empathy, question, round: next, can_skip: true, ready_for_card: false });
}

/** 导出供自测直接校验（与 normalizeTimeline 同一动机：契约可测，才谈得上守住契约） */
export function normalizeCard(raw, analysis, followup, extra, transcript = '') {
  const rule = generateCard({ analysis, followup, extra });
  const s = validateShape('card', raw || {});
  const tags = arr(s.tags).slice(0, 3);
  // 卡片强度锚定主分析：模型在这段最容易"重新打一个分"（实测出现 8 → 0），
  // 用锚点下限把它拉回去，保证用户回看时同一件事的强度不会自己变形。
  const emotion = pickFrom(s.emotion, EMOTIONS, rule.emotion, 2);
  const anchor = Number(analysis && analysis.intensity);
  const anchorOk = Number.isFinite(anchor) && anchor >= 5 ? anchor : null;
  const emotionPrimary = str(s.emotion_primary) || (analysis && analysis.emotion_primary) || rule.emotion_primary;
  const emotionSecondary = str(s.emotion_secondary) || (analysis && analysis.emotion_secondary) || rule.emotion_secondary;
  const emotionShift = str(s.emotion_shift) || (analysis && analysis.emotion_shift) || rule.emotion_shift;
  const shiftTrigger = str(s.shift_trigger) || (analysis && analysis.shift_trigger) || rule.shift_trigger;
  const hiddenNeed = guard(s.hidden_need, 'card.hidden_need') || (analysis && analysis.hidden_need) || rule.hidden_need;

  // v1.0.0-RC 升级：四类场景卡片。标题/正文/动作以 CARD_LIB 为 SSOT 逐字回填，保证与蓝图一字不差。
  // transcript 合并「原始倾诉 + 追问补充」，让矛盾/转折信号（一边…一边 / 明明…却）无论落在哪一句都能被识别。
  const sceneText = [transcript, extra].filter(Boolean).join(' ');
  const cardType = (raw && raw.card_type && ['see', 'hold', 'notice', 'action'].includes(raw.card_type))
    ? raw.card_type
    : selectCardType({ analysis, transcript: sceneText });
  const lib = CARD_LIB[cardType] || CARD_LIB.see;
  let title = lib.title;
  let cardBody = lib.body;
  let actionTitle = '';
  let actionStep = '';
  let actionNote = '';
  if (cardType === 'action') {
    const variant = pickActionVariant(rule.emotion, sceneText, { highRisk: isHighRiskText(sceneText) });
    title = variant.title;
    actionTitle = variant.title;
    actionStep = variant.step;
    actionNote = variant.note;
    cardBody = `${variant.step} ${variant.note}`;
  }

  return validateShape('card', {
    title: scrubForbidden(title),
    // 🔴 v1.1.3 修复：日期**永远由本机给出，不接受模型的**。
    // 排查证据（链路诊断日志）：模型在卡片里返回 "date":"2025-07-09"，而当天是 2026-09-30 ——
    // 模型没有可信时钟，它只是从训练语料里挑了一个"看起来像日期"的字符串。
    // 旧写法只要格式对就照单全收，于是卡片里存着一个凭空编出来的日期，
    // 而它是"格式合法的错误数据"，任何校验都查不出来。模型的活是写感受，不是报日期。
    date: new Date().toISOString().slice(0, 10),
    event: guard(s.event, 'card.event') || rule.event,
    emotion,
    emotion_primary: emotionPrimary,
    emotion_secondary: emotionSecondary,
    emotion_shift: emotionShift,
    shift_trigger: shiftTrigger,
    hidden_need: hiddenNeed,
    intensity: clampIntensity(modelIntensity(raw, anchorOk == null ? rule.intensity : anchorOk), { emotion, anchor: anchorOk }),
    body: pickFrom(s.body, BODIES, rule.body, 4),
    thought: guard(s.thought, 'card.thought'),
    need: pickFrom(s.need, NEEDS, rule.need, 3),
    behavior: guard(s.behavior, 'card.behavior'),
    result: guard(s.result, 'card.result') || rule.result,
    pattern: guard(s.pattern, 'card.pattern') || rule.pattern,
    experiment: guard(s.experiment, 'card.experiment') || rule.experiment,
    summary: guard(s.summary, 'card.summary') || rule.summary,
    tags: tags.length ? tags : rule.tags,
    ip_state: normalizeIpState(s.ip_state, rule.ip_state),
    // 四类场景卡片字段（v1.0.0-RC 升级）
    card_type: cardType,
    card_layer: CARD_LAYER[cardType] || lib.layer || '',
    card_name: lib.name || '情绪卡片',
    action_title: actionTitle,
    action_step: actionStep,
    action_note: actionNote,
    card_body: cardBody,
    // 周报聚合需要的内部字段（不对外，卡片契约未列）
    people: (analysis && analysis.people) || [],
    scene: (analysis && analysis.scene) || '',
  });
}

/** 导出仅为自测可达（v1.1.1）：云端归一化分支在 mock 模式下永远走不到，必须能单独断言 */
export function normalizeTimeline(raw, conversation) {
  const rule = buildTimeline(conversation);
  // 🔴 P0 修复（v1.1.1 审计）：本地判定「全程无情绪」时必须原样返回简化卡。
  // 否则 rule.nodes 为空 ⇒ 页面 timelineCurve([]) 抛 TypeError（xs[0].toFixed 读 undefined）。
  // 自测走 mock（ask 返回 null）永远走不到这里，只有真实云端会崩。
  // v1.2.1：统一经 withTimelineMeta 补齐 UI 标准化字段（含新格式兜底）。
  if (!raw || typeof raw !== 'object' || rule.type === 'no-emotion') return withTimelineMeta(rule);

  // 节点条数 / 顺序 / 关键词命中以本地规则引擎为准，保证确定性；只覆盖模型给的 emotions / caption
  // 模型可给旧格式（nodes[].emotions / caption）或新格式（timeline_list[].emotion_text / desc_text）。
  const rawList = Array.isArray(raw.timeline_list) ? raw.timeline_list
    : (Array.isArray(raw.nodes) ? raw.nodes : []);
  const nodes = (rule.nodes || []).map((n, i) => {
    const rn = rawList[i] || {};
    // 模型给的标签：可能是数组（旧）或 emotion_text 字符串（新，如「喜悦 + 委屈」）
    let modelEmos = [];
    if (Array.isArray(rn.emotions)) modelEmos = rn.emotions;
    else if (typeof rn.emotion_text === 'string') modelEmos = rn.emotion_text.split('+').map((s) => s.trim()).filter(Boolean);
    // 蓝图「禁止 AI 脑补」：模型给的标签必须在该轮原话里有关键词支撑才能采用，
    // 否则退回本地结果。模型可以在「本地全部候选」里改取舍/顺序，但不能凭空造一个。
    const supported = detectTimelineEmotions(n.text, { limit: TIMELINE_EMOTIONS.length });
    const picked = pickFrom(modelEmos, TIMELINE_EMOTIONS, n.emotions, 2);
    const emos = picked.filter((e) => supported.includes(e));
    const desc = (typeof rn.desc_text === 'string' && rn.desc_text.trim()) ? rn.desc_text.trim() : descForNode(n);
    const caption = (typeof rn.caption === 'string' && rn.caption.trim()) ? rn.caption.trim() : (n.caption || '');
    return { ...n, emotions: emos.length ? emos : n.emotions, caption, desc_text: desc };
  });

  const summary = guard(raw.summary_text, 'timeline.summary') || guard(raw.summary, 'timeline.summary') || rule.summary;

  const ah = raw.action_hint || {};
  const hint = rule.actionHint || {};
  const actionHint = {
    title: guard(ah.title, 'timeline.ah.title') || hint.title,
    step: guard(ah.step, 'timeline.ah.step') || hint.step,
    note: guard(ah.note, 'timeline.ah.note') || hint.note,
  };

  // 新字段：模型给的优先，否则由 withTimelineMeta 用本地兜底（标题/副标题/footer/按钮）。
  return withTimelineMeta({
    type: 'timeline',
    nodes,
    summary,
    actionHint,
    ...(typeof raw.card_title === 'string' && raw.card_title ? { card_title: raw.card_title } : {}),
    ...(typeof raw.card_subtitle === 'string' && raw.card_subtitle ? { card_subtitle: raw.card_subtitle } : {}),
    ...(typeof raw.footer_note === 'string' && raw.footer_note ? { footer_note: raw.footer_note } : {}),
    ...(typeof raw.btn_left === 'string' && raw.btn_left ? { btn_left: raw.btn_left } : {}),
    ...(typeof raw.btn_right === 'string' && raw.btn_right ? { btn_right: raw.btn_right } : {}),
  });
}

function normalizeWeekly(raw, cards) {
  const rule = weeklyReport(cards);
  if (!raw || typeof raw !== 'object') return rule;

  const rows = (v, keys, fallback) => {
    const list = Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : [];
    const out = list.map((x) => {
      const o = {};
      keys.forEach((k) => { o[k] = typeof x[k] === 'number' ? x[k] : guard(x[k], 'weekly.' + k); });
      return o;
    }).filter((o) => Object.values(o).some((x) => x !== '' && x !== 0));
    return out.length ? out : fallback;
  };

  return validateShape('weekly', {
    week_start: rule.week_start,
    week_end: rule.week_end,
    headline: guard(raw.headline, 'weekly.headline') || rule.headline,
    top_triggers: rows(raw.top_triggers, ['trigger', 'count', 'emotion'], rule.top_triggers),
    top_people: rows(raw.top_people, ['person', 'count', 'avg_intensity'], rule.top_people),
    correlations: rows(raw.correlations, ['factor', 'observation'], rule.correlations),
    effective_coping: rows(raw.effective_coping, ['action', 'result'], rule.effective_coping),
    experiment: guard(raw.experiment, 'weekly.experiment') || rule.experiment,
    summary: guard(raw.summary, 'weekly.summary') || rule.summary,
    cards_count: rule.cards_count,
  });
}

/* ==================== 统一调用封装 ==================== */

/**
 * 走一次「真实模型 + 严格解析」，只取数据；拿不到就返回 null，交调用方降级到本地规则引擎。
 * 同时把这一跳写进链路诊断日志：用了哪个模型、多久、成功还是降级、模型原文长什么样。
 * @returns {Promise<object|null>}
 */
async function ask(opts) {
  const stage = opts.stage || 'llm';
  const dseq = diag.begin('ai', stage, {
    detail: `tier=${opts.tier || '-'} temp=${opts.temperature} maxTokens=${opts.maxTokens || '-'}`,
  });
  const t = Date.now();
  const r = await callJson(opts);
  const used = r.model || (llmDebug() && llmDebug().model) || '';
  diag.end(dseq, {
    ok: !!r.ok,
    code: r.ok ? '' : (r.code || 'unknown'),
    model: used,
    ms: Date.now() - t,
    detail: r.ok ? '模型返回已解析为 JSON' : `未取到结构化结果，降级到本地规则引擎（${r.code || 'unknown'}）`,
    raw: r.text || '',
  });
  return r.ok ? r.data : null;
}

/** 归一化结果也留一条痕：用户要看的是「最终拿到的 JSON」，不是模型原文里的噪声 */
function diagJson(stage, data, extra = '') {
  try {
    diag.note('ai', stage + '.json', { ok: true, detail: extra, raw: JSON.stringify(data) });
  } catch (e) { /* ignore */ }
  return data;
}

/* ==================== 对外接口 ==================== */

export const api = {
  /**
   * POST /api/safety —— 安全识别（每次输入后先跑）
   *
   * 这一段的兜底是本产品最不能含糊的地方，三条分支写死：
   *   ① 模型答了 → 用归一化结果（等级与动作不一致只往更保守的方向纠正）
   *   ② 模型「该答没答好」（超时/报错/解析失败/被内容过滤/空响应）→ medium + gentle_check，绝不放行 continue
   *   ③ 通道结构性不可用（离线 / 显式走本地 / 无可用模型）→ 本地规则引擎，它本身就是完整的安全分类器
   * @returns {Promise<{risk_level:string, reason:string, action:string}>}
   */
  async safety({ transcript = '' } = {}) {
    const dseq = diag.begin('ai', 'safety', {
      detail: `tier=fast temp=${MODEL_CONFIG.safety.temperature} 输入=${String(transcript).slice(0, 40)}`,
    });
    const t = Date.now();
    const res = await callJson({
      stage: 'safety',
      system: SYSTEM.safety,
      user: buildSafetyPrompt(transcript),
      temperature: MODEL_CONFIG.safety.temperature,
      maxTokens: MODEL_CONFIG.safety.maxTokens,
      json: true,
      tier: 'fast', // v1.5 §2.1：安全识别走极速 + 高召回档
    });
    const used = res.model || (llmDebug() && llmDebug().model) || '';
    diag.end(dseq, {
      ok: !!res.ok,
      code: res.ok ? '' : (res.code || 'unknown'),
      model: used,
      ms: Date.now() - t,
      detail: res.ok ? '模型返回已解析为 JSON' : `未取到结果：${res.code || 'unknown'}${isStructural(res.code) ? '（结构性不可用 → 本地规则引擎）' : '（保守兜底 gentle_check）'}`,
      raw: res.text || '',
    });

    let r;
    if (res.ok) {
      r = normalizeSafety(res.data);
    } else if (isStructural(res.code)) {
      r = { ...safetyCheck(transcript), degraded: 'local_engine' };
    } else {
      r = normalizeSafety(null);
      r.degraded = res.code || 'llm_failed';
    }
    // 安全识别的放行/拦截结论必须留痕：这是整条链路上唯一一个「能不能继续」的开关
    diag.note('ai', 'safety.verdict', {
      ok: true,
      detail: `风险等级=${r.risk_level} 动作=${r.action}${r.degraded ? ` 降级=${r.degraded}` : ''}`,
      raw: JSON.stringify({ risk_level: r.risk_level, action: r.action, reason: r.reason || '', degraded: r.degraded || '' }),
    });

    store.setRisk({
      level: r.risk_level,
      action: r.action,
      evidence: r.risk_level === 'none' ? '' : str(transcript).slice(0, 60),
    });
    return r;
  },

  /**
   * POST /api/analyze —— 主分析（安全识别 action=continue 后）
   * @returns {Promise<object>} 主分析 JSON
   */
  async analyze({ transcript = '', onProgress, voiceFeatures = null } = {}) {
    // v1.3.0 记忆地基：跨会话结构化记忆召回，注入主分析提示（受 memory_on 总开关控制）。
    let memoryContext = '';
    try {
      // v1.6.19 P1-2：严格全等 —— 字段缺失按「关」处理（旧 `!== false` 会把"没有这个字段"误判成"用户同意了"）
      const on = (store.getState().user.settings.memory_on) === true;
      if (on) {
        const units = await memory.loadMemory();
        const top = memory.recallTopN(units, { transcript, emotion: [], limit: 3 });
        if (top.length) memoryContext = memory.buildMemoryContext(top.map((t) => t.unit));
      }
    } catch (e) { /* 降级：无记忆上下文，不影响主流程 */ }
    const raw = await ask({
      stage: 'main',
      system: sysWithPrefs(SYSTEM.main),
      user: buildMainPrompt(transcript, voiceFeatures, memoryContext),
      temperature: MODEL_CONFIG.main.temperature,
      maxTokens: MODEL_CONFIG.main.maxTokens,
      json: true,
      tier: 'strong', // v1.5 §2.2：主分析走强推理档，治「追问泛泛而谈」与 JSON 不稳
      onProgress,      // v1.5 §2.2：流式输出回调（逐字显示）
    });
    if (raw) return diagJson('main', normalizeAnalysis(raw, transcript));
    return diagJson('main', analyzeMain(transcript), '本地规则引擎兜底'); // 降级：绝不让流程断在这里
  },

  /**
   * POST /api/followup —— 追问
   * @returns {Promise<object>}
   */
  async followup({ analysis = null, asked = [], userAnswer = '', round = 0 } = {}) {
    // 已经问满 3 轮 → 收尾，不再白调一次模型
    if (round >= 3) {
      return validateShape('followup', { empathy: '', question: '', round: 3, can_skip: true, ready_for_card: true });
    }
    // 用户明确表示不想继续 → 也不打扰模型
    if (/不想说|跳过|不聊了|算了|没必要/.test(str(userAnswer))) {
      return validateShape('followup', { empathy: '', question: '', round: Math.min(round + 1, 3), can_skip: true, ready_for_card: true });
    }
    const raw = await ask({
      stage: 'followup',
      system: sysWithPrefs(SYSTEM.followup),
      user: buildFollowupPrompt({ analysis, asked, userAnswer }),
      temperature: MODEL_CONFIG.followup.temperature,
      maxTokens: MODEL_CONFIG.followup.maxTokens,
      json: true,
      tier: 'strong', // v1.5 §2.2：追问走强推理档
    });
    if (raw) return diagJson('followup', normalizeFollowup(raw, { round, asked }));
    return diagJson('followup', nextFollowup({ analysis, asked, userAnswer, round }), '本地规则引擎兜底');
  },

  /** POST /api/card/generate —— 追问结束后整合成卡片（不落库） */
  async cardGenerate({ analysis = null, followup = [], extra = '', transcript = '' } = {}) {
    const raw = await ask({
      stage: 'card',
      system: sysWithPrefs(SYSTEM.card),
      user: buildCardPrompt({ analysis, followup, extra }),
      temperature: MODEL_CONFIG.card.temperature,
      maxTokens: MODEL_CONFIG.card.maxTokens,
      json: true,
      tier: 'strong', // v1.5 §2.2：卡片走强推理档
    });
    if (raw) return diagJson('card', normalizeCard(raw, analysis, followup, extra, transcript));
    return diagJson('card', buildScenarioCard({ analysis, followup, extra, transcript }), '本地规则引擎兜底');
  },

  /** POST /api/card/create */
  async cardCreate(card) {
    return store.addCard(card);
  },

  /** 情绪时间线：由本次会话对话流生成复盘卡（本地规则引擎为离线主路径，云端为增强） */
  async timelineGenerate({ conversation = [] } = {}) {
    const raw = await ask({
      stage: 'timeline',
      system: SYSTEM.timeline,
      user: buildTimelinePrompt({ conversation }),
      temperature: MODEL_CONFIG.timeline.temperature,
      maxTokens: MODEL_CONFIG.timeline.maxTokens,
      json: true,
      tier: 'strong',
    });
    if (raw) return diagJson('timeline', normalizeTimeline(raw, conversation));
    return diagJson('timeline', buildTimeline(conversation), '本地规则引擎兜底');
  },

  /** 保存时间线卡片到本机（隐私优先，完全本地，不自动分享） */
  async saveTimeline(tl) {
    return store.addTimeline(tl);
  },

  // v1.6.15：删掉 cardList / cardGet（全仓零调用）。卡片列表在 UI 里直接读 store 渲染，
  // 这两个「看起来是接口、实际没人打」的壳子只会误导后来人。

  /** GET /api/report/weekly */
  async reportWeekly() {
    const cards = store.getState().cards;
    if (!cards.length) return weeklyReport(cards);
    const raw = await ask({
      stage: 'weekly',
      system: SYSTEM.weekly,
      user: buildWeeklyPrompt({ cards: cards.slice(0, 30) }),
      temperature: MODEL_CONFIG.weekly.temperature,
      maxTokens: MODEL_CONFIG.weekly.maxTokens,
      json: true,
      tier: 'strong', // v1.5 §2.2：周报走强推理档
    });
    return normalizeWeekly(raw, cards);
  },

  /** DELETE /api/user/data */
  async userDataDelete() {
    store.deleteAllData();
    // v1.3.0 记忆地基：一键删除全部数据时，IndexedDB 里的记忆与历史会话一并清空。
    try { await memory.clearMemory(); } catch (e) { /* ignore */ }
    return { deleted: true };
  },

  /** 诊断用：当前 AI 通道状态 + 调用轨迹（自测与排查取证据的入口） */
  aiStatus() {
    return {
      ...llmStats(),
      forbidden: forbiddenHits(),
      intensityFixed: intensityAdjustments(),
      inputCap: AI.maxInputChars,
    };
  },

  aiDebug() { return llmDebug(); },
};
