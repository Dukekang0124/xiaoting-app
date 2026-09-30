/**
 * 探针：真实用户「首屏」（第一次打开）到底看到哪一版？
 *
 * 为什么需要它：
 *   L3 校验里 curl/HTTP 层的判断会被网关「按 Accept-Encoding 分桶缓存」污染，
 *   而真浏览器自身也有 HTTP 缓存 + Service Worker 两层。
 *   要回答「新用户打开根域名看到什么」，唯一可信的做法是：
 *   全新 browser context（空缓存、空 SW）→ goto 根域名（裸 URL，不带 ?cb=）→ 读页面内版本。
 *
 * 判据（三条互相独立，缺一条就可能被缓存骗过）：
 *   ① index.html 里 APP_VERSION          → 首屏 HTML 是哪一版
 *   ② 运行时实际加载的 /js/app.js 版本    → 脚本是哪一版（HTML 旧 + 脚本新 = 半旧半新，更危险）
 *   ③ sw.js 的 CACHE 名                   → 老用户续期路径指向哪一版
 * 输出：console + _selftest/shots/probe-first-paint.png
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'https://xiaoting.app.workbuddy.host';
const SHOTS = path.join(__dirname, 'shots');
const EXPECT = process.env.EXPECT || '1.3.5';
let pass = 0;
let fail = 0;
const rows = [];

function check(name, ok, detail) {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  rows.push({ name, ok, detail });
}

(async () => {
  if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  // 关键：全新 context = 空 HTTP 缓存、无 Service Worker、无 localStorage
  const ctx = await browser.newContext({
    viewport: { width: 430, height: 932 },
    deviceScaleFactor: 2,
    bypassCSP: true,
    serviceWorkers: 'block', // 先阻断 SW，量纯网络首屏
  });
  const page = await ctx.newPage();

  const netLog = [];
  page.on('response', async (res) => {
    const u = res.url();
    if (u.startsWith(BASE)) {
      const h = res.headers();
      netLog.push({
        url: u.replace(BASE, ''),
        status: res.status(),
        lm: h['last-modified'] || '',
        age: h['age'] || '',
        cache: h['cache-control'] || '',
        enc: h['content-encoding'] || '',
      });
    }
  });

  console.log(`目标：${BASE}   期望版本：${EXPECT}`);
  console.log('='.repeat(60));

  // ① 首屏 HTML（裸 URL，模拟用户在地址栏敲域名）
  const html = await (await ctx.request.get(`${BASE}/`)).text();
  const htmlVer = (html.match(/APP_VERSION\s*=\s*['"]([^'"]+)/) || [])[1] ||
    (html.match(/"version"\s*:\s*"([^"]+)"/) || [])[1] || '(未找到)';
  const htmlHasPatch = /replayIpColors/.test(html);
  check(`首屏 HTML 版本 == ${EXPECT}`, htmlVer === EXPECT, `拿到 ${htmlVer}`);

  // ② 裸路径拿 app.js（和浏览器同一条网络路径）
  const appjs = await (await ctx.request.get(`${BASE}/js/app.js`)).text();
  const appHasPatch = /replayIpColors/.test(appjs);
  const appHasIdle = /scheduleIdleRevert/.test(appjs);
  check('首屏 /js/app.js 含本版特征串（replayIpColors + scheduleIdleRevert）',
    appHasPatch && appHasIdle, `replayIpColors=${appHasPatch} scheduleIdleRevert=${appHasIdle}`);

  const swjs = await (await ctx.request.get(`${BASE}/sw.js`)).text();
  const swCache = (swjs.match(/CACHE\s*=\s*['"]([^'"]+)/) || [])[1] || '(未找到)';
  check(`首屏 /sw.js CACHE == xiaoting-v${EXPECT}`, swCache === `xiaoting-v${EXPECT}`, `拿到 ${swCache}`);

  console.log('-'.repeat(60));
  console.log('真浏览器渲染（全新 context，无缓存无 SW）');
  await page.goto(`${BASE}/`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(2500);

  const runtime = await page.evaluate(() => {
    const out = {};
    try {
      out.title = document.title;
      // 版本可能挂在多处，全查一遍
      out.windowVersion = window.APP_VERSION || window.__APP_VERSION__ || null;
      const meta = document.querySelector('meta[name="app-version"]');
      out.metaVersion = meta ? meta.getAttribute('content') : null;
      out.bodyLen = document.body ? document.body.innerHTML.length : 0;
      out.hasIp = !!document.querySelector('.mascot');
      out.scripts = Array.from(document.querySelectorAll('script[src]')).map((s) => s.getAttribute('src'));
    } catch (e) { out.err = String(e); }
    return out;
  });
  console.log('  运行时：', JSON.stringify(runtime));

  const rtHtmlVer = await page.evaluate(() => {
    const t = document.documentElement.innerHTML;
    const m = t.match(/APP_VERSION\s*=\s*['"]([^'"]+)/);
    return m ? m[1] : null;
  });
  check(`真浏览器首屏 APP_VERSION == ${EXPECT}`,
    rtHtmlVer === EXPECT, `拿到 ${rtHtmlVer}`);

  // 真浏览器里实际执行的是哪一版 app.js：从已加载模块拿特征（import 走浏览器缓存）
  const rtPatch = await page.evaluate(async () => {
    try {
      const m = await import('/js/app.js');
      const src = m && (m.__test__ ? 'has_test_export' : 'no_test_export');
      return src;
    } catch (e) { return 'err:' + String(e).slice(0, 80); }
  });
  console.log('  模块导出：', rtPatch);

  await page.screenshot({ path: path.join(SHOTS, 'probe-first-paint.png') });
  console.log(`  截图：_selftest/shots/probe-first-paint.png`);

  console.log('-'.repeat(60));
  console.log('首屏网络日志（last-modified / age 是判「缓存还是源」的硬证据）');
  netLog.slice(0, 14).forEach((r) => {
    console.log(`  ${String(r.status).padEnd(4)} ${r.url.padEnd(34)} lm=${r.lm} age=${r.age || '-'} enc=${r.enc || '-'}`);
  });

  const stale = netLog.filter((r) => r.lm && !r.lm.includes('12:') && r.lm.includes('09:05:39'));
  if (stale.length) {
    console.log('-'.repeat(60));
    console.log(`⚠ ${stale.length} 个资源仍来自 09:05:39 的旧快照（网关 br 桶缓存）：`);
    stale.forEach((r) => console.log(`   ${r.url}  age=${r.age}`));
  }

  console.log('='.repeat(60));
  console.log(`首屏探针：${pass}/${pass + fail} 通过`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('探针异常：', e);
  process.exit(2);
});
