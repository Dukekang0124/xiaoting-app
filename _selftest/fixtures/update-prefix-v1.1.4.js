// 墨小溟 · 版本更新与自动弹窗（v0.7.0）
// ------------------------------------------------------------------
// 设计要点（《版本更新与自动弹窗模块开发指令》）：
//   检测时机：App 启动 + 从后台回到前台（visibilitychange）
//   平台识别：微信 / Android(APK) / iOS / 普通浏览器
//   弹窗：自定义 Modal（非 window.confirm）—— 圆角 20px、暖奶油白 #FFF8F0、墨小溟举牌 IP、温和文案
//   非强制：立即更新(柔紫) + 稍后再说(灰，关闭 + 当天不再提醒)
//   强制：单个「立即更新」按钮，不可关闭
//   release_notes 逐条小圆点展示
//
// 测试入口（仅当 URL 带 query 时生效，正常用户不会带，零副作用）：
//   ?fake_version=9.9.9  → 把"线上最新版"临时改成指定值，方便看弹窗
//   ?force_update=1      → 把"是否强制"临时改成 true
//   ?showUpdate=1|force  → 版本相同也强制弹一次（纯视觉检查用）
//   ?app=android         → 模拟 APK 分支（正常安卓壳靠 UA 标记识别）

import { mascot } from './ip.js';

/* ---------------- 常量 ---------------- */

const SNOOZE_KEY = 'xiaoting:update_snooze_day'; // 当天"稍后再说"过的日期
const SNOOZE_DAY_KEY = 'xiaoting:update_snooze_day';

/* ---------------- 小工具 ---------------- */

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 语义化版本比较：a>b 返回正数，a<b 返回负数，相等返回 0 */
export function cmpVersion(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/** 平台识别：微信 / Android(APK) / iOS / 普通浏览器 */
export function platform() {
  const ua = navigator.userAgent || '';
  const isWeChat = /micromessenger/i.test(ua);
  const isIOS = /iphone|ipad|ipod/i.test(ua);
  const isAndroid = /android/i.test(ua);
  // 我们的安卓壳：UA 含标记，或 URL 带 ?app=android（便于在普通浏览器里模拟 APK 分支自测）
  const isApk = /xiaotingandroid|xiaoting_app/i.test(ua) || /[?&]app=android\b/.test(location.search);
  return { ua, isWeChat, isIOS, isAndroid, isApk };
}

export function getSnoozeDay() {
  try { return localStorage.getItem(SNOOZE_KEY) || ''; } catch (e) { return ''; }
}
export function setSnoozeDay() {
  try { localStorage.setItem(SNOOZE_KEY, todayStr()); } catch (e) {}
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('http_' + res.status);
  return res.json();
}

/** 取线上最新版本信息（带测试 query 覆盖） */
export async function fetchLatest() {
  const data = await fetchJson('/api/version/latest');
  const q = new URLSearchParams(location.search);
  const fake = q.get('fake_version');
  const forced = q.get('force_update');
  if (fake) data.latest_version = fake;
  if (forced === '1' || forced === 'true') data.force_update = true;
  return data;
}

/** 取更新历史（给「关于墨小溟」页） */
export async function fetchHistory() {
  return fetchJson('/api/version/history');
}

/* ---------------- 弹窗渲染 ---------------- */

let modalEl = null;
let lastShownKey = ''; // 防止同一次 session 内（前台/后台来回切）重复弹

function closeModal() {
  if (modalEl && modalEl.parentNode) modalEl.parentNode.removeChild(modalEl);
  modalEl = null;
}

function subCopy(p, data) {
  if (p.isWeChat) return '微信里没法直接更新，点右上角「···」在浏览器中打开，就能装最新版啦。';
  if (p.isApk) return '点击立即更新，墨小溟会下载并安装最新安装包。';
  return '点击立即更新，墨小溟会自动刷新到最新版。';
}

function primaryLabel(p) {
  if (p.isWeChat) return '复制下载链接';
  return '立即更新';
}

function showModal(data, opts) {
  const p = opts.platform || platform();
  const force = !!opts.force;
  closeModal(); // 先清掉可能残留的旧弹窗

  const notesHtml = (data.release_notes || [])
    .map((n) => `<li>${esc(n)}</li>`)
    .join('');

  const overlay = document.createElement('div');
  overlay.className = 'update-overlay' + (force ? ' update-overlay--force' : '');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.innerHTML = `
    <div class="update-card">
      <div class="update-ip">
        ${mascot('happy', 104)}
        <div class="update-sign">有新版啦</div>
      </div>
      <h3 class="update-title">墨小溟更新到了 v${esc(data.latest_version)}</h3>
      <p class="update-sub">${esc(subCopy(p, data))}</p>
      ${notesHtml ? `<ul class="update-notes">${notesHtml}</ul>` : ''}
      <div class="update-actions">
        <button class="update-btn update-btn--primary" id="updateNow" type="button">${esc(primaryLabel(p))}</button>
        ${force ? '' : '<button class="update-btn update-btn--ghost" id="updateLater" type="button">稍后再说</button>'}
      </div>
    </div>`;

  document.body.appendChild(overlay);
  modalEl = overlay;

  const now = document.getElementById('updateNow');
  if (now) now.addEventListener('click', () => doUpdate(p, data));

  const later = document.getElementById('updateLater');
  if (later) later.addEventListener('click', () => {
    setSnoozeDay();
    closeModal();
  });

  // 强制更新：点遮罩不关、ESC 不关；非强制：点遮罩 = 稍后再说
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay && !force) {
      setSnoozeDay();
      closeModal();
    }
  });
  if (!force) {
    overlay._onKey = (e) => { if (e.key === 'Escape') { setSnoozeDay(); closeModal(); } };
    document.addEventListener('keydown', overlay._onKey);
  }
}

/* ---------------- 更新动作（三端分支） ---------------- */

function copyText(t) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).catch(() => fallbackCopy(t));
    } else {
      fallbackCopy(t);
    }
  } catch (e) {
    fallbackCopy(t);
  }
}

function fallbackCopy(t) {
  const ta = document.createElement('textarea');
  ta.value = t;
  ta.style.cssText = 'position:fixed;top:-9999px;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch (e) {}
  document.body.removeChild(ta);
}

/** Web / iOS：清空 Service Worker 缓存后刷新，确保拿到最新静态资源 */
function webUpdateReload() {
  try {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then((regs) => {
        Promise.all(regs.map((r) => r.unregister()))
          .then(() => {
            if ('caches' in window) {
              caches.keys().then((ks) => Promise.all(ks.map((k) => caches.delete(k))))
                .then(() => location.reload(true))
                .catch(() => location.reload(true));
            } else {
              location.reload(true);
            }
          })
          .catch(() => location.reload(true));
      }).catch(() => location.reload(true));
    } else {
      location.reload(true);
    }
  } catch (e) {
    location.reload(true);
  }
}

export function doUpdate(p, data) {
  if (p.isWeChat) {
    // 微信内无法自动更新：复制链接，引导用户在浏览器打开
    copyText(data.web_url || location.href);
    const sub = modalEl && modalEl.querySelector('.update-sub');
    if (sub) {
      sub.textContent = '链接已复制 ✓ 去浏览器打开墨小溟，就能装最新版。';
      sub.classList.add('update-sub--ok');
    }
    const now = modalEl && document.getElementById('updateNow');
    if (now) now.textContent = '已复制，去浏览器打开';
    return;
  }
  if (p.isApk) {
    // APK：打开下载地址（安卓壳会触发下载 + 未知来源安装引导）
    window.location.href = data.download_url || data.web_url || location.href;
    return;
  }
  // Web / iOS：清空缓存后刷新
  webUpdateReload();
}

/* ---------------- 检测主流程 ---------------- */

/**
 * 检测是否有新版本需要提示。
 * @param {{manual?:boolean, forceShow?:boolean}} opts
 *   manual：来自「关于墨小溟」页的手动检查，总是尝试弹（除非已无新版）
 *   forceShow：版本相同也强弹一次（纯视觉检查）
 * @returns {Promise<{shown:boolean, reason?:string, force?:boolean, data?:object}>}
 */
export async function checkUpdate(opts = {}) {
  let data;
  try {
    data = await fetchLatest();
  } catch (e) {
    return { shown: false, reason: 'fetch_failed' };
  }

  const current = window.APP_VERSION || '0.0.0';
  const hasNew = cmpVersion(data.latest_version, current) > 0;
  const q = new URLSearchParams(location.search);
  const showUpdate = opts.forceShow || q.get('showUpdate') === '1' || q.get('showUpdate') === 'force';

  if (!hasNew && !showUpdate) return { shown: false, reason: 'no_update' };
  if (!data.force_update && !showUpdate && !opts.manual && getSnoozeDay() === todayStr()) {
    return { shown: false, reason: 'snoozed' };
  }

  // 防止同一次 session 内重复弹（前台/后台来回切）
  const key = `${data.latest_version}:${data.force_update ? 'F' : 'N'}:${todayStr()}`;
  if (!showUpdate && !opts.manual && key === lastShownKey) return { shown: false, reason: 'already_shown' };
  lastShownKey = key;

  showModal(data, { force: !!data.force_update, platform: platform() });
  return { shown: true, force: !!data.force_update, data };
}

/** 启动版本检测：App 启动 + 从后台回到前台 */
export function initUpdate() {
  // 启动即检测一次
  checkUpdate().catch(() => {});
  // 从后台回到前台再检测一次（用户去微信聊天回来，可能正好发了新版）
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkUpdate().catch(() => {});
  });
}
