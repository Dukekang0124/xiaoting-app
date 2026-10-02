/**
 * 复现脚本（2026-10-02）：两个高频可疑点
 * R1. 设置页点「标准」(动画强度 seg) → 会不会跳到 #/followup？
 * R2. 分析页在无 AI 能力（本地无 key）时会不会永远转圈、有没有超时兜底？
 * R3. changelog 页到底有没有协议正文（入口文案承诺 vs 落地）
 */
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:4173';

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext({ viewport: { width: 420, height: 880 } });
  await ctx.addInitScript(() => {
    try { localStorage.setItem('xiaoting:monthly:done_' + new Date().toISOString().slice(0, 7), String(Date.now())); } catch (e) {}
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e.message).slice(0, 200)));
  const clear = () => page.evaluate(() => document.querySelectorAll('.monthly-overlay,.update-overlay,.risk-modal,.gentle-overlay,.welcome-overlay').forEach((e) => e && e.parentNode && e.parentNode.removeChild(e)));

  // ---------- R1 ----------
  console.log('===== R1. 设置页「动画强度」段选择 =====');
  await page.goto(BASE + '/#/settings', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700); await clear();
  const r1 = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('#view button')].map((b) => ({ id: b.id, text: (b.innerText || '').trim(), v: b.dataset ? b.dataset.v : '' }));
    return { hash: location.hash, btns };
  });
  console.log('  进入设置 hash=' + r1.hash + '，可点按钮:', JSON.stringify(r1.btns));
  const seg = r1.btns.find((b) => /柔和|标准/.test(b.text));
  if (seg) {
    await page.evaluate((txt) => {
      const b = [...document.querySelectorAll('#view button')].find((x) => (x.innerText || '').trim() === txt);
      if (b) b.click();
    }, seg.text);
    await page.waitForTimeout(1200); await clear();
    const after = await page.evaluate(() => ({ hash: location.hash, segs: [...document.querySelectorAll('#view button')].map((b) => (b.innerText || '').trim()) }));
    console.log(`  点「${seg.text}」后 hash=${after.hash}`);
    console.log(`  按钮区:', ${JSON.stringify(after.segs)}`);
    console.log('  ⇒ 判定: ' + (/followup|analyzing/.test(after.hash) ? '❌ 异常跳转' : '✅ 停留设置页'));
    // 再点一次「柔和」看反向是否也跳
    await page.goto(BASE + '/#/settings', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(700); await clear();
    await page.evaluate(() => { const b = [...document.querySelectorAll('#view button')].find((x) => /柔和/.test(x.innerText || '')); if (b) b.click(); });
    await page.waitForTimeout(1200); await clear();
    const after2 = await page.evaluate(() => location.hash);
    console.log(`  再点「柔和」后 hash=${after2} ⇒ ${/followup|analyzing/.test(after2) ? '❌ 异常跳转' : '✅'}`);
  } else { console.log('  ⚠️ 没找到「柔和/标准」按钮'); }

  // ---------- R2 ----------
  console.log('\n===== R2. 分析页无 AI 能力时的兜底 =====');
  await page.goto(BASE + '/#/record?mode=text', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700); await clear();
  await page.evaluate(() => { const t = document.getElementById('recInput'); if (t) { t.value = '今天被领导当众说了一句，我很憋屈，但没敢回嘴，回来一直闷着。'; t.dispatchEvent(new Event('input', { bubbles: true })); } });
  await page.waitForTimeout(200);
  await page.evaluate(() => { const b = document.getElementById('recDone') || document.getElementById('recToggle'); if (b) b.click(); });
  const t0 = Date.now();
  let left = false;
  const marks = [];
  for (let i = 0; i < 40; i++) { // 最多观察 40s
    await page.waitForTimeout(1000);
    const s = await page.evaluate(() => ({
      hash: location.hash,
      rotating: !!document.getElementById('analyzingCopy'),
      txt: ((document.getElementById('view') || {}).innerText || '').slice(0, 60).replace(/\s+/g, ' '),
    }));
    if (i % 5 === 0) marks.push(`${((Date.now() - t0) / 1000).toFixed(0)}s ${s.hash}`);
    if (s.hash !== '#/analyzing') {
      left = true;
      console.log(`  ⇒ ${((Date.now() - t0) / 1000).toFixed(0)}s 离开 analyzing → ${s.hash}`);
      console.log(`     内容: ${s.txt}`);
      break;
    }
  }
  if (!left) {
    console.log(`  ❌ 40s 仍卡在 #/analyzing（无超时兜底）`);
    const s = await page.evaluate(() => ({ txt: ((document.getElementById('view') || {}).innerText || '').slice(0, 200), diag: window.__mm_diag || null }));
    console.log(`     页面内容: ${s.txt}`);
  }
  console.log('  轨迹:', marks.join(' | '));
  console.log('  页面错误:', JSON.stringify(errs.slice(-5)));

  // ---------- R3 ----------
  console.log('\n===== R3. changelog 页协议入口落地 =====');
  await page.goto(BASE + '/#/changelog', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800); await clear();
  const r3 = await page.evaluate(() => {
    const v = document.getElementById('view');
    const t = (v.innerText || '');
    const heads = t.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 24);
    return { len: t.length, heads, hasPrivacyBox: !!v.querySelector('.privacy-box'), bodyHTML: (v.querySelector('.privacy-box') || {}).innerText ? v.querySelector('.privacy-box').innerText.slice(0, 120) : '' };
  });
  console.log(`  页长 ${r3.len} 字；结构: ${JSON.stringify(r3.heads)}`);
  console.log(`  privacy-box 存在=${r3.hasPrivacyBox}，内容: ${r3.bodyHTML}`);
  // 「我」页入口文案
  await page.goto(BASE + '/#/me', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(700); await clear();
  const entry = await page.evaluate(() => {
    const a = [...document.querySelectorAll('#view a')].map((x) => ({ href: x.getAttribute('href'), t: (x.innerText || '').replace(/\s+/g, ' ').trim() })).filter((x) => x.href && x.href.includes('#/'));
    return a;
  });
  console.log('  「我」页入口:', JSON.stringify(entry));

  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
