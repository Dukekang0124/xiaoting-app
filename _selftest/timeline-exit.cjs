/**
 * 墨小溟 · 「结束倾诉 → 时间线 → 左滑退出」落点回归探针（#261 修复）
 *
 * 康哥反馈：结束倾诉后进入时间线页，点保存图片，再左滑退出，落点不对（被扔到「我的」而非回首页）。
 * 根因：BACK_PARENT.timeline 一律映射到 'me'，没区分「实时时间线（来自结束倾诉）」与「回看时间线」。
 * 修复：实时时间线（#/timeline 无 id）退出回首页 'say'；回看时间线（#/timeline?id=xxx）退出回 'me'。
 *
 * 本探针验证两句话：
 *   ① 实时时间线左滑退出 ⇒ 落到 #/say（首页）
 *   ② 回看时间线左滑退出 ⇒ 落到 #/me（我的） —— 不能因为修了 ① 把这个也带歪
 *
 * 用数据代替猜：直接模拟左边缘右划，读真实路由落点。
 * 手势模拟严格复用 _selftest/swipe-selftest.cjs 已验证可用的配方：
 *   isMobile+hasTouch 上下文 + 完整 page.goto(BASE+hash) + page.mouse 左边缘右拖。
 *   （缺 isMobile 时 page.mouse 不会转成手势 handler 能接住的指针事件，落点会保持不变 = 假红。）
 * 运行：NODE_PATH=<workspace>/node_modules node _selftest/timeline-exit.cjs   （BASE 由门禁注入）
 */
const { chromium } = require('C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules/playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:4173';

let pass = 0, failN = 0;
const ok = (m) => { console.log('  ✓ ' + m); pass++; };
const bad = (m) => { console.error('  ✗ ' + m); failN++; };

async function swipeExit(page, hash) {
  await page.goto(BASE + hash, { waitUntil: 'load' });
  await page.waitForTimeout(450);
  // 左边缘右拖：起手区 [0,28]，commit 阈值 34% 屏宽（390→≈133px）。
  await page.mouse.move(10, 420);
  await page.mouse.down();
  await page.mouse.move(70, 420, { steps: 4 });
  await page.mouse.move(300, 420, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(650);
  return page.evaluate(() => location.hash);
}

(async () => {
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || 'chrome', headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'zh-CN',
    isMobile: true, hasTouch: true,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('  [pageerror]', e.message));

  // 每次导航前预置：跳过首启引导；注入一条回看时间线（reviewx）供 ② 使用。
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('moxiaoming:welcomed_v1', '1');
      const s = JSON.parse(localStorage.getItem('xiaoting:v1') || '{}');
      s.timelines = s.timelines || [];
      if (!s.timelines.some((t) => t.id === 'reviewx')) s.timelines.push({ id: 'reviewx', type: 'no-emotion' });
      localStorage.setItem('xiaoting:v1', JSON.stringify(s));
    } catch (e) { /* ignore */ }
  });

  console.log('[timeline-exit] ① 实时时间线（#/timeline 无 id）左滑退出应回 #/say');
  {
    const got = await swipeExit(page, '/#/timeline');
    if (got === '#/say') ok('实时时间线左滑退出 → #/say');
    else bad(`实时时间线左滑退出落点 = ${got}（应为 #/say）`);
  }

  console.log('[timeline-exit] ② 回看时间线（#/timeline?id=reviewx）左滑退出应回 #/me');
  {
    const got = await swipeExit(page, '/#/timeline?id=reviewx');
    if (got === '#/me') ok('回看时间线左滑退出 → #/me');
    else bad(`回看时间线左滑退出落点 = ${got}（应为 #/me）`);
  }

  await browser.close();
  console.log(`\n[timeline-exit] 通过 ${pass} / 失败 ${failN}`);
  process.exit(failN ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
