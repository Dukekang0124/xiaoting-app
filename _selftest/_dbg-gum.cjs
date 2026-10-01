module.paths.push('C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules');
const { chromium } = require('playwright');
(async () => {
  for (const withBridge of [false, true]) {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN', isMobile: true, hasTouch: true, permissions: ['microphone'] });
    if (withBridge) {
      await ctx.addInitScript(() => {
        window.Capacitor = { isNativePlatform: () => true, Plugins: { SpeechRecognition: { available: async () => ({ available: true }) } } };
      });
    }
    const page = await ctx.newPage();
    await page.goto('http://127.0.0.1:4174/', { waitUntil: 'domcontentloaded' });
    const r = await page.evaluate(async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        const n = s.getAudioTracks().length;
        s.getTracks().forEach((t) => t.stop());
        return { ok: true, tracks: n };
      } catch (e) { return { ok: false, name: e.name, msg: String(e.message).slice(0, 80) }; }
    });
    console.log('bridge=' + withBridge, JSON.stringify(r));
    await browser.close();
  }
})();
