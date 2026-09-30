// 墨小溟 v1.2.1 攻坚 · 左滑返回手势 + 网络降级文案 真跑自测（本机 Chrome）
// 运行：NODE_PATH=<受管 node_modules> node _selftest/swipe-selftest.cjs
// 关键点：自起 server.cjs，用 Playwright pointer 事件真实驱动「左边缘右拖」手势，
//       断言 (1) 子页返回父级 (2) 拖动时 #view 跟手位移(parallax) (3) 首页不误触发
//       (4) 未过阈值回弹 (5) 录音中弹温柔保存提示 (6) 网络降级文案已落地。
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const PORT = 4175; // 避开主自测 4173，互不干扰
const BASE = 'http://127.0.0.1:' + PORT;
const NODE = 'C:\\Users\\Admin\\.workbuddy\\binaries\\node\\versions\\22.22.2-3\\node.exe';
const OUT = path.join(__dirname, 'shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail: String(detail || '') });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

async function waitServer() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return true; } catch (e) { /* retry */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server not up on ' + BASE);
}

(async () => {
  const srv = spawn(NODE, ['server.cjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), STATS_KEY: 'selftest' },
    stdio: 'ignore',
  });
  let browser;
  try {
    await waitServer();
    browser = await chromium.launch({
      channel: 'chrome', headless: true,
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
    });
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'zh-CN', isMobile: true, hasTouch: true,
    });
    const page = await ctx.newPage();
    await ctx.addInitScript(() => { try { localStorage.setItem('xiaoting:ai', 'mock'); localStorage.setItem('moxiaoming:welcomed_v1', '1'); } catch (e) {} });
    const errors = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    const goto = (h) => page.goto(BASE + h, { waitUntil: 'domcontentloaded' });
    const settle = async () => { await page.waitForFunction(() => !document.querySelector('.toast.toast--on'), null, { timeout: 3000 }).catch(() => {}); await page.waitForTimeout(350); };

    // 进首页预热
    await goto('/#/say'); await settle();

    // ---- S1：子页面左滑返回（settings → me），并抓中途 parallax 截图 ----
    await goto('/#/settings'); await settle();
    const before = await page.evaluate(() => location.hash);
    await page.mouse.move(10, 420);
    await page.mouse.down();
    await page.mouse.move(70, 420, { steps: 4 });
    const midTransform = await page.evaluate(() => document.getElementById('view').style.transform || '');
    await page.mouse.move(240, 420, { steps: 8 });
    await page.screenshot({ path: path.join(OUT, 'swipe-mid.png') }); // 证据：跟手位移中间帧
    await page.mouse.up();
    await page.waitForTimeout(550);
    const after = await page.evaluate(() => location.hash);
    check('S1·设置页左滑返回上级（me）', before === '#/settings' && after === '#/me', `before=${before} after=${after}`);
    check('S1·拖动时 #view 产生跟手位移（parallax）', /translateX/.test(midTransform), `midTransform=${midTransform}`);

    // ---- S2：首页级（say）左滑不误触发返回 ----
    await goto('/#/say'); await settle();
    const h0 = await page.evaluate(() => location.hash);
    await page.mouse.move(10, 420); await page.mouse.down();
    await page.mouse.move(240, 420, { steps: 8 }); await page.mouse.up();
    await page.waitForTimeout(350);
    const h1 = await page.evaluate(() => location.hash);
    check('S2·首页级（say）左滑不误触发返回', h0 === '#/say' && h1 === '#/say', `before=${h0} after=${h1}`);

    // ---- S3：未过阈值回弹，不导航 ----
    await goto('/#/settings'); await settle();
    const p0 = await page.evaluate(() => location.hash);
    await page.mouse.move(10, 420); await page.mouse.down();
    await page.mouse.move(45, 420, { steps: 4 }); await page.mouse.up();
    await page.waitForTimeout(450);
    const p1 = await page.evaluate(() => location.hash);
    check('S3·小幅拖动（未过阈值）回弹不导航', p0 === '#/settings' && p1 === '#/settings', `before=${p0} after=${p1}`);

    // ---- S4：录音中左滑弹出温柔保存提示 ----
    await goto('/#/say'); await settle();
    await page.evaluate(async () => { const app = await import('/js/app.js'); app.__test__.rec.active = true; });
    await goto('/#/settings'); await settle();
    await page.mouse.move(10, 420); await page.mouse.down();
    await page.mouse.move(260, 420, { steps: 8 }); await page.mouse.up();
    await page.waitForTimeout(450);
    const hasConfirm = await page.evaluate(() => !!document.querySelector('.gentle-confirm'));
    const confirmMsg = await page.evaluate(() => { const m = document.querySelector('.gentle-confirm__msg'); return m ? m.textContent : ''; });
    check('S4·录音中左滑弹出温柔保存提示', hasConfirm && /正在为你保存这片深海的记忆/.test(confirmMsg), `confirm="${confirmMsg}"`);
    await page.evaluate(async () => { const app = await import('/js/app.js'); const c = document.getElementById('gcCancel'); if (c) c.click(); app.__test__.rec.active = false; });

    // ---- S5：网络降级文案（拦截版本接口 → 触发「深海信号微弱」） ----
    await page.route('**/api/version/history', (r) => r.abort());
    await page.route('**/version.json', (r) => r.abort());
    await goto('/#/changelog'); await settle();
    await page.waitForTimeout(900);
    const clText = await page.evaluate(() => { const el = document.getElementById('clList'); return el ? el.textContent : ''; });
    check('S5·网络失败走降级文案「深海信号微弱，请检查网络再试」', /深海信号微弱，请检查网络再试/.test(clText), `clList="${clText.slice(0, 40)}"`);

    // 排除 S5 故意注入的网络失败（那两条 console.error 正是战役三要验证的"真实错误日志"），
    // 只把"非预期"的运行时错误算作失败。
    const realErrors = errors.filter((e) => !/version\/history|version\.json|ERR_FAILED|更新检测/.test(e));
    check('无运行时错误（排除 S5 故意注入的网络失败）', realErrors.length === 0, realErrors.slice(0, 5).join(' | '));

    const passed = results.filter((r) => r.ok).length;
    console.log(`\n===== 左滑返回 + 网络文案真跑自测：${passed}/${results.length} 通过 =====`);
    if (errors.length) console.log('运行时错误：\n' + errors.join('\n'));
    process.exitCode = passed === results.length ? 0 : 1;
  } catch (e) {
    console.error('测试异常：', e);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    try { srv.kill('SIGTERM'); } catch (e) { /* ignore */ }
  }
})();
