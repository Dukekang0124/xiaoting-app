/**
 * 复现：有卡片 + AI 通道不可用（/api/llm 404，线上静态托管必然如此）→ 周报页是否永远停在 loading。
 * 用法：BASE=http://127.0.0.1:4173 node _selftest/_audit_weekly_20261002.cjs
 */
const { chromium } = require('playwright');
const BASE = (process.env.BASE || 'http://127.0.0.1:4173').replace(/\/$/, '');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext({ viewport: { width: 420, height: 880 } });
  await ctx.addInitScript(() => { try { localStorage.setItem('xiaoting:monthly:done_' + new Date().toISOString().slice(0, 7), String(Date.now())); } catch (e) {} });
  const page = await ctx.newPage();
  const unhandled = [];
  page.on('pageerror', (e) => unhandled.push('PAGEERROR ' + String(e.message).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') unhandled.push('CONSOLE ' + m.text().slice(0, 200)); });
  const clear = () => page.evaluate(() => document.querySelectorAll('.monthly-overlay,.update-overlay,.risk-modal,.gentle-overlay,.welcome-overlay').forEach((e) => e && e.parentNode && e.parentNode.removeChild(e)));
  const settle = async (ms = 500) => { await page.waitForTimeout(ms); await clear(); };

  console.log('===== 步骤1：跑流程生成一张真实卡片 =====');
  await page.goto(BASE + '/#/record?mode=text', { waitUntil: 'domcontentloaded' }); await settle(600);
  await page.evaluate(() => { const t = document.getElementById('recInput'); if (t) { t.value = '被领导当众批评，很憋屈，一句话没敢回。'; t.dispatchEvent(new Event('input', { bubbles: true })); } });
  await settle(240);
  await page.evaluate(() => { const b = document.getElementById('recDone') || document.getElementById('recToggle'); if (b) b.click(); });
  for (let i = 0; i < 26; i++) {
    await page.waitForTimeout(1000);
    const h = await page.evaluate(() => location.hash);
    if (/timeline|cards|risk|say/.test(h) && i > 4) break;
    if (/analyzing|followup|gentle|confirm|timeline/.test(h)) {
      await page.evaluate(() => {
        const ids = ['fuSkip', 'fuSkipTop', 'fuNext', 'gProceed', 'cfKeep', 'cfContinue', 'recToggle', 'recDone', 'tlSave'];
        for (const id of ids) { const e = document.getElementById(id); if (e) { e.click(); return; } }
        const b = [...document.querySelectorAll('#view button')].find((x) => /跳过|继续|先收下|保存|结束倾诉/.test(x.innerText || '')); if (b) b.click();
      });
      await settle(1200);
    }
  }
  const cards = await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('xiaoting:v1') || '{}'); return { cards: (s.user && s.user.cards ? s.user.cards.length : 0), keys: s.user ? Object.keys(s.user) : [] }; });
  console.log(`  卡片数=${cards.cards}，user 字段=[${cards.keys}]`);

  console.log('\n===== 步骤2：进入周报页，观察 20s =====');
  unhandled.length = 0;
  await page.goto(BASE + '/#/weekly', { waitUntil: 'domcontentloaded' });
  await settle(600);
  const marks = [];
  for (let i = 1; i <= 20; i++) {
    await page.waitForTimeout(1000);
    const t = await page.evaluate(() => ((document.getElementById('view') || {}).innerText || '').trim().length);
    if (i % 3 === 0) marks.push(`${i}s:${t}字`);
    if (t > 120) { console.log(`  ⇒ ${i}s 周报渲染出来了（${t} 字）`); break; }
  }
  const finalTxt = await page.evaluate(() => ((document.getElementById('view') || {}).innerText || ''));
  const final = finalTxt.trim().slice(0, 120).replace(/\s+/g, ' ');
  const stuck = finalTxt.trim().length < 120;
  console.log(`  轨迹: ${marks.join(' ')}`);
  console.log(`  最终文本(${finalTxt.trim().length}字): ${final}`);
  console.log(`  未捕获错误: ${JSON.stringify(unhandled.slice(0, 4))}`);
  console.log(`\n  ⇒ 判定: ${stuck ? '❌ 周报页永久停在 loading（AI 通道不可用时无兜底渲染）' : '✅ 能出内容'}`);

  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
