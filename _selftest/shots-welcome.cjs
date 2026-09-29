// 专抓「首次欢迎弹窗」截图。干净的首次访问上下文（不预置 welcomed 标记），
// 进 say 页即触发 showWelcome()，等 .welcome-overlay 出现后截图，用于交付物。
const { chromium } = require('playwright-core');
const path = require('path');

const BASE = process.env.BASE || 'http://127.0.0.1:4173';
const OUT = path.join(__dirname, 'shots');

(async () => {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  // 干净上下文：不设 welcomed 标记，首次访问必弹欢迎层
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    locale: 'zh-CN',
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  await page.goto(BASE + '/#/say', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.welcome-overlay', { timeout: 8000 });
  await page.waitForTimeout(300); // 等 IP 动效稳定
  await page.screenshot({ path: path.join(OUT, '01-welcome.png'), fullPage: true });
  console.log('welcome shot saved ->', path.join(OUT, '01-welcome.png'));
  await browser.close();
})().catch((e) => { console.error('welcome shot failed:', e); process.exit(1); });
