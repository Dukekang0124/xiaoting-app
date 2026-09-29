// 一次性探针：量首页纵向布局几何，为 §1.2 排版断言定阈值（不猜数字）
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await ctx.addInitScript(() => { try { localStorage.setItem('xiaoting:ai', 'mock'); } catch (e) {} });
  const p = await ctx.newPage();
  await p.goto('http://127.0.0.1:4173/#/say', { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('#talkbtn', { timeout: 15000 });
  const g = await p.evaluate(() => {
    const r = (s) => { const el = document.querySelector(s); if (!el) return null; const b = el.getBoundingClientRect(); return { top: +b.top.toFixed(1), bottom: +b.bottom.toFixed(1), h: +b.height.toFixed(1) }; };
    const cs = (s, prop) => { const el = document.querySelector(s); return el ? getComputedStyle(el)[prop] : null; };
    const mascot = r('.mascot'), btn = r('#talkbtn'), greet = r('.say__greet'), head = r('.say__head'), act = r('.say__action');
    const btnCS = getComputedStyle(document.querySelector('#talkbtn'));
    return {
      head, greet, mascot, btn, act,
      gapHead: mascot && head ? +(mascot.top - head.bottom).toFixed(1) : null,
      gapMascotBtn: mascot && btn ? +(btn.top - mascot.bottom).toFixed(1) : null,
      headMB: cs('.say__head', 'marginBottom'),
      greetMT: cs('.say__greet', 'marginTop'),
      greetMB: cs('.say__greet', 'marginBottom'),
      mascotPad: cs('.say__mascot', 'padding'),
      actGap: cs('.say__action', 'gap'),
      hintMB: cs('.say__hint', 'marginBottom'),
      animName: btnCS.animationName,
      bg: btnCS.backgroundImage,
      bgStops: (btnCS.backgroundImage.match(/rgb\(/g) || []).length,
      hasRadial: /radial-gradient/.test(btnCS.backgroundImage),
      btnTop: btn ? btn.top : null,
      vh: window.innerHeight,
    };
  });
  console.log(JSON.stringify(g, null, 2));
  await b.close();
})();
