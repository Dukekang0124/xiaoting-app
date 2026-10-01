// 审计探针：高危后继续倾诉一轮 → 「结束倾诉」是否仍被阻断（真实链路，非手工 setState）
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:4188';
(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
     try { localStorage.setItem('monthly:done_' + (new Date().getFullYear() * 100 + (new Date().getMonth() + 1)), '1'); } catch (e) {} try { localStorage.setItem('xiaoting:ai', 'mock'); localStorage.setItem('moxiaoming:welcomed_v1', '1'); } catch (e) {} });
  await page.goto(BASE + '/#/say', { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  // 1) 第一轮：命中高危（模拟安全识别置入 risk）
  const r1 = await page.evaluate(async () => {
    const s = await import('/js/store.js');
    s.startSession();
    s.startDraft('最近真的不想活了，想结束一切');
    s.setState({ risk: { level: 'high', action: 'refer', hit: true, evidence: '模拟高危' } });
    return s.getState().risk;
  });
  console.log('第1轮后 risk =', JSON.stringify(r1));

  // 2) 用户从危机页返回，又倾诉了一轮（startDraft 会重建 state）
  const r2 = await page.evaluate(async () => {
    const s = await import('/js/store.js');
    s.startDraft('算了，我还是想说说今天开会的事，有点委屈');
    return { risk: s.getState().risk, sessionLog: (s.getState().sessionLog || []).length };
  });
  console.log('第2轮后 risk =', JSON.stringify(r2.risk), ' sessionLog 条数 =', r2.sessionLog);

  // 3) 点「结束倾诉」看走向
  await page.evaluate(() => { location.hash = '#/me'; });
  await page.waitForTimeout(150);
  await page.evaluate(() => { location.hash = '#/say'; });
  await page.waitForTimeout(400);
  const btn = await page.$('#endVent');
  console.log('首页「结束倾诉」存在 =', !!btn);
  if (btn) await btn.click();
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => ({
    hash: location.hash,
    hasTimeline: !!document.querySelector('.tl-card'),
    hasRisk: !!document.querySelector('.risk'),
    nodes: Array.from(document.querySelectorAll('.tl-node__emo')).map((n) => n.textContent.trim()),
  }));
  console.log('点「结束倾诉」后 =', JSON.stringify(after));
  console.log(after.hash === '#/timeline' ? '❌ 高危会话仍生成了时间线卡（阻断被 startDraft 重置 risk 冲掉）' : '✅ 仍被阻断');
  await browser.close();
})();
