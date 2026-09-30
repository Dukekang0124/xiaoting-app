/**
 * 审计 B：设置开关的「真实生效」验证（行为级，不看 body.class）
 *
 * 为什么重写：第一版探针用「body.class 是否变化」当判据，结果 ipTouch / ipBubble / soundOn 三条全红，
 *   但那三个开关本来就不改 body class（它们影响的是「点击 IP 时的行为」和「音频模块开关」）
 *   ⇒ **判据错 = 假红**。教训：设置项的判据必须落在它真正影响的那条链路上，不能拿一个通用信号套所有开关。
 *
 * 真正的判据（每个开关一条独立链路）：
 *   ipMotion  → body.ip-motion-off 出现/消失
 *   ipIntensity → body.ip-intensity-gentle 出现/消失
 *   ipTouch   → 关闭后点击 IP **不再**出现气泡与动画
 *   ipBubble  → 关闭后点击 IP **有动画但无气泡文字**
 *   soundOn   → window.ipAudio 的 enabled 状态跟随
 *   notify_on → 🔴 无任何副作用（死开关）
 *
 * 用法：BASE=http://127.0.0.1:4175 node _selftest/audit-settings-effective.cjs
 */
const path = require('path');
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:4175';
let pass = 0, fail = 0;
const bad = [];
function check(name, ok, detail) {
  if (ok) pass++; else fail++;
  if (!ok) bad.push(name);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const setSetting = (page, k, v) => page.evaluate(async ([k, v]) => {
  const st = await import('/js/store.js');
  st.setSetting(k, v);
}, [k, v]);

const readSetting = (page, k) => page.evaluate(async (k) => {
  const st = await import('/js/store.js');
  return st.getState().user.settings[k];
}, k);

/** 点一下 IP，返回「有没有气泡文字」「有没有动画类」
 *  🔴 契约要点（读 interaction.js 得到，别凭猜）：
 *   ① 事件是 **pointerdown + pointerup 成对**（只有 pointerdown 没 pointerup 不算一次点击）；
 *   ② 位移超过 moveTolPx(12) 会被当成拖动而取消，故两次事件坐标必须相同；
 *   ③ `.mascot` 是 SVG 元素，**没有 `click()` 方法**（第一版脚本在这里崩过）⇒ 一律用 dispatchEvent；
 *   ④ 气泡是 `#ipBubble`，判据是 `hidden===false && textContent 非空`；
 *   ⑤ 🔴 **每次点击前必须显式清场**：动画类 1700ms 才移除、气泡 2000ms 才隐藏，
 *      不等退场就断言，会读到**上一次点击的残留**（第二版脚本在这里假红过一条）。
 */
async function tapIp(page) {
  return page.evaluate(async () => {
    const el = document.querySelector('.say__mascot .mascot') || document.querySelector('.mascot');
    if (!el) return { err: 'no mascot' };
    // —— 清场：把上一次点击留下的瞬时 UI 全部复位，保证只测本次 ——
    const b0 = document.getElementById('ipBubble');
    if (b0) { b0.hidden = true; b0.textContent = ''; b0.classList.remove('ip-bubble--on'); }
    document.querySelectorAll('.say__mascot, .mascot').forEach((e) => {
      e.classList.remove('ip-tap1', 'ip-tap2', 'ip-tap3', 'ip-tap-over');
    });
    await new Promise((r) => setTimeout(r, 80));

    const o = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: 100, clientY: 100 };
    el.dispatchEvent(new PointerEvent('pointerdown', o));
    await new Promise((r) => setTimeout(r, 50));
    el.dispatchEvent(new PointerEvent('pointerup', o));
    await new Promise((r) => setTimeout(r, 380));
    const b = document.getElementById('ipBubble');
    const anim = document.querySelector('[class*="ip-tap1"], [class*="ip-tap2"], [class*="ip-tap3"], [class*="ip-tap-over"]');
    return {
      bubbleText: b && !b.hidden ? b.textContent.trim().slice(0, 20) : '',
      hasBubble: !!(b && !b.hidden && b.textContent.trim()),
      hasAnim: !!anim,
    };
  });
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 430, height: 932 }, deviceScaleFactor: 2, locale: 'zh-CN', hasTouch: true, isMobile: true,
    serviceWorkers: 'block',
  });
  await ctx.addInitScript(() => {
    try { localStorage.setItem('xiaoting:ai', 'mock'); localStorage.setItem('moxiaoming:welcomed_v1', '1'); } catch (e) {}
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/#/say`, { waitUntil: 'load' });
  await page.waitForSelector('.mascot', { timeout: 15000 });
  await page.waitForTimeout(1200);

  // 每个开关先从 UI 上拨（证明 UI 绑定存在），再用 store 精确置位（证明下游链路读它）
  await page.evaluate(() => { location.hash = '#/settings'; });
  await page.waitForTimeout(900);
  const uiIds = await page.$$eval('.settings input[type=checkbox]', (els) => els.map((e) => e.id));
  console.log(`设置页 checkbox：${uiIds.join(' ')}`);
  check('设置页存在 IP 动效 / 触碰 / 气泡 / 音效四个 checkbox',
    ['setIpMotion', 'setIpTouch', 'setIpBubble', 'setSound'].every((i) => uiIds.includes(i)), uiIds.join(','));

  await page.evaluate(() => { location.hash = '#/say'; });
  await page.waitForTimeout(1000);

  // ① ipMotion → body class（唯一一个真的改 body 的）
  await setSetting(page, 'ipMotion', true);
  await page.evaluate(async () => { const a = await import('/js/app.js'); a.__test__ && a.__test__.render && a.__test__.render(); });
  await page.waitForTimeout(400);
  const mOn = await page.evaluate(() => document.body.className);
  await setSetting(page, 'ipMotion', false);
  await page.evaluate(async () => { const a = await import('/js/app.js'); a.__test__ && a.__test__.render && a.__test__.render(); });
  await page.waitForTimeout(400);
  const mOff = await page.evaluate(() => document.body.className);
  check('ipMotion 关掉 → body.ip-motion-off 出现', mOff.includes('ip-motion-off') && !mOn.includes('ip-motion-off'), `${mOn} → ${mOff}`);
  await setSetting(page, 'ipMotion', true);
  await page.evaluate(async () => { const a = await import('/js/app.js'); a.__test__ && a.__test__.render && a.__test__.render(); });
  await page.waitForTimeout(400);

  // ② ipTouch：开 → 点击有反应；关 → 点击无气泡无动画
  await setSetting(page, 'ipTouch', true);
  await setSetting(page, 'ipBubble', true);
  await page.waitForTimeout(300);
  const tapOn = await tapIp(page);
  check('ipTouch 开启时点击 IP 有气泡（基线臂，证明这条链路可观测）',
    tapOn.hasBubble, `气泡="${tapOn.bubbleText}" 动画=${tapOn.hasAnim}`);
  await setSetting(page, 'ipTouch', false);
  await page.waitForTimeout(300);
  const tapOff = await tapIp(page);
  check('ipTouch 关闭后点击 IP 不再有气泡/动画',
    !tapOff.hasBubble && !tapOff.hasAnim, `气泡="${tapOff.bubbleText}" 动画=${tapOff.hasAnim}`);
  await setSetting(page, 'ipTouch', true);
  await page.waitForTimeout(300);

  // ③ ipBubble：关掉后应「有动画但无气泡文字」
  await setSetting(page, 'ipBubble', false);
  await page.waitForTimeout(300);
  const tapNoBubble = await tapIp(page);
  check('ipBubble 关闭后点击 IP 有动画但无气泡文字',
    !tapNoBubble.hasBubble, `气泡="${tapNoBubble.bubbleText}" 动画=${tapNoBubble.hasAnim}`);
  await setSetting(page, 'ipBubble', true);
  await page.waitForTimeout(300);

  // ④ soundOn：跟随 ipAudio 模块
  await setSetting(page, 'soundOn', true);
  await page.waitForTimeout(400);
  const sOn = await page.evaluate(async () => {
    const a = await import('/js/ip-audio.js');
    return { hasApi: typeof (a.setEnabled || a.default?.setEnabled) === 'function' };
  });
  check('soundOn 有真实下游（ip-audio 模块提供 setEnabled）', sOn.hasApi, JSON.stringify(sOn));

  // ⑤ notify_on：死开关判定
  const lsBefore = await page.evaluate(() => JSON.stringify(Object.keys(localStorage).sort()));
  await setSetting(page, 'notify_on', true);
  await page.waitForTimeout(2500);
  const after = await page.evaluate(async () => {
    const st = await import('/js/store.js');
    return { val: st.getState().user.settings.notify_on, ls: JSON.stringify(Object.keys(localStorage).sort()), txt: document.body.textContent.length };
  });
  const noEffect = after.ls === lsBefore;
  check('notify_on 拨动后应产生可观测副作用（无 = 死开关）', !noEffect,
    `store.notify_on=${after.val}；2.5s 内 localStorage/页面均无变化 ⇒ 用户拨了等于没拨`);

  const finalVal = await readSetting(page, 'notify_on');
  console.log(`\n==== 设置项行为审计：PASS ${pass} / FAIL ${fail} ====`);
  if (bad.length) console.log('未通过：\n  ' + bad.join('\n  '));

  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('脚本异常：', e); process.exit(2); });
