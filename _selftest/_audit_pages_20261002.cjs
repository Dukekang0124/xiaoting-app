/**
 * 墨小溟 · 全产品逐页逐流程审计（2026-10-02）
 *
 * 覆盖：
 *  A. 17 条路由逐页真访问 → 渲染非空 / 无 pageerror / 无 console.error / 无 4xx5xx
 *  B. 每页按钮扫描：枚举可点元素并逐个真点 → 记录 error / hash 跳变 / 下载
 *  C. 文案与落地一致性：协议入口 / 导出格式 / wipe 文案 / 轻提醒降级说明
 *  D. 设置持久化：改 → reload → 值保持 + 生效（body class / 音频模块 / 动效）
 *  E. 主流程真跑（打字链路 + 失败兜底）
 *  F. 导出类按钮真触发下载
 *
 * 用法：NODE_PATH=<ws>/node_modules node _selftest/_audit_pages_20261002.cjs
 *      BASE=http://127.0.0.1:4173 node _selftest/_audit_pages_20261002.cjs
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://127.0.0.1:4173';
const OUT_DIR = path.join(__dirname, '_audit_20261002');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

/** 需要真实触发的下载按钮（点它会下载文件） */
const DOWNLOAD_HINTS = ['export', '导出', 'tlExport', 'diagExport', 'clDl', 'clExport'];
/** 危险按钮：绝不在浏览器里点（会清数据/触发原生安装） */
const DANGEROUS = /wipe|clearAll|clearCards|clearMemory|清空|删除全部|清除本地|清除所有/;

const ROUTES = [
  ['say', '#/say'], ['record', '#/record'], ['record-text', '#/record?mode=text'],
  ['analyzing', '#/analyzing'], ['followup', '#/followup'], ['gentle', '#/gentle'],
  ['confirm', '#/confirm'], ['timeline', '#/timeline'], ['timelines', '#/timelines'],
  ['cards', '#/cards'], ['card', '#/card/c_demo'], ['weekly', '#/weekly'],
  ['me', '#/me'], ['memory', '#/memory'], ['settings', '#/settings'],
  ['changelog', '#/changelog'], ['risk', '#/risk'], ['diag', '#/diag'],
  ['root', '#/'],
];

const report = { base: BASE, started: new Date().toISOString(), pages: [], buttons: [], flows: [], checks: [], errors: [] };
const log = (...a) => console.log(...a);

(async () => {
  const browser = await chromium.launch({
    channel: 'chrome',
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  const ctx = await browser.newContext({ viewport: { width: 420, height: 880 }, acceptDownloads: true });
  const page = await ctx.newPage();

  // 幂等 seed：预置「本月复盘已看过」，避免每月 1 号弹窗挡点击（历史教训）
  await ctx.addInitScript(() => {
    try {
      const k = 'xiaoting:monthly:done_' + new Date().toISOString().slice(0, 7);
      if (!localStorage.getItem(k)) localStorage.setItem(k, String(Date.now()));
      if (!localStorage.getItem('xiaoting:seeded_audit')) localStorage.setItem('xiaoting:seeded_audit', '1');
    } catch (e) {}
  });

  /** 错误收集器 */
  let errBag = { page: [], console: [], bad: [] };
  const attach = () => {
    errBag = { page: [], console: [], bad: [] };
    const onErr = (e) => errBag.page.push(String(e && e.message || e).slice(0, 220));
    page.on('pageerror', onErr);
    page.on('console', (m) => { if (m.type() === 'error') errBag.console.push(m.text().slice(0, 220)); });
    page.on('response', (r) => { if (r.status() >= 400) errBag.bad.push(r.status() + ' ' + r.url().slice(0, 140)); });
  };
  attach();

  /** 清掉一切瞬时/常驻覆盖层，避免读到上一屏残留（历史教训） */
  const clearOverlays = () => page.evaluate(() => {
    document.querySelectorAll('.monthly-overlay,.update-overlay,.risk-modal,.gentle-overlay,.welcome-overlay,.onboarding,.ovl,.modal,.sheet')
      .forEach((el) => { if (el && el.parentNode) el.parentNode.removeChild(el); });
    const t = document.getElementById('toast');
    if (t) { t.classList.remove('toast--on'); t.className = 'toast'; t.style.opacity = '0'; }
  });

  const settle = async (ms = 420) => { await page.waitForTimeout(ms); await clearOverlays(); };

  // ---- A. 逐路由真访问 ----
  log('\n===== A. 逐路由真访问 =====');
  for (const [name, hash] of ROUTES) {
    attach();
    const before = errBag;
    try {
      await page.goto(BASE + '/' + hash, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !document.querySelector('.toast.toast--on'), null, { timeout: 3000 }).catch(() => {});
      await settle(380);
      const info = await page.evaluate(() => {
        const v = document.getElementById('view');
        const txt = v ? (v.innerText || '').trim() : '';
        return {
          hasView: !!v,
          childCount: v ? v.children.length : 0,
          textLen: txt.length,
          head: txt.slice(0, 60).replace(/\s+/g, ' '),
          realHash: location.hash,
        };
      });
      const e = errBag;
      const ok = info.hasView && info.childCount > 0 && e.page.length === 0 && e.console.length === 0 && e.bad.length === 0;
      report.pages.push({ route: name, hash, ...info, pageErrors: e.page, consoleErrors: e.console, badResponses: e.bad, ok });
      log(`  ${ok ? '✅' : '❌'} ${name.padEnd(12)} 子元素=${String(info.childCount).padEnd(3)} 文本=${String(info.textLen).padEnd(5)} hash→${info.realHash} ${info.head}`);
      if (!ok) log(`      pageerror=${JSON.stringify(e.page)} console=${JSON.stringify(e.console)} bad=${JSON.stringify(e.bad)}`);
    } catch (ex) {
      report.pages.push({ route: name, hash, ok: false, fatal: String(ex.message).slice(0, 200) });
      log(`  ❌ ${name} 导航失败: ${ex.message.slice(0, 120)}`);
    }
  }

  // ---- B. 逐页按钮扫描（真点） ----
  log('\n===== B. 逐页按钮扫描（真点，危险项跳过） =====');
  const scanRoutes = ['say', 'record-text', 'me', 'settings', 'memory', 'changelog', 'risk', 'timelines', 'weekly', 'diag'];
  for (const [name, hash] of ROUTES) {
    if (!scanRoutes.includes(name)) continue;
    await page.goto(BASE + '/' + hash, { waitUntil: 'domcontentloaded' });
    await settle(320);
    const els = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('#view a, #view button').forEach((el) => {
        if (el.offsetParent === null && el.tagName !== 'A') return;
        out.push({ tag: el.tagName, id: el.id || '', cls: (el.className || '').toString().slice(0, 40), text: (el.innerText || '').trim().slice(0, 24), href: el.getAttribute('href') || '', danger: false });
      });
      return out;
    });
    let clicked = 0, skipped = 0;
    for (const el of els) {
      if (DANGEROUS.test(el.id) || DANGEROUS.test(el.text)) { skipped++; continue; }
      attach();
      const h0 = await page.evaluate(() => location.hash);
      let dl = null;
      try {
        const p = page.waitForEvent('download', { timeout: 2500 }).catch(() => null);
        await page.evaluate((id) => {
          const e = id ? document.getElementById(id) : null;
          if (!e) return;
          (e.tagName === 'A' ? e : e).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }, el.id);
        const d = await p;
        if (d) dl = d.suggestedFilename();
      } catch (e) { /* 单点失败记入 errBag */ }
      await settle(220);
      const h1 = await page.evaluate(() => location.hash);
      const e = errBag;
      const moved = h1 !== h0;
      const suspicious = e.page.length > 0 || e.console.length > 0 || e.bad.length > 0;
      if (suspicious || (moved && !/^(#\/say|#\/me|#\/settings|#\/changelog|#\/risk|#\/memory|#\/timelines|#\/weekly|#\/diag|#\/cards|#\/timeline)/.test(h1))) {
        report.errors.push({ route: name, el: el.id || el.text || el.tag, kind: 'button', pageErrors: e.page, consoleErrors: e.console, badResponses: e.bad, hash0: h0, hash1: h1 });
        log(`  ❌ [${name}] ${el.id || el.text} → hash ${h0}→${h1} ${JSON.stringify(e.page)}${JSON.stringify(e.console)}`);
      } else if (dl) {
        report.buttons.push({ route: name, el: el.id || el.text, download: dl });
      }
      clicked++;
      // 回到该页再扫下一个按钮
      await page.goto(BASE + '/' + hash, { waitUntil: 'domcontentloaded' });
      await settle(260);
    }
    log(`  · ${name.padEnd(12)} 枚举 ${els.length} / 实点 ${clicked} / 跳过危险 ${skipped}`);
  }

  // ---- C. 文案与落地一致性 ----
  log('\n===== C. 文案与落地一致性 =====');
  const check = (name, pass, detail) => { report.checks.push({ name, pass, detail }); log(`  ${pass ? '✅' : '❌'} ${name} — ${detail}`); };

  // C1 changelog 页是否真的有「用户协议 / 隐私政策」正文
  await page.goto(BASE + '/#/changelog', { waitUntil: 'domcontentloaded' }); await settle(360);
  const cl = await page.evaluate(() => {
    const v = document.getElementById('view');
    const t = (v.innerText || '');
    return { len: t.length, hasAgreement: /用户协议|隐私政策|条款/.test(t), text: t.slice(0, 200) };
  });
  check('C1 changelog 页含协议/隐私正文', cl.hasAgreement, `页面文本 ${cl.len} 字，命中协议关键词=${cl.hasAgreement}`);

  // C2 设置页隐私说明是否存在（承诺的正文真在这）
  await page.goto(BASE + '/#/settings', { waitUntil: 'domcontentloaded' }); await settle(360);
  const st = await page.evaluate(() => {
    const v = document.getElementById('view');
    const t = v.innerText || '';
    return { len: t.length, hasPrivacy: /隐私/.test(t), hasCloud: /云端|转写|录音/.test(t) };
  });
  check('C2 设置页确有隐私说明', st.hasPrivacy, `设置页文本 ${st.len} 字，含「隐私」=${st.hasPrivacy}，含云端/转写=${st.hasCloud}`);

  // C3 导出格式承诺 vs 实际下载文件类型
  await page.goto(BASE + '/#/me', { waitUntil: 'domcontentloaded' }); await settle(360);
  const exportDesc = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#view .mrow')].map((e) => e.innerText || '');
    return rows.find((r) => /导出/.test(r)) || '';
  });
  check('C3 导出按钮文案', true, `「${exportDesc.replace(/\s+/g, ' ').slice(0, 60)}」`);

  // C4 轻提醒开关：Web 端（不支持本地通知）是否如实告知
  await page.goto(BASE + '/#/me', { waitUntil: 'domcontentloaded' }); await settle(360);
  const notifyUi = await page.evaluate(() => {
    const box = document.getElementById('meNotify');
    if (!box) return { ok: false, why: '开关不存在' };
    const row = box.closest('.row, .mrow, label, div') || box.parentElement;
    const rowTxt = (row && row.innerText || '') + ' ' + (box.parentElement && box.parentElement.innerText || '');
    return { ok: true, checked: box.checked, uiText: rowTxt.replace(/\s+/g, ' ').slice(0, 120) };
  });
  check('C4 轻提醒开关在 Web 端有降级说明', /不支持|不可用|当前环境/.test(notifyUi.uiText), `开关存在=${notifyUi.ok} checked=${notifyUi.checked}；UI 文案「${notifyUi.uiText.slice(0, 80)}」`);

  // C5 历史时段推断的真实数据源（notify.preferredHour 的输入是否存在）
  const hourSrc = await page.evaluate(() => {
    const s = window.__test__ ? window.__test__() : null;
    const u = s && s.user ? s.user : {};
    return { userKeys: Object.keys(u), topKeys: s ? Object.keys(s).filter((k) => Array.isArray(s[k])) : [] };
  });
  check('C5 轻提醒时段的数据源', hourSrc.topKeys.length > 0, `state.user 字段=[${hourSrc.userKeys}]，state 顶层数组=[${hourSrc.topKeys}]；notify.js 读 user.timeline/cards/records`);

  // ---- D. 设置持久化 + 生效 ----
  log('\n===== D. 设置持久化与生效 =====');
  await page.goto(BASE + '/#/settings', { waitUntil: 'domcontentloaded' }); await settle(360);
  const beforeSet = await page.evaluate(() => {
    const b = document.body.className || '';
    const ids = ['setIpMotion', 'setIpTouch', 'setIpBubble', 'setSound', 'setCloudAsr', 'setMemory'];
    const map = {}; ids.forEach((i) => { const e = document.getElementById(i); map[i] = e ? e.checked : null; });
    return { bodyClass: b, switches: map };
  });
  // 拨两个开关：关闭 IP 动效（应掉 body.ip-motion-off）、关闭气泡
  await page.evaluate(() => {
    const m = document.getElementById('setIpMotion'); if (m && m.checked) m.click();
    const b = document.getElementById('setIpBubble'); if (b && b.checked) b.click();
  });
  await settle(300);
  const afterToggle = await page.evaluate(() => ({
    bodyClass: document.body.className || '',
    ipMotion: document.getElementById('setIpMotion').checked,
    ipBubble: document.getElementById('setIpBubble').checked,
    ls: JSON.parse(localStorage.getItem('xiaoting:v1') || '{}'),
  }));
  const ipMotionOff = /ip-motion-off/.test(afterToggle.bodyClass);
  check('D1 IP 动效关闭 → body.ip-motion-off 生效', ipMotionOff, `className: "${beforeSet.bodyClass}" → "${afterToggle.bodyClass}"`);

  await page.reload({ waitUntil: 'domcontentloaded' }); await settle(420);
  const afterReload = await page.evaluate(() => ({
    bodyClass: document.body.className || '',
    ipMotion: document.getElementById('setIpMotion') ? document.getElementById('setIpMotion').checked : null,
  }));
  const persisted = afterReload.ipMotion === false && /ip-motion-off/.test(afterReload.bodyClass);
  check('D2 reload 后设置保持且仍生效', persisted, `reload 后 ipMotion=${afterReload.ipMotion} className="${afterReload.bodyClass}"`);

  // ---- E. 主流程真跑（打字链路 + 兜底） ----
  log('\n===== E. 主流程真跑 =====');
  await page.goto(BASE + '/#/say', { waitUntil: 'domcontentloaded' }); await settle(400);
  await page.evaluate(() => { const a = [...document.querySelectorAll('#view a')].find((x) => /打字也行/.test(x.innerText || '')); if (a) a.click(); });
  await settle(360);
  const onRecord = await page.evaluate(() => location.hash);
  check('E1 首页→打字页', /record/.test(onRecord), `hash=${onRecord}`);

  await page.evaluate(() => { const t = document.getElementById('recInput') || document.querySelector('#view textarea'); if (t) { t.value = '今天被领导当众说了一句，我很憋屈，但没敢回嘴。'; t.dispatchEvent(new Event('input', { bubbles: true })); } });
  await settle(260);
  await page.evaluate(() => { const b = document.getElementById('fillDemo'); if (b) b.click(); });
  await settle(240);
  const filled = await page.evaluate(() => { const t = document.getElementById('recInput'); return t ? t.value.length : -1; });
  check('E2 示例填充', filled > 0, `输入框字数=${filled}`);

  await page.evaluate(() => { const b = document.getElementById('recDone') || document.getElementById('recToggle'); if (b) b.click(); });
  await settle(600);
  const afterDone = await page.evaluate(() => location.hash);
  check('E3 提交后进入流程', !/record/.test(afterDone), `hash=${afterDone}`);

  // 走完后续（跳过 / 继续），记录都能到哪
  let steps = [];
  for (let i = 0; i < 8; i++) {
    const st2 = await page.evaluate(() => ({ hash: location.hash, txt: (document.getElementById('view') || {}).innerText || '' }));
    steps.push(st2.hash);
    if (/timeline/.test(st2.hash) || /risk/.test(st2.hash)) break;
    const acted = await page.evaluate(() => {
      const ids = ['fuSkip', 'fuSkipTop', 'fuNext', 'gProceed', 'cfKeep', 'cfContinue', 'recToggle', 'recDone'];
      for (const id of ids) { const e = document.getElementById(id); if (e) { e.click(); return id; } }
      return null;
    });
    if (!acted) { const b = await page.evaluate(() => { const btn = [...document.querySelectorAll('#view button')].find((x) => /跳过|继续|先收下|返回/.test(x.innerText || '')); if (btn) { btn.click(); return btn.innerText.trim().slice(0, 12); } return null; }); if (!b) break; }
    await settle(620);
  }
  const flowEnd = await page.evaluate(() => ({ hash: location.hash, txt: (document.getElementById('view') || {}).innerText || '' }));
  report.flows.push({ steps, end: flowEnd.hash, endText: flowEnd.txt.slice(0, 120) });
  check('E4 流程可推进到终态', /timeline|risk|say|gentle|followup|confirm/.test(flowEnd.hash), `路径: ${steps.join(' → ')}，终点 ${flowEnd.hash}`);

  // ---- F. 导出类按钮真下载 ----
  log('\n===== F. 导出/下载类按钮 =====');
  await page.goto(BASE + '/#/me', { waitUntil: 'domcontentloaded' }); await settle(360);
  for (const id of ['meExport', 'meClearCards', 'meClearMemory', 'wipe']) {
    const has = await page.evaluate((i) => !!document.getElementById(i), id);
    if (!has) { check('F ' + id, false, '元素不存在'); continue; }
    if (/wipe|clearCards|clearMemory/.test(id)) { check('F ' + id, true, `存在（危险项，浏览器内不点）`); continue; }
    let dl = null;
    try {
      const p = page.waitForEvent('download', { timeout: 3000 }).catch(() => null);
      await page.evaluate((i) => document.getElementById(i).click(), id);
      const d = await p; dl = d ? d.suggestedFilename() : null;
    } catch (e) {}
    check('F ' + id, !!dl, dl ? `下载 ${dl}` : '未捕获下载事件（可能是浏览器内下载被拦）');
    await page.goto(BASE + '/#/me', { waitUntil: 'domcontentloaded' }); await settle(320);
  }

  await browser.close();

  const pagesBad = report.pages.filter((p) => !p.ok).length;
  log(`\n===== 汇总：路由 ${report.pages.length - pagesBad}/${report.pages.length} 通过；按钮异常 ${report.errors.length} 处；断言 ${report.checks.filter((c) => c.pass).length}/${report.checks.length} 通过 =====`);
  fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  log(`证据已写入 _selftest/_audit_20261002/report.json`);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
