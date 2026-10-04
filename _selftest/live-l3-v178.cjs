/**
 * 线上（L3）UI 真跑：验证 v1.7.8 的四处改动在**发出去的那一份**上真的生效。
 *
 * 🔴 为什么必须跑线上而不是本地 www/：本地 www/ 只能证明"我打算发什么"，
 *    证不了"线上现在是什么"。本项目已多次出现"本地全绿、线上还是旧版"（站点没发布）。
 *
 * 判据素养沿用：
 *   · 每个场景用**新 context**（同 page 重复 goto 相同 hash 不触发 hashchange，DOM 是陈旧的）
 *   · 断言打在**消费方**（按钮的 disabled / 返回链接的 DOM 位置），不打在定义处
 *   · 控制台 error 只在非 /api/* 范围内判定（纯静态托管下 /api/* 恒 404 是已知事实）
 *
 * 用法：NODE_PATH=<managed node_modules> node _probe/live_ui_178.cjs
 */
const { chromium } = require('playwright');

const BASE = process.env.LIVE_BASE || 'https://xiaoting.app.workbuddy.host';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail: String(detail || '') });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

async function newCtx(browser) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-CN',
  });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('moxiaoming:welcomed_v1', '1');
      localStorage.setItem('xiaoting:ai', 'mock');
      localStorage.setItem('monthly:done_' + (new Date().getFullYear() * 100 + (new Date().getMonth() + 1)), '1');
    } catch (e) { /* ignore */ }
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  return { ctx, page, errs };
}
const realErrs = (errs) => errs.filter((e) => !/ERR_FAILED|ERR_ABORTED|api\/|version\.json|favicon|更新检测|cloud|404/i.test(e));

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });

  /* ---------- 场景 1：线上就是 v1.7.8，且周报页有常驻返回 ---------- */
  {
    const { ctx, page, errs } = await newCtx(browser);
    await page.goto(BASE + '/#/say', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.mascot', { timeout: 20000 });
    const ver = await page.evaluate(() => window.APP_VERSION);
    check('线上运行版本 = 1.7.8', ver === '1.7.8', String(ver));

    await page.goto(BASE + '/#/weekly', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.weekly', { timeout: 15000 });
    // 页头必须**在内容区之外**：这样加载慢/生成失败也有出口（这正是 P3 的修法）
    const headInPage = await page.locator('.weekly > .page-head a.ghost[href="#/me"]').count();
    const headInRoot = await page.locator('#weeklyRoot a.ghost[href="#/me"]').count();
    check('线上周报页返回入口存在且在内容区之外', headInPage === 1 && headInRoot === 0,
      `页头=${headInPage} 内容区=${headInRoot}`);
    // 真点一下：必须真的回到「我」页
    await page.click('.weekly > .page-head a.ghost[href="#/me"]');
    await page.waitForSelector('.me', { timeout: 10000 });
    check('线上点返回真的回到「我」页', page.url().includes('#/me'), page.url());

    check('线上场景1 无致命运行时错误', realErrs(errs).length === 0, realErrs(errs).slice(0, 3).join(' | '));
    await ctx.close();
  }

  /* ---------- 场景 2：打字页空输入置灰 / 有内容亮起 ---------- */
  {
    const { ctx, page, errs } = await newCtx(browser);
    await page.goto(BASE + '/#/record?mode=text', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#recInput', { timeout: 15000 });
    check('线上打字页空输入时「说完了」置灰', await page.isDisabled('#recDone'), '');
    await page.fill('#recInput', '   ');
    check('线上只输入空白仍置灰（trim 判空）', await page.isDisabled('#recDone'), '');
    await page.fill('#recInput', '今天下班路上看到一只猫，蹲了很久。');
    check('线上有内容后「说完了」可点', !(await page.isDisabled('#recDone')), '');

    // 真点一下，确认能进分析中页（不是"看起来能点"）
    await page.click('#recDone');
    await page.waitForSelector('.stage-copy', { timeout: 12000 });
    check('线上点「说完了」真的进入分析中页', (await page.locator('.stage-copy').count()) > 0, '');

    check('线上场景2 无致命运行时错误', realErrs(errs).length === 0, realErrs(errs).slice(0, 3).join(' | '));
    await ctx.close();
  }

  /* ---------- 场景 3：安全兜底修法已进线上产物（代码级自证，配合本地 A/B 的行为证据） ---------- */
  {
    const { ctx, page } = await newCtx(browser);
    await page.goto(BASE + '/#/say', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.mascot', { timeout: 20000 });
    const marks = await page.evaluate(async () => {
      const api = await fetch('/js/api.js').then((r) => r.text());
      const app = await fetch('/js/app.js').then((r) => r.text());
      const prompts = await fetch('/js/prompts.js').then((r) => r.text());
      return {
        apiLocalEngine: api.includes('local_engine_after_llm_failed'),
        appConservative: app.includes('conservativeSafetyFallback'),
        appRecDisabled: app.includes('id="recDone" type="button" disabled'),
        appWeeklyHead: app.includes('id="weeklyRoot"><div class="loading"'),
        hoistCount: (prompts.match(/hoistUserInput/g) || []).length,
      };
    });
    check('线上 api.js 含「失败后取本地更保守者」修法', marks.apiLocalEngine, '');
    check('线上 app.js 含 conservativeSafetyFallback', marks.appConservative, '');
    check('线上 app.js 含空输入置灰修法', marks.appRecDisabled, '');
    check('线上 app.js 含周报常驻页头修法', marks.appWeeklyHead, '');
    check('线上 prompts.js 的 hoistUserInput 已随包上线', marks.hoistCount >= 5, String(marks.hoistCount));
    await ctx.close();
  }

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== 线上 L3 UI 真跑：${results.length - failed.length}/${results.length} 通过 ====`);
  if (failed.length) { failed.forEach((f) => console.log('  ✗ ' + f.name + '  ' + f.detail)); process.exit(1); }
})().catch((e) => { console.error('运行异常：', e); process.exit(2); });
