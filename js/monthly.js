// 墨小溟 · 月度情绪复盘（文档 §追加模块3）
//
// 🔴 全部字段**本机算**，不交给模型：卡片日期/统计/总结都是模型编过的地方
//    （曾返回 2025-07-09 这种合法但假的日期），月度复盘同理。宁可规则引擎，
//    也不要一张看起来很像真的、其实没发生过事实的卡片。
//
// 数据口径：timelines 是「一次倾诉 = 一条」的产物，最适合当 recordCount 的来源；
//   cards 是场景卡（矛盾/读心/行动/托住），一次倾诉可能给多张，混进来会虚高。

import { COPY, TIMELINE_EMOTION_KEYWORDS } from './prompts.js';

/** 月份键：1 月 = 1 … 12 月 = 12（不要用 toISOString，UTC 会把 1 号凌晨算成上个月） */
export function monthKey(d) {
  const dt = d || new Date();
  return dt.getFullYear() * 100 + (dt.getMonth() + 1);
}

/** 「2026年10月」：用本机时间拼，不交给模型 */
export function monthLabel(d) {
  const dt = d || new Date();
  return `${dt.getFullYear()}年${dt.getMonth() + 1}月`;
}

/** 某条时间线卡落在第几个月（卡片自带 timeline_group === 月度复盘 的跳过，避免复盘套复盘） */
export function recordMonth(tl) {
  const d = (tl && (tl.saved_at || tl.created_at || tl.createdAt || tl.createTime)) ? new Date(tl.saved_at || tl.created_at || tl.createdAt || tl.createTime) : null;
  return d ? monthKey(d) : 0;
}

/** 取出某个月的全部记录（去重：同一 at 时间戳的重复落库只算一次） */
export function monthRecords(timelines, ym) {
  const all = Array.isArray(timelines) ? timelines : [];
  const out = [];
  const seen = new Set();
  for (const tl of all) {
    if (!tl || tl.timeline_group === COPY.monthly.timelineGroup) continue; // 复盘卡不参与统计
    if (recordMonth(tl) !== ym) continue;
    const at = (tl.saved_at || tl.created_at || tl.createdAt || tl.createTime || 0);
    if (seen.has(at)) continue;
    seen.add(at);
    out.push(tl);
  }
  return out;
}

/** 本月出现最多的情绪标签（最多 3 个）*/
export function topEmotionTags(records, n = 3) {
  const cnt = new Map();
  for (const tl of records) {
    const nodes = Array.isArray(tl && tl.timeline_list) ? tl.timeline_list : (Array.isArray(tl && tl.nodes) ? tl.nodes : []);
    for (const nd of nodes) {
      const ems = Array.isArray(nd && nd.emotions) ? nd.emotions : [];
      for (const e of ems) if (typeof e === "string" && e) cnt.set(e, (cnt.get(e) || 0) + 1);
    }
  }
  return [...cnt.entries()]
    .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))
    .slice(0, Math.max(1, n | 0))
    .map(([tag]) => tag);
}

/** 本月情绪画像：节点得分均值 / 极差 / 正负分布 */
export function monthStats(records) {
  const scores = [];
  const tags = [];
  for (const tl of records) {
    const nodes = Array.isArray(tl && tl.timeline_list) ? tl.timeline_list : (Array.isArray(tl && tl.nodes) ? tl.nodes : []);
    for (const nd of nodes) {
      if (Number.isFinite(nd && nd.emotion_score)) scores.push(nd.emotion_score);
      if (Array.isArray(nd && nd.emotions)) tags.push(...nd.emotions);
    }
  }
  const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  const max = scores.length ? Math.max(...scores) : 0;
  const min = scores.length ? Math.min(...scores) : 0;
  // 愤怒组标签：只统计「烦躁/愤怒/压抑」这一族的占比，用来和「低落」区分开
  const angryWords = new Set([].concat(
    TIMELINE_EMOTION_KEYWORDS["愤怒"] || [],
    TIMELINE_EMOTION_KEYWORDS["烦躁"] || [],
    TIMELINE_EMOTION_KEYWORDS["压抑"] || [],
    TIMELINE_EMOTION_KEYWORDS["焦虑"] || [],
  ));
  let angryHit = 0;
  let lowHit = 0;
  for (const t of tags) {
    if (angryWords.has(t)) angryHit += 1;
    if ((TIMELINE_EMOTION_KEYWORDS[t] || []).some((w) =>
      ["低落", "委屈", "难过", "悲伤", "疲惫", "麻木", "无力", "空虚"].includes(w))) lowHit += 1;
  }
  return { avg, max, min, span: max - min, n: scores.length, angryHit, lowHit, total: tags.length };
}

/** 场景判定：起伏大 / 低落委屈疲惫 / 烦躁愤怒压抑 / 正向居多 / 整体平淡 */
export function chooseScenario(st) {
  if (!st || !st.n) return "flat";
  // 起伏大：正负都真实存在，且拉得开 —— 只重不轻或只轻不重都不算「起伏」
  if (st.max > 10 && st.min < -10 && st.span >= 60) return "swing";
  if (st.avg < -20 && st.angryHit >= st.lowHit && st.angryHit > 0) return "angry";
  if (st.avg < -25) return "low";
  if (st.avg > 20) return "positive";
  return "flat";
}

/** 组件装：生成月度复盘卡片数据。记录不足 minRecords 条时返回 null（不硬凑） */
export function buildMonthlyReview(timelines, opt = {}) {
  const now = opt.now || new Date();
  const cfg = (COPY.monthly || {});
  const min = Number(cfg.trigger && cfg.trigger.minRecords) || 3;
  const ym = Number.isFinite(opt.month) ? opt.month : monthKey(now);
  const records = monthRecords(timelines, ym);
  if (records.length < min) return null; // 🔴 硬约束：当月记录 < 3 条不生成
  const st = monthStats(records);
  const key = chooseScenario(st);
  const sc = ((cfg.scenarios || {})[key] || {});
  return {
    card_id: `emo_month_${ym}`,
    create_time: now.toISOString(),
    target_month: monthLabel((ym / 100 >= 0) ? new Date(Number(String(ym).slice(0, 4)), Number(String(ym).slice(4)) - 1, 1) : now),
    record_count: records.length,
    top_emotion_tags: topEmotionTags(records, 3),
    emotion_trend_desc: sc.emotionTrendDesc || "",
    insight_text: sc.insightText || "",
    monthly_tip: sc.monthlyTip || "",
    ip_bubble_text: sc.ipBubbleText || "",
    timeline_group: cfg.timelineGroup || "月度复盘",
    is_high_risk: false, // 🔴 固定 false：月度总结不是一次倾诉，不做安全升级
    card_theme: cfg.cardTheme || "month-purple",
    scenario: key,
  };
}

/** 今天是不是该自动弹复盘的月份日（默认每月 1 号） */
export function shouldAutoReview(now) {
  const dt = now || new Date();
  const cfg = COPY.monthly || {};
  const tr = cfg.trigger || {};
  if (tr.auto === false) return false;
  return dt.getDate() === Number(tr.day || 1);
}
