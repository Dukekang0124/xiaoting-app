#!/usr/bin/env node
/**
 * 发布产物冒烟：直接跑 `www/`（而不是源码目录），验证「要发出去的那份」真能启动。
 *
 * 为什么要单独有这一层：`build-web.mjs` 按白名单把文件拷进 www/，白名单漏一项的表现是
 *   **页面照常打开、功能静默降级**（新模块 404 → 动态 import 失败 → 相关能力消失），
 *   源码目录跑自测永远发现不了。历史上白名单/ASSETS 已经各踩过一次。
 *
 * 覆盖：
 *   ① www/ 版本号七处一致（index.html / sw.js CACHE / manifest / version.json）
 *   ② 页面真能启动（boot 无致命错误、IP 渲染出来、三 Tab 在）
 *   ③ 关键 ES Module 能从 www/ 加载（state-machine / copywriting / interaction / ip-audio / ip-runtime）
 *   ④ v1.3.5 四处修补在产物里真的生效（默认值同源 / 色彩过渡真的插值 / 倾听气泡 / 3 分钟计时器）
 *   ⑤ 稳定别名与版本包逐字节相同（下载入口不会 404 或给错包）
 *
 * 用法：NODE_PATH=<受管 node_modules> node _selftest/www-artifact-smoke.cjs
 *      （先跑 npm run build:web 生成 www/）
 */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const WWW = path.join(ROOT, 'www');
const PORT = Number(process.env.SMOKE_PORT || 4210); // 安全区端口（4190 在 undici 不良端口黑名单里）
const BASE = 'http://127.0.0.1:' + PORT;
const NODE = process.env.NODE_BIN || process.execPath;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail: String(detail || '') });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

/** 极简静态服务器：只用 Node 原生模块，避免依赖（www/ 是纯静态，不含 /api/*） */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.apk': 'application/vnd.android.package-archive',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
function startStatic() {
  const http = require('http');
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
    if (p === '/') p = '/index.html';
    const f = path.join(WWW, p);
    if (!f.startsWith(WWW) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain' }); res.end('404'); return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => srv.listen(PORT, '127.0.0.1', () => r(srv)));
}

async function waitServer() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + '/index.html'); if (r.ok) return true; } catch (e) { /* retry */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('static server not up on ' + BASE);
}

(async () => {
  if (!fs.existsSync(path.join(WWW, 'index.html'))) {
    console.error('✗ 没有 www/index.html —— 先跑 npm run build:web');
    process.exit(2);
  }

  // ① 产物内的版本号（不开浏览器就能查）
  const html = fs.readFileSync(path.join(WWW, 'index.html'), 'utf8');
  const vHtml = (/APP_VERSION\s*=\s*'([^']+)'/.exec(html) || [])[1] || '';
  const sw = fs.readFileSync(path.join(WWW, 'sw.js'), 'utf8');
  const vCache = (/CACHE\s*=\s*'xiaoting-v([^']+)'/.exec(sw) || [])[1] || '';
  const man = JSON.parse(fs.readFileSync(path.join(WWW, 'manifest.webmanifest'), 'utf8'));
  const vj = JSON.parse(fs.readFileSync(path.join(WWW, 'version.json'), 'utf8'));
  check('产物·index.html / sw CACHE / manifest / version.json 版本号一致',
    vHtml && vHtml === vCache && vHtml === man.version && vHtml === vj.latest_version,
    `html=${vHtml} cache=${vCache} manifest=${man.version} version.json=${vj.latest_version}`);
  check('产物·versionCode 与版本号自洽（MA*10000+MI*100+PA）', (() => {
    const [ma, mi, pa] = vHtml.split('.').map(Number);
    return vj.apk.versionCode === ma * 10000 + mi * 100 + pa;
  })(), `v${vHtml} → ${vj.apk.versionCode}`);
  // 🔴 v1.7.8 全链路检查发现：version.json 里存在**两处** versionCode（顶层 + apk 内），
  //    发版脚本只抬了 apk.versionCode，顶层那份停在上一版（1.7.6→1.7.7 时停留在 10706）。
  //    虽然现在全仓 0 处消费顶层那份，但同一份清单里两个互相矛盾的 versionCode，
  //    迟早有人照顶层那份做版本比较 ⇒ 加断言把它焊死，防止再次漂移。
  check('产物·version.json 顶层 versionCode 与 apk.versionCode 同源',
    vj.versionCode === vj.apk.versionCode,
    `顶层=${vj.versionCode} apk内=${vj.apk.versionCode}`);

  // ⑤ 稳定别名与版本包逐字节相同
  const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
  const verApk = path.join(WWW, 'apk', `Xiaoting-v${vHtml}-release.apk`);
  const latestApk = path.join(WWW, 'apk', 'xiaoting-latest.apk');
  // 本版安装包在**取包之前**结构性地不存在（APK 就是 CI 出包时才产生的）。
  // 所以判据要按「本版包在不在 apk-dist/」分流，而不是按环境变量：
  //   · 包在 ⇒ 硬门禁，必须已进 www/apk 且稳定别名与清单 md5 逐字节一致
  //   · 包不在 ⇒ 显式跳过并说明（既不判红把流程永远卡死，也不假装通过）
  // 🔴 发布前那一次必须用 SELFTEST_REQUIRE_APK=1 跑，此时包必须已在，跳不掉。
  const apkSrcReady = fs.existsSync(path.join(ROOT, 'apk-dist', `Xiaoting-v${vHtml}-release.apk`));
  const requireApk = process.env.SELFTEST_REQUIRE_APK === '1';
  if (fs.existsSync(verApk) && fs.existsSync(latestApk)) {
    check('产物·稳定别名 xiaoting-latest.apk 与该版本包逐字节相同',
      md5(verApk) === md5(latestApk) && md5(verApk) === vj.apk.md5,
      `${md5(verApk).slice(0, 12)}… vs ${vj.apk.md5.slice(0, 12)}…`);
  } else if (!apkSrcReady && !requireApk) {
    console.log(`SKIP  产物·稳定别名（v${vHtml} 的安装包还没取回来：apk-dist/ 里没有 —— ` +
      `出包后跑 node scripts/fetch-dist-apk.mjs ${vHtml} 再 build:web，然后 ` +
      `SELFTEST_REQUIRE_APK=1 重跑本探针即硬校验）`);
  } else {
    check('产物·稳定别名 xiaoting-latest.apk 存在（下载入口不会 404）', false,
      `缺少 ${path.basename(fs.existsSync(verApk) ? latestApk : verApk)} —— 先 node scripts/fetch-dist-apk.mjs 再 build:web`);
  }

  const srv = await startStatic();
  let browser;
  try {
    await waitServer();
    browser = await chromium.launch({ channel: process.env.PW_CHANNEL || 'chrome', headless: true });
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-CN' });
    // 把 app 的 __test__ 暴露到 window.__t（与 ip-state-selftest 同一手法：动态 import 复用同一模块实例）
    await ctx.addInitScript(() => {
       try { localStorage.setItem('monthly:done_' + (new Date().getFullYear() * 100 + (new Date().getMonth() + 1)), '1'); } catch (e) {}
      try { localStorage.setItem('xiaoting:ai', 'mock'); localStorage.setItem('moxiaoming:welcomed_v1', '1'); } catch (e) {}
      const tick = setInterval(() => {
        if (!window.__t) import('/js/app.js').then((m) => { window.__t = m.__test__; }).catch(() => {});
        else clearInterval(tick);
      }, 50);
      setTimeout(() => clearInterval(tick), 5000);
    });
    const page = await ctx.newPage();
    const errs = [];
    const http404 = [];
    page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
    // 记下 404 的**具体 URL**：只报「有 404」的断言没法定位，等于白写
    page.on('response', (r) => { if (r.status() === 404) http404.push(new URL(r.url()).pathname); });
    // 只让第三方/后端的失败静音（www/ 是纯静态，没有 /api/*）
    const realErrs = () => errs.filter((e) => !/ERR_FAILED|ERR_ABORTED|api\/|version\.json|favicon|更新检测|cloud|404/i.test(e));
    // 静态托管下 /api/* 必然 404（后端不在这一侧）；除此之外的 404 都是真缺陷
    const bad404 = () => [...new Set(http404)].filter((p) => !/^\/api\//.test(p));

    await page.goto(BASE + '/#/say', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.mascot', { timeout: 10000 });
    await page.waitForFunction(() => !!window.__t, null, { timeout: 8000 }).catch(() => {});

    // ② 真能启动
    check('产物·页面启动并渲染 IP', !!(await page.$('.mascot')), '');
    check('产物·底部 3 个 Tab', (await page.locator('.tab').count()) === 3, String(await page.locator('.tab').count()));
    const ver = await page.evaluate(() => window.APP_VERSION);
    check('产物·运行时 APP_VERSION 与产物版本一致', ver === vHtml, String(ver));

    // ③ 关键模块都能从 www/ 加载（白名单漏项会在这里现形）
    const mods = await page.evaluate(async () => {
      const names = ['state-machine', 'copywriting', 'interaction', 'ip-audio', 'ip', 'store', 'prompts', 'api', 'ai', 'asr', 'voice', 'router', 'config', 'update', 'diag', 'memory', 'llm', 'native-asr', 'motion'];
      const out = {};
      for (const n of names) {
        try { const m = await import('/js/' + n + '.js'); out[n] = Object.keys(m).length > 0 || typeof m.default === 'object'; }
        catch (e) { out[n] = 'ERR: ' + e.message; }
      }
      return out;
    });
    const badMods = Object.keys(mods).filter((k) => mods[k] !== true);
    check('产物·全部模块可从 www/ 加载（白名单没漏文件）', badMods.length === 0,
      badMods.length ? badMods.map((k) => k + '=' + mods[k]).join(' | ') : `${Object.keys(mods).length} 个模块`);

    // ④ v1.3.5 四处修补在产物里生效
    const fixed = await page.evaluate(async () => {
      const sm = await import('/js/state-machine.js');
      const st = await import('/js/store.js');
      const s = st.getState().user.settings;
      const want = Object.assign({}, sm.BASE_SETTINGS_DEFAULT, sm.IP_SETTINGS_DEFAULT);
      // 色彩过渡：真插值才会走出中间色
      const node = () => document.querySelector('.say__mascot .mascot');
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
      return {
        settingsSame: Object.keys(want).every((k) => s[k] === want[k]),
        hasTouch: typeof st.touchInteraction === 'function',
        before, mid, end,
      };
    });
    const rgb = (s) => (String(s).match(/\d+/g) || []).map(Number).slice(0, 3);
    const d = (a, b) => { const x = rgb(a), y = rgb(b); return Math.abs(x[0] - y[0]) + Math.abs(x[1] - y[1]) + Math.abs(x[2] - y[2]); };
    check('产物·settings 默认值与 state-machine 同源', fixed.settingsSame, '');
    check('产物·store.touchInteraction 存在（3 分钟回归计时器的基础）', fixed.hasTouch, String(fixed.hasTouch));
    check('产物·情绪切换是过渡不是硬切（中间色在起终点之间）',
      d(fixed.before, fixed.mid) > 8 && d(fixed.mid, fixed.end) > 8 &&
      Math.abs(d(fixed.before, fixed.mid) + d(fixed.mid, fixed.end) - d(fixed.before, fixed.end)) <= 3,
      `${fixed.before} → ${fixed.mid} → ${fixed.end}`);

    // 倾听气泡
    await page.goto(BASE + '/#/record?mode=text', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.record__mascot .mascot', { timeout: 8000 });
    const listen = await page.evaluate(async () => {
      const sm = await import('/js/state-machine.js');
      const b = document.querySelector('.record__mascot .ip-bubble');
      const h = document.getElementById('recHint');
      return {
        text: b ? b.textContent.trim() : '', want: sm.NODE_BUBBLE.listening,
        state: document.querySelector('.record__mascot .mascot').getAttribute('data-state'),
        hint: h ? h.textContent.trim() : '',
      };
    });
    check('产物·倾听节点气泡「我在听」在产物里生效', listen.text === '我在听' && listen.state === 'listening', JSON.stringify(listen));
    check('产物·轮播提示不与节点气泡重复', !!listen.hint && !listen.hint.startsWith(listen.text), `hint=「${listen.hint}」`);

    check('产物·无致命运行时错误', realErrs().length === 0, realErrs().slice(0, 4).join(' | '));
    check('产物·除 /api/*（静态托管本来就没有后端）外没有 404', bad404().length === 0,
      bad404().join(' | ') || `404 只有 ${[...new Set(http404)].join(', ') || '无'}`);
  } finally {
    try { if (browser) await browser.close(); } catch (e) { /* ignore */ }
    try { srv.close(); } catch (e) { /* ignore */ }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== www/ 产物冒烟：${results.length - failed.length}/${results.length} 通过 ====`);
  if (failed.length) { failed.forEach((f) => console.log('  ✗ ' + f.name + '   ' + f.detail)); process.exit(1); }
})().catch((e) => { console.error('运行异常：', e); process.exit(2); });
