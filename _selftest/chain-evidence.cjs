// 墨小溟 · 「真实数据流」取证脚本（v1.1.3）
//
// 目的：把「用户语音 → ASR → 安全识别 → 主分析 → 追问 → 卡片」这条链路**真跑一遍**，
// 并把 js/diag.js 记下的每一条带时间戳的日志原样打印出来 —— 用来回答
// 「AI 到底有没有真的调用，还是前端在假装转圈」。
//
// 为什么必须跑在线上域名：云服务按 Origin 放行（虽然实测对 localhost 也放行，但为了保证与线上一致），
// 且「静态资源换成本地磁盘」能保证跑的是**本次新代码**而不是线上旧缓存。
//
// 运行：NODE_PATH=<managed-node-workspace>/node_modules node _selftest/chain-evidence.cjs
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.LIVE || 'https://xiaoting.app.workbuddy.host';
const OUT = path.join(__dirname, 'shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
};

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'zh-CN', isMobile: true, hasTouch: true,
    serviceWorkers: 'block',
  });
  const served = new Set();
  await ctx.route(`${BASE}/**`, async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.startsWith('/.cloud/')) return route.continue();
    if (u.pathname.startsWith('/api/')) {
      if (u.pathname === '/api/health') return route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: '{"ok":true,"version":"0.0.0-nobackend","asr":"unconfigured"}' });
      if (u.pathname === '/api/events') return route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: '{"ok":true,"stored":0,"persisted":false}' });
      return route.fulfill({ status: 503, contentType: 'application/json; charset=utf-8', body: '{"ok":false,"error":"asr_not_configured"}' });
    }
    const rel = u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname).replace(/^\/+/, '');
    const f = path.join(ROOT, rel);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return route.continue();
    served.add(rel);
    return route.fulfill({ status: 200, contentType: MIME[path.extname(f)] || 'application/octet-stream', headers: { 'Cache-Control': 'no-store' }, body: fs.readFileSync(f) });
  });

  const page = await ctx.newPage();
  const consoleLines = [];
  page.on('console', (m) => { const t = m.text(); if (t.includes('墨小溟·diag')) consoleLines.push(t); });
  page.on('pageerror', (e) => console.error('PAGEERROR:', e.message));

  await page.goto(BASE + '/#/say', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#talkbtn', { timeout: 30000 });
  // 首访欢迎弹窗会盖住整页挡点击（真机上用户点一下就没了），这里先关掉
  const welcomeBtn = await page.$('#welcomeStart');
  if (welcomeBtn) { await welcomeBtn.click(); await page.waitForTimeout(300); }

  const ver = await page.evaluate(() => window.APP_VERSION);
  console.log(`页面版本 = v${ver}（本地 index.html = ${(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').match(/APP_VERSION\s*=\s*'([\d.]+)'/) || [])[1]}）`);
  console.log(`本地回填的资源：${Array.from(served).sort().join(', ')}`);

  // 走诊断页的「跑一次真实链路」按钮 —— 顺带验证这个页面在真环境下真的能点、真的能出结果
  await page.goto(BASE + '/#/diag', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#diagRun', { timeout: 30000 });
  console.log('\n=== 点击「用「我今天很烦。」跑一次真实链路」 ===\n');
  const t0 = Date.now();
  await page.click('#diagRun');
  await page.waitForFunction(() => {
    const el = document.getElementById('diagStage');
    return el && el.textContent === '完成';
  }, { timeout: 180000 });
  const totalMs = Date.now() - t0;
  console.log(`整条链路真实耗时：${totalMs}ms（${(totalMs / 1000).toFixed(1)}s）\n`);

  const logText = await page.evaluate(async () => {
    const d = await import('/js/diag.js');
    return d.text();
  });
  console.log('========== 链路诊断日志（原样输出）==========');
  console.log(logText);
  console.log('========== 日志结束 ==========\n');

  console.log(`=== 控制台 [墨小溟·diag] 输出（${consoleLines.length} 条，真机上可用 adb logcat 抓）===`);
  consoleLines.forEach((l) => console.log('  ' + l));

  const summary = await page.evaluate(async () => {
    const d = await import('/js/diag.js');
    return { sum: d.summary(), env: d.environment() };
  });
  console.log('\n=== 各阶段汇总 ===');
  summary.sum.forEach((s) => console.log(`  ${s.stage.padEnd(8)} ${s.calls} 次  成功 ${s.ok}  失败 ${s.fail}  均值 ${Math.round(s.ms / s.calls)}ms  峰值 ${s.maxMs}ms  模型 ${Object.keys(s.models).join('/') || '-'}`));
  console.log('  环境：' + JSON.stringify(summary.env));

  const outFile = path.join(ROOT, '_selftest', 'chain-evidence.txt');
  fs.writeFileSync(outFile, logText + '\n\n耗时：' + totalMs + 'ms\n', 'utf8');
  console.log('\n日志已写入：' + outFile);

  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT, '26-diag-page.png'), fullPage: true });

  await browser.close();
})().catch((e) => { console.error('运行异常：', e); process.exit(2); });
