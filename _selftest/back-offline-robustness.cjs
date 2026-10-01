// 墨小溟 v1.1.10 · 新增健壮性行为自测（全局返回键 / 离线浮条 / 优雅兜底 / 诊断页返回）
// 运行：BASE=http://127.0.0.1:4173 NODE_PATH=<managed-node-workspace>/node_modules node _selftest/back-offline-robustness.cjs
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:4173';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail: String(detail || '') });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    await page.waitForFunction(
      () => document.querySelector('#view') && document.querySelector('#view').innerHTML.length > 0,
      null, { timeout: 10000 },
    );

    // 1) 子页面（关于/更新历史）按返回键 → 回到上一级 #/me
    await page.evaluate(() => { location.hash = '#/changelog'; });
    await sleep(300);
    await page.evaluate(async () => { const m = await import('/js/app.js'); m.__test__.handleHardwareBack(); });
    await sleep(200);
    let h = await page.evaluate(() => location.hash);
    check('子页面(关于)按返回键 → 回到 #/me', h === '#/me', h);

    // 2) 首页级按返回键（浏览器环境）不应导航（避免误退整页）
    await page.evaluate(() => { location.hash = '#/say'; });
    await sleep(200);
    const before = await page.evaluate(() => location.hash);
    await page.evaluate(async () => { const m = await import('/js/app.js'); m.__test__.handleHardwareBack(); });
    await sleep(150);
    const after = await page.evaluate(() => location.hash);
    check('首页级按返回键（浏览器）不导航', before === after && after === '#/say', `${before}->${after}`);

    // 3) 倾诉进行中（录音/分析）按返回键 → 先弹温柔确认，且不立即导航
    await page.evaluate(() => { location.hash = '#/record?mode=text'; });
    await sleep(200);
    await page.evaluate(async () => { const m = await import('/js/app.js'); m.__test__.rec.active = true; });
    await page.evaluate(async () => { const m = await import('/js/app.js'); m.__test__.handleHardwareBack(); });
    await sleep(200);
    const hasConfirm = await page.evaluate(() => !!document.querySelector('.gentle-confirm'));
    const h3 = await page.evaluate(() => location.hash);
    check('倾诉进行中按返回键 → 弹温柔确认框', hasConfirm, '');
    check('倾诉进行中按返回键 → 未立即导航', h3 === '#/record?mode=text', h3);
    await page.evaluate(() => { const b = document.getElementById('gcCancel'); if (b) b.click(); });
    await sleep(150);
    const confirmGone = await page.evaluate(() => !document.querySelector('.gentle-confirm'));
    check('温柔确认「再想想」→ 确认框消失', confirmGone, '');
    await page.evaluate(async () => { const m = await import('/js/app.js'); m.__test__.rec.active = false; });

    // 4) 离线浮条：断网出现、恢复隐藏
    await ctx.setOffline(true);
    await sleep(250);
    const offlineShown = await page.evaluate(() => { const b = document.getElementById('offlineBar'); return !!b && !b.hidden; });
    check('断网 → 离线浮条出现', offlineShown, '');
    await ctx.setOffline(false);
    await sleep(250);
    const onlineHidden = await page.evaluate(() => { const b = document.getElementById('offlineBar'); return !!b && b.hidden; });
    check('恢复网络 → 离线浮条隐藏', onlineHidden, '');

    // 5) 更新历史拉取失败 → 优雅文案 + 「检查更新」按钮保留
    // 🔴 尾部星号不能省：fetchJson 给每个清单请求都加 ?cb=（破网关缓存桶，v1.4.6 起），
    //    `**/api/version/history` 匹配不到带 query 的 URL ⇒ abort 静默失效。
    //    🔴 文案也要跟着改：v1.2.1 已把「暂时无法连接深海」统一改成「深海信号微弱，请检查网络再试」，
    //    旧断言是在验一个不存在的产品行为（改文案不会让它变绿，只会让它验错东西）。
    await page.route('**/version.json*', (r) => r.abort());
    await page.route('**/api/version/history*', (r) => r.abort());
    await page.route('**/version-latest.js*', (r) => r.abort());
    // 🔴 改 hash 不重载页面（清单已在 update.js 内存里）⇒ 必须真重载才会重新取数走失败分支。
    await page.evaluate(() => { location.hash = '#/changelog'; });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(900);
    const clText = await page.evaluate(() => { const e = document.getElementById('clList'); return e ? e.textContent : ''; });
    const hasCheck = await page.evaluate(() => !!document.getElementById('clCheck'));
    check('更新历史拉取失败 → 显示「深海信号微弱，请检查网络再试」', clText.indexOf('深海信号微弱，请检查网络再试') >= 0, clText.slice(0, 40));
    check('更新历史失败 → 「检查更新」按钮保留', hasCheck, '');
    await page.unroute('**/version.json*');
    await page.unroute('**/api/version/history*');

    // 6) 诊断页有返回按钮（→ #/settings）
    await page.evaluate(() => { location.hash = '#/settings'; });
    await sleep(200);
    await page.evaluate(() => { const a = document.querySelector('a.set-diaglink'); if (a) a.click(); });
    await sleep(300);
    const hasDiagBack = await page.evaluate(() => {
      const a = document.querySelector('.page--diag .page-head a.ghost');
      return !!a && a.getAttribute('href') === '#/settings';
    });
    check('诊断页存在返回按钮(→#/settings)', hasDiagBack, await page.evaluate(() => location.hash));
  } catch (e) {
    check('测试执行未抛异常', false, String((e && e.message) || e));
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n===== 健壮性自测：共 ${results.length} 条，失败 ${failed.length} 条 =====`);
  process.exit(failed.length ? 1 : 0);
})();
