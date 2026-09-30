#!/usr/bin/env node
/**
 * L3 收尾校验：发布之后再跑，回答唯一该问的问题 ——「线上那份，到底是哪一版」。
 *
 * 🔴 为什么必须有这一层：本地全套自测全绿只证明 L1/L2（源码正确）。发布链路里还有
 *   构建产物、上传、CDN、Service Worker 缓存四段，任何一段错了线上仍是旧版，
 *   而所有本地断言都是绿的。历史上线上曾长期停在 0.6.0，本地毫无察觉。
 *
 * 判据（全部对着本地 server/version.json 与产物比对，不靠肉眼看版本号）：
 *   ① 线上 /version.json 的 latest_version / versionCode / apk.md5 与本地清单一致
 *   ② 线上 /apk/Xiaoting-v<v>-release.apk 200，且**下载回来复算 md5** 与清单一致
 *   ③ 线上稳定别名 /apk/xiaoting-latest.apk 200，md5 与版本包一致（下载入口不会给错包）
 *   ④ 线上 /index.html 的 APP_VERSION == v
 *   ⑤ 线上 /sw.js 的 CACHE == xiaoting-v<v>（否则老用户永远拿不到新版资源）
 *   ⑥ 线上 /js/ 关键模块 200 且含该版本的特征串（防「版本号升了、代码没上」）
 *   ⑦ 真浏览器打开线上页面：运行时 APP_VERSION == v，IP 渲染出来，色彩过渡仍是插值（非硬切）
 *
 * 用法：NODE_PATH=<受管 node_modules> node _selftest/release-l3-verify.cjs
 *      换目标：LIVE=https://... node ...
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const LIVE = (process.env.LIVE || 'https://xiaoting.app.workbuddy.host').replace(/\/$/, '');

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'server/version.json'), 'utf8'));
const V = manifest.latest_version;
const CODE = manifest.apk.versionCode;
const MD5 = manifest.apk.md5;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail: String(detail || '') });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const md5buf = (b) => crypto.createHash('md5').update(b).digest('hex');

/** 带一次重试的 GET（CDN 首次回源偶发 5xx，重试一次再判失败） */
async function get(url) {
  let last = null;
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(url, { redirect: 'follow', headers: { 'cache-control': 'no-cache' } });
      const buf = Buffer.from(await r.arrayBuffer());
      return { ok: r.ok, status: r.status, buf, text: buf.toString('utf8'), age: r.headers.get('age'), lm: r.headers.get('last-modified') };
    } catch (e) { last = e; await new Promise((r2) => setTimeout(r2, 900)); }
  }
  return { ok: false, status: 0, error: last && last.message, buf: Buffer.alloc(0), text: '' };
}

/**
 * 按**真实浏览器**的请求头打裸路径 —— 这是判「用户到底看到什么」的唯一正确姿势。
 * 🔴 踩过的坑：网关/网关会按 `Accept-Encoding` 分桶缓存。实测 `br` 桶里存着上一版快照，
 *   而 `gzip` / `identity` 桶是新的。Chrome 一律发 br ⇒ 真实用户拿到旧页，
 *   而用 `?cb=` 或 gzip 写的校验会**全绿**，把问题整个盖住。
 *   所以：判「是否真的上线」必须用浏览器头 + 裸路径。
 */
const BROWSER_HEADERS = {
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-encoding': 'gzip, deflate, br, zstd', // Chrome 的默认组合
  'accept-language': 'zh-CN,zh;q=0.9',
  'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none',
  'upgrade-insecure-requests': '1',
};
async function getAsBrowser(pathname, extra = {}) {
  try {
    const r = await fetch(LIVE + pathname, { redirect: 'follow', headers: Object.assign({}, BROWSER_HEADERS, extra) });
    const buf = Buffer.from(await r.arrayBuffer());
    return { ok: r.ok, status: r.status, text: buf.toString('utf8'), age: r.headers.get('age'), lm: r.headers.get('last-modified'), enc: r.headers.get('content-encoding') };
  } catch (e) { return { ok: false, status: 0, text: '', error: e.message }; }
}

(async () => {
  console.log('=========================================================');
  console.log(' L3 收尾校验：线上版本 vs 本地清单');
  console.log(' 目标：' + LIVE);
  console.log(' 本地清单：v' + V + ' (code ' + CODE + ', md5 ' + (MD5 || '(空)') + ')');
  console.log('=========================================================\n');

  if (!MD5) {
    console.log('✗ 本地 server/version.json 的 apk.md5 为空 —— CI 还没回填，先等 CI 跑完再校验');
    process.exit(2);
  }

  // ① 线上 version.json
  const vj = await get(LIVE + '/version.json?cb=' + Date.now());
  let live = null;
  try { live = JSON.parse(vj.text); } catch (e) { /* 下面报错 */ }
  check('线上 /version.json 可读且是合法 JSON', !!live, live ? '' : `status=${vj.status} ${vj.error || ''}`);
  if (live) {
    check('线上 latest_version == 本地清单', live.latest_version === V, `线上 ${live.latest_version} / 本地 ${V}`);
    check('线上 versionCode == 本地清单', live.apk && live.apk.versionCode === CODE, `线上 ${live.apk && live.apk.versionCode} / 本地 ${CODE}`);
    check('线上 apk.md5 == 本地清单（CI 回填一致）', live.apk && live.apk.md5 === MD5, `线上 ${live.apk && live.apk.md5}`);
  }

  // ② 版本包：下载回来复算 md5（文件名和体积都不是版本证据，只有内容哈希是）
  const verUrl = `${LIVE}/apk/Xiaoting-v${V}-release.apk`;
  const apk = await get(verUrl);
  check(`线上 ${`/apk/Xiaoting-v${V}-release.apk`} 返回 200`, apk.ok, `status=${apk.status}${apk.error ? ' ' + apk.error : ''}`);
  if (apk.ok) {
    const h = md5buf(apk.buf);
    check('线上版本包内容 md5 == 清单（下载入口给的是这一版）', h === MD5, `${h} / ${MD5}（${apk.buf.length} 字节）`);
    // PK 魔数：确认下回来的真是 zip/apk 而不是错误页
    check('线上版本包是 APK（PK 魔数）', apk.buf[0] === 0x50 && apk.buf[1] === 0x4b, `magic=${apk.buf.slice(0, 2).toString('hex')}`);
  }

  // ③ 稳定别名
  const alias = await get(LIVE + '/apk/xiaoting-latest.apk');
  check('线上稳定别名 /apk/xiaoting-latest.apk 返回 200', alias.ok, `status=${alias.status}`);
  if (alias.ok) {
    check('稳定别名与版本包逐字节相同（别名没指向旧包）', md5buf(alias.buf) === MD5, md5buf(alias.buf));
  }

  // ①b 真实用户路径：用浏览器头 + 裸路径（这是用户实际拿到的内容）
  console.log('\n--- 真实浏览器路径（裸 URL + Chrome 默认请求头，含 br）---');
  const bIdx = await getAsBrowser('/index.html');
  const mB = /APP_VERSION\s*=\s*'([^']+)'/.exec(bIdx.text || '');
  check('线上（浏览器头）/index.html 的 APP_VERSION == 本地版本', !!mB && mB[1] === V,
    `拿到 ${mB ? mB[1] : '?'}  lm=${bIdx.lm} age=${bIdx.age} enc=${bIdx.enc}`);

  const bSw = await getAsBrowser('/sw.js');
  const mBCache = /CACHE\s*=\s*'([^']+)'/.exec(bSw.text || '');
  check('线上（浏览器头）/sw.js 的 CACHE == xiaoting-v' + V,
    !!mBCache && mBCache[1] === 'xiaoting-v' + V, `拿到 ${mBCache ? mBCache[1] : '?'}  lm=${bSw.lm} age=${bSw.age}`);

  const bApp = await getAsBrowser('/js/app.js');
  check('线上（浏览器头）/js/app.js 含本版特征串', bApp.text.includes('replayIpColors'),
    `含 replayIpColors=${bApp.text.includes('replayIpColors')}  lm=${bApp.lm} age=${bApp.age}`);

  // 诊断：同一路径换编码/打断缓存键，用来区分「源上没有」还是「缓存盖住」
  const dGzip = await getAsBrowser('/index.html', { 'accept-encoding': 'gzip' });
  const dIdent = await getAsBrowser('/index.html', { 'accept-encoding': 'identity' });
  const dTrick = await getAsBrowser('//index.html');
  const pick = (r) => { const m = /APP_VERSION\s*=\s*'([^']+)'/.exec(r.text || ''); return `${m ? m[1] : '?'}(age=${r.age || '-'})`; };
  console.log(`   诊断：gzip=${pick(dGzip)}  identity=${pick(dIdent)}  双斜杠路径=${pick(dTrick)}`);
  if (mB && mB[1] !== V && pick(dGzip).startsWith(V)) {
    console.log('   ⚠ 判定：**源上已经是 ' + V + '，是网关按 Accept-Encoding=br 分桶缓存了旧快照**（gzip/identity 桶是新的）。');
    console.log('     这不是代码问题，重新发布不会清除它；受影响的是真实 Chrome 用户的首屏。');
  }

  // ④ 打断缓存再读一次 /index.html（作为「源上有没有」的旁证，不作为通过判据）
  const idx = await get(LIVE + '/index.html?cb=' + Date.now());
  const mVer = /APP_VERSION\s*=\s*'([^']+)'/.exec(idx.text || '');
  check('线上（打断缓存）index.html 的 APP_VERSION == 本地版本（=「源上有没有」）',
    !!mVer && mVer[1] === V, mVer ? mVer[1] : `status=${idx.status}`);

  // ⑤ /sw.js CACHE
  const sw = await get(LIVE + '/sw.js?cb=' + Date.now());
  const mCache = /CACHE\s*=\s*'([^']+)'/.exec(sw.text || '');
  check('线上 sw.js 的 CACHE == xiaoting-v' + V + '（老用户能拿到新资源）',
    !!mCache && mCache[1] === 'xiaoting-v' + V, mCache ? mCache[1] : `status=${sw.status}`);

  // ⑥ 关键模块与该版本特征串
  const marks = [
    ['/js/app.js', ['replayIpColors', 'scheduleIdleRevert', 'readIpInlineColors', 'NODE_BUBBLE.listening']],
    ['/js/state-machine.js', ['IP_SETTINGS_DEFAULT', 'BASE_SETTINGS_DEFAULT', 'NODE_BUBBLE']],
    ['/js/store.js', ['touchInteraction']],
    ['/js/prompts.js', ['不用急着说清楚']],
  ];
  for (const [url, keys] of marks) {
    const r = await get(LIVE + url + '?cb=' + Date.now());
    const missing = keys.filter((k) => !r.text.includes(k));
    check(`线上（打断缓存）${url} 含本版特征串（=「源上有没有」，不证明用户拿得到）`,
      r.ok && missing.length === 0, r.ok ? (missing.length ? '缺 ' + missing.join(',') : keys.length + ' 个特征串齐') : `status=${r.status}`);
  }

  // ⑦ 真浏览器：线上页面能跑，且色彩过渡真的是过渡
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-CN' });
    await ctx.addInitScript(() => {
      try { localStorage.setItem('xiaoting:ai', 'mock'); localStorage.setItem('moxiaoming:welcomed_v1', '1'); } catch (e) {}
      const tick = setInterval(() => {
        if (!window.__t) import('/js/app.js').then((m) => { window.__t = m.__test__; }).catch(() => {});
        else clearInterval(tick);
      }, 50);
      setTimeout(() => clearInterval(tick), 8000);
    });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(LIVE + '/#/say', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('.mascot', { timeout: 20000 });
    await page.waitForFunction(() => !!window.__t, null, { timeout: 10000 }).catch(() => {});

    const rt = await page.evaluate(() => window.APP_VERSION);
    check('线上运行时 APP_VERSION == 本地版本（浏览器看到的就是新版）', rt === V, String(rt));

    const tr = await page.evaluate(async () => {
      const st = await import('/js/store.js');
      const node = () => document.querySelector('.say__mascot .mascot');
      if (!node()) return { err: 'no mascot' };
      st.setState({ emotionKey: 'default', emotionIntensity: 5, risk: { level: 'none', action: 'continue', hit: false, evidence: '' } });
      window.__t.render();
      await new Promise((r) => setTimeout(r, 950));
      const before = getComputedStyle(node()).getPropertyValue('--ip-body-in').trim();
      st.setEmotion('sad', 8);
      window.__t.render();
      await new Promise((r) => setTimeout(r, 140));
      const mid = getComputedStyle(node()).getPropertyValue('--ip-body-in').trim();
      await new Promise((r) => setTimeout(r, 950));
      const end = getComputedStyle(node()).getPropertyValue('--ip-body-in').trim();
      return { before, mid, end };
    });
    const rgb = (s) => (String(s).match(/\d+/g) || []).map(Number).slice(0, 3);
    const d = (a, b) => { const x = rgb(a), y = rgb(b); return Math.abs(x[0] - y[0]) + Math.abs(x[1] - y[1]) + Math.abs(x[2] - y[2]); };
    check('线上·情绪色切换是过渡不是硬切（中间色在起终点之间）',
      !tr.err && d(tr.before, tr.mid) > 8 && d(tr.mid, tr.end) > 8 &&
      Math.abs(d(tr.before, tr.mid) + d(tr.mid, tr.end) - d(tr.before, tr.end)) <= 3,
      tr.err || `${tr.before} → ${tr.mid} → ${tr.end}`);
    check('线上·无未捕获的页面异常', errs.length === 0, errs.slice(0, 3).join(' | '));
  } catch (e) {
    check('线上·真浏览器能打开页面', false, e.message);
  } finally {
    try { if (browser) await browser.close(); } catch (e) { /* ignore */ }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== L3 收尾校验：${results.length - failed.length}/${results.length} 通过 ====`);
  if (failed.length) {
    console.log('未通过项（线上与本地清单不一致 = 视为未发布）：');
    failed.forEach((f) => console.log('  ✗ ' + f.name + '   ' + f.detail));
    process.exit(1);
  }
})().catch((e) => { console.error('运行异常：', e); process.exit(2); });
