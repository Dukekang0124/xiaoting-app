/**
 * js/install.js —— v1.7.0：下载安卓版 + 装到桌面（A2HS）。
 *
 * 【为什么单独一个文件】v1.6.19 之前，"网页版能用、安卓版更好"这件事在整个代码库里
 * 只有一句假陈述撑着 —— update.js 的 subCopy() 对 Web/iOS 用户说「会自动刷新到最新版」，
 * 刷新是真的，但**一句都没说还有个 APK、更没给入口**。这条缺口分两半：
 *   ① 想装的人不知道能装（缺门面与入口）→ 由落地页 + #/download 解决；
 *   ② 装完能干什么（缺安装能力）→ 由本文件的 A2HS 解决。
 *
 * 【铁律】
 *   · 版本信息一律走清单，不硬编码版本号：优先 `window.__VERSION_MANIFEST__`
 *     （server/version.json 的脚本形态副本，构建产物，专门解决静态托管不给 ACAO 时
 *     跨域 fetch JSON 被拒 ⇒ 读不到清单 ⇒ 页面写死版本必然漂）；读不到再回落 /version.json。
 *   · 下载按钮必须真能下到：来源按「清单 url → 按版本号拼全称 → 稳定别名」三档回落，
 *     任何一档存在都能下载，不会留下一个点了没反应的按钮。
 *   · 装到桌面：Chromium 系走 beforeinstallprompt；iOS Safari 没有这个事件，
 *     只能给「分享 → 添加到主屏幕」的引导。**不支持就不做假按钮**，直接给文字说明。
 */

import { platform, fetchLatest } from './update.js';

/* ---------------- 版本清单 ---------------- */

/**
 * 🔴 清单**必须复用 update.fetchLatest()**，不要自己另开一条路读：
 *    `window.__VERSION_MANIFEST__` 是 update.js 内部 `loadScript()` 加载 version-latest.js
 *    后写上去、随即又清掉的**中转变量**（update.js:225/236/281）——直接去读它，九成是 null。
 *    fetchLatest() 才是这产品的清单真相入口：三通道（后端 /api/version/latest、
 *    静态 /version.json、跨域脚本形态 /version-latest.js）并行全拿、取版本号最大者。
 */
export async function readManifest() {
  try {
    const m = await fetchLatest();
    if (m && m.latest_version) return m;
  } catch (e) { /* 断网 / 被拦：交给调用方降级，不静默吞成"没有新版本" */ }
  return null;
}

/* ---------------- 下载源（三档回落，按钮永远有东西可下） ---------------- */

/**
 * 候选下载地址，按可靠性排序去重。
 *  ① 清单里的 apk.url（权威，CI 回填的绝对地址）
 *  ② 按版本号拼的包名（www/apk/ 里历史包全留着，升级后旧包照样在）
 *  ③ 稳定别名 xiaoting-latest.apk（build-web 每次构建自动指向最新版）
 */
export function apkSources(m) {
  const out = [];
  const push = (u) => { if (u && out.indexOf(u) < 0) out.push(u); };
  if (m && m.apk && m.apk.url) push(m.apk.url);
  const v = (m && (m.apk && m.apk.version)) || (m && m.latest_version) || '';
  if (v) push(`apk/Xiaoting-v${v}-release.apk`);
  push('apk/xiaoting-latest.apk');
  return out;
}

/** 可直接挂 <a href> 的地址（清单给的是绝对 URL 就原样，相对路径补 ./ 保证在子路径下也对） */
export function apkHref(m) {
  const list = apkSources(m);
  if (!list.length) return '';
  const first = list[0];
  if (/^(https?:)?\/\//i.test(first)) return first;
  return './' + first.replace(/^\.?\//, '');
}

/** 给 <a download> 兜底：有些浏览器不给 download 属性，靠 Content-Disposition；这里只做提示 */
export function isApkUrl(u) {
  return /\.apk(\?|$)/i.test(String(u || ''));
}

/* ---------------- 装到桌面（A2HS） ---------------- */

const INSTALLED_KEY = 'moxiaoming:app_installed_v1';

let deferredPrompt = null;

/** 挂 beforeinstallprompt / appinstalled。返回是否支持 A2HS 这条通道。 */
export function initInstallPrompt() {
  try {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
    });
    window.addEventListener('appinstalled', () => {
      deferredPrompt = null;
      try { localStorage.setItem(INSTALLED_KEY, '1'); } catch (e) { /* 配额 / 隐私模式 */ }
    });
  } catch (e) { /* 非浏览器环境（模块直跑 / 自测） */ }
  return canInstall();
}

/** 当前这次会话里是否已经拿到过安装提示事件（拿到才说明这个浏览器真能装） */
export function canInstall() {
  return !!deferredPrompt;
}

/** 是否已经装到过桌面（装过就不再劝第二次，免得变成烦人的弹窗） */
export function alreadyInstalled() {
  try { return localStorage.getItem(INSTALLED_KEY) === '1'; } catch (e) { return false; }
}

/** 触发安装提示；返回 {ok:true} 或 {ok:false,reason} —— 绝不静默失败 */
export async function installToHome() {
  if (!deferredPrompt) return { ok: false, reason: 'unsupported' };
  try {
    deferredPrompt.prompt();
    const r = await deferredPrompt.userChoice;
    deferredPrompt = null;
    return { ok: !!(r && r.outcome === 'accepted') };
  } catch (e) {
    return { ok: false, reason: 'error' };
  }
}

/** iOS Safari 没有 beforeinstallprompt，只能靠「分享 → 添加到主屏幕」 */
export function isIOSLike() {
  return /iphone|ipad|ipod/i.test((navigator.userAgent || ''));
}

/** 是不是已经以独立窗口（桌面图标 / 全屏）在跑了 */
export function isStandalone() {
  try {
    return !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
      || navigator.standalone === 1;
  } catch (e) { return false; }
}

/**
 * 装到桌面的可执行动作：能 A2HS 就弹原生安装框，不能就给文字引导。
 * 返回 { kind: 'installed' | 'prompted' | 'guide', text }，text 直接可以上屏，
 * **不给空头按钮**（同「死开关比没开关更糟」那条规矩）。
 */
export async function installAction() {
  if (isStandalone()) return { kind: 'installed', text: '已经在桌面上了，直接点图标进来就行。' };
  if (alreadyInstalled()) return { kind: 'installed', text: '你已经装过啦，去桌面找墨小溟的图标。' };
  if (canInstall()) {
    const r = await installToHome();
    if (r.ok) {
      try { localStorage.setItem(INSTALLED_KEY, '1'); } catch (e) { /* ignore */ }
      return { kind: 'installed', text: '装好了 —— 去桌面看看，图标就在那儿。' };
    }
    return { kind: 'guide', text: '刚才那步没成功，可以试试在浏览器菜单里选「安装应用」。' };
  }
  if (isIOSLike()) {
    return {
      kind: 'guide',
      text: 'iPhone 上这样装：点底部中间的「分享」按钮 → 往下找「添加到主屏幕」→ 点「添加」。装完桌面上就有墨小溟了。',
    };
  }
  return {
    kind: 'guide',
    text: '在浏览器菜单里选「添加到主屏幕 / 安装应用」，就能把墨小溟放到桌面，点开即用、不用每次输网址。',
  };
}

/* ---------------- 四平台卡片（复用 update.js 的 platform()，不重造 UA 判断） ---------------- */

/** 当前平台的下载引导卡：给什么、怎么交互、不能给的时候怎么说实话 */
export function platformCard(p) {
  const pl = p || platform();
  if (pl.isApk) {
    return {
      key: 'apk',
      title: '你已经在安卓版里了',
      body: '现在用的是安卓客户端。有新版本时，墨小溟会在应用里提示你更新，跟着 3 步就能装上——切出去、锁屏都不会断。',
      action: null,
    };
  }
  if (pl.isWeChat) {
    return {
      key: 'wechat',
      title: '微信里装不了安装包',
      body: '微信不允许直接下载 apk。点右上角「···」→ 选「在浏览器中打开」，就能正常下载了。',
      action: { text: '复制墨小溟网址', kind: 'copy' },
    };
  }
  if (pl.isIOS) {
    return {
      key: 'ios',
      title: 'iPhone 先用网页版',
      body: '目前没有上架苹果商店的 iOS 客户端。网页版能正常倾诉、看卡片和时间线；想要放到桌面，按下面的方法加到主屏幕就行。',
      action: { text: '告诉我怎么装到桌面', kind: 'install' },
    };
  }
  return {
    key: 'android',
    title: '安卓：下安装包，装完更顺手',
    body: '安卓版多了三件网页版没有的事：手机轻提醒（晚上轻轻问候你）、后台下载安装（切出去也不断）、返回键和左滑手势。',
    action: { text: '下载安卓安装包', kind: 'apk' },
  };
}
