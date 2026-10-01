module.paths.push('C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules');
const { chromium } = require('playwright');
const DEMO = '今天又和男朋友吵架了。';
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN', isMobile: true, hasTouch: true, permissions: ['microphone'] });
  await ctx.addInitScript(() => {
    try { localStorage.setItem('moxiaoming:welcomed_v1', '1'); localStorage.setItem('xiaoting:ai', 'mock'); } catch (e) {}
    window.__native = { startCalls: 0 };
    const fakePlugin = {
      available: async () => ({ available: true }),
      requestPermissions: async () => ({ speechRecognition: 'granted' }),
      addListener: async () => ({ remove: async () => {} }),
      start: async () => { window.__native.startCalls++; return {}; },
      stop: async () => ({}),
    };
    window.Capacitor = { isNativePlatform: () => true, Plugins: { SpeechRecognition: fakePlugin } };
  });
  let asrCalls = 0;
  await ctx.route('**/api/asr', (r) => { asrCalls++; r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, text: DEMO, engine: 'mock', ms: 1 }) }); });
  await ctx.route('https://xiaoting-asr.pages.dev/api/health', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, ai_binding: true }) }));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('[console]', m.text().slice(0, 160)); });
  await page.goto('http://127.0.0.1:4174/#/say', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#talkbtn', { timeout: 10000 });
  const box = await page.locator('#talkbtn').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(1400);
  await page.mouse.up();
  await page.waitForTimeout(1500);
  const out = await page.evaluate(async () => {
    const d = await import('/js/diag.js');
    return d.entries().slice(-14).map((e) => (e.stage + '/' + e.event + ' ' + (e.ok === false ? 'FAIL ' : '') + (e.detail || '')).slice(0, 110));
  });
  console.log('asrCalls=' + asrCalls, 'hash=' + await page.evaluate(() => location.hash));
  out.forEach((l) => console.log('  ', l));
  await browser.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(2); });
