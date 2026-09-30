// 墨小溟 · 记忆引擎（V1.1 地基 / app v1.3.0）
// 设计原则（来自架构方案 §2.3）：结构化提取优先于向量库。
//   本模块【不要求模型改输出契约】——直接复用已经产出的结构化 analysis（事件/人物/心结/情绪）
//   派生「记忆单元」，因此不触碰 MAIN_PROMPT / normalizeAnalysis，零回归风险。
//   语义召回 = 标签匹配 + 时间近因 + 重要性 + 情绪粗粒度重叠（复用 EMOTION 标准词），纯本地、隐私零风险。
//   向量嵌入留到 v1.4.0 可选增强（Transformers.js 本地 embedding）。

import {
  dbPut, dbGet, dbGetAll, dbDelete, clearAllMemory, setSetting, getSetting,
} from './db.js';

// 透出 settings 读写，便于记忆面板 / 迁移守卫复用（不破坏 db.js 单一职责）。
export { setSetting, getSetting };

export function makeId(prefix) {
  return (prefix || 'm') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function daysSince(iso) {
  if (!iso) return 9999;
  const t = typeof iso === 'number' ? iso : new Date(iso).getTime();
  if (!Number.isFinite(t)) return 9999;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

function normTitle(s) { return (s || '').toString().trim().toLowerCase(); }

/**
 * 从一次已完成的会话派生「记忆单元」（不写库，纯函数）。
 * 复用结构化 analysis：人物 / 事件 / 心结，各带 emotion_tags，绝不存原始转录全文（隐私）。
 * @param {{analysis?:object, transcript?:string, timeline?:object|null, sessionId?:string, dateISO?:string}} p
 */
export function deriveMemoryUnits({ analysis = {}, transcript = '', timeline = null, sessionId = '', dateISO = new Date().toISOString() } = {}) {
  const emotionTags = Array.isArray(analysis.emotion) && analysis.emotion.length
    ? analysis.emotion.slice(0, 6)
    : (analysis.emotion_primary ? [analysis.emotion_primary] : []);
  const base = {
    created_at: dateISO,
    last_recalled_at: 0,
    source_session_id: sessionId,
    important: false,
    user_edited: false,
    emotion_tags: emotionTags,
  };
  const units = [];
  // 人物（最多 2）
  (Array.isArray(analysis.people) ? analysis.people : [])
    .filter((p) => p && String(p).trim()).slice(0, 2)
    .forEach((p) => units.push({
      ...base,
      type: 'person',
      title: String(p).trim(),
      summary: `在「${analysis.event || '一次倾诉'}」中被提及`,
      tags: ['人物'],
    }));
  // 事件
  if (analysis.event && String(analysis.event).trim()) {
    units.push({
      ...base,
      type: 'event',
      title: String(analysis.event).trim(),
      summary: analysis.scene || '',
      tags: ['事件'],
    });
  }
  // 心结（hidden_need 优先，其次 pattern）
  const knotText = analysis.hidden_need || analysis.pattern;
  if (knotText && String(knotText).trim()) {
    units.push({
      ...base,
      type: 'knot',
      title: String(knotText).trim().slice(0, 60),
      summary: analysis.event || '',
      tags: ['心结'],
    });
  }
  return units;
}

/**
 * 跨会话召回 Top-N：打分 = 重要性 + 时间近因 + 情绪重叠 + 当前倾诉提及。
 * 返回 [{ unit, score }]，已按分降序。
 */
export function recallTopN(units = [], { transcript = '', emotion = [], limit = 3 } = {}) {
  const emo = (Array.isArray(emotion) ? emotion : []).map((e) => String(e).trim());
  const text = (transcript || '').toLowerCase();
  const scored = units.map((u) => {
    let score = 0;
    if (u.important) score += 50;
    score += Math.max(0, 30 - daysSince(u.created_at)); // 近因：越新越高
    const uEmo = (u.emotion_tags || []).map((e) => String(e).trim());
    score += emo.filter((e) => uEmo.includes(e)).length * 8; // 情绪重叠
    const title = normTitle(u.title);
    if (title && text.includes(title)) score += 5; // 当前倾诉提到这个名字/事件
    return { unit: u, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(0, limit));
}

/**
 * 保存会话 + 派生记忆（去重合并）。幂等安全：同一 (type+title) 已存在则更新而非新增。
 * @returns {Promise<{sessionSaved:boolean, memoryUpserted:number}>}
 */
export async function saveSessionWithMemory({ session, analysis = {}, transcript = '', timeline = null, dateISO = new Date().toISOString() } = {}) {
  const sessionId = session && session.id ? session.id : makeId('s');
  const fullSession = {
    id: sessionId,
    date: dateISO,
    transcript,
    timeline: timeline || null,
    analysis: analysis || null,
    emotions: Array.isArray(analysis.emotion) ? analysis.emotion : (analysis.emotion_primary ? [analysis.emotion_primary] : []),
  };
  const sessionSaved = await dbPut('sessions', fullSession);

  const derived = deriveMemoryUnits({ analysis, transcript, timeline, sessionId, dateISO });
  const existing = await dbGetAll('memory');
  const keyOf = (u) => `${u.type}|${normTitle(u.title)}`;
  const map = new Map(existing.map((e) => [keyOf(e), e]));
  let upserted = 0;
  for (const u of derived) {
    const k = keyOf(u);
    const prev = map.get(k);
    if (prev) {
      // 已存在：保留用户标记（important / user_edited），精炼 summary/情绪标签
      const merged = {
        ...prev,
        summary: u.summary || prev.summary,
        emotion_tags: u.emotion_tags.length ? u.emotion_tags : prev.emotion_tags,
        last_recalled_at: prev.last_recalled_at || 0,
      };
      await dbPut('memory', merged);
    } else {
      await dbPut('memory', { ...u, id: makeId('m') });
    }
    upserted++;
  }
  return { sessionSaved, memoryUpserted: upserted };
}

/**
 * 生成注入 MAIN_PROMPT 的「跨会话记忆上下文」（隐私安全：只给结构化摘要，绝不给原始转录）。
 * @param {Array} units 召回到的记忆单元（按分数降序）
 */
export function buildMemoryContext(units = []) {
  if (!units.length) return '';
  const tagOf = { person: '人物', event: '事件', knot: '心结' };
  const lines = units.map((u) => {
    const tag = tagOf[u.type] || '记忆';
    const emo = (u.emotion_tags || []).length ? `（情绪：${(u.emotion_tags || []).join('、')}）` : '';
    const sum = u.summary ? `——${u.summary}` : '';
    return `· ${tag}「${u.title}」${emo}${sum}`;
  });
  return (
    '【你之前陪 TA 聊过的（墨小溟结构化记忆，仅作陪伴连贯性参考，绝不要当作事实复述或编造细节）】\n' +
    lines.join('\n') +
    '\n提示：若本次倾诉自然关联到以上某条，可以轻轻呼应、体现「我在听、我记得」，但不要用命令式或说教；若无关联则忽略本段。'
  );
}

/* ---------- 记忆管理面板用：读 / 删 / 改 / 清空 ---------- */

export const loadMemory = () => dbGetAll('memory');
export const loadSessions = () => dbGetAll('sessions');

export async function deleteMemory(id) { return dbDelete('memory', id); }

export async function markMemoryImportant(id, val) {
  const all = await dbGetAll('memory');
  const u = all.find((x) => x.id === id);
  if (!u) return false;
  u.important = !!val;
  return dbPut('memory', u);
}

export async function editMemory(id, patch = {}) {
  const all = await dbGetAll('memory');
  const u = all.find((x) => x.id === id);
  if (!u) return false;
  u.title = typeof patch.title === 'string' && patch.title.trim() ? patch.title.trim() : u.title;
  u.summary = typeof patch.summary === 'string' ? patch.summary : u.summary;
  u.user_edited = true;
  return dbPut('memory', u);
}

export const clearMemory = () => clearAllMemory();

/* ---------- 迁移：从既有 localStorage 已存时间线卡播种记忆（一次） ---------- */

export async function migrateFromLocalStorage(state) {
  const done = await getSetting('migrated');
  if (done) return { skipped: true };
  const timelines = Array.isArray(state && state.timelines) ? state.timelines : [];
  let seeded = 0;
  for (const tl of timelines) {
    const a = (tl && tl.analysis) || {};
    const dateISO = tl.saved_at || tl.date || new Date().toISOString();
    const r = await saveSessionWithMemory({
      session: { id: makeId('s') },
      analysis: {
        event: a.event, people: a.people, scene: a.scene, emotion: a.emotion,
        emotion_primary: a.emotion_primary, hidden_need: a.hidden_need, pattern: a.pattern,
      },
      transcript: '',
      timeline: tl,
      dateISO,
    });
    seeded += r.memoryUpserted;
  }
  await setSetting('migrated', true);
  return { skipped: false, seeded, timelines: timelines.length };
}
