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
     try { localStorage.setItem('monthly:done_' + (new Date().getFullYear() * 100 + (new Date().getMonth() + 1)), '1'); } catch (e) {}
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

  /**
   * 🔴 判据必须落在**这个开关真正影响的那条链路**上，不能拿一个通用信号套所有开关。
   *   第一版统一用 body.className 当判据 ⇒ ipTouch / ipBubble / setSound 三条**假红**：
   *   · ipTouch / ipBubble 压根不改 body class，它们改的是**点击 IP 时的行为**（有动画/有气泡）
   *   · setSound 的下游是 window.ipAudio.setEnabled()（app.js:1817），isEnabled() 才是它的真信号
   *   ⇒ 假红比不测更糟：会误导人去改一处根本没坏的代码。
   *   行为级判据（点 IP 看气泡/动画）放在 audit-settings-effective.cjs，这里只查「拨了有没有落库」。
   */
  const readStore = (k) => page.evaluate(async (k) => {
    const st = await import('/js/store.js');
    return st.getState().user.settings[k];
  }, k);

  const probeSwitch = async (id, label, opts) => {
    const o = opts || {};
    // setIpMotion → ipMotion（🔴 必须把首字母降为小写，否则读成 store.IpMotion 恒 undefined = 假红）
    const raw = id.replace(/^set/, '');
    const key = o.key || raw.charAt(0).toLowerCase() + raw.slice(1);
    const el = await page.$(`#${id}`);
    if (!el) { note(`设置项 ${id} 不存在`, 'UI 上没有这个开关'); return; }
    const readSig = o.sig || (() => readStore(key));
    const sigBefore = await readSig();
    const checkedBefore = await el.isChecked();
    await el.click();
    await page.waitForTimeout(700);
    const sigAfter = await readSig();
    const checkedAfter = await el.isChecked();
    const storeVal = await readStore(key);
    const changed = JSON.stringify(sigBefore) !== JSON.stringify(sigAfter);
    check(`设置项 ${label}（${id}）拨动在自己链路上有副作用`,
      changed && storeVal !== undefined,
      `${o.sigName || 'store'} ${JSON.stringify(sigBefore)} → ${JSON.stringify(sigAfter)}${changed ? '' : '（没变！）'}; checked ${checkedBefore}→${checkedAfter}; store.${key}=${JSON.stringify(storeVal)}`);
    await el.click();
    await page.waitForTimeout(400);
  };

  await probeSwitch('setIpMotion', 'IP 情绪动效', {
    sig: () => page.evaluate(() => document.body.className), sigName: 'body.class',
  });
  await probeSwitch('setIpTouch', 'IP 触碰互动');
  await probeSwitch('setIpBubble', '气泡文字');
  await probeSwitch('setSound', '轻音效', {
    key: 'soundOn',
    sig: () => page.evaluate(() => (window.ipAudio ? window.ipAudio.isEnabled() : null)),
    sigName: 'ipAudio.isEnabled',
  });

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
    // v1.4.1：这个开关已从死开关修为真实功能（js/notify.js + @capacitor/local-notifications）。
    //
    // 旧判据（"拨动后必须有副作用"）在 Web 端已经**不适用**：Web 根本发不出本地通知，
    // 硬要求副作用等于逼着前端装作成功 —— 那恰恰会把死开关换成更坏的假开关。
    // 新契约的核心是**绝不留假象**：
    //   · 原生端：真的安排每日提醒，开关保持开启
    //   · 不支持的环境：开关禁用 + 明确说明；万一被拨动，必须有回话并回退为关
    const supported = await page.evaluate(async () => {
      const n = await import('/js/notify.js');
      return await n.isSupported();
    });
    const st0 = await page.evaluate(() => {
      const el = document.getElementById('meNotify');
      const block = el && el.closest('.mblock');
      return {
        disabled: el ? el.disabled : null,
        desc: block ? ((block.querySelector('.mblock__n') || {}).textContent || '') : '',
      };
    });
    console.log(`\n  notify.isSupported()=${supported}；开关 disabled=${st0.disabled}`);
    console.log(`    说明文案="${st0.desc}"`);

    // 顺带验「你习惯的时段」不是空话：纯函数，有历史时取众数、无历史给默认 21
    const hourFn = await page.evaluate(async () => {
      const n = await import('/js/notify.js');
      return {
        empty: n.preferredHour([]),
        night: n.preferredHour([{ createdAt: new Date(2026, 8, 30, 23, 10).getTime() }, { createdAt: new Date(2026, 8, 29, 23, 40).getTime() }]),
        mixed: n.preferredHour([
          { createdAt: new Date(2026, 8, 30, 8, 0).getTime() },
          { createdAt: new Date(2026, 8, 29, 8, 30).getTime() },
          { createdAt: new Date(2026, 8, 28, 22, 0).getTime() },
        ]),
      };
    });
    check('「习惯的时段」取自历史记录（不是写死一个点）', hourFn.mixed === 8 && hourFn.night === 23, JSON.stringify(hourFn));
    check('无历史时给温和默认值 21 点', hourFn.empty === 21, String(hourFn.empty));

    if (supported) {
      await nt.click();
      await page.waitForTimeout(1500);
      const a = await page.evaluate(async () => {
        const s = await import('/js/store.js');
        return { checked: document.getElementById('meNotify').checked, val: s.getState().user.settings.notify_on };
      });
      check('原生端：开启后开关保持开启（提醒真的安排上了）', a.checked === true && a.val === true, JSON.stringify(a));
      await nt.click();
      await page.waitForTimeout(600);
    } else {
      check('不支持的环境：开关被禁用，不让人白拨一次', st0.disabled === true, String(st0.disabled));
      check('不支持的环境：有明确文字说明，而不是默默什么都不做', /不支持/.test(st0.desc), st0.desc);
      // 强行启用后拨动：必须回话并回退，绝不留"已开启"的假象
      await page.evaluate(() => { const el = document.getElementById('meNotify'); if (el) el.disabled = false; });
      await nt.click();
      await page.waitForTimeout(1200);
      const a = await page.evaluate(async () => {
        const s = await import('/js/store.js');
        return { checked: document.getElementById('meNotify').checked, val: s.getState().user.settings.notify_on };
      });
      check('强行拨动后不留"已开启"假象（回退为关 + 有回话）', a.checked === false && a.val === false, JSON.stringify(a));
    }
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
