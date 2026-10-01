module.paths.push('C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules');
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('[console]', m.text().slice(0, 120)); });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 120)));
  await page.goto('http://127.0.0.1:4174/#/changelog', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#clList', { timeout: 8000 });
  await page.waitForTimeout(2500);
  const out = await page.evaluate(async () => {
    const u = await import('/js/update.js');
    let hist = null, histErr = '';
    try { hist = await u.fetchHistory(); } catch (e) { histErr = String(e.message).slice(0, 160); }
    return {
      items: document.querySelectorAll('#clList .cl-item').length,
      html: document.getElementById('clList').innerHTML.slice(0, 120),
      histLatest: hist && hist.latest_version,
      histLen: hist && hist.versions.length,
      histErr,
    };
  });
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(2); });
