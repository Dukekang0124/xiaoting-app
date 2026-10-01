/**
 * 更新提示「四象限」验收（v1.4.3）
 *
 * 范式来源：Sinoky 的 `_internal/fix-update-nag/test_nag.cjs` —— 它踩过一个很贵的坑：
 *   App 内提示「有新版——刷新页面更新」，但在 App 里刷新页面**不会带来任何变化**，
 *   于是提示反复出现、却永远更新不了。修完留下一套四象限测试防回归。
 *
 * 这里照搬它的四个象限（**原生端/网页端 × 版本相等/有新版本**），再补两个本仓特有的场景：
 *   · dismissed：用户拒绝过**这个版本** ⇒ 不再自动打扰（v1.4.3 新增，对齐 Sinoky 的 apkDismissed）
 *   · 假包拦截：HTTP 200 + HTML 也必须被拒（Sinoky/ChunkSpoke 都栽过的坑）
 *
 * 为什么必须分象限而不是写一条"能弹窗就行"：
 *   同一份代码在 App 里和在网页上**要做的事完全相反** ——
 *   App 里弹"刷新页面"是错的（刷了也没用），网页上弹"下载安装包"也是错的（它没安装包）。
 *   单一断言只能证明"能弹"，证明不了"弹对了"。
 *
 * 用法：BASE=http://127.0.0.1:4175 node _selftest/audit-update-quadrant.cjs
 */
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:4175';
let pass = 0, fail = 0;
const bad = [];
function check(name, ok, detail) {
  if (ok) pass++; else fail++;
  if (!ok) bad.push(name);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/** 造一份版本清单（形状与线上 /version.json 一致） */
const manifest = (latest) => JSON.stringify({
  latest_version: latest,
  release_notes: ['测试用更新说明'],
  download_url: `https://xiaoting.app.workbuddy.host/apk/Xiaoting-v${latest}-release.apk`,
  force_update: false,
  web_url: 'https://xiaoting.app.workbuddy.host/',
  apk: { versionCode: 99999, version: latest, url: `https://xiaoting.app.workbuddy.host/apk/Xiaoting-v${latest}-release.apk`, md5: '', size: 0, force: false },
});

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });

  // 先取到本版号，后面所有场景都以它为基准（不硬编码，发版后脚本不用改）
  const meta = await (async () => {
    const ctx = await browser.newContext({ viewport: { width: 430, height: 932 }, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/#/me`, { waitUntil: 'load' });
    const m = await page.evaluate(async () => {
      const u = await import('/js/update.js');
      return { app: window.APP_VERSION, latest: u.LATEST_VERSION };
    });
    await ctx.close();
    return m;
  })();
  const NEWER = meta.app.split('.').map((n, i) => (i === 1 ? Number(n) + 1 : n)).join('.'); // 1.4.3 -> 1.5.3
  console.log(`本版 APP_VERSION=${meta.app}，LATEST_VERSION=${meta.latest}，测试用"更新版"=${NEWER}\n`);

  /**
   * 跑一个象限。
   * @param {{name:string, native:boolean, online:string, dismissed?:string}}
   * @returns {{dialog:boolean, sub:string, manual:string, banner:boolean}}
   */
  async function quadrant(c) {
    const ctx = await browser.newContext({
      viewport: { width: 430, height: 932 }, locale: 'zh-CN',
      hasTouch: true, isMobile: true, serviceWorkers: 'block',
    });
    await ctx.addInitScript(([native, dismissed]) => {
      try {
        localStorage.setItem('xiaoting:ai', 'mock');
        localStorage.setItem('moxiaoming:welcomed_v1', '1');
        if (dismissed) localStorage.setItem('xiaoting:update_dismissed_ver', dismissed);
      } catch (e) {}
      if (native) {
        window.Capacitor = { isNativePlatform: () => true, Plugins: {} };
      }
    }, [c.native, c.dismissed || '']);

    const body = manifest(c.online);
    // 🔴 两个候选路径都要 mock：fetchManifest 先试 /api/version/latest，
    //    它在本地 server 上是真端点，只 mock /version.json 会走不到我们想要的输入。
    await ctx.route('**/api/version/latest', (r) => r.fulfill({ status: 200, contentType: 'application/json', body }));
    await ctx.route('**/version.json*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body }));
    /**
     * 外域一律打断，避免真联网（与 Sinoky 的做法一致）。
     *
     * 🔴 必须**排除**线上域名，否则原生端整个象限都是假的：
     *   原生端 `apiBase()` 返回绝对域名 `https://xiaoting.app.workbuddy.host`，
     *   版本清单请求走的是**外域**而不是 127.0.0.1 —— 通用打断规则一旦把它吃掉，
     *   fetchManifest 就失败、转而走硬编码兜底，于是「App内版本相等」那条会**假绿**
     *   （恰好等于期望值），而「App内有新版本」会假红。
     *   第一版脚本就是这么错的，靠"手动检查的文案里透出的线上版本号"才定位到。
     */
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)(?!xiaoting\.app\.workbuddy\.host)/, (r) => r.abort());

    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 120)));
    await page.goto(`${BASE}/#/me`, { waitUntil: 'load' });
    await page.waitForTimeout(2600); // 启动自动检测链

    const auto = await page.evaluate(() => {
      const ov = document.querySelector('.update-overlay');
      return { dialog: !!ov, sub: ov ? (ov.querySelector('.update-sub') || {}).textContent || '' : '' };
    });

    // 再走一次「关于墨小溟」页的手动检查（用户主动问，必须永远有回话）
    const manual = await page.evaluate(async () => {
      const u = await import('/js/update.js');
      const r = await u.checkUpdate({ manual: true });
      return (u.describeCheckResult(r) || {}).text || '';
    });

    await ctx.close();
    return Object.assign({ errs }, auto, { manual });
  }

  // ---------- ① 原生端 + 有新版本 → 必须弹，且不能是"刷新页面" ----------
  const Q1 = await quadrant({ name: 'apk-newer', native: true, online: NEWER });
  // 🛡 防假绿守卫：先确认注入的版本号真的被读到了。
  //    没有这条，下面任何"没弹窗"都可能是 mock 没生效造成的，而不是产品行为。
  check('象限① 守卫·注入的线上版本号确实被读到（mock 生效）',
    Q1.manual.includes(NEWER), `期望出现 ${NEWER}，actual="${Q1.manual}"`);
  check('象限① App内 + 有新版本 → 弹更新弹窗', Q1.dialog === true, `dialog=${Q1.dialog}`);
  // 🔴 这条是 Sinoky 那个坑的正面判据：App 里说"刷新页面"= 让用户做一件没用的事
  check('象限① App内文案不能是「刷新页面」（刷了也不会变，就是 Sinoky 踩的坑）',
    Q1.dialog && !/刷新/.test(Q1.sub), `sub="${Q1.sub}"`);

  // ---------- ② 原生端 + 版本相同 → 零打扰 ----------
  const Q2 = await quadrant({ name: 'apk-equal', native: true, online: meta.app });
  // 🛡 防假绿守卫：这个象限"没弹窗"是期望值，而 mock 失效时**也会**没弹窗 ⇒
  //    必须证明我们注入的版本号确实被读到了，否则这条断言恒真。
  check('象限② 守卫·线上版本号确实被读到（mock 生效，否则"没弹窗"恒真）',
    Q2.manual.includes(`线上 v${meta.app}`), `期望出现「线上 v${meta.app}」，actual="${Q2.manual}"`);
  check('象限② App内 + 已是最新 → 不弹任何东西（零打扰）', Q2.dialog === false, `dialog=${Q2.dialog}`);
  check('象限② 手动检查仍然有回话（不能因为"没新版"就沉默）',
    /已是最新/.test(Q2.manual), `manual="${Q2.manual}"`);

  // ---------- ③ 网页端 + 有新版本 → 可以提示（网页刷新是有效的） ----------
  const Q3 = await quadrant({ name: 'web-newer', native: false, online: NEWER });
  check('象限③ 网页端 + 有新版本 → 弹提示', Q3.dialog === true, `dialog=${Q3.dialog}`);
  check('象限③ 网页端文案是「刷新页面」（网页上刷新确实有效）',
    /刷新/.test(Q3.sub), `sub="${Q3.sub}"`);

  // ---------- ④ 用户拒绝过这个版本 → 不再自动打扰，但手动检查照常 ----------
  const Q4 = await quadrant({ name: 'apk-dismissed', native: true, online: NEWER, dismissed: NEWER });
  check('象限④ 拒绝过该版本 → 自动检测不再弹（不反复打扰）', Q4.dialog === false, `dialog=${Q4.dialog}`);
  check('象限④ 手动检查仍然给准确结论（主动问就必须答）',
    /稍后再说/.test(Q4.manual) || /发现新版本/.test(Q4.manual), `manual="${Q4.manual}"`);

  // ---------- ⑤ 假包拦截（单元级）：HTTP 200 + HTML 必须被拒 ----------
  const ctx5 = await browser.newContext({ viewport: { width: 430, height: 932 }, serviceWorkers: 'block' });
  const page5 = await ctx5.newPage();
  await page5.goto(`${BASE}/#/me`, { waitUntil: 'load' });
  const VAL = await page5.evaluate(async () => {
    const u = await import('/js/update.js');
    const html = new TextEncoder().encode('<!DOCTYPE HTML><html><body>Not Found</body></html>'.padEnd(9000, ' '));
    const apk = new Uint8Array(9000); apk[0] = 0x50; apk[1] = 0x4b; apk[2] = 0x03; apk[3] = 0x04;
    const png = new Uint8Array(9000); png[0] = 0x89; png[1] = 0x50;
    return {
      html: u.validateApkBytes(html, 'text/html; charset=utf-8'),
      apk: u.validateApkBytes(apk, 'application/vnd.android.package-archive'),
      png: u.validateApkBytes(png, 'image/png'),
      tiny: u.validateApkBytes(new Uint8Array(10), 'application/octet-stream'),
    };
  });
  await ctx5.close();
  check('假包·HTTP 200 的 HTML 被拒（Pages/Vercel 兜底页正是这种）',
    VAL.html.ok === false && VAL.html.reason === 'not_an_apk', JSON.stringify(VAL.html));
  check('假包·真 APK（PK\\x03\\x04）放行', VAL.apk.ok === true, JSON.stringify(VAL.apk));
  check('假包·PNG 等其它二进制也被拒（只要不是 ZIP 就不是安装包）',
    VAL.png.ok === false, JSON.stringify(VAL.png));
  check('假包·过小文件被拒', VAL.tiny.ok === false && VAL.tiny.reason === 'download_too_small', JSON.stringify(VAL.tiny));

  const allErrs = [].concat(Q1.errs, Q2.errs, Q3.errs, Q4.errs).filter((e) => !/favicon|net::ERR_|Failed to load/i.test(e));
  check('四象限全程无未捕获异常', allErrs.length === 0, allErrs.slice(0, 3).join(' | '));

  console.log(`\n==== 更新提示四象限：PASS ${pass} / FAIL ${fail} ====`);
  if (bad.length) console.log('未通过：\n  ' + bad.join('\n  '));
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('脚本异常：', e); process.exit(2); });
