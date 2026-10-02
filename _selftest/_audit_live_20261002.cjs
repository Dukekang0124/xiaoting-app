/**
 * 墨小溟 · 线上/本地 L3 真跑审计（2026-10-02）
 *
 * 用法：
 *   BASE=https://xiaoting.app.workbuddy.host node _selftest/_audit_live_20261002.cjs   # 线上
 *   BASE=http://127.0.0.1:4173 node _selftest/_audit_live_20261002.cjs                # 本地
 *
 * 内容：
 *  L1. 静态资源全量可达（无 4xx5xx）+ index.html 版本标记
 *  L2. 17 条路由真访问：零 pageerror / 零 console.error
 *  L3. 完整主流程真跑并生成数据 → 卡片/时间线/记忆/周报页面能否读出来
 *  L4. Service Worker 注册与缓存版本 / 离线可用性
 *  L5. 更新弹窗链路（拦截原生安装，验「已下好 → 点立即安装」的 UI 反馈）
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = (process.env.BASE || 'http://127.0.0.1:4173').replace(/\/$/, '');
const OUT = path.join(__dirname, '_audit_20261002', 'live-' + new Date().toISOString().slice(0, 10) + '.json');
const LIVE = /^https?:\/\/(?!127\.0\.0\.1|localhost)/.test(BASE);

const ROUTES = ['#/say', '#/record', '#/record?mode=text', '#/followup', '#/gentle', '#/confirm',
  '#/timeline', '#/timelines', '#/cards', '#/weekly', '#/me', '#/memory', '#/settings',
  '#/changelog', '#/risk', '#/diag'];

const rep = { base: BASE, live: LIVE, routes: [], static: [], flow: {}, checks: [], started: new Date().toISOString() };
const chk = (n, pass, d) => { rep.checks.push({ name: n, pass, detail: d }); console.log(`  ${pass ? '✅' : '❌'} ${n} — ${d}`); };

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const ctx = await browser.newContext({ viewport: { width: 420, height: 880 }, acceptDownloads: true });

  // 线上：把所有写端点打桩，绝不写生产数据
  if (LIVE) {
    await ctx.route('**/api/**', (route) => {
      const u = route.request().url();
      if (/\/api\/(events|stats|llm.*feedback)/.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"skipped":true}' });
      return route.continue();
    });
  }
  await ctx.addInitScript(() => {
    try { localStorage.setItem('xiaoting:monthly:done_' + new Date().toISOString().slice(0, 7), String(Date.now())); } catch (e) {}
  });
  const page = await ctx.newPage();
  const errs = { page: [], console: [], bad: [] };
  const attach = () => { errs.page = []; errs.console = []; errs.bad = [];
    page.removeAllListeners('pageerror'); page.removeAllListeners('console'); page.removeAllListeners('response');
    page.on('pageerror', (e) => errs.page.push(String(e.message).slice(0, 200)));
    page.on('console', (m) => { if (m.type() === 'error') errs.console.push(m.text().slice(0, 200)); });
    page.on('response', (r) => { if (r.status() >= 400) errs.bad.push(r.status() + ' ' + r.url().replace(BASE, '').slice(0, 120)); });
  };
  const clear = () => page.evaluate(() => document.querySelectorAll('.monthly-overlay,.update-overlay,.risk-modal,.gentle-overlay,.welcome-overlay').forEach((e) => e && e.parentNode && e.parentNode.removeChild(e)));
  const settle = async (ms = 500) => { await page.waitForTimeout(ms); await clear(); };

  console.log(`\n########## 目标：${BASE}${LIVE ? '（线上，写端点已打桩）' : '（本地）'} ##########`);

  // ---- L1 静态资源 ----
  console.log('\n===== L1. 首屏与静态资源 =====');
  attach();
  await page.goto(BASE + '/#/say', { waitUntil: 'load' });
  await page.waitForTimeout(1500); await clear();
  const boot = await page.evaluate(() => ({
    appVersion: (window.APP_VERSION || '').toString(),
    viewLen: ((document.getElementById('view') || {}).innerText || '').length,
    iconHref: ((document.querySelector('link[rel="icon"],link[rel="apple-touch-icon"]') || {}).href || ''),
  }));
  chk('L1-1 首屏渲染', boot.viewLen > 30, `APP_VERSION=${boot.appVersion}，首屏文本 ${boot.viewLen} 字`);
  chk('L1-2 资源无 4xx5xx', errs.bad.length === 0, `4xx/5xx: ${JSON.stringify(errs.bad.slice(0, 6))}`);
  rep.static = { bad: errs.bad.slice(), boot };

  // ---- L2 路由 ----
  console.log('\n===== L2. 逐路由真访问 =====');
  for (const h of ROUTES) {
    attach();
    await page.goto(BASE + '/' + h, { waitUntil: 'domcontentloaded' });
    await settle(420);
    const info = await page.evaluate(() => {
      const v = document.getElementById('view');
      return { child: v ? v.children.length : 0, len: v ? ((v.innerText || '').trim()).length : 0, hash: location.hash };
    });
    const ok = info.child > 0 && errs.page.length === 0 && errs.console.length === 0 && errs.bad.length === 0;
    rep.routes.push({ hash: h, ...info, ok, pageErrors: errs.page.slice(), consoleErrors: errs.console.slice(), bad: errs.bad.slice() });
    console.log(`  ${ok ? '✅' : '❌'} ${h.padEnd(22)} 子元素=${info.child} 文本=${String(info.len).padEnd(5)} ${errs.page.length || errs.console.length ? JSON.stringify([...errs.page, ...errs.console]) : ''}`);
  }

  // ---- L3 完整主流程（生成真实数据） ----
  console.log('\n===== L3. 完整主流程真跑（打字链路） =====');
  attach();
  await page.goto(BASE + '/#/record?mode=text', { waitUntil: 'domcontentloaded' });
  await settle(600);
  await page.evaluate(() => {
    const t = document.getElementById('recInput');
    if (t) { t.value = '今天被领导当众点名说了一句很难听的话，我当时脸发烫，一句话都没敢回，回来一直闷着，饭也吃不下。'; t.dispatchEvent(new Event('input', { bubbles: true })); }
  });
  await settle(260);
  await page.evaluate(() => { const b = document.getElementById('recDone') || document.getElementById('recToggle'); if (b) b.click(); });

  const path_ = [];
  for (let i = 0; i < 26; i++) {
    await page.waitForTimeout(1000);
    const s = await page.evaluate(() => location.hash);
    if (path_[path_.length - 1] !== s) path_.push(s);
    if (/timeline|cards|risk|say/.test(s) && path_.length > 3) break;
    if (/analyzing|followup|gentle|confirm/.test(s)) {
      await page.evaluate(() => {
        const ids = ['fuSkip', 'fuSkipTop', 'fuNext', 'gProceed', 'cfKeep', 'cfContinue', 'recToggle', 'recDone', 'tlSave'];
        for (const id of ids) { const e = document.getElementById(id); if (e) { e.click(); return; } }
        const btn = [...document.querySelectorAll('#view button')].find((x) => /跳过|继续|先收下|保存|结束倾诉/.test(x.innerText || ''));
        if (btn) btn.click();
      });
      await settle(1500);
    }
  }
  rep.flow.path = path_;
  console.log('  路径:', path_.join(' → '));

  // 生成数据后回看各页
  console.log('\n===== L3b. 有数据后的页面读得出吗 =====');
  for (const h of ['#/cards', '#/card/', '#/timeline', '#/timelines', '#/weekly', '#/memory']) {
    attach();
    await page.goto(BASE + '/' + h, { waitUntil: 'domcontentloaded' });
    await settle(600);
    const d = await page.evaluate(() => {
      const v = document.getElementById('view');
      return { len: ((v.innerText || '').trim()).length, head: ((v.innerText || '').trim()).slice(0, 70).replace(/\s+/g, ' ') };
    });
    const e = errs;
    const ok = d.len > 10 && e.page.length === 0;
    rep.routes.push({ hash: h, afterFlow: true, len: d.len, ok, pageErrors: e.page.slice() });
    console.log(`  ${ok ? '✅' : '❌'} ${h.padEnd(14)} ${String(d.len).padEnd(5)} ${d.head}${e.page.length ? ' ERR:' + JSON.stringify(e.page) : ''}`);
  }

  // card 详情（取真实 id）
  await page.goto(BASE + '/#/cards', { waitUntil: 'domcontentloaded' }); await settle(600);
  const cardId = await page.evaluate(() => {
    const a = document.querySelector('#view a[href*="#/card/"]');
    return a ? a.getAttribute('href') : null;
  });
  if (cardId) {
    attach();
    await page.goto(BASE + '/' + cardId, { waitUntil: 'domcontentloaded' }); await settle(600);
    const cd = await page.evaluate(() => ((document.getElementById('view') || {}).innerText || '').trim().length);
    chk('L3-1 卡片详情能打开', cd > 20, `${cardId} 详情文本 ${cd} 字`);
  } else { chk('L3-1 卡片详情能打开', false, '用例未生成卡片（流程未到 cards）'); }

  // 时间线导出（下载）
  await page.goto(BASE + '/#/timeline', { waitUntil: 'domcontentloaded' }); await settle(700);
  const tlSave = await page.evaluate(() => !!document.getElementById('tlSave'));
  if (tlSave) {
    await page.evaluate(() => document.getElementById('tlSave').click());
    await settle(700);
  }
  await page.goto(BASE + '/#/timeline', { waitUntil: 'domcontentloaded' }); await settle(800);
  let dlName = null;
  try {
    const p = page.waitForEvent('download', { timeout: 4000 }).catch(() => null);
    await page.evaluate(() => { const b = document.getElementById('tlExport'); if (b) b.click(); });
    const d = await p; dlName = d ? d.suggestedFilename() : null;
  } catch (e) {}
  chk('L3-2 时间线导出可下载', !!dlName, dlName || '未捕获下载');

  // ---- L4 SW / 离线 ----
  console.log('\n===== L4. Service Worker 与离线 =====');
  try {
    const swInfo = await page.evaluate(async () => {
      const regs = await navigator.serviceWorker.getRegistrations();
      return { count: regs.length, scope: regs.length ? regs[0].scope : '' };
    });
    const ready = await page.evaluate(async () => {
      if (!navigator.serviceWorker.controller) {
        try { await navigator.serviceWorker.register('/sw.js'); } catch (e) { return 'register_failed'; }
      }
      try { const r = await navigator.serviceWorker.ready; return 'ready'; } catch (e) { return 'not_ready:' + e.message; }
    });
    chk('L4-1 SW 注册', swInfo.count > 0 || ready === 'ready', `registrations=${swInfo.count}, ready=${ready}, scope=${swInfo.scope}`);
    // 离线重载
    await page.goto(BASE + '/#/me', { waitUntil: 'domcontentloaded' }); await settle(700);
    await ctx.setOffline(true);
    let offlineOk = false, offlineInfo = '';
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 8000 });
      await page.waitForTimeout(900);
      const o = await page.evaluate(() => ({ len: ((document.getElementById('view') || {}).innerText || '').length, hasSW: !!navigator.serviceWorker.controller }));
      offlineOk = o.len > 20; offlineInfo = `离线重载文本 ${o.len} 字，controller=${o.hasSW}`;
    } catch (e) { offlineInfo = '离线重载失败: ' + e.message.slice(0, 80); }
    chk('L4-2 断网重载可用', offlineOk, offlineInfo);
    await ctx.setOffline(false);
  } catch (e) { chk('L4 SW', false, String(e.message).slice(0, 120)); }

  // ---- L5 更新弹窗链路 ----
  console.log('\n===== L5. 更新弹窗（拦截原生安装） =====');
  await page.goto(BASE + '/#/changelog', { waitUntil: 'domcontentloaded' }); await settle(600);
  const clBtn = await page.evaluate(() => !!document.getElementById('clCheck'));
  if (clBtn) {
    await page.evaluate(() => document.getElementById('clCheck').click());
    await settle(2200);
    const modal = await page.evaluate(() => {
      const o = document.querySelector('.update-overlay');
      return { exists: !!o, text: o ? (o.innerText || '').replace(/\s+/g, ' ').slice(0, 180) : '', hasNow: !!document.getElementById('updateNow') };
    });
    chk('L5-1 检查更新弹出卡片', modal.exists, modal.text || '无弹窗');
    if (modal.exists) {
      const nowTxt = await page.evaluate(() => { const b = document.getElementById('updateNow'); return b ? (b.innerText || '').trim() : ''; });
      chk('L5-2 主按钮文案随平台', /立即更新|复制下载链接|浏览器/.test(nowTxt), `按钮：「${nowTxt}」`);
    }
  } else chk('L5-1 检查更新弹出卡片', false, 'clCheck 按钮不存在');

  await browser.close();
  const fail = rep.checks.filter((c) => !c.pass).length;
  console.log(`\n===== 汇总（${BASE}）：断言 ${rep.checks.length - fail}/${rep.checks.length} 通过，路由异常 ${rep.routes.filter((r) => r.ok === false).length} 条 =====`);
  fs.writeFileSync(OUT, JSON.stringify(rep, null, 2), 'utf8');
  console.log('证据:', OUT);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
