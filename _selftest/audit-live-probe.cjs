#!/usr/bin/env node
/**
 * 生产环境真浏览器探针 —— 回答「线上真实用户会遇到什么」
 *
 * 为什么必须用真浏览器：curl 经过本地代理，Host 头可能被改，据此判断「同源校验是否失效」会得出错误结论。
 * 真浏览器发出的请求，Host / Origin / Sec-Fetch-* 都是真实形态，这才是 L3 证据。
 *
 * 只读、零写入：本脚本不对生产做任何写操作，仅发一次 /api/asr 的探测请求（该请求本身也不落库）。
 *
 * 用法：NODE_PATH=... node _selftest/audit-live-probe.cjs
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const LIVE = process.env.LIVE || 'https://xiaoting.app.workbuddy.host';
const lines = [];
const log = (s) => { lines.push(s); console.log(s); };

(async () => {
  log('==============================================');
  log(' 生产环境真浏览器探针');
  log(' 目标：' + LIVE);
  log(' 时间：' + new Date().toISOString());
  log('==============================================');

  const browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();

  const pageErrors = [];
  const consoleErrors = [];
  const http4xx5xx = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('response', (r) => { if (r.status() >= 400) http4xx5xx.push(r.status() + ' ' + r.url()); });

  log('\n--- ① 加载线上首页 ---');
  const resp = await page.goto(LIVE + '/', { waitUntil: 'networkidle', timeout: 60000 }).catch((e) => { log('  goto 失败: ' + e.message); return null; });
  log('  HTTP 状态: ' + (resp ? resp.status() : 'n/a'));

  const info = await page.evaluate(() => ({
    title: document.title,
    appVersion: window.APP_VERSION || null,
    hasBoot: typeof window.boot,
    bodyText: (document.body && document.body.innerText || '').slice(0, 200),
  }));
  log('  <title> = ' + info.title);
  log('  window.APP_VERSION = ' + info.appVersion);
  log('  页面可见文本前 200 字: ' + info.bodyText.replace(/\n+/g, ' | '));

  log('\n--- ② 线上真实请求头形态（同源 POST /api/asr）---');
  const asrProbe = await page.evaluate(async () => {
    const out = {};
    try {
      // 先记录浏览器实际会发的头（用一条同源请求，由 SW/浏览器自行附加）
      const r = await fetch('/api/asr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ speech: 'aGVsbG8=', lang: 'zh' }),
      });
      out.status = r.status;
      out.body = await r.text();
    } catch (e) {
      out.err = String((e && e.message) || e);
    }
    return out;
  });
  log('  POST /api/asr -> HTTP ' + asrProbe.status);
  log('  响应体: ' + asrProbe.body);
  if (asrProbe.err) log('  异常: ' + asrProbe.err);

  log('\n--- ③ 同源 GET /api/health ---');
  const health = await page.evaluate(async () => {
    try { const r = await fetch('/api/health'); return { status: r.status, body: await r.text() }; }
    catch (e) { return { err: String((e && e.message) || e) }; }
  });
  log('  -> HTTP ' + health.status + '  ' + health.body);

  log('\n--- ④ 同源 GET /api/version/latest（更新检查依赖它）---');
  const ver = await page.evaluate(async () => {
    try { const r = await fetch('/api/version/latest', { cache: 'no-store' }); return { status: r.status, body: (await r.text()).slice(0, 200) }; }
    catch (e) { return { err: String((e && e.message) || e) }; }
  });
  log('  -> HTTP ' + ver.status + '  ' + ver.body);

  log('\n--- ⑤ 页面运行期错误 ---');
  log('  pageerror 数 = ' + pageErrors.length);
  pageErrors.slice(0, 5).forEach((e) => log('    · ' + e.slice(0, 160)));
  log('  console.error 数 = ' + consoleErrors.length);
  consoleErrors.slice(0, 5).forEach((e) => log('    · ' + e.slice(0, 160)));
  log('  4xx/5xx 响应数 = ' + http4xx5xx.length);
  http4xx5xx.slice(0, 10).forEach((e) => log('    · ' + e.slice(0, 160)));

  log('\n--- ⑥ 页面渲染是否真的出来了（0.6.0 的最小闭环）---');
  const rendered = await page.evaluate(() => {
    const v = document.getElementById('view');
    return { viewHtmlLen: v ? v.innerHTML.length : -1, hasTabbar: !!document.getElementById('tabbar'), tabbarBtns: document.querySelectorAll('#tabbar button, #tabbar a').length };
  });
  log('  #view innerHTML 长度 = ' + rendered.viewHtmlLen);
  log('  #tabbar 存在 = ' + rendered.hasTabbar + '，按钮数 = ' + rendered.tabbarBtns);

  await browser.close();

  const report = lines.join('\n');
  fs.writeFileSync(path.join(__dirname, 'audit-live-probe.out.txt'), report, 'utf8');
  log('\n已写入 _selftest/audit-live-probe.out.txt');
})().catch((e) => { console.error('探针崩溃：', e); process.exit(2); });
