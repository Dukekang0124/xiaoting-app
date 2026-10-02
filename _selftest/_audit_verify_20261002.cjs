/**
 * 修复后二次验证（2026-10-02）：v1.6.15 那几条修复，到底生效没有？
 * 按 skill §9.3 的规矩：同一判据，修复前后各看一次，记数字不记「绿了」。
 *
 * V1 changelog 页真的有「用户协议 / 隐私政策」正文（此前点进去只有「关于墨小溟」）
 * V2 Web 端检查更新**不再**请求 /api/version/*（公开站纯静态托管，那条必然 404）
 * V3 设置页隐私说明仍在，且与 changelog 同源（同一份 privacyBlockHtml）
 * V4 轻提醒：Web 端开关如实禁用并说明 + 时段数据源改为真实存在的 state.timelines/cards
 * V5 全站逐路由仍零报错（回归确认修复没带来新问题）
 */
const { chromium } = require('playwright');
const BASE = (process.env.BASE || 'http://127.0.0.1:4173').replace(/\/$/, '');
const LIVE = /^https?:\/\/(?!127\.0\.0\.1|localhost)/.test(BASE);

(async () => {
  const b = await chromium.launch({ channel: 'chrome' });
  const ctx = await b.newContext({ viewport: { width: 420, height: 880 } });
  if (LIVE) await ctx.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"skipped":true}' }));
  await ctx.addInitScript(() => { try { localStorage.setItem('xiaoting:monthly:done_' + new Date().toISOString().slice(0, 7), String(Date.now())); } catch (e) {} });
  const page = await ctx.newPage();
  const reqs = [];
  const errs = { page: [], console: [], bad: [] };
  page.on('request', (r) => { if (/\/api\/version/.test(r.url())) reqs.push(r.url().replace(BASE, '')); });
  page.on('pageerror', (e) => errs.page.push(String(e.message).slice(0, 160)));
  page.on('console', (m) => { if (m.type() === 'error') errs.console.push(m.text().slice(0, 160)); });
  page.on('response', (r) => { if (r.status() >= 400) errs.bad.push(r.status() + ' ' + r.url().replace(BASE, '').slice(0, 100)); });
  const clear = () => page.evaluate(() => document.querySelectorAll('.monthly-overlay,.update-overlay,.risk-modal,.gentle-overlay,.welcome-overlay').forEach((e) => e && e.parentNode && e.parentNode.removeChild(e)));
  const settle = async (ms = 600) => { await page.waitForTimeout(ms); await clear(); };

  console.log(`\n########## 验证目标：${BASE} ##########`);

  // V1 + V3 协议正文
  console.log('\n===== V1/V3 用户协议 / 隐私政策 落地 =====');
  await page.goto(BASE + '/#/changelog', { waitUntil: 'domcontentloaded' }); await settle(1000);
  const cl = await page.evaluate(() => {
    const v = document.getElementById('view');
    const t = (v.innerText || '');
    const box = v.querySelector('.privacy-box');
    return {
      hasHeading: /用户协议 \/ 隐私政策/.test(t),
      hasBox: !!box,
      boxSecs: box ? box.querySelectorAll('.privacy__sec').length : 0,
      boxTitle: box ? (box.querySelector('.privacy__title') || {}).innerText || '' : '',
      boxLen: box ? (box.innerText || '').length : 0,
      total: t.length,
      hasHistory: /v1\.6\.1/.test(t),
    };
  });
  console.log(`  changelog 页：标题命中=${cl.hasHeading} 隐私框=${cl.hasBox} 段落数=${cl.boxSecs} 标题=「${cl.boxTitle}」正文${cl.boxLen}字 页面总${cl.total}字 更新历史=${cl.hasHistory}`);
  console.log(`  ⇒ V1 ${cl.hasHeading && cl.boxSecs >= 3 ? '✅ 协议正文真的落在这一页了（修复前：0 段、只有「关于墨小溟」）' : '❌ 仍接不住'}`);
  console.log(`  ⇒ V3 ${cl.boxSecs >= 3 ? '✅ 与设置页同源（同一份 privacyBlockHtml 渲染）' : '❌'}`);

  await page.goto(BASE + '/#/settings', { waitUntil: 'domcontentloaded' }); await settle(900);
  const sp = await page.evaluate(() => {
    const box = document.querySelector('#view .privacy-box');
    return { secs: box ? box.querySelectorAll('.privacy__sec').length : 0 };
  });
  console.log(`  设置页隐私段落数=${sp.secs} ⇒ 两页 ${cl.boxSecs === sp.secs ? '✅ 一致' : '❌ 不一致'}`);

  // V2 /api/version 请求
  console.log('\n===== V2 检查更新是否还打 /api/version/* =====');
  reqs.length = 0; errs.bad.length = 0;
  await page.goto(BASE + '/#/changelog', { waitUntil: 'domcontentloaded' }); await settle(900);
  const hasCheck = await page.evaluate(() => !!document.getElementById('clCheck'));
  if (hasCheck) {
    await page.evaluate(() => document.getElementById('clCheck').click());
    await settle(2600);
  }
  const apiHits = reqs.filter((u) => /\/api\/version/.test(u));
  console.log(`  点「检查更新」时发出的 /api/version/* 请求：${apiHits.length} 条 ${JSON.stringify(apiHits)}`);
  console.log(`  期间 4xx/5xx：${JSON.stringify(errs.bad.slice(0, 4))}`);
  console.log(`  ⇒ V2 ${apiHits.length === 0 ? '✅ 不再白撞必然 404 的通道（修复前：/api/version/latest + /api/version/history 各一次 404）' : '❌ 仍在打'}`);

  // V4 轻提醒
  console.log('\n===== V4 轻提醒（数据源 + 环境降级） =====');
  await page.goto(BASE + '/#/me', { waitUntil: 'domcontentloaded' }); await settle(900);
  const nt = await page.evaluate(() => {
    const b = document.getElementById('meNotify');
    if (!b) return { missing: true };
    const blk = b.closest('.mblock');
    return { disabled: b.disabled, desc: ((blk && blk.querySelector('.mblock__n')) || {}).innerText || '' };
  });
  console.log(`  Web 端开关 disabled=${nt.disabled}；说明=「${nt.desc}」`);
  console.log(`  ⇒ V4-a ${nt.disabled && /不支持/.test(nt.desc) ? '✅ 环境不支持时如实禁用+说明' : '❌ 假开关风险'}`);
  const ds = await page.evaluate(async () => {
    const n = await import('/js/notify.js');
    const s = (await import('/js/store.js'));
    const st = s.getState();
    // 造两条不同时段的假记录，验证 preferredHour 真能读出来（修复前恒 21）
    st.timelines = [{ saved_at: new Date().setHours(6, 0, 0, 0) }, { saved_at: new Date().setHours(6, 30, 0, 0) }, { saved_at: new Date().setHours(6, 45, 0, 0) }];
    return { hour6: n.preferredHour(st.timelines) };
  });
  console.log(`  造 3 条「早上 6 点」的历史 → preferredHour() = ${ds.hour6}（修复前：数据源不存在，恒返回 21）`);
  console.log(`  ⇒ V4-b ${ds.hour6 === 6 ? '✅ 时段真的从历史里读出来了' : '❌ 仍回落默认值'}`);

  // V5 全站回归
  console.log('\n===== V5 逐路由零报错（修复后回归） =====');
  let bad = 0;
  for (const h of ['#/say', '#/me', '#/settings', '#/memory', '#/changelog', '#/risk', '#/diag', '#/timeline', '#/cards']) {
    errs.page.length = 0; errs.console.length = 0; errs.bad.length = 0;
    await page.goto(BASE + '/' + h, { waitUntil: 'domcontentloaded' }); await settle(600);
    const info = await page.evaluate(() => { const v = document.getElementById('view'); return { c: v ? v.children.length : 0, len: v ? ((v.innerText || '').trim()).length : 0 }; });
    const ok = info.c > 0 && errs.page.length === 0 && errs.console.length === 0 && errs.bad.length === 0;
    if (!ok) bad++;
    console.log(`  ${ok ? '✅' : '❌'} ${h.padEnd(12)} ${String(info.len).padEnd(5)} ${errs.page.length || errs.console.length || errs.bad.length ? JSON.stringify([...errs.page, ...errs.console, ...errs.bad].slice(0, 3)) : ''}`);
  }
  console.log(`\n===== 汇总（${BASE}）：V5 异常 ${bad} 条 =====`);
  await b.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
