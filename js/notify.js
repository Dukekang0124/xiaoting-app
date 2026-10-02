// 墨小溟 · 轻问候提醒（v1.4.1 · Task「死开关」修复）
//
// 【为什么要写这一层】设置里长期有一个「允许轻提醒」开关：UI 有、store 会存值，
// 但**全仓没有任何一处读它** —— 用户拨动它，什么都不会发生。
// 这比没有这个开关更糟：没开关是"没承诺"，假开关是"承诺了却没兑现"。
//
// 【怎么兑现】文案承诺的是「在你习惯的时段，轻轻问候你，不会频繁打扰」，
// 所以实现必须做到三件事，缺一件就还是假开关：
//   ① 时段取自用户自己的历史倾诉时间（不是写死一个点）
//   ② 一天一条，不重复打扰
//   ③ 环境不支持时**明确告诉用户**，而不是默默什么都不做
//
// 【降级边界】Web 端没有本地通知能力。此时开关必须显示为不可用并说明原因，
// 绝不能让用户开了以为生效 —— 那正是这次要根治的问题。

import { isNativeApp } from './config.js';
import { getState } from './store.js';
import * as diag from './diag.js';

const REMINDER_ID = 20260930; // 固定 ID：重复 schedule 不会堆积多条，只会覆盖

let kit = null;
let kitLoaded = false;

/** 惰性加载通知插件。**必须动态 import**：Web 端没这个包，静态 import 会连带崩掉整条设置页。 */
async function loadKit() {
  if (kitLoaded) return kit;
  kitLoaded = true;
  if (!isNativeApp()) { kit = null; return null; }
  try {
    const m = await import('@capacitor/local-notifications');
    kit = m && m.LocalNotifications ? m.LocalNotifications : null;
  } catch (e) {
    kit = null;
    diag.note('notify', 'plugin_unavailable', { detail: String((e && e.message) || e).slice(0, 120) });
  }
  return kit;
}

/** 当前环境能不能真的发本地通知。UI 用它决定开关是否可用、以及怎么说明。 */
export async function isSupported() {
  return !!(await loadKit());
}

/**
 * 从用户自己的历史倾诉记录里推断「习惯的时段」。
 * 取各小时出现次数的众数；没有任何历史时给一个温和的默认值（21 点）。
 * 纯函数、好测 —— 这条逻辑如果写死 21 点，文案「你习惯的时段」就又是空话。
 */
export function preferredHour(records) {
  const list = Array.isArray(records) ? records : [];
  const buckets = new Array(24).fill(0);
  for (const r of list) {
    const t = r && (r.createdAt || r.savedAt || r.ts || r.saved_at || r.create_time || r.created_at);
    if (!t) continue;
    const d = new Date(Number(t));
    if (!Number.isFinite(d.getTime())) continue;
    buckets[d.getHours()] += 1;
  }
  let bestHour = -1;
  let best = 0;
  for (let h = 0; h < 24; h++) {
    if (buckets[h] > best) { best = buckets[h]; bestHour = h; }
  }
  return bestHour >= 0 ? bestHour : 21;
}

/**
 * 取当前用户的历史记录（不同 store 版本字段名不同，逐一兼容）。
 *
 * 🔴 v1.6.15 修复：这里以前读的是 `user.timeline / user.cards / user.records` —— 这三个字段
 * 在 store 里根本不存在（`user` 只有 id / nickname / createdAt / settings），永远拿到空数组
 * ⇒ `preferredHour()` 恒回落默认 21 点 ⇒ 文案承诺的「在你习惯的时段」实际从来没生效过。
 * 真实数据在 state 顶层：`timelines`（情绪时间线）/ `cards`（情绪卡片）。
 */
function historyRecords() {
  const s = getState() || {};
  if (s.timelines && s.timelines.length) return s.timelines;
  if (s.cards && s.cards.length) return s.cards;
  return [];
}

const REMINDER_BODY = [
  '今天想说点什么吗？我在这里。',
  '如果有点累，说两句再走也好。',
  '不着急，想说的时候再叫我。',
];

/**
 * 把开关状态同步到系统。
 * @param {boolean} on 是否开启
 * @returns {{ok:boolean, action?:string, reason?:string, hour?:number, detail?:string}}
 */
export async function sync(on) {
  const L = await loadKit();
  if (!L) return { ok: false, reason: 'unsupported' };

  try {
    if (!on) {
      await L.cancel({ notifications: [{ id: REMINDER_ID }] });
      diag.note('notify', 'cancelled', { ok: true });
      return { ok: true, action: 'cancelled' };
    }

    const perm = await L.checkPermissions();
    if (perm.display !== 'granted') {
      const req = await L.requestPermissions();
      if (req.display !== 'granted') {
        diag.note('notify', 'permission_denied', { ok: false });
        return { ok: false, reason: 'permission_denied' };
      }
    }

    const hour = preferredHour(historyRecords());
    await L.schedule({
      notifications: [{
        id: REMINDER_ID,
        title: '墨小溟',
        body: REMINDER_BODY[hour % REMINDER_BODY.length],
        schedule: { on: { hour, minute: 0 }, every: 'day' },
        // 一天一条：不设 repeats，避免变成每小时一次的骚扰
        sound: null,
        attachments: null,
        actionTypeId: '',
        extra: null,
      }],
    });
    diag.note('notify', 'scheduled', { ok: true, detail: `每日 ${hour}:00 一条` });
    return { ok: true, action: 'scheduled', hour };
  } catch (e) {
    const detail = String((e && e.message) || e);
    diag.note('notify', 'failed', { ok: false, detail: detail.slice(0, 160) });
    return { ok: false, reason: 'failed', detail };
  }
}
