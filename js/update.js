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
import { apiBase } from './config.js';
import * as diag from './diag.js';

/* ---------------- 常量 ---------------- */

const SNOOZE_KEY = 'xiaoting:update_snooze_day'; // 当天"稍后再说"过的日期

/**
 * 版本清单的两个候选路径，按顺序试（v1.1.4 修）。
 *
 * 🔴 为什么必须走 apiBase()：
 *   APK 里网页跑在 WebView 的 `https://localhost` 上（Capacitor androidScheme=https）。
 *   相对路径 `/api/version/latest` 打的是 **WebView 本地资产服务**，永远 404
 *   ⇒ 更新检测一次都不会成功、且失败被静默吞掉 ⇒ **用户永远收不到新版提示**。
 *   这与 v1.1.2 修过的 ASR 是同一类缺陷（`js/asr.js` 早就用了 apiBase），当年漏了本文件。
 *
 * 🔴 为什么要有静态清单这条兜底：
 *   公开站是**静态托管**（CloudStudio Gateway），没有 Node 后端 ⇒ `/api/version/*` 恒 404。
 *   所以 `version.json` 会被一并发布成静态文件，它不依赖任何服务端，是 APK 唯一可靠路径。
 *   顺序是有意的：有后端时优先用后端（以后端为准），没后端就落到静态清单。
 */
const LATEST_PATHS = ['/api/version/latest', '/version.json'];

/** 最近一次取数失败的原因（给诊断页 / 自测断言用，不再静默） */
let lastError = '';

export function lastFetchError() { return lastError; }

/* ---------------- 小工具 ---------------- */

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * 把可能是相对路径的地址补成绝对地址。
 * APK 里页面在 `https://localhost`，任何相对路径都指向 WebView 本地资产 ⇒ 必须补到服务端基址。
 * 已经是 http(s):// 的原样返回（静态清单里的地址本来就是绝对的）。
 */
function absUrl(u) {
  const s = String(u == null ? '' : u).trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  const base = apiBase();
  if (!base) return s; // Web 同源：相对路径本来就是对的
  return base + (s.startsWith('/') ? s : '/' + s);
}

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

/**
 * 依次试候选路径，返回第一个能解析成"版本清单"的结果。
 * 每个候选都带 apiBase() 前缀（原生容器里是绝对基址，Web 上是同源）。
 * 全部失败时把**每个候选的失败原因**都带上 —— 排障时最怕的就是只看到一句 fetch_failed。
 */
async function fetchManifest(paths) {
  const tried = [];
  for (const p of paths) {
    const url = apiBase() + p;
    try {
      const data = await fetchJson(url);
      if (data && typeof data === 'object' && (data.latest_version || data.history)) {
        lastError = '';
        diag.note('update', 'manifest_ok', { path: p, latest: data.latest_version || '' });
        return data;
      }
      tried.push(p + ':bad_shape');
    } catch (e) {
      tried.push(p + ':' + ((e && e.message) || 'err'));
    }
  }
  lastError = tried.join(' | ');
  diag.note('update', 'manifest_fail', { tried: lastError, base: apiBase() || '(same-origin)' });
  throw new Error('fetch_failed: ' + lastError);
}

/** 取线上最新版本信息（带测试 query 覆盖） */
export async function fetchLatest() {
  const data = await fetchManifest(LATEST_PATHS);
  const q = new URLSearchParams(location.search);
  const fake = q.get('fake_version');
  const forced = q.get('force_update');
  if (fake) data.latest_version = fake;
  if (forced === '1' || forced === 'true') data.force_update = true;
  return data;
}

/** 取更新历史（给「关于墨小溟」页）。后端与静态清单字段名不同，这里统一形状。 */
export async function fetchHistory() {
  const data = await fetchManifest(['/api/version/history', '/version.json']);
  return {
    latest_version: data.latest_version || '',
    versions: data.versions || data.history || [],
  };
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
  if (p.isApk) return '点「立即更新」会跳到浏览器下载并安装最新安装包，装完回到这里就是新版。';
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
    // 🔴 必须绝对地址：APK 页面在 https://localhost，相对路径会去 WebView 里找一个不存在的包。
    window.location.href = absUrl(data.download_url) || absUrl(data.web_url) || location.href;
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
    // 🔴 不再静默：失败原因带回去（含每个候选路径各自的错），并已由 fetchManifest 记进诊断日志。
    // 之前这里只返回 'fetch_failed'，导致"更新弹窗一次都没弹过"这件事在开发期完全看不见。
    return { shown: false, reason: 'fetch_failed', detail: lastError };
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
