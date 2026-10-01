/**
 * 一次性鉴别力校验：证明 selftest 里「Capacitor 就位即认作 APK」这条断言**真的能抓到缺陷**。
 * 做法：A/B 换源码 js/update.js —— 新版（Capacitor 判据）vs 旧版（只认 UA 标记），
 *       跑同一套判定，期望 新=红转绿 / 旧=红。若两版都绿，说明断言没鉴别力。
 *
 * 用法：先起根服务，再 BASE=http://127.0.0.1:4173 node _selftest/platform-cap-abi.cjs
 */
const path = require('path');
const fs = require('fs');
const NODE_PATH = process.env.NODE_PATH || '';
if (NODE_PATH) module.paths.push(...NODE_PATH.split(path.delimiter));
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const BASE = process.env.BASE || 'http://127.0.0.1:4173';

(async () => {
  const target = path.join(ROOT, 'js', 'update.js');
  const newSrc = fs.readFileSync(target, 'utf8');
  if (!/isNativeApp\(\)/.test(newSrc)) {
    console.error('✗ 当前 js/update.js 里没有 isNativeApp() —— 新版判据不在，无法做这个 A/B');
    process.exit(1);
  }
  // 旧版：把 isApk 的判定退回"只认 UA 标记 / ?app=android"
  const oldSrc = newSrc.replace(
    /const isApk = isNativeApp\(\)\s*\n\s*\|\| /,
    'const isApk = false\n    || ',
  );
  if (oldSrc === newSrc) { console.error('✗ 未能构造出旧版（正则没命中）'); process.exit(1); }

  const browser = await chromium.launch({ channel: 'chrome' });
  let pass = 0, fail = 0;
  const ok = (c, label, extra = '') => {
    if (c) { pass++; console.log(`  ✅ ${label}${extra ? '  — ' + extra : ''}`); }
    else { fail++; console.log(`  ❌ ${label}${extra ? '  — ' + extra : ''}`); }
  };

  async function measure(label) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
    await ctx.addInitScript(() => {
       try { localStorage.setItem('monthly:done_' + (new Date().getFullYear() * 100 + (new Date().getMonth() + 1)), '1'); } catch (e) {}
      window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', platform: 'android' };
      try { localStorage.setItem('moxiaoming:welcomed_v1', '1'); } catch (e) {}
    });
    const page = await ctx.newPage();
    // URL 不带 ?app=android、UA 不带标记 —— 只靠 Capacitor 桥
    await page.goto(BASE + '/#/say', { waitUntil: 'domcontentloaded' });
    const r = await page.evaluate(async () => {
      const u = await import('/js/update.js?bust=' + Date.now());
      const p = u.platform();
      return { isApk: p.isApk, ua: p.ua.slice(0, 40) };
    });
    await ctx.close();
    console.log(`  [${label}] isApk=${r.isApk}`);
    return r;
  }

  try {
    console.log('\n──────── variant = new（当前代码，期望 isApk=true）────────');
    fs.writeFileSync(target, newSrc);
    const N = await measure('new');
    console.log('  断言：');
    ok(N.isApk === true, '★ 新版：Capacitor 就位即认作 APK（不依赖从未设过的 UA 标记）', JSON.stringify(N));
    // 控制：同一页面在没有 Capacitor 时应为 false（防"永远 true"）
    const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
    const page2 = await ctx2.newPage();
    await page2.goto(BASE + '/#/say', { waitUntil: 'domcontentloaded' });
    const PF = await page2.evaluate(async () => (await import('/js/update.js?bust=' + Date.now())).platform().isApk);
    await ctx2.close();
    console.log(`  [new/无 Capacitor] isApk=${PF}`);
    ok(PF === false, '★ 新版鉴别力反向：普通浏览器仍不认作 APK', String(PF));

    console.log('\n──────── variant = old（判据退回只认 UA，期望 isApk=false=红）────────');
    fs.writeFileSync(target, oldSrc);
    const O = await measure('old');
    console.log('  断言（这些是**刻意的反向断言**，它们成立 = 旧版确实坏）：');
    ok(O.isApk === false, '旧版：真机壳里 isApk=false（缺陷本体，弹窗按钮会走 Web 分支只刷新）');
  } finally {
    fs.writeFileSync(target, newSrc);
    const back = fs.readFileSync(target, 'utf8');
    if (back !== newSrc) { fail++; console.log('  ❌ js/update.js 未复原！请手工恢复'); }
    else console.log('\n  （js/update.js 已复原 ✓）');
  }

  await browser.close();
  console.log(`\n==== ${pass} 通过 / ${fail} 失败 ====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('异常：', e); process.exit(1); });
