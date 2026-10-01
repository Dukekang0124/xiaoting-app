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
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e && e.message ? e.message : e)));

  console.log('目标：' + BASE);
  await page.goto(BASE + '/#/say', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.welcome-overlay', { timeout: 15000 });

  const v = await page.evaluate(() => window.APP_VERSION || '');
  console.log('线上 APP_VERSION = ' + v);
  if (String(v) !== '1.6.0') throw new Error('线上不是 v1.6.0，是 ' + v + ' ⇒ 证据无效，先查发布');

  const seen = [];
  for (let i = 1; i <= 4; i += 1) {
    seen.push({ i, t: await title(page), b: await body(page) });
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

  const ok = seen.length === 4 && seen.every((s) => s.t && s.b) && greetHit && hasPrivacy >= 4 && !errs.length;
  console.log('\n--- 结果 ---');
  seen.forEach((s) => console.log(`  第 ${s.i} 屏：${s.t} / ${(s.b || '').slice(0, 40)}…`));
  console.log('  问候气泡含「我是墨小溟」：' + (greetHit ? '是' : '否'));
  console.log('  设置页隐私段落数：' + hasPrivacy);
  console.log('  页面异常：' + (errs.length ? errs.join(' | ') : '无'));
  console.log(ok ? '\n==== v1.6.0 线上证据截图：全部到位 ====' : '\n==== ✗ 证据不全，见上方 ====');

  await browser.close();
  process.exit(ok ? 0 : 1);
})();
