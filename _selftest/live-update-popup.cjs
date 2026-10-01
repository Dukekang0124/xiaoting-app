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
// 模拟"手机里装着的那一版"：默认取线上清单里【上一个】发布版本（history[1]），
// 不再写死 1.1.4（那个版本从未出过包，站内 /apk/ 里没有它的安装包，会让旧包复现断言失败）。
// 仍可用 OLD_VERSION 环境变量覆盖（例如本地没有上一版包时手动指定一个站内存在的版本）。
let OLD_VERSION = process.env.OLD_VERSION || '';

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
  const cmp = (a, b) => String(a).localeCompare(b, undefined, { numeric: true });
  /* 🔴 v1.5.0 复发（v1.4.5 也踩过一次）的坑：旧包从 history[1] 取。
     一旦 history 顶部有重复条目（CI 回填与本地 unshift 各插了一次同一个版本），
     history[1] 就会取到 **latest 自己** ⇒ 「旧包」其实是最新版 ⇒ B 臂必然假红，
     而且看起来像"更新功能坏了"，其实是测试数据脏了。
     判据：这一条断言现在会直接点名重复项，不再让它伪装成产品缺陷。 */
  const dupAt = (live.history || []).findIndex(
    (h, i, arr) => i > 0 && h.version === arr[i - 1].version);
  ok('线上清单 history 顶部无重复版本（否则"旧包"会取成最新版 → B 臂假红）',
    dupAt === -1, dupAt === -1 ? '无重复' : `history[${dupAt}] 与 history[${dupAt - 1}] 都是 ${(live.history[dupAt] || {}).version}`);
  if (!OLD_VERSION) {
    // 取 history 里**第一个真的小于 latest** 的版本，绝不盲信 history[1]
    const cand = (live.history || []).map((h) => h.version).find((v) => cmp(v, latest) < 0);
    OLD_VERSION = cand || '1.1.9';
  }
  ok('线上清单 latest_version > 模拟旧包，弹窗前提成立',
    cmp(latest, OLD_VERSION) > 0,
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
    const r = await fetch(dlUrl + (dlUrl.includes('?') ? '&' : '?') + 'cb=' + Date.now());
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

  // ★ v1.2.0 教训：EdgeOne 对静态资产无 Cache-Control，发版后有小时级窗口，多边缘节点/分桶
  //   摇摆着吐上一版旧缓存（curl 桶新、页面脚本桶旧；同一 URL 两次请求可能一新一旧）。
  //   这不影响 APK 用户（资源在壳内），但会让 L3 的「新文案/新行为/别名 md5」断言随机假红。
  //   解法：所有 js/css 请求统一加唯一 cache-buster query 强制回源 —— 仍是线上真实资源，
  //   只是绕过 CDN 旧条目。route 规则「后注册优先」：通用 buster 先注册，sw.js 阻断后注册。
  const CB = `cb${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const busterRoute = (route) => {
    const u = new URL(route.request().url());
    if (/\.(js|css)$/.test(u.pathname) && !u.searchParams.has('cb')) {
      u.searchParams.set('cb', CB);
      return route.continue({ url: u.toString() });
    }
    return route.continue();
  };

  async function arm({ rewriteTo, label }) {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 }, locale: 'zh-CN', isMobile: true, hasTouch: true,
    });
    await ctx.route('**/*', busterRoute);
    // 阻断 Service Worker：线上 SW 会重新导航/回源，和 Playwright 的文档改写抢时序，
    // 让弹窗在轮询瞬间被「重载」抹掉 → 假阴性。SW 不参与「版本比较」判定（只缓存资产 +
    // 旁路 /version.json），阻断它不影响要验证的「旧包→弹窗」逻辑，只让测试变确定。
    await ctx.route('**/sw.js', (r) => r.abort());
    await ctx.addInitScript(() => {
       try { localStorage.setItem('monthly:done_' + (new Date().getFullYear() * 100 + (new Date().getMonth() + 1)), '1'); } catch (e) {}
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
  ok('B·走的是 APK 分支文案（v1.2 应用内安装指引）', B.info.sub.includes('安装指引'), B.info.sub);
  // v1.2 行为：APK 点「立即更新」弹应用内安装指引（不甩浏览器）。
  // 注意：必须和 B 臂一样把壳内版本改写成旧版，否则 1.2.0==latest 不弹窗，指引无从触发。
  {
    const ctxG = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN', isMobile: true, hasTouch: true });
    await ctxG.route('**/*', busterRoute);
    await ctxG.route('**/sw.js', (r) => r.abort());
    await ctxG.route(
      (url) => url.hostname === host && (url.pathname === '/' || url.pathname === '/index.html'),
      async (route) => {
        const res = await route.fetch();
        let body = await res.text();
        body = body.replace(/APP_VERSION\s*=\s*'[^']+'/, `APP_VERSION = '${OLD_VERSION}'`);
        await route.fulfill({ response: res, body });
      },
    );
    await ctxG.addInitScript(() => {
       try { localStorage.setItem('monthly:done_' + (new Date().getFullYear() * 100 + (new Date().getMonth() + 1)), '1'); } catch (e) {}
      window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', platform: 'android' };
      try { localStorage.setItem('xiaoting:ai', 'mock'); localStorage.setItem('moxiaoming:welcomed_v1', '1'); } catch (e) {}
    });
    const pageG = await ctxG.newPage();
    await pageG.goto(`${ORIGIN}/#/say`, { waitUntil: 'domcontentloaded' });
    await pageG.waitForSelector('.update-overlay', { timeout: 9000 });
    await pageG.click('#updateNow');
    let guideShown = true;
    try { await pageG.waitForSelector('.install-overlay', { timeout: 6000 }); } catch (e) { guideShown = false; }
    const g = await pageG.evaluate(() => ({
      title: (document.querySelector('.install-overlay .update-sign') || {}).textContent || '',
      steps: document.querySelectorAll('.install-steps li').length,
      start: (document.getElementById('installStart') || {}).textContent || '',
    }));
    ok('B·点立即更新 → 应用内安装指引弹窗（v1.2 新行为）', guideShown && g.title.includes('安装指引') && g.steps === 3 && g.start.includes('开始下载'), JSON.stringify(g));
    await pageG.screenshot({ path: path.join(__dirname, 'shots', 'live-install-guide.png') }).catch(() => {});
    await ctxG.close();
  }
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
    await ctx.route('**/sw.js', (r) => r.abort());
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
        const r = await fetch(target + (target.includes('?') ? '&' : '?') + 'cb=' + Date.now());
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
    await ctxNat.route('**/sw.js', (r) => r.abort());
    await ctxNat.addInitScript(() => {
       try { localStorage.setItem('monthly:done_' + (new Date().getFullYear() * 100 + (new Date().getMonth() + 1)), '1'); } catch (e) {}
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
