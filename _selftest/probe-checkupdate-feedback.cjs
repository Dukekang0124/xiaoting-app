/**
 * 确证：「检查更新」点击后是否有任何用户可见反馈？
 *
 * 背景：通牒文档称「点检查更新提示深海信号微弱 ⇒ 接口彻底失败」。
 *  实测线上 /version.json 三通道正常（13175B 合法 JSON，latest=1.3.5），
 *  真浏览器 checkUpdate({manual:true}) 返回 {reason:'no_update'}。
 *  但调用处是 `update.checkUpdate({manual:true}).catch(()=>{})` —— 没有任何 else 分支。
 *  ⇒ 假设：**用户点了「检查更新」，因为已是最新版，页面毫无反应**，体感就是"连不上"。
 *  这是可本机复现的 UX 缺陷，与接口无关。
 *
 * 判据：
 *   A. 更新历史列表能否正常渲染（"深海信号微弱"只应出现在这条链路失败时）
 *   B. 点击「检查更新」后 1.5s 内，有无任何可见反馈（toast / 弹窗 / 文案变化）
 */
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:4176';
let pass = 0, fail = 0;
const check = (n, ok, d) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`); };

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 430, height: 932 }, locale: 'zh-CN', serviceWorkers: 'block' });
  // 关掉首次欢迎浮层，否则 welcome-overlay 会拦截点击（intercepts pointer events）
  await ctx.addInitScript(() => {
    try { localStorage.setItem('moxiaoming:welcomed_v1', '1'); localStorage.setItem('xiaoting:ai', 'mock'); } catch (e) {}
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));

  await page.goto(`${BASE}/#/changelog`, { waitUntil: 'load' });
  await page.waitForTimeout(2500);

  // A. 更新历史是否渲染成功
  const listState = await page.evaluate(() => {
    const el = document.getElementById('clList');
    return { text: el ? el.textContent.trim().slice(0, 120) : '(无)', items: el ? el.querySelectorAll('.cl-item').length : 0 };
  });
  check('更新历史列表渲染成功（不是「深海信号微弱」降级）',
    listState.items > 0, `条目=${listState.items} 首段="${listState.text}"`);
  if (/深海信号微弱/.test(listState.text)) {
    console.log('   ⚠ 命中降级文案 —— 说明这条链路确实失败（本机环境无网络后端时属预期）');
  }

  // B. 点「检查更新」后有无可见反馈
  const before = await page.evaluate(() => ({
    toast: !!document.querySelector('.toast--on'),
    overlay: document.querySelectorAll('.update-overlay, .install-overlay').length,
    bodyText: document.body.textContent.length,
  }));
  const btn = await page.$('#clCheck');
  check('存在「检查更新」按钮', !!btn, btn ? '' : '未找到 #clCheck');
  if (btn) {
    await btn.click();
    await page.waitForTimeout(1500);
    const after = await page.evaluate(() => ({
      toast: !!document.querySelector('.toast--on'),
      overlay: document.querySelectorAll('.update-overlay, .install-overlay').length,
      bodyText: document.body.textContent.length,
    }));
    const anyFeedback = after.toast !== before.toast || after.overlay > 0 || after.bodyText !== before.bodyText;
    check('点击「检查更新」后有用户可见反馈（已是最新版时也应提示）', anyFeedback,
      `toast=${before.toast}→${after.toast} 弹窗=${before.overlay}→${after.overlay} 文本长度=${before.bodyText}→${after.bodyText}`);
    if (!anyFeedback) {
      console.log('\n  🔴 确证缺陷：点击「检查更新」在「已是最新版」时**零反馈**');
      console.log('     调用处为 update.checkUpdate({manual:true}).catch(()=>{})，无 else 分支 ⇒');
      console.log('     用户视角 = 点了没反应 = 「更新功能坏了/连不上」。这与接口是否可用无关。');
    }
  }

  check('无未捕获异常', errs.length === 0, errs.slice(0, 2).join(' | '));
  console.log(`\n==== ${pass}/${pass + fail} ====`);
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('异常：', e); process.exit(2); });
