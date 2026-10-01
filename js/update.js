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
import { apiBase, isNativeApp } from './config.js';
import * as diag from './diag.js';

/* ---------------- 常量 ---------------- */

const SNOOZE_KEY = 'xiaoting:update_snooze_day'; // 当天"稍后再说"过的日期

/**
 * v1.4.2 · 硬编码「已知最新」兜底（康哥要求，但取值规则我改了，理由见下）
 *
 * 为什么需要它：线上版本清单是**静态文件**，只有发布站点才会变。
 *   一旦发版漏了发布站点（v1.4.1 正是如此：APK 发了、www 没发），
 *   线上 latest 还停在 1.3.5 ⇒ 比用户手上的 1.4.0 还旧 ⇒ 永远判定「已是最新」。
 *   这类故障前端完全看不出来，用户只会觉得「更新功能是死的」。
 *
 * 🔴 取值规则必须是「线上与硬编码**取较大者**」，不能用硬编码直接覆盖：
 *   直接覆盖 ⇒ 以后每发一版都得回来改这个常量，忘了改就等于把更新功能**反向锁死**
 *   （新版 1.5.0 上线了，硬编码还写 1.4.2 ⇒ 用户永远收不到 1.5.0 的提示）。
 *   那等于用一个新坑换掉旧坑。取大者时，它只在「线上更旧/取不到」时才起作用。
 *
 * 🔴 与 APP_VERSION 必须同步：自测里有一条断言卡死这条（两者必须相等），
 *   否则「发版忘改常量」又会变成下一个静默故障。
 */
export const LATEST_VERSION = '1.4.4';

/** 兜底安装包地址：必须是**版本化文件名**，不能用 xiaoting-latest.apk 别名
 *  （别名指向"站点上最新的那一版"，站点没发布时它反而是旧版 ⇒ 会让人装回旧包）。 */
const FALLBACK_APK_URL = 'https://xiaoting.app.workbuddy.host/apk/Xiaoting-v1.4.4-release.apk';

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

/**
 * 平台识别：微信 / Android(APK) / iOS / 普通浏览器
 *
 * 🔴 v1.1.6 修：`isApk` 曾经**只看 UA 标记**（`xiaotingandroid|xiaoting_app`），
 *   但那个标记全仓库从来没有被设过——`capacitor.config.json` 里没有 `appendUserAgent`，
 *   CI 生成 android 工程时也没注入。后果是真机里 `isApk` 恒为 false：
 *     · 弹窗走 Web 文案（"会自动刷新到最新版"，而 APK 里资源是打包在壳内的，刷新不可能变新版）
 *     · 点「立即更新」进 `webUpdateReload()` —— 清缓存 + reload，**永远装不上新版**
 *   即"弹窗弹得出来、按钮点不动"，断的正是「可供更新」那一半。
 *   判据改成 Capacitor 桥（`isNativeApp()`）——和 `apiBase()` 用的是同一个信号，
 *   它才是"我此刻跑在原生壳里"的可靠事实来源；UA 标记与 `?app=android` 保留为兜底/自测入口。
 */
export function platform() {
  const ua = navigator.userAgent || '';
  const isWeChat = /micromessenger/i.test(ua);
  const isIOS = /iphone|ipad|ipod/i.test(ua);
  const isAndroid = /android/i.test(ua);
  const isApk = isNativeApp()
    || /xiaotingandroid|xiaoting_app/i.test(ua)
    || /[?&]app=android\b/.test(location.search);
  return { ua, isWeChat, isIOS, isAndroid, isApk };
}

export function getSnoozeDay() {
  try { return localStorage.getItem(SNOOZE_KEY) || ''; } catch (e) { return ''; }
}
export function setSnoozeDay() {
  try { localStorage.setItem(SNOOZE_KEY, todayStr()); } catch (e) {}
}

/**
 * 按**版本**记住"用户已经拒绝过这次更新"（v1.4.3，对齐 Sinoky 的 apkDismissed 语义）。
 *
 * 旧行为是"当天不再提示，明天继续弹"：用户明确点过「稍后再说」，第二天又被弹一次，
 * 而他并没有改变主意。按版本记忆才对得上用户的真实意图——
 * 「这个版本我暂时不装」≠「今天不装，明天我可能就装」。
 *
 * 自动检测才会被它短路；「关于墨小溟」页的手动检查**永远可用**（用户主动问就必须给答案）。
 * 拒绝过 1.4.3 之后，1.5.0 发布时仍然会正常提示（版本不同）。
 */
const DISMISS_KEY = 'xiaoting:update_dismissed_ver';

export function getDismissedVersion() {
  try { return localStorage.getItem(DISMISS_KEY) || ''; } catch (e) { return ''; }
}
export function setDismissedVersion(v) {
  try { localStorage.setItem(DISMISS_KEY, String(v || '')); } catch (e) {}
}

async function fetchJson(url) {
  // v1.1.10：版本检测补 8 秒超时保护（ASR/LLM 已有，这里补齐最后一处网络请求）
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) {
      // v1.2.1 攻坚·战役三：真实错误日志（HTTP 状态 + URL），排障时直接在控制台看得到，不只在诊断面板。
      console.error('[更新检测] 请求失败', { url, http: res.status });
      throw new Error('http_' + res.status);
    }
    return res.json();
  } catch (e) {
    if (!(e && String(e.message).startsWith('http_'))) console.error('[更新检测] 请求异常', { url, err: String((e && e.message) || e) });
    throw e;
  } finally {
    clearTimeout(timer);
  }
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
  let data = null;
  try {
    data = await fetchManifest(LATEST_PATHS);
  } catch (e) {
    data = null; // 失败不抛：下面用硬编码兜底，用户至少还能收到"有新版本"这件事
  }

  const remoteLatest = String((data && data.latest_version) || '');
  const remoteIsStale = cmpVersion(remoteLatest || '0', LATEST_VERSION) < 0;

  if (!data) {
    data = {
      latest_version: LATEST_VERSION,
      release_notes: [],
      force_update: false,
      download_url: FALLBACK_APK_URL,
      _source: 'hardcoded',
      _remote: 'fetch_failed',
    };
    diag.note('update', 'manifest_fallback', { source: 'hardcoded', remote: 'fetch_failed', used: LATEST_VERSION });
  } else if (remoteIsStale) {
    // 🔴 线上清单比已知最新还旧（典型：发了 APK 没发站点）⇒ 用硬编码的版本号**和下载地址**。
    //    下载地址必须一起换：否则会拿 1.3.5 的包去"升级"一个 1.4.0 的用户，那是在帮倒忙。
    data = Object.assign({}, data, {
      latest_version: LATEST_VERSION,
      download_url: FALLBACK_APK_URL,
      _source: 'hardcoded',
      _remote: remoteLatest,
    });
    diag.note('update', 'manifest_fallback', { source: 'hardcoded', remote: remoteLatest, used: LATEST_VERSION });
  } else {
    data = Object.assign({}, data, { _source: 'remote', _remote: remoteLatest });
  }

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
  if (p.isApk) return '点「立即更新」会弹出安装指引，跟着 3 步就能装上最新版。';
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

  /**
   * 「稍后再说」的统一语义（v1.4.3）：当天不再自动弹 **且** 这个版本不再自动弹。
   * 三个入口（稍后按钮 / 点遮罩 / ESC）都走这里，避免以后加入口时漏掉其中一个。
   * 强制更新（force）永远不给这条路 —— 上面三个入口在 force 时都不注册。
   */
  const snooze = () => { setSnoozeDay(); setDismissedVersion(data.latest_version); };

  const now = document.getElementById('updateNow');
  if (now) now.addEventListener('click', () => doUpdate(p, data));

  const later = document.getElementById('updateLater');
  if (later) later.addEventListener('click', () => {
    snooze();
    closeModal();
  });

  // 强制更新：点遮罩不关、ESC 不关；非强制：点遮罩 = 稍后再说
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay && !force) {
      snooze();
      closeModal();
    }
  });
  if (!force) {
    overlay._onKey = (e) => { if (e.key === 'Escape') { snooze(); closeModal(); } };
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
    // APK：不再直接甩系统浏览器（那样用户只看到一团乱跳、还不知道下一步干嘛）。
    // 改为应用内安装指引弹窗：先讲清 3 步，点「开始下载」才触发下载，下载后提示下拉通知栏安装 + 未知来源权限。
    showInstallGuide(data, p);
    return;
  }
  // Web / iOS：清空缓存后刷新
  webUpdateReload();
}

/**
 * APK 应用内安装指引弹窗（v1.2.0，Task #117）。
 * 不甩系统浏览器，而是先在应用内讲清 3 步；点「开始下载」才触发下载（WebView 把 .apk 当下载而非页面跳转），
 * 再把弹窗切换成「下载中 → 完成后下拉通知栏安装 + 未知来源权限提示」，全程用户都知道在干嘛。
 * 零依赖：不引入任何新原生插件，只靠 DOM 弹窗 + window.location.href 触发下载。
 */
/* ---------------- 应用内安装器（v1.4.1 · Task #141） ---------------- */

/**
 * 惰性加载安装器插件。
 *
 * 🔴 必须动态 import，不能静态 import：这两个插件**只在原生壳里存在**。
 * 静态 import 会让 Web 端整个 update.js 模块加载失败 —— 一崩就是
 * 「检查更新」这个刚修好的功能也跟着没了。那比功能缺失严重得多。
 *
 * @returns null 表示不可用（Web 端 / 插件没装 / 插件没注册），调用方据此降级。
 */
async function loadInstaller() {
  if (!isNativeApp()) return null;
  try {
    const [fsm, fom] = await Promise.all([
      import('@capacitor/filesystem'),
      import('@capacitor-community/file-opener'),
    ]);
    if (!fsm || !fsm.Filesystem || !fom || !fom.FileOpener) return null;
    return { Filesystem: fsm.Filesystem, Directory: fsm.Directory, FileOpener: fom.FileOpener };
  } catch (e) {
    diag.note('update', 'installer_unavailable', { detail: String((e && e.message) || e).slice(0, 120) });
    return null;
  }
}

function bytesToBase64(u8) {
  let s = '';
  const CHUNK = 0x8000; // 分块，避免 apply 参数过多爆栈
  for (let i = 0; i < u8.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

/**
 * 下载结果到底是不是一个真的 APK。
 *
 * 🔴 为什么必须校验：托管平台对**不存在的路径**有两种完全不同的反应，而只有一种会被
 *   `res.ok` 拦住：
 *     · 普通静态托管 → 404（`res.ok===false`，已被拦住）✅ 墨小溟线上就是这种
 *     · SPA 式托管（Cloudflare Pages / Vercel 等）→ **回落 index.html 并返回 200**
 *   ⇒ 第二种情况下 `res.ok` 为真，正文却是 HTML。实测复现过：
 *     `https://xiaoting-asr.pages.dev/apk/Xiaoting-v9.9.9-release.apk`
 *     → HTTP **200**、`text/html`、8491 字节。
 *   如果只靠 `res.ok` + 体积判断，这段 HTML 会被写进缓存目录并**调起系统安装器**，
 *   用户看到「已唤起安装界面」，然后系统报「解析包时出现问题」——完全不知道发生了什么。
 *
 *   Sinoky 与 ChunkSpoke 都栽在同一个坑上（ChunkSpoke 的注释写明是「Sinoky 踩坑移植」），
 *   两家的解法一致：**校验 ZIP/APK 魔数 PK\x03\x04**。
 *   体积阈值治不了这个病 —— 假包 8KB，比 1KB 的阈值大得多。
 *
 * @returns {{ok:true}|{ok:false, reason:string, detail:string}}
 */
export function validateApkBytes(bytes, contentType) {
  const ct = String(contentType || '');
  if (!bytes || bytes.byteLength < 4096) {
    return { ok: false, reason: 'download_too_small', detail: `仅 ${(bytes && bytes.byteLength) || 0} 字节` };
  }
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  if (!isZip) {
    const head = Array.from(bytes.slice(0, 4)).map((b) => b.toString(16).padStart(2, '0')).join(' ');
    return {
      ok: false,
      reason: 'not_an_apk',
      detail: `前四字节 ${head}（应为 50 4b 03 04），Content-Type=${ct || '(空)'}`,
    };
  }
  return { ok: true };
}

/**
 * 应用内下载安装包 → 写入缓存目录 → 调起系统安装器。
 *
 * 与旧流程（触发下载 + 让用户自己去通知栏找）的区别：
 * 旧流程把「在通知栏里找到一个叫 Xiaoting…apk 的文件」这个动作甩给了用户，
 * 很多人就卡在这一步。新流程下完直接弹系统安装界面。
 *
 * 依赖（缺一不可，CI 已注入/打包）：
 *   · REQUEST_INSTALL_PACKAGES 权限 —— 缺了系统静默拒绝，表现为「点了没反应」
 *   · @capacitor/filesystem        —— 落盘并换取 content:// URI（Android 7+ 直接给文件路径会被拒）
 *   · @capacitor-community/file-opener —— 发 ACTION_VIEW 唤起安装器
 *
 * @returns {{ok:true}|{ok:false, reason:string, detail?:string}}
 */
export async function installApkInApp(url, version = '') {
  const kit = await loadInstaller();
  if (!kit) return { ok: false, reason: 'plugin_missing' };
  const { Filesystem, Directory, FileOpener } = kit;
  const file = `xiaoting-v${String(version || 'latest').replace(/[^\w.]/g, '')}.apk`;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return { ok: false, reason: 'download_failed', detail: 'HTTP ' + res.status };
    // 用 arrayBuffer 而不是 blob：魔数校验需要拿到前几个字节，且后续转 base64 自己控制编码
    const bytes = new Uint8Array(await res.arrayBuffer());
    const ctype = res.headers.get('content-type') || '';

    // 🔴 关键拦截：HTTP 200 也可能是 HTML（SPA 式托管的兜底页）。详见 validateApkBytes 注释。
    const valid = validateApkBytes(bytes, ctype);
    if (!valid.ok) {
      diag.note('update', 'installer_bad_payload', { ok: false, detail: `${valid.reason} ${valid.detail} url=${url}` });
      return { ok: false, reason: valid.reason, detail: valid.detail };
    }

    const b64 = bytesToBase64(bytes);
    await Filesystem.writeFile({ path: file, directory: Directory.Cache, data: b64, recursive: true });
    const uri = await Filesystem.getUri({ path: file, directory: Directory.Cache });
    await FileOpener.open({ url: uri.uri, contentType: 'application/vnd.android.package-archive' });
    diag.note('update', 'installer_opened', { ok: true, detail: `已唤起系统安装器 ${uri.uri} 大小=${bytes.byteLength}B 魔数=PK` });
    return { ok: true, size: bytes.byteLength };
  } catch (e) {
    const detail = String((e && e.message) || e);
    diag.note('update', 'installer_failed', { ok: false, detail: detail.slice(0, 160) });
    return { ok: false, reason: 'installer_failed', detail };
  }
}

function showInstallGuide(data, p) {
  const url = absUrl(data.download_url) || absUrl(data.web_url) || location.href;
  const overlay = document.createElement('div');
  overlay.className = 'install-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.innerHTML = `
    <div class="install-card">
      <div class="update-ip">
        ${mascot('happy', 96)}
        <div class="update-sign">安装指引</div>
      </div>
      <h3 class="update-title">墨小溟 v${esc(data.latest_version)} 已就绪</h3>
      <p class="update-sub">下面 3 步就能装上最新版，很快：</p>
      <ol class="install-steps">
        <li>点「开始下载」，安装包会在后台下载。</li>
        <li>下载完成后，从屏幕<b>顶部下拉通知栏</b>，点一下「Xiaoting…apk」。</li>
        <li>若弹出「允许安装未知应用」，打开该权限，再点安装即可。</li>
      </ol>
      <div class="install-actions">
        <button class="update-btn update-btn--primary" id="installStart" type="button">开始下载</button>
        <button class="update-btn update-btn--ghost" id="installLater" type="button">稍后再说</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const start = document.getElementById('installStart');
  if (start) start.addEventListener('click', async () => {
    const card = overlay.querySelector('.install-card');
    const showStep = (sign, title, sub, extra) => {
      if (!card) return;
      card.innerHTML = `
        <div class="update-ip">
          ${mascot(sign, 96)}
          <div class="update-sign">${esc(sign === 'happy' ? '搞定' : '下载中')}</div>
        </div>
        <h3 class="update-title">${esc(title)}</h3>
        <p class="update-sub">${sub}</p>
        ${extra || ''}
        <div class="install-actions">
          <button class="update-btn update-btn--primary" id="installDone" type="button">我知道了</button>
        </div>`;
      const done = document.getElementById('installDone');
      if (done) done.addEventListener('click', () => { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); });
    };

    // v1.4.1 Task #141：先试应用内安装（下完直接弹系统安装界面）。
    // 拿不到插件（Web 端 / 未装插件）时**必须**回落旧流程，而不是卡住不给反馈 ——
    // 旧流程虽然绕，但它是能装上的；新流程失败就什么都不做，那才是真坏。
    start.disabled = true;
    start.textContent = '准备中…';
    const r = await installApkInApp(url, data.latest_version);

    if (r.ok) {
      showStep('happy', '已唤起系统安装界面',
        '下面按系统提示点「安装」即可。<br/>若提示「允许安装未知应用」，打开该权限后再点一次。');
      return;
    }

    // 🔴 下载到的根本不是安装包（假包 / 太小）：**绝不能**回落到「用下载方式」——
    //    用户会下载到同一个 HTML 文件，绕一圈回到原点，还会以为是自己手机的问题。
    //    这种情况必须如实说「服务器上的安装包有问题」，并指向手动下载入口。
    if (r.reason === 'not_an_apk' || r.reason === 'download_too_small') {
      showStep('worried', '安装包暂时拿不到',
        '服务器返回的不是安装包文件（可能是网页文件），这通常是发布环节出了问题，不是你的手机的问题。<br/>请稍后再试，或到「关于墨小溟」页手动下载。',
        `<p class="update-sub">（诊断：${esc(String(r.detail || r.reason))}）</p>`);
      return;
    }

    // 其余失败（插件缺失等）：降级为触发下载（WebView 里指向 .apk 会被当成下载而非跳转），再给通知栏指引。
    try { window.location.href = url; } catch (e) { /* ignore */ }
    showStep('listening', '正在下载安装包…',
      '下载完成后，从屏幕顶部<b>下拉通知栏</b>，点「Xiaoting…apk」即可安装。<br/>若提示「允许安装未知应用」，请打开该权限后再点安装。',
      r.reason === 'plugin_missing' ? '' : `<p class="update-sub">（应用内安装未生效：${esc(String(r.reason || ''))}，已改用下载方式）</p>`);
  });

  const later = document.getElementById('installLater');
  if (later) later.addEventListener('click', () => { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); });
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
  const latest = String(data.latest_version || '');
  const hasNew = cmpVersion(latest, current) > 0;
  const q = new URLSearchParams(location.search);
  const showUpdate = opts.forceShow || q.get('showUpdate') === '1' || q.get('showUpdate') === 'force';

  // 🔴 v1.4.0：所有分支都带上 current / latest，调用方才能给用户一句可读的结果。
  //   起因：手动点「检查更新」在「已是最新版」时只 return {reason:'no_update'}，
  //   调用处 `.catch(()=>{})` 无 else ⇒ 页面零反馈 ⇒ 用户体感「更新功能坏了/连不上」。
  //   接口其实是通的（实测 /version.json 三通道 200 + 合法 JSON），坏的是"没有回话"。
  const ctx = { current, latest };

  if (!hasNew && !showUpdate) return Object.assign({ shown: false, reason: 'no_update' }, ctx);

  // v1.4.3：用户对**这个版本**点过「稍后再说」⇒ 不再自动打扰。
  //   放在 force 判断之外是刻意的：强制更新（force_update / 低于最低可用版本）不接受拒绝。
  //   手动检查（opts.manual）也不受影响 —— 用户主动问，就必须回答。
  if (!data.force_update && !showUpdate && !opts.manual && getDismissedVersion() === latest) {
    return Object.assign({ shown: false, reason: 'dismissed' }, ctx);
  }

  if (!data.force_update && !showUpdate && !opts.manual && getSnoozeDay() === todayStr()) {
    return Object.assign({ shown: false, reason: 'snoozed' }, ctx);
  }

  // 防止同一次 session 内重复弹（前台/后台来回切）
  const key = `${data.latest_version}:${data.force_update ? 'F' : 'N'}:${todayStr()}`;
  if (!showUpdate && !opts.manual && key === lastShownKey) return Object.assign({ shown: false, reason: 'already_shown' }, ctx);
  lastShownKey = key;

  showModal(data, { force: !!data.force_update, platform: platform() });

  // 🔴 v1.4.3 修：这里必须带 `reason: 'shown'`。
  //    describeCheckResult 是按 r.reason 分派的，漏了它就会落到 default 分支，
  //    于是「手动检查 + 发现新版本」这个**最该有回话**的场景反而显示「检查失败：未知原因」
  //    —— 用户同时看到弹窗和一句"检查失败"，自相矛盾。
  //    v1.4.0 承诺"检查更新永远有回话"时只覆盖了「没新版」那一半，这半边一直漏着，
  //    是四象限测试（象限①/④ 的手动检查分支）把它暴露出来的。
  return Object.assign({ shown: true, reason: 'shown', force: !!data.force_update, data }, ctx);
}

/**
 * 把 checkUpdate 的结果翻译成一句**给用户看的人话**（v1.4.0）。
 * 手动检查必须永远有回话 —— 这是"更新功能是死的"这类误判的唯一根治办法。
 * 失败时把**真实原因**（每个候选路径各自的错）原样带出来，用户可截图，开发者可据此定位。
 */
export function describeCheckResult(r) {
  const cur = (r && r.current) || window.APP_VERSION || '?';
  const latest = (r && r.latest) || '';
  switch (r && r.reason) {
    case 'no_update':
      return { ok: true, text: `已是最新版本 v${cur}（线上 v${latest || cur}）` };
    case 'shown':
      return { ok: true, text: `发现新版本 v${latest}，已为你弹出更新提示` };
    case 'snoozed':
      return { ok: true, text: `今天已经提醒过啦，明天再说（线上 v${latest}）` };
    case 'dismissed':
      return { ok: true, text: `你之前选了「稍后再说」，v${latest} 不再自动提醒（想装随时手动检查）` };
    case 'already_shown':
      return { ok: true, text: `本次已提示过新版本 v${latest}` };
    case 'fetch_failed':
      return {
        ok: false,
        text: `检查失败：${r.detail || '网络不可达'}`,
        detail: r.detail || '',
      };
    default:
      return { ok: false, text: `检查失败：${(r && r.reason) || '未知原因'}` };
  }
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
