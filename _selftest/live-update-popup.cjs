/**
 * L3 线上真跑：APK 壳启动即弹「有新版本」——打真实域名，不是本地桩。
 *
 * 为什么必须有这一层：本地自测（分区 H / update-apk-abi.cjs）证明的是"代码分支对"，
 * 但"发上线之后到底弹不弹"取决于三个只有生产环境才知道的事实：
 *   ① 线上 /version.json 是不是最新的（构建产物有没有真的推上去）
 *   ② 线上 index.html / js/update.js 是不是修好的那一版
 *   ③ 弹窗里那个下载地址到底能不能下到东西（这才是「立即更新」的最后一米）
 * 这三件事任意一件错了，本地全绿也白搭。历史上本项目就栽在"测试全绿 ≠ 生产可用"上。
 *
 * 做法：用本机 Chrome 打开**线上站点**，塞一个 initScript 让页面以为自己是手机里的 APK
 * （`window.Capacitor.isNativePlatform()` → true），并把文档里的 APP_VERSION 从线上版本
 * 改写成"上一版"，模拟"用户手机里装的是旧包"。
 *   控制臂 A：不改 APP_VERSION（等于装的就是最新版）→ 必须【不弹】（防"假阳性弹窗"）
 *   实验臂 B：改成旧版本号 → 必须【弹】，且标题版本号 = 线上清单的 latest_version
 * 两臂互为鉴别力校验：只有一个成立说明测试本身无效。
 *
 * ⚠️ 写成 .cjs：项目自测一律走 CommonJS + NODE_PATH 注入 playwright
 *   （ESM 不认 NODE_PATH，`import 'playwright'` 在受管环境里解析不到）。
 *
 * 用法：NODE_PATH=<受管 workspace>/node_modules node _selftest/live-update-popup.cjs
 */
const path = require('path');
const NODE_PATH = process.env.NODE_PATH || '';
if (NODE_PATH) module.paths.push(...NODE_PATH.split(path.delimiter));
const { createHash } = require('crypto');
const { chromium } = require('playwright');

const ORIGIN = process.env.LIVE_ORIGIN || 'https://xiaoting.app.workbuddy.host';
const OLD_VERSION = process.env.OLD_VERSION || '1.1.4'; // 模拟"手机里装着的那一版"

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
};

(async () => {
  console.log(`\n===== L3 线上真跑 · ${ORIGIN} =====\n`);

  /* ---------- 0. 自己直连取一次线上清单（不信页面给的，取真相） ---------- */
  let live;
  try {
    const res = await fetch(`${ORIGIN}/version.json?t=${Date.now()}`, { cache: 'no-store' });
    ok('线上 /version.json 可达', res.status === 200, 'HTTP ' + res.status);
    live = await res.json();
  } catch (e) {
    console.error('线上清单取不到，测试无法继续：' + ((e && e.message) || e));
    process.exit(1);
  }
  const latest = live.latest_version;
  ok('线上清单 latest_version > 模拟旧包，弹窗前提成立',
    String(latest).localeCompare(OLD_VERSION, undefined, { numeric: true }) > 0,
    `线上 ${latest} vs 壳内 ${OLD_VERSION}`);
  ok('线上清单 history 首条 == latest_version',
    !!(live.history || [])[0] && live.history[0].version === latest,
    `history[0]=${((live.history || [{}])[0]).version}`);

  /* ---------- 1. 线上资产真的是修好的那一版 ---------- */
  const html = await (await fetch(`${ORIGIN}/index.html?t=${Date.now()}`, { cache: 'no-store' })).text();
  const liveVer = (html.match(/APP_VERSION\s*=\s*'([^']+)'/) || [])[1] || '';
  ok('线上 index.html 版本号 == 清单 latest_version', liveVer === latest, `index=${liveVer} manifest=${latest}`);
  const upd = await (await fetch(`${ORIGIN}/js/update.js?t=${Date.now()}`, { cache: 'no-store' })).text();
  ok('线上 js/update.js 含 apiBase（修好的那版）', upd.includes('apiBase'),
    `${(upd.match(/apiBase/g) || []).length} 处`);
  ok('线上 js/update.js 有静态清单兜底 /version.json', upd.includes("'/version.json'"), '');

  /* ---------- 2. 下载地址真能下到东西（「立即更新」的最后一米） ---------- */
  const dlUrl = live.download_url || (live.apk && live.apk.url) || '';
  ok('线上清单 download_url 指向站内 /apk/', /\/apk\/.+\.apk$/.test(dlUrl), dlUrl);
  if (dlUrl) {
    const r = await fetch(dlUrl);
    ok('download_url 可下载（HTTP 200）', r.status === 200, 'HTTP ' + r.status);
    const ct = r.headers.get('content-type') || '';
    const buf = Buffer.from(await r.arrayBuffer());
    ok('download_url 返回的是安装包（ZIP 魔数 PK\\x03\\x04）',
      buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50,
      `前 4 字节 ${buf.subarray(0, 4).toString('hex')}`);
    ok('download_url 是安卓安装包 MIME', /android|octet-stream/i.test(ct), ct);
    if (live.apk && live.apk.size) {
      ok('实际体积 == 清单 apk.size', buf.length === live.apk.size, `${buf.length} vs ${live.apk.size}`);
    }
    if (live.apk && live.apk.md5) {
      const md5 = createHash('md5').update(buf).digest('hex');
      ok('实际 md5 == 清单 apk.md5（线上清单与真实二进制对齐）', md5 === live.apk.md5,
        `${md5} vs ${live.apk.md5}`);
    }
    // 旧包也要能在站内下到：否则"想亲眼看见弹窗"的人装不到那个旧版
    const ro = await fetch(`${ORIGIN}/apk/Xiaoting-v${OLD_VERSION}-release.apk`);
    ok(`站内也能下到模拟旧包 v${OLD_VERSION}（供真机复现弹窗）`, ro.status === 200, 'HTTP ' + ro.status);
  }

  /* ---------- 3. 浏览器两臂 ---------- */
  const browser = await chromium.launch({ channel: 'chrome' });
  const host = new URL(ORIGIN).host;

  async function arm({ rewriteTo, label }) {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 }, locale: 'zh-CN', isMobile: true, hasTouch: true,
    });
    await ctx.addInitScript(() => {
      // 让页面以为自己在安卓壳里（走 APK 分支 + apiBase() 出绝对基址）
      window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', platform: 'android' };
      try {
        localStorage.setItem('xiaoting:ai', 'mock');
        localStorage.setItem('moxiaoming:welcomed_v1', '1');
      } catch (e) {}
    });
    const seen = [];
    const page = await ctx.newPage();
    page.on('request', (r) => { if (/version/.test(r.url())) seen.push(r.url()); });

    if (rewriteTo) {
      // 只拦文档：把线上那一行版本号改写成"旧包"，模拟用户手机里装的是上一版
      await ctx.route(
        (url) => url.hostname === host && (url.pathname === '/' || url.pathname === '/index.html'),
        async (route) => {
          const res = await route.fetch();
          let body = await res.text();
          const before = (body.match(/APP_VERSION\s*=\s*'([^']+)'/) || [])[1];
          body = body.replace(/APP_VERSION\s*=\s*'[^']+'/, `APP_VERSION = '${rewriteTo}'`);
          const after = (body.match(/APP_VERSION\s*=\s*'([^']+)'/) || [])[1];
          console.log(`  [${label}] 文档版本改写：${before} → ${after}`);
          await route.fulfill({ response: res, body });
        },
      );
    }

    await page.goto(`${ORIGIN}/#/say`, { waitUntil: 'domcontentloaded' });
    let shown = false;
    try { await page.waitForSelector('.update-overlay', { timeout: 9000 }); shown = true; } catch (e) { shown = false; }
    const info = await page.evaluate(() => ({
      title: (document.querySelector('.update-title') || {}).textContent || '',
      sub: (document.querySelector('.update-sub') || {}).textContent || '',
      notes: document.querySelectorAll('.update-notes li').length,
      appVer: window.APP_VERSION || '',
      hasLater: !!document.getElementById('updateLater'),
      hasNow: !!document.getElementById('updateNow'),
    }));
    const manifestHit = seen.find((u) => /version\.json|\/api\/version\//.test(u)) || '';
    await page.screenshot({ path: path.join(__dirname, 'shots', `live-update-${label}.png`) }).catch(() => {});
    await ctx.close();
    return { shown, info, manifestHit, seen };
  }

  console.log('\n  —— 控制臂 A：壳内版本 = 线上最新（不该弹）——');
  const A = await arm({ rewriteTo: null, label: 'control' });
  ok('A·已是最新版时不弹窗（防假阳性）', A.shown === false, `shown=${A.shown}`);
  ok('A·页面自身版本号确实是线上最新', A.info.appVer === latest, A.info.appVer);

  console.log('\n  —— 实验臂 B：壳内版本 = 旧包（必须弹）——');
  const B = await arm({ rewriteTo: OLD_VERSION, label: 'old-apk' });
  ok('B·旧包启动即自动弹出更新弹窗', B.shown === true, `shown=${B.shown}`);
  ok('B·弹窗标题版本号 == 线上清单 latest_version', B.info.title.includes(latest), B.info.title);
  ok('B·走的是 APK 分支文案', B.info.sub.includes('下载并安装'), B.info.sub);
  ok('B·弹窗带 release_notes 逐条展示', B.info.notes >= 1, `${B.info.notes} 条`);
  ok('B·有「立即更新」与「稍后再说」', B.info.hasNow && B.info.hasLater, `${B.info.hasNow}/${B.info.hasLater}`);
  ok('B·清单请求走绝对地址（APK 里不打 WebView 本地资产）',
    /^https?:\/\//.test(B.manifestHit) && B.manifestHit.includes(host), B.manifestHit || '(未捕获)');

  /* ---------- 4. 站内安装包入口（网页版；壳里刻意不显示） ---------- */
  // 为什么要专门验：没有任何下载入口时，站上等于"只有已经装了的人才知道有 App"，
  // 新用户拿不到包 —— 「上线为 APK」这一环其实是断的。
  // 这条断言同时守住两件事：入口在不在，以及它指向的那个文件**真的存在**。
  console.log('\n  —— 站内安装包入口（网页版）——');
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
    const page = await ctx.newPage();
    await page.goto(`${ORIGIN}/#/changelog`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#clList', { timeout: 9000 }).catch(() => {});
    const dl = await page.evaluate(() => {
      const a = document.getElementById('clDl');
      return a ? { href: a.getAttribute('href'), text: (a.textContent || '').trim(), abs: a.href } : null;
    });
    ok('网页版「关于」页有安卓安装包下载入口', !!dl, JSON.stringify(dl));
    if (dl) {
      ok('入口文案写明是安卓安装包', /安卓/.test(dl.text), dl.text);
      const target = dl.abs || '';
      const aliasHit = /\/apk\/xiaoting-latest\.apk$/.test(target);
      ok('入口指向稳定别名（不会随版本号过期）', aliasHit, target);
      if (aliasHit) {
        const r = await fetch(target);
        const buf = Buffer.from(await r.arrayBuffer());
        ok('稳定别名可下载且是 APK',
          r.status === 200 && buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50,
          `HTTP ${r.status} / ${buf.length}B`);
        if (live.apk && live.apk.md5) {
          const md5 = createHash('md5').update(buf).digest('hex');
          ok('稳定别名取到的就是最新版包（md5 对齐）', md5 === live.apk.md5, `${md5} vs ${live.apk.md5}`);
        }
      }
    }

    // 壳里必须不显示这个入口（已经装着 App 了，再让下载安装包很奇怪）
    const ctxNat = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
    await ctxNat.addInitScript(() => {
      window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', platform: 'android' };
    });
    const pageNat = await ctxNat.newPage();
    await pageNat.goto(`${ORIGIN}/#/changelog`, { waitUntil: 'domcontentloaded' });
    await pageNat.waitForSelector('#clList', { timeout: 9000 }).catch(() => {});
    const inNative = await pageNat.evaluate(() => !!document.getElementById('clDl'));
    ok('壳里不显示该入口（只在网页版出现）', inNative === false, String(inNative));
    await ctxNat.close();
    await ctx.close();
  }

  await browser.close();

  console.log(`\n==== 汇总：${pass} 通过 / ${fail} 失败 ====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
