// 墨小溟 · 文案库（v1.3.1 / v1.3.2 / v1.3.3 / v1.3.4）
// 纯数据 + 选取函数，无副作用、无 DOM，便于单元测试与后续维护。
// 约束：开放式、不设问拷问、不鸡汤、不说教；单行、移动端不折行。

/* ============================================================
   随机工具
   ============================================================ */
export function pick(arr, seed) {
  if (!Array.isArray(arr) || !arr.length) return '';
  const i = typeof seed === 'number' ? Math.abs(seed) % arr.length : Math.floor(Math.random() * arr.length);
  return arr[i];
}

/* ============================================================
   一、首页问候语库（v1.3.3）
   ============================================================ */
export const GREETING_LIBRARY = {
  // 时段基础问候（无历史记录的新用户）
  time_based: {
    dawn: ['早上好，有什么想说说的吗？', '早安，心里有话可以讲给我听。', '新的一天，想聊聊什么都可以。', '清晨，你可以慢慢说出心里的感受。'],
    morning: ['早上好，有什么想说说的吗？', '早安，心里有话可以讲给我听。', '新的一天，想聊聊什么都可以。', '清晨，你可以慢慢说出心里的感受。'],
    afternoon: ['下午好，有什么事想说吗？', '午后，心里有话可以和我说说。', '下午好，想到什么，都可以讲。', '此刻，你可以把心事慢慢讲出来。'],
    evening: ['傍晚好，今天有什么感受想诉说吗？', '一天快要结束，想说说心里的感受吗？', '黄昏了，有什么心里话可以告诉我。'],
    night: ['晚上好，愿意和我聊聊吗？', '夜色渐深，心里的情绪可以说出来。', '夜晚，不用硬扛，想说就说。'],
    late: ['夜深了，如果你心里烦闷，可以和我说。', '深夜，不必独自承受，我在这里听。', '安静的夜里，有心事可以慢慢讲。'],
  },
  // 历史情绪适配问候（老用户，只温和呼应，不深挖）
  history_based: {
    sad: ['又见面啦，今天心里感受怎么样？', '我还记得你的情绪，今天想说说吗？', '如果你心里沉甸甸的，可以讲给我听。'],
    tired: ['欢迎回来，累了的话，可以和我说说。', '今天是否也有消耗你的时刻？想说可以讲。'],
    anxious: ['你来了，心里有纷乱的思绪，不妨说一说。', '如果心里乱糟糟，我在这里倾听。'],
    joy: ['你好呀，今天有没有想分享的小事？', '很高兴见到你，有开心的事可以告诉我。'],
    mixed: ['情绪总是起伏不定，你今天想聊聊吗？', '心里有复杂感受，都可以讲出来。'],
  },
  // 通用中性兜底
  neutral: ['你来了，想说什么都可以。', '心里有话，尽管讲出来。', '想到什么，都可以和我说。', '不用刻意准备，想到哪说到哪。'],
};

/** 首页主问候下方小字（v1.3.3 §五） */
export const GREETING_SMALL_TEXT = [
  '不用组织语言，想到哪说到哪。',
  '不必整理思绪，想到什么就说什么。',
  '不用斟酌措辞，你的感受最重要。',
  '不用刻意表达，如实说出感受就好。',
  '碎片化的想法，也可以直接讲。',
];

/** 首页底部卡片提示（仅正常倾诉模式生效，v1.3.3 §五） */
export const CARD_HINT = [
  '还没有卡片。说一次，就会有一张。',
  '每一次倾诉，都会生成一张情绪卡片。',
  '把心事说出来，就会留下属于你的情绪碎片。',
  '暂时没有记录，倾诉之后，就会生成卡片。',
];

/** 按当前小时判断时段键 */
export function timeSlot(hour) {
  const h = Number(hour);
  if (h >= 6 && h < 11) return 'dawn';
  if (h >= 11 && h < 18) return 'afternoon';
  if (h >= 18 && h < 21) return 'evening';
  if (h >= 21 && h < 23) return 'night';
  return 'late'; // 23:00–06:00
}

/**
 * 选取首页问候语。
 * @param {object} p { hour, hasHistory, bias }  bias ∈ sad|tired|anxious|joy|mixed|null
 * @returns {string}
 */
export function greetingFor({ hour = new Date().getHours(), hasHistory = false, bias = null } = {}) {
  if (hasHistory && bias && GREETING_LIBRARY.history_based[bias]) {
    return pick(GREETING_LIBRARY.history_based[bias]);
  }
  if (hasHistory) return pick(GREETING_LIBRARY.neutral);
  return pick(GREETING_LIBRARY.time_based[timeSlot(hour)]);
}

/* ============================================================
   二、对话开场回应短句库（v1.3.4 §一）
   ============================================================ */
export const OPENING_RESPONSES = {
  joy: ['听起来，你感受到这份开心了。', '真好，愿意和我分享这份感受。', '这份轻松，我收到了。', '能体会到，此刻你心里是舒展的。'],
  sad: ['听起来心里沉甸甸的。', '我在这里，听你慢慢说完。', '这种难受的感觉，一定不好受。', '你可以慢慢讲，我认真听着。'],
  angry: ['我感受到你心里的火气了。', '这件事让你觉得很生气。', '心里憋着这样的情绪，会很累。', '你可以把心里的委屈和恼火都说出来。'],
  anxious: ['思绪乱糟糟的，对不对。', '心里悬着的感觉，很难熬。', '我听见了你心里的不安。', '纷乱的想法，都可以慢慢说出来。'],
  tired: ['能感觉到，你消耗了很多精力。', '辛苦了，你可以好好说说。', '这种无力疲惫的感觉，我收到了。', '不必硬撑，在这里可以放松一点。'],
  lonely: ['独自承受的滋味，不太好受。', '此刻，我在这里陪着你。', '心里空落落的，可以慢慢讲。', '谢谢你愿意把这份感受告诉我。'],
  mixed: ['心里的感受很复杂，是吗。', '多种情绪交织在一起，一定很难理清。', '这种拉扯的感觉，我听见了。', '没关系，不用强迫自己把感受理顺。'],
  vague: ['这种难以描述的感受，也可以讲出来。', '哪怕说不清楚，也没关系。', '不用定义它，如实说就好。', '我们可以慢慢感受这份情绪。'],
  neutral: ['我在听，继续说吧。', '原来是这样，你接着讲。', '嗯，我收到了。', '还有什么想告诉我吗？'],
};

/** 由情绪调色板键取开场回应（default→neutral） */
export function openingFor(emotionKey) {
  const k = emotionKey === 'default' || !emotionKey ? 'neutral' : emotionKey;
  return pick(OPENING_RESPONSES[k] || OPENING_RESPONSES.neutral);
}

/* ============================================================
   三、IP 点击 / 长按 气泡（普通模式，v1.3.1 §二）
   ============================================================ */
export const TAP_BUBBLES = {
  tap1: ['嗯？我在。', '你戳我啦。', '我陪着你。', '不想说话也没关系。'],
  tap2: ['咦，又点我。', '今天安安静静的吗？', '想随便待一会儿？'],
  tap3: ['你很喜欢戳我呀。', '要不要和我静静待一会？', '可以什么都不说。'],
  over: ['哈哈，轻点戳我~', '我收到你的触碰啦。'],
};

/** 情绪联动差异化气泡（v1.3.1 §四） */
export const TAP_BUBBLES_BY_EMOTION = {
  sad: ['我在这里陪着你'],
  joy: ['你来找我啦'],
  tired: ['好好歇一会吧'],
};

/* ============================================================
   四、安静陪伴模式文案（v1.3.2）
   ============================================================ */
export const QUIET_COPY = {
  titles: ['此刻，安静就好', '不用开口，我在这里陪着你', '允许什么都不说', '我们静静待一会儿', '不必急着表达', '只是停留片刻也可以', '思绪慢慢飘一会儿吧'],
  smallTexts: ['不用倾诉，不必思考，只是停留', '不想说话，就静静和我待一会儿', '思绪可以放空，没有任务'],
  cardHints: ['安静的时刻，不会生成情绪卡片', '此刻不需要记录，只需要感受', '沉默的时光，也值得被容纳'],
  enterBubble: ['我们可以安静待一会儿，不用说话。'],
  exitBubble: ['如果你想诉说，随时可以开始', '想说话的时候，我依然在这里'],
  // 安静模式专属点击气泡
  tap1: ['嗯，我陪着你', '静静地待着就很好', '我在这儿'],
  tap2: ['你轻轻碰我啦', '不用急着倾诉', '就这样就可以'],
  tap3: ['谢谢你愿意过来坐坐', '放空一会儿没关系', '深海里，很安静'],
  over: ['哈哈，轻点戳我哦', '收到你的触碰啦'],
};

/** 安静模式点击气泡（专属库） */
export function quietTapBubble(count) {
  if (count <= 1) return pick(QUIET_COPY.tap1);
  if (count === 2) return pick(QUIET_COPY.tap2);
  if (count === 3) return pick(QUIET_COPY.tap3);
  return pick(QUIET_COPY.over);
}

/** 普通模式点击气泡（含情绪联动差异；count≥4 为软反馈） */
export function normalTapBubble(count, emotionKey) {
  // 情绪联动优先（悲伤/喜悦/疲惫）
  if (count <= 3 && emotionKey && TAP_BUBBLES_BY_EMOTION[emotionKey]) {
    return pick(TAP_BUBBLES_BY_EMOTION[emotionKey]);
  }
  if (count <= 1) return pick(TAP_BUBBLES.tap1);
  if (count === 2) return pick(TAP_BUBBLES.tap2);
  if (count === 3) return pick(TAP_BUBBLES.tap3);
  return pick(TAP_BUBBLES.over);
}

/* ============================================================
   五、个人中心（我）页面文案（v1.3.4 §二）
   ============================================================ */
export const ME_COPY = {
  title: '你的深海空间',
  subtitle: '在这里，管理你的情绪记录与陪伴设置',
  overview: { title: '你的情绪碎片', desc: '所有倾诉生成的情绪卡片，都收纳在这里。', button: '查看全部卡片', note: '每一张卡片，都是你留下的情绪痕迹。' },
  memory: {
    title: '记忆管理', viewDesc: '你可以随时查看墨小溟保存的记忆条目。', viewBtn: '查看记忆',
    delOne: '确定删除这条记忆吗？删除后墨小溟不会再引用这段内容。',
    clearAll: '清空全部记忆后，墨小溟会忘记所有过往信息。你的情绪卡片记录不会被删除，仅清除跨会话记忆。是否继续？',
    toggle: '开启跨会话记忆',
    toggleDesc: '开启后，墨小溟能记住你过往提到的事情，下次对话可以呼应你。关闭则每次对话独立，不会留存会话记忆。',
  },
  settingsTitle: '墨小溟互动设置',
  notify: { title: '轻问候提醒', desc: '墨小溟会在你习惯的时段，轻轻问候你，不会频繁打扰。', toggle: '允许轻提醒' },
  storage: { title: '记录管理', exportBtn: '导出全部情绪记录', exportDesc: '导出为 Markdown / JSON 文件，保存到本地。', clearBtn: '清除所有情绪卡片记录', clearConfirm: '确定清空所有情绪卡片？此操作不可恢复。' },
  boundary: { title: '陪伴边界提示', text: '墨小溟是情绪倾听陪伴伙伴，不能替代心理咨询师、医生或专业心理诊疗。如果长期被痛苦困扰，请寻求专业人士帮助。' },
  support: {
    title: '情绪支持',
    faq: [
      { q: '墨小溟会把我的心事泄露出去吗？', a: '你的对话与情绪记录归你所有，严格遵循隐私协议，不会对外分享。' },
      { q: '安静陪伴模式会保存我的情绪吗？', a: '安静陪伴模式仅为互动陪伴，不会生成情绪卡片，不会记录对话。' },
      { q: '我可以随时删除记忆和卡片吗？', a: '可以，记忆、卡片都支持手动删除。' },
    ],
  },
  about: {
    title: '关于墨小溟',
    text: '墨小溟是一只住在深海的紫色墨鱼。它不会评判，不会说教，只是安静接住你的所有情绪。开心、委屈、愤怒、迷茫，所有心里话，都可以讲给它听。不想说话的时候，也可以和它静静待一会儿。',
  },
  legal: { title: '隐私协议 & 用户协议', text: '点击查看《用户协议》《隐私政策》，了解你的数据如何存储与保护。' },
  wipe: { title: '清除数据', confirm: '清除本地数据：会删除本机全部卡片、记忆，云端记录将同步清除。操作无法撤销。' },
};

export const __test__ = {
  GREETING_LIBRARY, GREETING_SMALL_TEXT, CARD_HINT, OPENING_RESPONSES, TAP_BUBBLES,
  TAP_BUBBLES_BY_EMOTION, QUIET_COPY, ME_COPY,
  pick, timeSlot, greetingFor, openingFor, quietTapBubble, normalTapBubble,
};
