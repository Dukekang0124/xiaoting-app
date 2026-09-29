// v1.1.0 时间线模块「遗漏与问题」专项审计（只读探测，不断言修复）
// 运行：NODE_PATH=<managed>/node_modules BASE=http://127.0.0.1:4188 node _selftest/audit-timeline.cjs
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const BASE = process.env.BASE || 'http://127.0.0.1:4188';
const OUT = path.join(__dirname, 'shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const lines = [];
const say = (t) => { lines.push(t); console.log(t); };

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => say('  [pageerror] ' + e.message));
  await page.addInitScript(() => {
    try {
      localStorage.setItem('xiaoting:ai', 'mock');
      localStorage.setItem('moxiaoming:welcomed_v1', '1');
    } catch (e) {}
  });

  await page.goto(BASE + '/#/say', { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  // ---- 造 3 段情绪会话（开心 → 委屈 → 愤怒）----
  const seed = async (text) => {
    await page.evaluate((t) => {
      const el = document.querySelector('#sayInput') || document.querySelector('textarea');
      if (el) { el.value = t; el.dispatchEvent(new Event('input', { bubbles: true })); }
    }, text);
    const done = await page.$('#sayDone') || await page.$('#recDone') || await page.$('.primary');
    if (done) await done.click();
    await page.waitForTimeout(1200);
  };
  // 直接走 store 更快更稳
  await page.evaluate(async () => {
    const s = await import('/js/store.js');
    s.startSession();
    s.startDraft('今天他升职了，我真的很开心，为他高兴');
    s.startDraft('结果他连一句谢谢都没说，我觉得好委屈');
    s.startDraft('后来他还把活都推给我，我越想越愤怒');
  });
  // 用 SPA hash 跳转触发重渲染（不 reload，否则 store 内存态丢失）
  await page.evaluate(() => { location.hash = '#/me'; });
  await page.waitForTimeout(200);
  await page.evaluate(() => { location.hash = '#/say'; });
  await page.waitForTimeout(600);

  say('=== A. 「结束倾诉」入口 ===');
  const hasEnd = await page.$('#endVent');
  say('  首页存在 #endVent（结束倾诉）：' + !!hasEnd);
  if (hasEnd) await hasEnd.click();
  await page.waitForTimeout(1500);
  say('  当前路由：' + (await page.evaluate(() => location.hash)));
  const nodes = await page.evaluate(() => {
    const t = document.querySelector('.tl-node__emo');
    return Array.from(document.querySelectorAll('.tl-node__emo')).map((n) => n.textContent.trim());
  });
  say('  时间线节点情绪：' + JSON.stringify(nodes));
  const summary = await page.evaluate(() => (document.querySelector('.tl-summary') || {}).textContent || '');
  say('  小结：' + summary.slice(0, 80));

  say('=== B. 保存按钮：是否真的能「保存为图片」===');
  const saveTxt = await page.evaluate(() => (document.querySelector('#tlSave') || {}).textContent || '');
  say('  按钮文案：' + saveTxt);
  const hasCanvas = await page.evaluate(() => !!document.querySelector('canvas'));
  say('  页面存在 canvas（截图导出能力）：' + hasCanvas);
  const hasExport = await page.evaluate(async () => {
    try {
      const m = await import('/js/app.js');
      const api = await import('/js/api.js');
      return { appKeys: Object.keys(m).filter((k) => /export|png|image|shot|canvas/i.test(k)), apiKeys: Object.keys(api.api || {}) };
    } catch (e) { return { err: String(e) }; }
  });
  say('  导出相关导出符号：' + JSON.stringify(hasExport));

  say('=== C. 重复点击「保存卡片」是否去重 ===');
  const before = await page.evaluate(async () => { const s = await import('/js/store.js'); return (s.getState().timelines || []).length; });
  await page.click('#tlSave'); await page.waitForTimeout(300);
  await page.click('#tlSave'); await page.waitForTimeout(300);
  await page.click('#tlSave'); await page.waitForTimeout(300);
  const after = await page.evaluate(async () => { const s = await import('/js/store.js'); return (s.getState().timelines || []).length; });
  say(`  timelines 条数：点击前 ${before} → 连点3次后 ${after}（无去重则 = before+3）`);
  const btnState = await page.evaluate(() => {
    const b = document.querySelector('#tlSave');
    return b ? { text: b.textContent.trim(), disabled: b.disabled, cls: b.className } : null;
  });
  say('  点击后按钮状态：' + JSON.stringify(btnState) + '（若仍是「保存卡片」且可点 → 用户无从得知已保存）');

  say('=== D. 已保存的时间线：有没有回看入口 ===');
  const entries = await page.evaluate(() => {
    const txt = document.body.innerText;
    return {
      hasTimelineWord: /时间线|深海情绪记录/.test(txt),
      navItems: Array.from(document.querySelectorAll('.tabbar a, .tabbar button')).map((n) => n.textContent.trim()),
    };
  });
  say('  底部导航项：' + JSON.stringify(entries.navItems));
  await page.goto(BASE + '/#/cards', { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  const cardsPage = await page.evaluate(() => document.body.innerText.slice(0, 300));
  say('  卡片列表页首屏文本：' + JSON.stringify(cardsPage.replace(/\n+/g, ' | ').slice(0, 200)));
  await page.goto(BASE + '/#/me', { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  const mePage = await page.evaluate(() => Array.from(document.querySelectorAll('a,button')).map((n) => n.textContent.trim()).filter(Boolean));
  say('  「我的」页可点项：' + JSON.stringify(mePage));
  const ls = await page.evaluate(() => {
    try { const d = JSON.parse(localStorage.getItem('xiaoting:v1') || '{}'); return { timelines: (d.timelines || []).length, cards: (d.cards || []).length }; } catch (e) { return { err: String(e) }; }
  });
  say('  localStorage 实际存量：' + JSON.stringify(ls) + '（有数据但无入口 ⇒ 只写不读死数据）');

  say('=== E. 刷新后「结束倾诉」是否还在（真 reload）===');
  await page.goto(BASE + '/#/say');
  await page.waitForTimeout(200);
  await page.reload({ waitUntil: 'networkidle' });   // 注意：只改 hash 不会重载，必须真 reload
  await page.waitForTimeout(700);
  const endAfterReload = await page.evaluate(async () => {
    const s = await import('/js/store.js');
    return {
      sessionLog: (s.getState().sessionLog || []).length,
      timelines: (s.getState().timelines || []).length,
      btn: !!document.querySelector('#endVent'),
      hash: location.hash,
    };
  });
  say('  ' + JSON.stringify(endAfterReload) + '（sessionLog 不持久化 ⇒ 刷新后「结束倾诉」入口消失）');

  say('=== G. toast 是否跨页面残留 ===');
  await page.evaluate(async () => { const s = await import('/js/store.js'); s.toast('测试提示'); });
  await page.waitForTimeout(150);
  const t1 = await page.evaluate(() => !!document.querySelector('.toast.toast--on'));
  await page.evaluate(() => { location.hash = '#/cards'; });
  await page.waitForTimeout(200);
  const t2 = await page.evaluate(() => ({
    hash: location.hash,
    toastVisible: !!document.querySelector('.toast.toast--on'),
    toastText: (document.querySelector('.toast') || {}).textContent || '',
  }));
  say('  say 页 toast 可见=' + t1 + ' → 切到 cards 页后 ' + JSON.stringify(t2));

  say('=== F. 时间线页的「离开」路径 ===');
  await page.evaluate(async () => {
    const s = await import('/js/store.js');
    s.startSession(); s.startDraft('我很开心'); s.startDraft('我好委屈');
  });
  await page.evaluate(async () => {
    const s = await import('/js/store.js');
    const r = await import('/js/router.js').catch(() => null);
  });
  await page.evaluate(() => { location.hash = '#/cards'; });
  await page.waitForTimeout(200);
  await page.evaluate(() => { location.hash = '#/say'; });
  await page.waitForTimeout(500);
  const e2 = await page.$('#endVent'); if (e2) await e2.click();
  await page.waitForTimeout(1200);
  const leave = await page.evaluate(() => ({
    hash: location.hash,
    hasTabbar: !!document.querySelector('.tabbar'),
    backBtns: Array.from(document.querySelectorAll('a,button')).map((n) => n.textContent.trim()).filter(Boolean),
  }));
  say('  ' + JSON.stringify(leave));

  await page.screenshot({ path: path.join(OUT, 'audit-timeline.png'), fullPage: true });
  await browser.close();
  fs.writeFileSync(path.join(__dirname, 'audit-timeline.out.txt'), lines.join('\n'), 'utf8');
})();
