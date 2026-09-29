// A/B 对照：证明 §1.1 视觉断言「真的会抓到回归」，而不是永远为真
// A = 现状样式；B = 注入覆盖，把按钮打回「纯色 + 无光晕」（模拟被改回扁平色块的回归）
const { chromium } = require('playwright');

const measure = async (page) => page.evaluate(() => {
  const b = document.querySelector('#talkbtn');
  const cs = getComputedStyle(b);
  const mascotR = document.querySelector('.mascot').getBoundingClientRect();
  const btnR = b.getBoundingClientRect();
  return {
    animName: cs.animationName,
    bgStops: (cs.backgroundImage.match(/rgb\(/g) || []).length,
    hasRadial: /radial-gradient/.test(cs.backgroundImage),
    gapMascotBtn: +(btnR.top - mascotR.bottom).toFixed(1),
  };
});

const judge = (m) => ({
  '§1.1 待机光晕': String(m.animName).includes('btn-halo'),
  '§1.1 三段渐变': m.bgStops >= 3,
  '§1.1 高光层': m.hasRadial,
  '§1.2 IP贴合': m.gapMascotBtn <= 12,
});

(async () => {
  const b = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await ctx.addInitScript(() => { try { localStorage.setItem('xiaoting:ai', 'mock'); } catch (e) {} });
  const p = await ctx.newPage();
  await p.goto('http://127.0.0.1:4173/#/say', { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('#talkbtn', { timeout: 15000 });

  const A = judge(await measure(p));
  await p.addStyleTag({ content: '.talkbtn{background:#B8A9E8 !important;animation:none !important;box-shadow:none !important;margin-top:60px !important}' });
  await p.waitForTimeout(150);
  const B = judge(await measure(p));

  console.log('\n断言项                      A(现状)   B(打回扁平色块)   是否具备鉴别力');
  let sensitive = 0;
  for (const k of Object.keys(A)) {
    const s = A[k] === true && B[k] === false;
    if (s) sensitive++;
    console.log(`  ${k.padEnd(22)} ${String(A[k]).padEnd(9)} ${String(B[k]).padEnd(17)} ${s ? '✓ 会 FAIL' : '✗ 无鉴别力'}`);
  }
  console.log(`\nA/B 结论：${sensitive}/${Object.keys(A).length} 条断言在回归时会真的报错`);
  await b.close();
  process.exit(sensitive === Object.keys(A).length ? 0 : 1);
})();
