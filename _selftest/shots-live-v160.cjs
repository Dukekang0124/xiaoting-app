// v1.6.0 发版证据截图：对**线上**地址走一遍 4 屏新手引导 + 首条问候 + 设置页隐私说明。
// 与 onboarding-ui.cjs 的区别：那个打本地 http（自测服），这个打真实线上域名，
//   证明「用户打开 https://xiaoting.app.workbuddy.host 看到的就是 v1.6.0 的引导」。
// 用法：NODE_PATH=<受管 workspace>/node_modules node _selftest/shots-live-v160.cjs
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');

const BASE = process.env.LIVE_BASE || 'https://xiaoting.app.workbuddy.host';
const OUT = path.join(__dirname, 'shots-live-v160');
fs.mkdirSync(OUT, { recursive: true });

const shot = async (page, n) => {
  await page.waitForFunction(() => !document.querySelector('.toast.toast--on')).catch(() => {});
  await page.waitForTimeout(420);
  await page.screenshot({ path: path.join(OUT, n), fullPage: false });
  console.log('  📷 ' + n);
};
const title = (p) => p.$eval('.welcome-title', (el) => (el.textContent || '').trim()).catch(() => '');
const body = (p) => p.$eval('.welcome-lines', (el) => (el.textContent || '').trim()).catch(() => '');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  });
  const page = await ctx.newPage();
  // 🔴 为什么要给 /js/* 加破缓存参数：线上托管网关按 (路径, Accept-Encoding) 分桶缓存，
  //    Chrome 走的 br 桶实测仍压着**上一版**的旧体（05:14:49 那次发布的内容），
  //    而 identity / zstd 桶是新的 —— 同一时刻两个桶给出不同版本。
  //    截图证据要取自**源站真身**，所以这里把 /js/* 请求改写为带 ?cb= 的同源地址，
  //    该 URL 从未被缓存过 ⇒ 必然回源（回源结果已用 identity 桶单独复核过 = v1.6.1）。
  const bust = Date.now().toString(36);
  await page.route('**/js/*.js', (route) => {
    const u = route.request().url();
    if (u.includes('?')) return route.continue();
    return route.continue({ url: u + '?cb=' + bust });
  });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e && e.message ? e.message : e)));

  console.log('目标：' + BASE);
  await page.goto(BASE + '/#/say', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.welcome-overlay', { timeout: 15000 });

  const v = await page.evaluate(() => window.APP_VERSION || '');
  // 🔴 判据不能写死版本号：写死了就变成「发新版本时这个探针自己红」，
  //    排查时会被误导成"发布失败"，实际只是脚本没跟上。改从本地 SSOT（index.html）读。
  const localV = (require('node:fs').readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')
    .match(/APP_VERSION\s*=\s*'([\d.]+(-RC)?)'/) || [])[1];
  console.log('线上 APP_VERSION = ' + v + '　本地版本 = ' + localV);
  if (String(v) !== localV) throw new Error('线上是 ' + v + '、本地是 ' + localV + ' ⇒ 证据无效，先查发布');

  const seen = [];
  for (let i = 1; i <= 4; i += 1) {
    // 徽标 + 标题要**同屏**取：v1.6.0 第 3 屏是「徽标=重要提醒 / 标题=重要提醒」的重复，
    // 只在结束之后回头查是查不到的（那时浮层已经拆了）。
    const badge = await page.$eval('.welcome-badge', (el) => (el.textContent || '').trim()).catch(() => '');
    seen.push({ i, badge, t: await title(page), b: await body(page) });
    await shot(page, `0${i}-live-welcome-${i}.png`);
    if (i < 4) {
      // 🔴 只能点 #wNext：.welcome-btns 里是「上一屏/先跳过」两个 .linkbtn，
      //    按 button 取第一个会点到「先跳过」⇒ 引导直接结束（第一次跑就栽在这）。
      await page.evaluate(() => {
        const b = document.getElementById('wNext');
        if (b) b.click();
      });
      await page.waitForTimeout(320);
    }
  }

  // 最后一屏点「开始体验」→ 应自动弹出首条问候气泡（不是 toast）
  await page.evaluate(() => {
    const b = document.getElementById('wNext');
    if (b) b.click();
  });
  await page.waitForTimeout(700);
  await page.waitForSelector('.welcome-overlay', { state: 'detached', timeout: 8000 }).catch(() => {});
  const greet = await page
    .$$eval('.convo, .bubble, .msg', (ns) => ns.map((n) => (n.textContent || '').trim()))
    .catch(() => []);
  await shot(page, '05-live-greet.png');
  const greetHit = greet.some((s) => s.includes('我是墨小溟'));

  // 设置页隐私说明
  // 🔴 换页要走 hash（SPA 里点 tab 也可能不重载，这里直接 hash + 等渲染）
  await page.evaluate(() => { location.hash = '#/settings'; });
  await page.waitForSelector('.privacy-box', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(600);
  const hasPrivacy = await page.$$eval('.privacy__line', (n) => n.length).catch(() => 0);
  await shot(page, '06-live-settings-privacy.png');

  const s3ok = seen[2] || {};
  const ok = seen.length === 4 && seen.every((x) => x.t && x.b) && greetHit && hasPrivacy >= 4 &&
    !!(s3ok.badge && s3ok.t && s3ok.badge !== s3ok.t) && !errs.length;
  console.log('\n--- 结果 ---');
  seen.forEach((s) => console.log(`  第 ${s.i} 屏：${s.badge ? '[' + s.badge + '] ' : ''}${s.t} / ${(s.b || '').slice(0, 40)}…`));
  const s3 = seen[2] || {};
  console.log('  第 3 屏徽标与标题不同文：' +
    ((s3.badge && s3.t && s3.badge !== s3.t) ? '是' : '否（' + s3.badge + ' / ' + s3.t + '）'));
  console.log('  问候气泡含「我是墨小溟」：' + (greetHit ? '是' : '否'));
  console.log('  设置页隐私段落数：' + hasPrivacy);
  console.log('  页面异常：' + (errs.length ? errs.join(' | ') : '无'));
  console.log(ok ? '\n==== 线上证据截图（' + localV + '）：全部到位 ====' : '\n==== ✗ 证据不全，见上方 ====');

  await browser.close();
  process.exit(ok ? 0 : 1);
})();
