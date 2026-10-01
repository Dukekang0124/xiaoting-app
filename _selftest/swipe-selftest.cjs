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
  // 🔴 防呆（v1.6.3）：端口上若已有**上一轮残留**的 server.cjs，spawn 的新实例会以 EADDRINUSE 静默退出
  //    （本脚本 stdio:'ignore'，错误压根看不见），而 waitServer 会跟那个**旧进程**握手成功 ⇒
  //    整轮自测跑在旧代码上。v1.6.3 就栽在这：新 server.cjs 的 PUBLIC_FILES 已放行
  //    /moxiaoming_motion_sound_config.json，但因为跑在 v1.6.2 的旧服务上，该路径 404 ⇒ 假红，
  //    看着像产品回归，其实只是测的环境是旧的。「服务没了」的假红人尽皆知，
  //    「跑在旧服务上」的假红同样坑——必须先确认端口是空的再 spawn。
  try {
    const occupied = await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(900) });
    if (occupied.ok) {
      console.error(`\n端口 ${PORT} 上已经有一个 server.cjs 在跑（多半是上一轮的残留进程）。`);
      console.error('请先清掉它再重跑：netstat -ano | findstr :' + PORT);
      console.error('否则本轮测的是旧代码，断言结果不作数。\n');
      process.exit(2);
    }
  } catch (e) { /* 连不上 = 端口空着，正常路径 */ }

  const srv = spawn(NODE, ['server.cjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), STATS_KEY: 'selftest' },
    stdio: 'ignore',
    detached: true, // 独立进程组：进程树里不止 node 自己时也能整组带走
  });
  let srvKilled = false;
  const killSrv = () => {
    if (srvKilled) return; srvKilled = true;
    try { process.kill(-srv.pid, 'SIGKILL'); } catch (e) { try { srv.kill('SIGKILL'); } catch (e2) { /* ignore */ } }
  };
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
    await ctx.addInitScript(() => {
       try { localStorage.setItem('monthly:done_' + (new Date().getFullYear() * 100 + (new Date().getMonth() + 1)), '1'); } catch (e) {} try { localStorage.setItem('xiaoting:ai', 'mock'); localStorage.setItem('moxiaoming:welcomed_v1', '1'); } catch (e) {} });
    const errors = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    // 🔴 补一条带 URL 的 404 记录：console 那条「Failed to load resource: ... 404」**文本里不含路径**，
    //    光看它分不清是 /api/*（静态托管本来就没后端，已知 404）还是真缺了某个静态资源。
    page.on('response', (r) => { if (r.status() === 404) errors.push(`404: ${r.url()} | fromSW=${r.fromServiceWorker()} | type=${r.request().resourceType()} | method=${r.request().method()}`); });
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
    // 🔴 尾部星号不能省：update.js 给每个清单请求都加了 ?cb=时间戳，实测
    //    `**/version.json` 这种结尾锚定的通配**匹配不到带 query 的 URL**（命中 0 次），
    //    abort 静默失效 ⇒「网络失败」场景根本没发生 ⇒ 读到的是真历史 ⇒ 断言永远红。
    //    同坑见 _selftest/update-apk-abi.cjs:214（本轮一并修掉）。
    await page.route('**/api/version/history*', (r) => r.abort());
    await page.route('**/version.json*', (r) => r.abort());
    await page.route('**/version-latest.js*', (r) => r.abort());
    // 🔴 必须真重载：page.goto 只改 hash 不重载页面（见 store 持久化那条老坑），
    //    前面几节已经把清单读进 update.js 的内存里 ⇒ 不重载的话 S5 走的还是缓存，
    //    网络断不断都渲染同一份历史，断言同样永远不会绿。
    //    注意顺序：先 goto 到 changelog 把 hash 落定，再 reload —— 直接 reload 会重载上一个页面。
    await goto('/#/changelog');
    await page.reload({ waitUntil: 'domcontentloaded' }); await settle();
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
    killSrv();
    // 必须显式退出：detached 子进程 + Playwright 句柄会让事件循环拎不清，
    // 用例早跑完了进程还挂着 —— 下一次跑就撞上端口占用（上面的防呆会直接拦下）。
    process.exit(process.exitCode || 1);
  }
})();
