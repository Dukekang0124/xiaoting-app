// v1.1.1 验收截图：时间线卡片（已保存态）+ 我的页入口 + 列表页 + 导出的 PNG 本体
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const BASE = process.env.BASE || 'http://127.0.0.1:4174';
const OUT = path.join(__dirname, 'shots');
const DL = path.join(__dirname, 'shots', 'export');
if (!fs.existsSync(DL)) fs.mkdirSync(DL, { recursive: true });

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'zh-CN',
    isMobile: true, hasTouch: true, acceptDownloads: true, serviceWorkers: 'block',
  });
  const page = await ctx.newPage();
  await ctx.addInitScript(() => { try { localStorage.setItem('xiaoting:ai', 'mock'); localStorage.setItem('moxiaoming:welcomed_v1', '1'); } catch (e) {} });
  const settle = async (ms = 950) => {
    await page.waitForFunction(() => !document.querySelector('.toast.toast--on'), null, { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(ms);
  };
  const shot = async (n) => {
    await settle();
    await page.evaluate(() => {
      let s = document.getElementById('__shotfix');
      if (!s) { s = document.createElement('style'); s.id = '__shotfix'; document.head.appendChild(s); }
      s.textContent = '.tabbar{position:static !important;margin:0 !important;width:100% !important}.view{padding-bottom:22px !important}.toast{display:none !important}';
    });
    await page.waitForTimeout(90);
    await page.screenshot({ path: path.join(OUT, n), fullPage: true });
    await page.evaluate(() => { const s = document.getElementById('__shotfix'); if (s) s.remove(); });
  };

  await page.goto(BASE + '/#/say', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#sayInput, .talkbtn', { timeout: 9000 });

  await page.evaluate(async () => {
    const s = await import('/js/store.js');
    s.startSession();
    s.startDraft('今天他升职了，我真的很开心，为他高兴');
    s.startDraft('结果他连一句谢谢都没说，我觉得好委屈');
    s.startDraft('后来他还把活都推给我，我越想越愤怒');
  });
  await page.evaluate(() => { location.hash = '#/me'; });
  await page.waitForTimeout(200);
  await page.evaluate(() => { location.hash = '#/say'; });
  await page.waitForSelector('#endVent', { timeout: 9000 });
  await page.click('#endVent');
  await page.waitForSelector('.tl-card', { timeout: 15000 });
  await shot('v111-timeline-card.png');

  await page.click('#tlSave');
  await page.waitForTimeout(600);
  await shot('v111-timeline-saved.png');       // 按钮变「已保存 ✓」+ 出现「保存为图片」

  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    page.click('#tlExport'),
  ]);
  const p = path.join(DL, 'v111-timeline-export.png');
  await dl.saveAs(p);
  console.log('导出图片已保存：', p, fs.statSync(p).size, 'bytes');

  await page.evaluate(() => { location.hash = '#/me'; });
  await page.waitForTimeout(400);
  await shot('v111-me-entry.png');

  await page.click('.mrow--timelines');
  await page.waitForSelector('.tlrow', { timeout: 9000 });
  await shot('v111-timeline-list.png');

  await page.click('.tlrow');
  await page.waitForSelector('.tl-card', { timeout: 9000 });
  await shot('v111-timeline-revisit.png');

  await browser.close();
})();
