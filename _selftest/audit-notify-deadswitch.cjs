/**
 * 审计：v1.3.x 对外承诺 vs 真实行为（真跑，不靠 grep）
 *
 * 触发背景：核查「是否还有遗漏」时，静态扫描发现「我」页的「允许轻提醒」开关
 *   （settings.notify_on）全仓只有「渲染 / 绑定 / 默认值」三处，**没有任何地方读它**，
 *   且全仓没有 Notification / LocalNotifications 的调用 ⇒ 疑似死开关（拨了什么都不发生）。
 *   同类问题在 v0.5.0 修过一次（autoDeleteAudio），当时的原则是：
 *   「一个不起作用的隐私/功能开关比没有开关更糟」。
 *
 * 本脚本用真浏览器把「承诺 → 行为」逐条验证，重点抓两类问题：
 *   ① 控件拨动后**无任何副作用**（死开关）
 *   ② 页面入口点了报错 / 打不开
 *
 * 用法：BASE=http://127.0.0.1:4175 node _selftest/audit-notify-deadswitch.cjs
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:4175';
const SHOTS = path.join(__dirname, 'shots');
let pass = 0, fail = 0, warn = 0;
const findings = [];

function check(name, ok, detail) {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
function note(name, detail) { warn++; findings.push({ name, detail }); console.log(`NOTE  ${name}  — ${detail}`); }

(async () => {
  if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 430, height: 932 }, deviceScaleFactor: 2, locale: 'zh-CN', hasTouch: true, isMobile: true,
    serviceWorkers: 'block',
  });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('xiaoting:ai', 'mock');
      localStorage.setItem('moxiaoming:welcomed_v1', '1');
    } catch (e) {}
  });
  const page = await ctx.newPage();
  const errs = [];
  const reqs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 160)); });
  page.on('request', (r) => reqs.push(r.url()));

  // ---------- A. 「我」页每个入口都要能打开 ----------
  await page.goto(`${BASE}/#/me`, { waitUntil: 'load' });
  await page.waitForSelector('.mrow', { timeout: 15000 });
  await page.waitForTimeout(900);

  const entries = await page.$$eval('.mrow', (els) => els.map((e) => ({
    href: e.getAttribute('href'), text: (e.querySelector('.mrow__txt') || e).textContent.trim().slice(0, 20),
  })));
  console.log(`「我」页入口共 ${entries.length} 个：${entries.map((e) => e.href).join(' ')}`);

  for (const en of entries) {
    const before = errs.length;
    const beforeReqs = reqs.length;
    await page.evaluate((h) => { location.hash = h; }, en.href);
    await page.waitForTimeout(1100);
    const state = await page.evaluate(() => ({
      hash: location.hash,
      hasSection: !!document.querySelector('.page, section, .settings, .mblock, .mcard'),
      title: (document.querySelector('.page-title') || {}).textContent || '',
      nodes: document.querySelectorAll('section, .mblock, .mcard, .card').length,
      isEmpty: !document.body.textContent.trim() || document.body.textContent.trim().length < 30,
    }));
    const newErrs = errs.length - before;
    const blank = state.isEmpty || state.nodes === 0;
    check(`入口 ${en.href}（${en.text}）可打开且非空`, !blank && newErrs === 0,
      `hash=${state.hash} 节点=${state.nodes} 新报错=${newErrs}${newErrs ? ' ' + errs.slice(before).join(' | ') : ''}`);
    await page.screenshot({ path: path.join(SHOTS, `audit-me-${en.href.replace(/[#/]/g, '_')}.png`) });
    void beforeReqs;
  }

  // ---------- B. 设置页每个控件拨动后必须有可观测副作用 ----------
  await page.evaluate(() => { location.hash = '#/settings'; });
  await page.waitForTimeout(1000);

  const before = { cls: await page.evaluate(() => document.body.className), html: await page.evaluate(() => document.body.innerHTML.length) };

  const probeSwitch = async (id, label, expectClass) => {
    const el = await page.$(`#${id}`);
    if (!el) { note(`设置项 ${id} 不存在`, 'UI 上没有这个开关'); return; }
    const clsBefore = await page.evaluate(() => document.body.className);
    const checkedBefore = await el.isChecked();
    await el.click();
    await page.waitForTimeout(700);
    const clsAfter = await page.evaluate(() => document.body.className);
    const checkedAfter = await el.isChecked();
    const storeVal = await page.evaluate(async (k) => {
      const st = await import('/js/store.js');
      return st.getState().user.settings[k];
    }, id.replace(/^set/, (m) => m).replace(/^set/, ''));
    const changed = clsBefore !== clsAfter;
    check(`设置项 ${label}（${id}）拨动有副作用`,
      changed || !!expectClass && clsAfter.includes(expectClass),
      `body.class ${changed ? '变了' : '没变'}; checked ${checkedBefore}→${checkedAfter}; store=${JSON.stringify(storeVal)}`);
    await el.click();
    await page.waitForTimeout(400);
  };

  await probeSwitch('setIpMotion', 'IP 情绪动效', 'ip-motion-off');
  await probeSwitch('setIpTouch', 'IP 触碰互动');
  await probeSwitch('setIpBubble', '气泡文字');
  await probeSwitch('setSound', '轻音效');

  // 动画强度分段控件
  const segBtn = await page.$('#setIpIntensity button[data-v="gentle"]');
  if (segBtn) {
    const before2 = await page.evaluate(() => document.body.className);
    await segBtn.click();
    await page.waitForTimeout(500);
    const after2 = await page.evaluate(() => document.body.className);
    check('设置项 动画强度=柔和 拨动有副作用', before2 !== after2, `${before2} → ${after2}`);
  }
  void before;

  // ---------- C. 「我」页的「允许轻提醒」开关：拨动后是否有任何副作用 ----------
  await page.evaluate(() => { location.hash = '#/me'; });
  await page.waitForTimeout(1000);
  const nt = await page.$('#meNotify');
  check('「我」页存在「允许轻提醒」开关', !!nt, nt ? '' : '未找到 #meNotify');
  if (nt) {
    const reqBefore = reqs.length;
    const lsBefore = await page.evaluate(() => JSON.stringify(Object.keys(localStorage).sort()));
    const txtBefore = await page.evaluate(() => document.body.textContent.length);
    await nt.click();
    await page.waitForTimeout(3000); // 给"定时提醒"留出可能出现的时间窗
    const after = await page.evaluate(async () => {
      const st = await import('/js/store.js');
      return {
        checked: document.getElementById('meNotify').checked,
        storeVal: st.getState().user.settings.notify_on,
        ls: JSON.stringify(Object.keys(localStorage).sort()),
        txt: document.body.textContent.length,
        timers: typeof window.__notifyTimers,
      };
    });
    const newReq = reqs.slice(reqBefore).filter((u) => !/\.png|\.css|\.js|\.svg|\.json$/.test(u));
    const sideEffect = after.ls !== lsBefore || after.txt !== txtBefore || newReq.length > 0;
    console.log(`\n  「允许轻提醒」拨动后：store.notify_on=${after.storeVal} checked=${after.checked}`);
    console.log(`    localStorage ${after.ls === lsBefore ? '无变化' : '有变化'}；页面文本长度 ${txtBefore}→${after.txt}；新增非静态请求 ${newReq.length} 个`);
    check('「允许轻提醒」开关拨动后应有可观测副作用（无则=死开关）', sideEffect,
      sideEffect ? '' : '拨动 3 秒内：store 只被写入、页面无变化、无网络请求、无定时器 ⇒ 用户拨了等于没拨');
    if (!sideEffect) {
      note('死开关：「我」页「允许轻提醒」= 无效控件',
        '文案承诺「墨小溟会在你习惯的时段，轻轻问候你」，但全仓无 Notification/LocalNotifications 调用、notify_on 零消费');
    }
    await nt.click(); // 复位
    await page.waitForTimeout(300);
  }

  // ---------- D. 全局：无未捕获异常 ----------
  const realErrs = errs.filter((e) => !/favicon|net::ERR_|Failed to load resource/i.test(e));
  check('全流程无未捕获的页面异常', realErrs.length === 0, realErrs.slice(0, 4).join(' | '));

  console.log(`\n==== 审计结果：PASS ${pass} / FAIL ${fail} / NOTE ${warn} ====`);
  if (findings.length) {
    console.log('需要处理的问题：');
    findings.forEach((f) => console.log(`  ▲ ${f.name}\n    ${f.detail}`));
  }
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('审计脚本异常：', e); process.exit(2); });
