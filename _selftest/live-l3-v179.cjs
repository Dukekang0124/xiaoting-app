/**
 * 线上（L3）UI 真跑 · v1.7.9。
 *
 * 验的是**发出去的那一份**，不是本地 www/。本项目已多次出现「本地全绿、线上还是旧版」。
 *
 * 判据素养（沿用，逐条都有踩坑来历）：
 *   · 每个场景用**新 context** —— 同一 page 重复 goto 相同 hash 不触发 hashchange，DOM 是陈旧的
 *   · 断言打在**消费方**（按钮行为 / 返回链接的 DOM 位置 / 手势的真实跳转），不打在定义处
 *   · 危险/异常路径的用例不夹带触发词，避免用例自己污染结论
 *   · 手势要有**对照臂**：没有对照臂，"手势恒返回"这种坏实现也能让正手通过
 *
 * 用法：NODE_PATH=<managed node_modules> node _selftest/live-l3-v179.cjs
 */
const { chromium } = require('playwright');

const BASE = process.env.LIVE_BASE || 'https://xiaoting.app.workbuddy.host';
const WANT_VERSION = process.env.WANT_VERSION || '1.7.9';
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
// 静态托管下 /api/* 恒 404 是已知事实，不算缺陷
const realErrs = (errs) => errs.filter((e) => !/ERR_FAILED|ERR_ABORTED|api\/|version\.json|favicon|更新检测|cloud|404/i.test(e));

(async () => {
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || 'chrome', headless: true });

  /* ── 场景 1：线上就是目标版本；周报页有常驻返回；左滑手势真能返回 ── */
  {
    const { ctx, page, errs } = await newCtx(browser);
    await page.goto(BASE + '/#/say', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.mascot', { timeout: 25000 });
    check(`线上运行版本 = ${WANT_VERSION}`, (await page.evaluate(() => window.APP_VERSION)) === WANT_VERSION,
      String(await page.evaluate(() => window.APP_VERSION)));

    await page.goto(BASE + '/#/weekly', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.weekly', { timeout: 20000 });
    const headInPage = await page.locator('.weekly > .page-head a.ghost[href="#/me"]').count();
    const headInRoot = await page.locator('#weeklyRoot a.ghost[href="#/me"]').count();
    check('线上周报页返回入口存在且在内容区之外（异步失败也有出口）',
      headInPage === 1 && headInRoot === 0, `页头=${headInPage} 内容区=${headInRoot}`);

    await page.click('.weekly > .page-head a.ghost[href="#/me"]');
    await page.waitForSelector('.me', { timeout: 12000 });
    check('线上点返回真的回到「我」页', /#\/me/.test(page.url()), page.url());

    // 左滑手势（P3 明确要求）：先回周报页，再从左侧边缘真跑一段 pointer 手势
    await page.goto(BASE + '/#/weekly', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.weekly', { timeout: 20000 });
    await page.waitForTimeout(500);
    const VW = page.viewportSize().width;
    const drag = async (x0) => {
      await page.mouse.move(x0, 430);
      await page.mouse.down();
      for (let x = x0; x <= Math.round(VW * 0.9); x += 36) await page.mouse.move(x, 430);
      await page.mouse.up();
      await page.waitForTimeout(700);
    };
    await drag(8);
    check('线上周报页支持左滑手势返回（边缘起手真跑 → 回到「我」页）',
      /#\/me/.test(page.url()), page.url());

    // 对照臂：中部起手拖同样距离，不许返回
    await page.goto(BASE + '/#/weekly', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.weekly', { timeout: 20000 });
    await page.waitForTimeout(500);
    await drag(Math.round(VW * 0.45));
    check('线上对照臂：屏幕中部起手左滑不触发返回',
      /#\/weekly/.test(page.url()), page.url());

    check('线上场景1 无致命运行时错误', realErrs(errs).length === 0, realErrs(errs).slice(0, 3).join(' | '));
    await ctx.close();
  }

  /* ── 场景 2：打字页「说完了」的三态 + 提交逻辑（P4 需求原文） ── */
  {
    const { ctx, page, errs } = await newCtx(browser);
    await page.goto(BASE + '/#/record?mode=text', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#recInput', { timeout: 20000 });
    const dim = () => page.evaluate(() => document.getElementById('recDone').classList.contains('is-dim'));

    check('线上空输入时「说完了」视觉弱化（且不是 disabled，仍可点）',
      (await dim()) === true && !(await page.isDisabled('#recDone')),
      `dim=${await dim()} disabled=${await page.isDisabled('#recDone')}`);

    // 空输入点击：必须给提示，且不许跳页 —— 「只有空输入的时候才提示」这句的正面证据
    await page.click('#recDone');
    await page.waitForTimeout(250);
    const toast = await page.textContent('.toast--on').catch(() => '');
    check('线上空输入点击 → 提示「还没说话呢」且不跳页',
      toast.includes('还没说话呢') && !/#\/analyzing/.test(page.url()), `toast=「${toast}」 url=${page.url()}`);

    await page.fill('#recInput', '   ');
    check('线上只输入空白仍弱化（trim 判空）', (await dim()) === true, '');
    await page.fill('#recInput', '今天下班路上看到一只猫，蹲在那里看了很久。');
    check('线上有文字后弱化解除（不是永远弱化）', (await dim()) === false, '');

    // 有文字点击：必须直接提交并进分析中页
    await page.click('#recDone');
    await page.waitForSelector('.stage-copy', { timeout: 15000 });
    check('线上有文字点「说完了」直接提交并进入分析中页', (await page.locator('.stage-copy').count()) > 0, '');

    check('线上场景2 无致命运行时错误', realErrs(errs).length === 0, realErrs(errs).slice(0, 3).join(' | '));
    await ctx.close();
  }

  /* ── 场景 3：三处修法在线上产物里逐字存在（配合本地 A/B 的行为证据） ── */
  {
    const { ctx, page } = await newCtx(browser);
    await page.goto(BASE + '/#/say', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.mascot', { timeout: 25000 });
    const m = await page.evaluate(async () => {
      const [api, app, prompts] = await Promise.all(
        ['/js/api.js', '/js/app.js', '/js/prompts.js'].map((u) => fetch(u).then((r) => r.text())));
      return {
        localEngine: api.includes('local_engine_after_llm_failed'),
        conservative: app.includes('conservativeSafetyFallback'),
        isDim: app.includes('is-dim'),
        weeklyHead: app.includes('id="weeklyRoot"><div class="loading"'),
        hoist: (prompts.match(/hoistUserInput/g) || []).length,
      };
    });
    check('线上 api.js 含「失败后取本地更保守者」修法', m.localEngine, '');
    check('线上 app.js 含 conservativeSafetyFallback', m.conservative, '');
    check('线上 app.js 含「空输入弱化而非禁用」修法', m.isDim, '');
    check('线上 app.js 含周报常驻页头修法', m.weeklyHead, '');
    check('线上 prompts.js 的 hoistUserInput 仍在（P1 未被回退）', m.hoist >= 5, String(m.hoist));
    await ctx.close();
  }

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== 线上 L3 UI 真跑（v${WANT_VERSION}）：${results.length - failed.length}/${results.length} 通过 ====`);
  if (failed.length) { failed.forEach((f) => console.log('  ✗ ' + f.name + '  ' + f.detail)); process.exit(1); }
})().catch((e) => { console.error('运行异常：', e); process.exit(2); });
