// 墨小溟 · AI 引擎（mock 规则实现，严格对齐《AI Prompt 模板与文案库 v1.0》的 5 段输出契约）
// 换真实 LLM 时：用 prompts.js 的 builder 出 Prompt → 解析 JSON → 过 validateShape 兜底 → 返回同结构。

import { scrubForbidden, CARD_LIB, CARD_LAYER, TIMELINE_EMOTION_KEYWORDS, TIMELINE_EMOTIONS } from './prompts.js';

/* ==================== 词典 ==================== */

// 安全识别：按等级从高到低匹配，命中即停
const RISK_CRITICAL = ['正在割', '已经割', '正在流血', '已经吞', '已经吃药', '已经吃了药', '站在楼顶', '马上跳',
  '现在就结束', '正在自残', '正在伤害自己', '已经动手', '正在实施'];
const RISK_HIGH = ['自杀', '不想活', '活不下去', '想死', '结束生命', '轻生', '跳楼', '割腕', '自残', '伤害自己',
  '死了算了', '不如死', '活着没意思', '想结束', '一了百了', '消失', '解脱'];
const RISK_MEDIUM = ['绝望', '没意义', '撑不住', '熬不住', '崩溃', '麻木', '看不到希望', '顶不住', '没盼头', '活着好累'];
const RISK_LOW = ['低落', '难受', '很累', '压力大', '想哭', '孤独', 'emo', '心情不好', '有点丧'];
// 伤害他人风险（§4.7）：明确的伤害他人意图，本地兜底也要拦下来走 harm_others 动作
const RISK_HARM_OTHERS = ['伤害他', '伤害别人', '杀了他', '弄死他', '弄死别人', '报复他', '报复社会', '打死他', '打他一顿'];

// 顺序与 PRD 示例保持一致：同分时按此顺序输出（委屈在愤怒前）
const EMOTION_LEX = {
  委屈: ['委屈', '不被理解', '没人懂', '不被重视', '不重视', '忽视', '冷落', '不在乎我', '不在乎', '不回我'],
  愤怒: ['生气', '愤怒', '气死', '火大', '吵架', '吵', '烦', '讨厌', '恨', '凭什么', '不公平'],
  焦虑: ['焦虑', '担心', '紧张', '慌', '不安', '着急', '来不及'],
  羞耻: ['丢人', '羞耻', '没脸', '尴尬', '不配', '自我怀疑', '蠢'],
  悲伤: ['难过', '伤心', '悲伤', '想哭', '哭', '低落', '失落', '沮丧'],
  恐惧: ['害怕', '恐惧', '怕', '恐慌', '担心失去'],
  孤独: ['孤独', '一个人', '没人陪', '没人懂', '孤立'],
  无力: ['无力', '没办法', '改变不了', '使不上', '疲惫', '没力气'],
  内疚: ['内疚', '愧疚', '对不起', '自责', '怪我'],
  嫉妒: ['嫉妒', '吃醋', '羡慕'],
  开心: ['开心', '高兴', '幸福', '满足', '轻松', '愉快', '被暖到'],
  平静: ['平静', '还好', '踏实', '安心'],
};

const BODY_LEX = {
  胸闷: ['胸闷', '胸口', '喘不过', '窒息', '压得慌'],
  胃紧: ['胃', '反胃', '恶心', '胃紧'],
  头痛: ['头疼', '头痛', '炸开'],
  想哭: ['想哭', '眼泪', '哽咽'],
  发抖: ['发抖', '手抖', '抖'],
  失眠: ['睡不着', '失眠', '熬夜', '翻来覆去'],
  心跳快: ['心跳', '心慌', '心跳加快'],
};

const PEOPLE = ['男朋友', '女朋友', '老公', '老婆', '伴侣', '对象', '妈妈', '妈', '爸爸', '爸', '父母', '家人',
  '老板', '领导', '上司', '同事', '客户', '朋友', '闺蜜', '兄弟', '婆婆', '孩子', '老师', '室友', '他', '她'];

const SCENE_LEX = {
  亲密关系: ['男朋友', '女朋友', '老公', '老婆', '伴侣', '对象', '恋爱', '分手', '吵架'],
  原生家庭: ['父母', '妈妈', '妈', '爸爸', '爸', '家里', '原生家庭', '婆婆'],
  职场: ['老板', '领导', '上司', '同事', '客户', '加班', '开会', '项目', '绩效', '工作', '升职'],
  友情: ['朋友', '闺蜜', '兄弟', '室友'],
};

const BEHAVIOR_LEX = {
  冷战: ['冷战', '不理', '不回', '沉默', '摔门'],
  反击: ['吵回去', '反击', '骂回去', '怼'],
  争吵: ['吵架', '吵', '争', '吼', '骂'],
  压抑: ['忍着', '算了', '没说什么', '憋着', '压着'],
  逃避: ['逃避', '躲', '走开', ' vanished', '不理'],
  反复追问: ['反复问', '追着问', '一直问', '要他解释'],
  倾诉: ['跟朋友说', '找人聊', '倾诉', '说出来'],
  运动: ['跑步', '运动', '健身', '散步'],
  主动沟通: ['说清楚', '沟通', '表达', '问他', '说出来', '好好谈'],
};

// 认知模式：顺序=优先级（具体在前，泛化在后）
const PATTERNS = [
  { name: '读心', kws: ['他肯定', '她肯定', '他一定', '她一定', '肯定觉得', '不在乎我', '不爱我', '觉得我'],
    desc: (e, t) => `在缺少证据时，先替对方下了结论：${t || e}` },
  { name: '个人化', kws: ['都是我的错', '怪我', '我不够好', '是我不好', '都是我'],
    desc: () => '把责任全揽到自己身上，忽略了其他因素' },
  { name: '灾难化', kws: ['完了', '没救了', '完蛋', '毁了', '没希望', '彻底'],
    desc: () => '把一次事件推演成了不可挽回的结局' },
  { name: '应该化', kws: ['应该', '必须', '本来就该', '不应该'],
    desc: (e) => `用「应该」框住了对方或自己（围绕「${e}」）` },
  { name: '以偏概全', kws: ['每次都这样', '都这样', '总这样', '又这样', '又是这样'],
    desc: () => '用单次事件替整段关系/整个人下了定义' },
  { name: '绝对化', kws: ['总是', '从来', '根本', '永远', '一直', '每次都', '一直都不'],
    desc: (e) => `把「${e}」概括成了「总是/从来不」的绝对判断` },
];

const NEED_LEX = ['被重视', '被尊重', '安全感', '控制感', '公平', '被看见', '边界', '可预期', '被理解', '被爱'];
const EMOTION_NEED = {
  委屈: ['被看见', '被尊重'], 愤怒: ['被尊重', '公平'], 焦虑: ['可预期', '安全感'],
  羞耻: ['被理解'], 悲伤: ['被看见', '被爱'], 恐惧: ['安全感', '控制感'],
  孤独: ['被爱', '被看见'], 无力: ['控制感'], 内疚: ['被理解'], 嫉妒: ['安全感'], 开心: ['被看见'], 平静: [],
};
const PATTERN_NEED = { 读心: '被重视', 个人化: '被尊重', 灾难化: '安全感', 以偏概全: '可预期', 绝对化: '可预期', 应该化: '被尊重' };

const BG_FACTORS = ['加班', '熬夜', '失眠', '没睡好', '经期', '姨妈', '饮酒', '喝酒', '生病', '感冒'];

/* ==================== 工具 ==================== */

const has = (t, list) => list.some((w) => t.includes(w));
const firstMatch = (t, list) => list.find((w) => t.includes(w)) || '';
const seg = (t) => t.split(/[。！？!?\n，,]/).map((s) => s.trim()).filter(Boolean);

function extractEvent(t) {
  const s = seg(t)[0] || t.slice(0, 24);
  return s.replace(/^(今天|昨天|刚刚|刚才|早上|晚上|中午|最近|这周|这几天)\s*/, '').slice(0, 24) || '这次发生的事';
}
function extractThought(t) {
  const m = t.match(/[^。！？!?，,\n]*(觉得|认为|肯定|以为|感觉|应该)[^。！？!?\n]*/);
  return m ? m[0].trim() : '';
}
function detectEmotions(t) {
  const scores = [];
  for (const [emo, kws] of Object.entries(EMOTION_LEX)) {
    const n = kws.reduce((a, w) => a + (t.split(w).length - 1), 0);
    if (n > 0) scores.push([emo, n]);
  }
  scores.sort((a, b) => b[1] - a[1]);
  return scores.slice(0, 2).map((s) => s[0]);
}
function detectIntensity(t, emos) {
  let v = 5;
  if (emos.length >= 2) v += 1;
  if (has(t, ['又', '根本', '一直', '每次', '受够了', '彻底'])) v += 1;
  if (has(t, ['很', '特别', '非常', '极其'])) v += 1;
  if (has(t, ['一点点', '有点', '还好'])) v -= 2;
  return Math.max(0, Math.min(10, v));
}
function detectBodies(t) { return Object.entries(BODY_LEX).filter(([, kws]) => has(t, kws)).map(([k]) => k); }
function detectPeople(t) { return [...new Set(PEOPLE.filter((p) => t.includes(p)))].slice(0, 3); }
function detectScene(t) {
  const sc = Object.entries(SCENE_LEX).find(([, kws]) => has(t, kws));
  const bg = firstMatch(t, BG_FACTORS);
  const parts = [];
  if (sc) parts.push(sc[0]);
  if (bg) parts.push(bg);
  return parts.join(' · ');
}
function detectBehavior(t) {
  for (const [k, kws] of Object.entries(BEHAVIOR_LEX)) if (has(t, kws)) return k;
  return '';
}
function detectPatterns(t) {
  const t2 = t.toLowerCase();
  return PATTERNS.filter((p) => p.kws.some((w) => t2.includes(w)));
}
function deriveNeeds(text, emos, patterns) {
  const set = new Set();
  patterns.forEach((p) => { if (PATTERN_NEED[p.name]) set.add(PATTERN_NEED[p.name]); });
  if (/回消息|没回|不回|消息慢|回复|已读|等/.test(text)) set.add('可预期');
  emos.forEach((e) => (EMOTION_NEED[e] || []).forEach((n) => set.add(n)));
  if (!set.size) set.add('被看见');
  return [...set].filter((n) => NEED_LEX.includes(n)).slice(0, 3);
}
function resultOf(behavior) {
  return {
    冷战: '更焦虑，关系更紧张', 反击: '升级成更大的冲突', 争吵: '两个人都更累，问题没解决',
    压抑: '表面过去了，心里更堵', 逃避: '当下轻松，事后更内耗', 反复追问: '对方更躲，自己更不安',
    倾诉: '当下轻一点，但没找到模式', 运动: '身体松了，情绪还在', 主动沟通: '事情往前推了一步',
  }[behavior] || '情绪没有得到处理，还留在身体里';
}
function experimentOf(pattern, person) {
  const who = person || '对方';
  if (!pattern) return '下次有类似感觉时，先在心里说一句「我现在感觉到的是情绪，不是事实」，再决定怎么做';
  return {
    读心: `直接问${who}一句「你刚才是怎么想的？」，用他的回答替换你的猜测`,
    个人化: '列出 3 个不由你负责的因素，再决定自己真正该做的那 1 件',
    灾难化: '给这件事写「最坏 / 最好 / 最可能」三行，只做「最可能」那一列的事',
    应该化: `把「${who}应该……」改成「我希望……」，然后只说出这个希望`,
    以偏概全: '这次只描述「这一次」发生了什么，不写成「你每次都……」',
    绝对化: '把「总是/从来不」换成一个具体次数，比如「这周有 2 次」',
  }[pattern.name] || '先说出感受，再说出需要：「我现在需要……」';
}
const NEED_NEG = { 被重视: '不被重视', 被尊重: '不被尊重', 安全感: '不安全', 控制感: '失控', 公平: '不被公平对待', 被看见: '被忽视', 边界: '边界被越界', 可预期: '不可预期', 被理解: '不被理解', 被爱: '不被爱' };

/* ==================== 契约校验与兜底（§7.4）==================== */

const DEFAULTS = {
  safety: { risk_level: 'medium', reason: '安全识别失败，按保守策略处理', action: 'gentle_check' }, // §7.5 兜底非 continue
  main: {
    event: '', people: [], scene: '', emotion: [], emotion_primary: '', emotion_secondary: '',
    emotion_shift: '', shift_trigger: '', hidden_need: '', intensity: 5, body: [], thought: '',
    cognitive_patterns: [], need: [], behavior: '', result: '', pattern: '', experiment: '',
    summary: '', ip_state: 'empathy', ip_action: 'comfort_sway',
    needs_followup: true, followup_questions: [],
  },
  followup: { empathy: '', question: '', round: 1, can_skip: true, ready_for_card: false },
  card: {
    title: '', date: '', event: '', emotion: [], emotion_primary: '', emotion_secondary: '',
    emotion_shift: '', shift_trigger: '', hidden_need: '', intensity: 5, body: [], thought: '', need: [],
    behavior: '', result: '', pattern: '', experiment: '', summary: '', tags: [], ip_state: 'empathy',
    // 四类场景卡片（v1.0.0-RC 升级）：前端按 card_type 逐字回填标题/正文/动作
    card_type: 'see', card_layer: '', card_name: '', action_title: '', action_step: '', action_note: '', card_body: '',
  },
  weekly: {
    week_start: '', week_end: '', headline: '', top_triggers: [], top_people: [],
    correlations: [], effective_coping: [], experiment: '', summary: '', cards_count: 0,
  },
};

/** 用默认值补齐缺失字段，保证前端不崩 */
export function validateShape(type, obj) {
  const base = DEFAULTS[type] || {};
  if (!obj || typeof obj !== 'object') return { ...base };
  const out = { ...base };
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(base[k]) && !Array.isArray(v)) continue;
    out[k] = v;
  }
  return out;
}

/** 真实 LLM 返回的 JSON 解析兜底 */
export function safeJsonParse(str, type) {
  try { return validateShape(type, JSON.parse(str)); }
  catch (e) { return { ...(DEFAULTS[type] || {}) }; }
}

/* ==================== 1. 安全识别 ==================== */

/**
 * @returns {{risk_level:'none'|'low'|'medium'|'high'|'critical', reason:string, action:'continue'|'gentle_check'|'refer'|'emergency'}}
 */
export function safetyCheck(text) {
  const t = (text || '').trim();
  const kw = (list) => firstMatch(t, list);

  let level = 'none';
  let hitWord = '';
  if ((hitWord = kw(RISK_CRITICAL))) level = 'critical';
  else if ((hitWord = kw(RISK_HIGH))) level = 'high';
  else if ((hitWord = kw(RISK_HARM_OTHERS))) level = 'high';
  else if ((hitWord = kw(RISK_MEDIUM))) level = 'medium';
  else if ((hitWord = kw(RISK_LOW))) level = 'low';

  const action = level === 'critical' ? 'emergency'
    : level === 'high' ? (RISK_HARM_OTHERS.some((w) => (hitWord || '').includes(w)) ? 'harm_others' : 'refer')
      : level === 'medium' ? 'gentle_check'
        : 'continue';

  const reason = hitWord
    ? (level === 'none' ? '无高风险表述' : `命中高风险表述「${hitWord}」`)
    : '未命中高风险词，无自伤自杀意念';

  return validateShape('safety', { risk_level: level, reason, action });
}

/* ==================== 2. 主分析 ==================== */

export function analyzeMain(text) {
  const t = (text || '').trim();
  const event = extractEvent(t);
  const thought = extractThought(t);
  const patterns = detectPatterns(t);
  const emos = detectEmotions(t);
  const bodies = detectBodies(t);
  const people = detectPeople(t);
  const scene = detectScene(t);
  const behavior = detectBehavior(t);
  const intensity = detectIntensity(t, emos);
  const need = deriveNeeds(t, emos, patterns);
  const primary = patterns[0] || null;

  const cardish = { event, need, intensity };
  const summary = makeSummary(cardish, primary);

  // 信息不足判定（§ 主分析原则 7）：关键维度命中 <4 个则需要追问
  const dims = [!!thought, bodies.length > 0, !!scene, !!behavior, /以前|历史|之前也有|又一次/.test(t)].filter(Boolean).length;
  const needs_followup = dims < 4;

  const followup_questions = buildQuestions({ event, need, people, thought });

  return validateShape('main', {
    event,
    people,
    scene,
    emotion: emos.length ? emos : ['悲伤'],
    emotion_primary: emos[0] || '',
    emotion_secondary: emos[1] || '',
    emotion_shift: '',
    shift_trigger: '',
    hidden_need: '',
    intensity,
    body: bodies,
    thought,
    cognitive_patterns: patterns.map((p) => p.name),
    need,
    behavior,
    result: resultOf(behavior),
    pattern: primary ? primary.desc(event, thought) : '',
    experiment: experimentOf(primary, people[0]),
    summary,
    ip_state: ipStateForMain(emos, intensity),
    ip_action: 'comfort_sway',
    needs_followup,
    followup_questions,
  });
}

/** 由情绪与强度推导一个 IP 状态（规则引擎兜底版；真实模型会直接给 ip_state） */
function ipStateForMain(emos, intensity) {
  if (emos.includes('开心')) return 'happy';
  if (emos.includes('平静') || emos.includes('安心') || emos.includes('温柔')) return intensity <= 5 ? 'tender' : 'happy';
  if (intensity <= 4) return 'calm';
  if ((emos.includes('悲伤') || emos.includes('委屈') || emos.includes('难过')) && intensity >= 7) return 'empathy_tears';
  return 'empathy';
}

function makeSummary(c, pattern) {
  const needTxt = (c.need && c.need[0]) || '被看见';
  const base = pattern
    ? `你不是因为「${c.event}」而难受，是那一刻「${needTxt}」的需要被碰到了。这不是你太敏感，是一个可以慢慢练习的模式。`
    : `你刚才说的这些，我听见了。「${c.event}」让你不好受，而你在意的其实是「${needTxt}」。`;
  return scrubForbidden(base);
}

function buildQuestions({ event, need, people, thought }) {
  const who = people[0] || '对方';
  const qs = [
    '当时那一刻，你脑子里冒出来的第一句话是什么？',
    `你最难受的是「${event}」本身，还是那种「${need[0] || '不被看见'}」的感觉？`,
    '类似的感觉，以前什么时候也出现过？',
    '如果这个情绪会说话，它想保护你什么？',
    `下次同样情况，你愿意先试哪个小动作？（比如先跟${who}说一句你的需要）`,
  ];
  // 已有 thought 时，跳过"第一句话"那问
  return (thought ? qs.slice(1) : qs).slice(0, 3);
}

/* ==================== 3. 追问 ==================== */

const EMPATHY_BY_EMOTION = {
  委屈: '这种感觉，真的挺委屈的。',
  愤怒: '生气是有道理的。',
  焦虑: '心一直悬着，很难受吧。',
  悲伤: '难过的时候，慢一点也没关系。',
  孤独: '一个人扛，很辛苦。',
  恐惧: '害怕的感觉，我听见了。',
  无力: '觉得使不上劲，很累吧。',
  内疚: '你已经很不容易了。',
  羞耻: '这件事不代表你不好。',
  嫉妒: '会不舒服，很正常。',
  开心: '这份开心，值得记住。',
  平静: '嗯，我在听。',
};

/**
 * 生成下一轮追问。
 * @param {{analysis:object, asked:string[], userAnswer:string, round:number}} p
 * @returns {{empathy:string, question:string, round:number, can_skip:boolean, ready_for_card:boolean}}
 */
export function nextFollowup({ analysis, asked = [], userAnswer = '', round = 0 } = {}) {
  const a = validateShape('main', analysis);
  // 满 3 轮 → 收敛
  if (round >= 3) {
    return validateShape('followup', { empathy: '', question: '', round: 3, can_skip: true, ready_for_card: true });
  }
  // 用户表示不想继续
  if (/不想说|跳过|不聊了|算了|没必要/.test(userAnswer)) {
    return validateShape('followup', { empathy: '', question: '', round: round + 1, can_skip: true, ready_for_card: true });
  }

  const pool = (a.followup_questions && a.followup_questions.length)
    ? a.followup_questions
    : buildQuestions({ event: a.event, need: a.need, people: a.people, thought: a.thought });

  const remaining = pool.filter((q) => !asked.includes(q));
  if (!remaining.length) {
    return validateShape('followup', { empathy: '', question: '', round: round + 1, can_skip: true, ready_for_card: true });
  }
  const question = remaining[0];
  const empathy = EMPATHY_BY_EMOTION[(a.emotion && a.emotion[0]) || '平静'] || '我听见了。';

  return validateShape('followup', {
    empathy,
    question,
    round: round + 1,
    can_skip: true,
    ready_for_card: false,
  });
}

/* ==================== 4. 卡片生成 ==================== */

export function generateCard({ analysis, followup = [], extra = '' } = {}) {
  const a = validateShape('main', analysis);
  const extraText = [a.event, a.thought, ...(a.emotion || []), extra].filter(Boolean).join(' ');
  const need = (a.need && a.need.length) ? a.need : deriveNeeds(extraText, a.emotion || [], []);
  const pattern = a.pattern || '';
  const primaryName = (a.cognitive_patterns || [])[0] || null;

  const event = (a.event || '一次情绪事件').replace(/了$/, '');
  const need0 = need[0] || '被看见';
  const title = `${event.slice(0, 18)}，让我觉得${NEED_NEG[need0] || need0}`;

  const tags = [];
  if (a.scene) tags.push(a.scene.split(' · ')[0]);
  if (need0) tags.push(NEED_NEG[need0] || need0);
  if (a.body && a.body.length) tags.push('身体有反应');

  const intensity = a.intensity || 0;
  const ip_state = (a.emotion || []).some((e) => e === '开心') ? 'happy'
    : (a.emotion || []).some((e) => e === '平静' || e === '安心' || e === '温柔') ? (intensity <= 5 ? 'tender' : 'happy')
      : intensity <= 4 ? 'calm'
        : ((a.emotion || []).some((e) => e === '悲伤' || e === '委屈' || e === '难过') && intensity >= 7) ? 'empathy_tears'
          : 'empathy';

  // 用户补充的回答并入实验
  const experiment = extra ? `${a.experiment || ''}`.trim() || a.experiment : a.experiment;

  return validateShape('card', {
    title: scrubForbidden(title),
    date: new Date().toISOString().slice(0, 10),
    event: a.event,
    emotion: a.emotion,
    emotion_primary: a.emotion_primary || (a.emotion && a.emotion[0]) || '',
    emotion_secondary: a.emotion_secondary || (a.emotion && a.emotion[1]) || '',
    emotion_shift: a.emotion_shift || '',
    shift_trigger: a.shift_trigger || '',
    hidden_need: a.hidden_need || '',
    intensity,
    body: a.body,
    thought: a.thought,
    need,
    behavior: a.behavior,
    result: a.result,
    pattern,
    experiment,
    summary: scrubForbidden(a.summary || makeSummary({ event: a.event, need, intensity }, primaryName ? { name: primaryName } : null)),
    tags: [...new Set(tags)].slice(0, 3),
    ip_state,
    // 以下为周报聚合所需的内部字段（卡片契约未列，不影响对外结构）
    people: a.people || [],
    scene: a.scene || '',
  });
}

/* ==================== 4b. 四类场景卡片引擎（v1.0.0-RC 升级） ==================== */

const NEG_SET = new Set(['愤怒', '委屈', '焦虑', '羞耻', '悲伤', '恐惧', '孤独', '无力', '内疚', '嫉妒']);
const POS_SET = new Set(['开心', '高兴', '喜悦', '幸福', '满足', '轻松', '愉快', '平静', '安心', '踏实', '温柔']);

// 矛盾/复杂情绪信号：① 同时含正负情绪；② 明确转折词（一边…一边 / 又…又 / 明明…却 / 虽然…但 / 反而）
const CONTRADICTION_RE = /(一边.{0,10}一边|又.{0,8}又|明明.{0,14}(却|但)|虽然.{0,14}(但|却)|反而|却.{0,10}(开心|高兴|轻松|喜悦)|开心.{0,14}(委屈|难受|难过|心酸)|高兴.{0,14}(委屈|难受|难过)|委屈.{0,14}(开心|高兴|轻松)|难过.{0,14}(开心|轻松))/;

function isContradictory(emotion = [], transcript = '') {
  const emo = Array.isArray(emotion) ? emotion : [];
  const hasPos = emo.some((e) => POS_SET.has(e));
  const hasNeg = emo.some((e) => NEG_SET.has(e));
  return (hasPos && hasNeg) || CONTRADICTION_RE.test(transcript || '');
}

// 反刍 / 灾难化 / 读心 / 以偏概全 信号
const RUMINATION_RE = /(一定|肯定|觉得他|觉得她|脑补|灾难|钻牛角尖|想不通|反复想|越想越|全是|都怪|活该)/;

/**
 * 按对话场景选择四类卡片之一。
 * 优先级：① 矛盾/复杂情绪 → see；② 反刍/灾难化 → notice；③ 任何负向情绪 → action；④ 兜底 → hold。
 * @returns {'see'|'hold'|'notice'|'action'}
 */
export function selectCardType({ analysis = {}, transcript = '' } = {}) {
  const a = validateShape('main', analysis);
  const emo = a.emotion || [];
  const t = transcript || '';
  const pats = a.cognitive_patterns || [];

  if (isContradictory(emo, t)) return 'see';

  const rumination = pats.some((p) => ['灾难化', '读心', '以偏概全'].includes(p)) || RUMINATION_RE.test(t);
  if (rumination) return 'notice';

  if (emo.some((e) => NEG_SET.has(e))) return 'action';

  return 'hold';
}

/** 按情绪类型从微小行动卡的 4 套备选里选一套（命中 match 即选用，顺序即优先级） */
export function pickActionVariant(emotion = [], transcript = '') {
  const emo = Array.isArray(emotion) ? emotion : [];
  const t = transcript || '';
  const variants = (CARD_LIB.action && CARD_LIB.action.variants) || [];
  for (const v of variants) {
    if (emo.some((e) => (v.match || []).includes(e)) || (v.match || []).some((m) => t.includes(m))) return v;
  }
  return variants[1] || { title: '给情绪一个空间', step: '把此刻心里最沉重的一句话，直接打字留在这。不用修饰，写完就可以。', note: '写下来，不一定要立刻解决它。' };
}

/**
 * 产出一张「场景卡片」：含逐字 verbatim 标题/正文/动作（来自 CARD_LIB）+ 结构化资产字段（用于回看详情）。
 * 这是 v1.0.0-RC 升级后的卡片生成入口。
 * 注意：标题/正文/动作始终以 CARD_LIB 为 SSOT 逐字回填，保证与蓝图一字不差；模型只贡献结构化字段与 card_type。
 */
export function buildScenarioCard({ analysis, transcript = '', followup = [], extra = '' } = {}) {
  const a = validateShape('main', analysis);
  const type = selectCardType({ analysis: a, transcript });
  // 结构化资产字段复用 generateCard（event/emotion/intensity/need/body/thought/behavior/result/pattern/experiment/summary/tags）
  const base = generateCard({ analysis: a, followup, extra });
  const lib = CARD_LIB[type] || CARD_LIB.see;

  const card = {
    ...base,
    card_type: type,
    card_layer: CARD_LAYER[type] || '',
    card_name: lib.name || '情绪卡片',
  };

  if (type === 'action') {
    const variant = pickActionVariant(a.emotion, transcript);
    card.action_title = variant.title;
    card.action_step = variant.step;
    card.action_note = variant.note;
    card.title = variant.title;
    card.card_body = `${variant.step} ${variant.note}`;
  } else {
    card.title = lib.title;
    card.card_body = lib.body;
  }
  return validateShape('card', card);
}

/* ==================== 5. 情绪时间线（v1.1.0）====================
 * 复盘载体：对话结束后生成，只记录与呈现情绪流动，不是心理评估、不打分。
 * 约束铁律：① 每轮 ≤2 种并存情绪；② 只取用户说出来的，禁止脑补；③ 全程无情绪 → 简化卡；
 *          ④ 最多 6 节点（超出合并）；⑤ 小结描述流动、不评判、不鸡汤。
 */

/**
 * 从一段文字里抽出时间线情绪标签：按「首次出现顺序」取前 2 个，支持「A+B」并存。
 * 只命中白名单关键词，用户没说就不标（宁缺毋滥，绝不脑补）。
 */
export function detectTimelineEmotions(text) {
  const t = (text || '').trim();
  const found = [];
  for (const [label, kws] of Object.entries(TIMELINE_EMOTION_KEYWORDS)) {
    if (kws.some((w) => t.includes(w))) found.push(label);
  }
  // 按在原文里首次出现的位置排序，保证「先说开心、后说委屈」的叙事顺序
  const ordered = found
    .map((label) => ({ label, idx: Math.max(0, t.indexOf(label)) }))
    .sort((a, b) => a.idx - b.idx);
  return ordered.slice(0, 2).map((x) => x.label);
}

/** 小结文案：描述情绪流动的过程，不评判、不鸡汤、不解读深层原因 */
function buildTimelineSummary(nodes) {
  const seq = nodes.map((n) => (n.emotions && n.emotions.length ? n.emotions.join('+') : '一个未命名的瞬间'));
  const first = seq[0];
  const last = seq[seq.length - 1];
  let s = '这段对话里，你的感受一直在流动。';
  if (nodes.length === 1) {
    s += `从${first}开始，这一轮你主要停留在这里。情绪会停留，也会慢慢走，都是正常的。`;
  } else if (nodes.length === 2) {
    s += `先是${seq[0]}，接着变成了${seq[1]}。从一种感受滑向另一种，中间没有对错。`;
  } else {
    const mid = seq.slice(1, -1);
    s += `先是${seq[0]}`;
    if (mid.length) s += `，中间经过${mid.join('、')}`;
    s += `，最后落在${last}。很多时候情绪并不会一直保持同一种状态，这种来回起伏，是很自然的。`;
  }
  return scrubForbidden(s);
}

/**
 * 由对话流生成时间线卡片数据。
 * @param {Array<{role:string,text:string,at?:number}>} conversation 一次会话的全部消息（user/ai）
 * @returns {{type:'timeline',nodes:Array,summary:string,actionHint:object}
 *          |{type:'no-emotion',summary:string}}
 */
export function buildTimeline(conversation = []) {
  const userMsgs = (conversation || []).filter((m) => m && m.role === 'user' && m.text && m.text.trim());
  if (!userMsgs.length) {
    return { type: 'no-emotion', summary: '本次对话更多是陈述事件，没有捕捉到明显情绪' };
  }

  // 最多 6 节点；超出则把后面的轮次合并进最后一个节点
  const MAX = 6;
  let nodesSrc = userMsgs;
  if (userMsgs.length > MAX) {
    const keep = userMsgs.slice(0, MAX - 1);
    const rest = userMsgs.slice(MAX - 1);
    nodesSrc = [
      ...keep,
      {
        role: 'user',
        text: rest.map((m) => m.text).join('。'),
        at: (rest[rest.length - 1] || {}).at || Date.now(),
        _merged: true,
        _count: rest.length,
      },
    ];
  }

  const nodes = nodesSrc.map((m) => {
    const emotions = detectTimelineEmotions(m.text);
    const snippet = (m.text || '').trim().slice(0, 40);
    return {
      at: m.at || Date.now(),
      text: snippet,
      emotions,
      merged: !!m._merged,
      count: m._count || 1,
    };
  });

  // 全程无情绪 → 简化卡（蓝图 §三.5 边界）
  const anyEmotion = nodes.some((n) => n.emotions.length);
  if (!anyEmotion) {
    return { type: 'no-emotion', summary: '本次对话更多是陈述事件，没有捕捉到明显情绪' };
  }

  const summary = buildTimelineSummary(nodes);

  // 微小停靠提示：复用【微小行动卡】库，按最后一节点的情绪挑最低门槛那一档
  const last = nodes[nodes.length - 1];
  const hint = pickActionVariant(last.emotions, last.text);
  const actionHint = {
    title: (hint && hint.title) || '给情绪一个空间',
    step: (hint && hint.step) || '把此刻心里最沉重的一句话，直接打字留在这。不用修饰，写完就可以。',
    note: (hint && hint.note) || '写下来，不一定要立刻解决它。',
  };

  return { type: 'timeline', nodes, summary, actionHint };
}

/* ==================== 5b. 周报生成 ==================== */

function weekBounds(now = new Date()) {
  const start = new Date(now);
  const day = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - day);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return { start, end };
}

export function weeklyReport(cards) {
  const { start, end } = weekBounds();
  const week = (cards || []).filter((c) => {
    const d = new Date(c.created_at);
    return d >= start && d <= new Date(end.getTime() + 86400000 - 1);
  });

  const tally = (arr) => {
    const m = new Map();
    arr.forEach((k) => { if (k) m.set(k, (m.get(k) || 0) + 1); });
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };

  const triggerTally = tally(week.map((c) => c.event));
  const top_triggers = triggerTally.slice(0, 3).map(([t, n]) => {
    const card = week.find((c) => c.event === t);
    return { trigger: t, count: n, emotion: (card && card.emotion && card.emotion[0]) || '' };
  });

  const top_people = tally(week.map((c) => (c.people && c.people[0]) || '')).slice(0, 3).map(([p, n]) => {
    const rel = week.filter((c) => (c.people && c.people[0]) === p);
    const avg = rel.length ? Math.round((rel.reduce((a, c) => a + (c.intensity || 0), 0) / rel.length) * 10) / 10 : 0;
    return { person: p, count: n, avg_intensity: avg };
  });

  // 关联线索
  const FACTORS = ['睡眠不足', '加班', '经期', '饮酒', '运动'];
  const SIGNALS = { 睡眠不足: ['失眠', '睡不着', '没睡好', '熬夜'], 加班: ['加班', '项目', '赶'], 经期: ['经期', '姨妈'], 饮酒: ['喝酒', '饮酒'], 运动: ['跑步', '运动', '健身'] };
  const correlations = FACTORS.filter((f) => week.some((c) => JSON.stringify(c).includes(SIGNALS[f][0]) || SIGNALS[f].some((s) => JSON.stringify(c).includes(s))))
    .map((f) => ({ factor: f, observation: `本周有情绪记录与「${f}」同日出现（样本 ${week.length} 条，仅供参考）` }));

  const effectiveRaw = tally(week.filter((c) => c.behavior === '主动沟通' || c.behavior === '倾诉' || c.behavior === '运动').map((c) => c.behavior));
  const effective_coping = effectiveRaw.length
    ? effectiveRaw.map(([a]) => ({ action: a, result: '记录后情绪强度回落' }))
    : [{ action: '（本周还没有记录到明显有效的应对方式）', result: '' }];

  const avgIntensity = week.length ? Math.round((week.reduce((a, c) => a + (c.intensity || 0), 0) / week.length) * 10) / 10 : 0;
  const topEmo = tally(week.flatMap((c) => c.emotion || []))[0];

  const headline = week.length === 0
    ? '这周你还没有留下记录'
    : `这周 ${week.length} 次记录，平均强度 ${avgIntensity}/10${topEmo ? `，最常出现「${topEmo[0]}」` : ''}`;

  const experiment = (week[0] && week[0].experiment) || '下周挑一件小事，先说感受，再说需要。';

  const summary = week.length === 0
    ? '不着急，想说的那天再说也行。'
    : `你不是情绪太多，你只是把这一周都感受清楚了。${top_triggers[0] ? `最常碰到你的是「${top_triggers[0].trigger}」。` : ''}`;

  return validateShape('weekly', {
    week_start: start.toISOString().slice(0, 10),
    week_end: end.toISOString().slice(0, 10),
    headline,
    top_triggers,
    top_people,
    correlations,
    effective_coping,
    experiment,
    summary: scrubForbidden(summary),
    cards_count: week.length,
  });
}
