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
let unsupported = ''; // ''=可用；'env'=非原生环境；'plugin_missing'=原生环境但插件没挂上

/**
 * 取原生通知插件。
 *
 * 🔴 v1.6.16 修复：**只能从 Capacitor 运行时的插件表拿，不能靠裸说明符动态加载原生插件**。
 * 本项目无构建（浏览器/安卓 WebView 直接跑 ES Module），裸说明符没有 import map 也没有打包器解析，
 * 一定抛 `Failed to resolve module specifier` ⇒ 被 catch 吞掉 ⇒ Web 端「永远不支持轻提醒」的假象。
 * 这个坑 v1.6.12 的 DownloadManager 已经踩过一次（项目 MEMORY 铁律），notify.js 这次也没躲开：
 * 真机 APK 明明在 assets/capacitor.plugins.json 里注册了 @capacitor/local-notifications，
 * 用户却看到「当前环境不支持轻提醒（需安装 App 后使用）」—— 明明已经装了 App。
 *
 * 顺带不去缓存结果：Capacitor 的 bridge 可能晚于页面脚本就绪，每次读全局最稳（读一次全局的成本可忽略）。
 */
function pickPlugin() {
  try {
    const P = window.Capacitor && window.Capacitor.Plugins;
    return (P && (P.LocalNotifications || P.Notifications)) || null;
  } catch (e) { return null; }
}

/** 当前环境能不能真的发本地通知。UI 用它决定开关是否可用、以及怎么说明。 */
async function loadKit() {
  if (!isNativeApp()) { unsupported = 'env'; return null; }
  kit = pickPlugin();
  if (!kit) {
    unsupported = 'plugin_missing';
    diag.note('notify', 'plugin_unavailable', { detail: 'window.Capacitor.Plugins.LocalNotifications 缺失' });
    return null;
  }
  unsupported = '';
  return kit;
}

/** 当前环境能不能真的发本地通知。UI 用它决定开关是否可用、以及怎么说明。 */
export async function isSupported() {
  return !!(await loadKit());
}

/** 不支持时的原因（'env' | 'plugin_missing' | ''）。UI 照它说人话，别一律甩「需安装 App」。 */
export function unsupportedReason() { return unsupported || ''; }

/**
 * 把时间戳变成 Date。
 *
 * 🔴 v1.6.16 修复：原来写的是 `new Date(Number(t))`——`Number('2026-10-01T06:10:00.000Z')` 是 NaN，
 * 而 store 里真实字段就是 ISO 字符串（`addTimeline` 写 `saved_at`、`addCard` 写 `created_at`）
 * ⇒ 每一条都被 `Number.isFinite` 过滤掉 ⇒ 众数算不出来 ⇒ 又回到默认 21 点。
 * 上一版（v1.6.15）用数字时间戳造 3 条数据测出「6 点」是**假绿**：真实数据一条都解析不出来。
 * `new Date('ISO 串')` 和 `new Date(毫秒数)` 都吃得下，别再套一层 Number。
 */
function toDate(t) {
  if (t === null || t === undefined || t === '') return null;
  if (t instanceof Date) return Number.isFinite(t.getTime()) ? t : null;
  const d = new Date(t);
  return Number.isFinite(d.getTime()) ? d : null;
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
    const t = r && (r.createdAt || r.created_at || r.savedAt || r.saved_at || r.ts || r.time || r.at);
    const d = toDate(t);
    if (!d) continue;
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
