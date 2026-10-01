/**
 * 墨小溟 · 版本清单「跨域脚本通道」真跑探针（v1.6.2）
 *
 * 为什么要有这个脚本：
 *   真机截图（用户报障）显示 APK 里那句「暂时没连上更新服务，按本地记录你已是最新 v1.4.6」。
 *   根因不在缓存、不在七处版本号，而在 **CORS**：
 *     · APK 里页面跑在 Capacitor 的 `https://localhost` ⇒ 取清单只能拼跨域绝对地址；
 *     · 线上网关对 `/version.json` 的响应**没有 Access-Control-Allow-Origin**（两次带 Origin 头复测）；
 *     ⇒ fetch 被拒 ⇒ 落硬编码兜底 ⇒ latest 恒等于 APP_VERSION ⇒ hasNew=false ⇒ **弹窗一次都不弹**。
 *
 * 🔴 本探针与旧探针（update-apk-abi / live-update-popup）的差异，正是它存在的理由：
 *    旧探针给 route.fulfill 补了 `'Access-Control-Allow-Origin': '*'`，
 *    于是测的是"同源 + 有 CORS 头"这条在本地根本不存在的路 ⇒ 29/0 全绿，真机却一次不弹。
 *    **判据必须落在开关真正影响的那条链路上**（本项目已栽过两次：v1.1.6 的 UA 标记、v1.4.1 的静态检查）。
 *    所以这里 route.fulfill 一律**不给 ACAO**，忠实复刻线上；只有 `<script src>` 那条才通。
 *
 * 三臂：
 *   A 处理臂：JSON 通道全挂（CORS）+ 脚本通道给新版本  ⇒ **必须弹窗**
 *   B 对照臂：JSON 通道全挂 + 脚本通道给当前版本      ⇒ **不弹**（证明是按版本号比出来的，不是永远弹）
 *   C 兜底臂：三条通道全挂                            ⇒ 不弹，且文案必须承认「无法确认」而不是谎称「已是最新」
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const NODE_PATH = process.env.NODE_PATH || '';
if (NODE_PATH) module.paths.push(...NODE_PATH.split(path.delimiter));
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 4191); // 避 WHATWG 不良端口（4190 在黑名单里）
const BASE = `http://127.0.0.1:${PORT}`;
const HOSTED = 'https://xiaoting.app.workbuddy.host';

const CURRENT = (fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
  .match(/APP_VERSION\s*=\s*'([\d.]+)/) || [])[1];
if (!CURRENT) { console.error('✗ 读不到 APP_VERSION（真相源）'); process.exit(1); }
const BUMPED = (() => { const p = CURRENT.split('.').map((n) => Number(n) || 0); p[2] = (p[2] || 0) + 1; return p.join('.'); })();

const out = [];
const log = (...a) => { const s = a.join(' '); out.push(s); console.log(s); };
let pass = 0, fail = 0;
function ok(cond, label, extra = '') {
  if (cond) { pass++; log(`  ✅ ${label}`); }
  else { fail++; log(`  ❌ ${label}${extra ? '  ← ' + extra : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  return new Promise((resolve) => {
    const p = spawn('node', ['server.cjs'], {
      cwd: ROOT, env: { ...process.env, PORT: String(PORT), STATS_KEY: 'selftest' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let done = false;
    const onData = (d) => { const s = d.toString(); if (!done && /listening|started|on http|:[0-9]{4}/i.test(s)) { done = true; resolve(p); } };
    p.stdout.on('data', onData); p.stderr.on('data', onData);
    setTimeout(() => { if (!done) { done = true; resolve(p); } }, 2500);
  });
}

/** 跑一臂。manifestMode: 'new' | 'current' | 'none' */
async function runArm(browser, mode, label) {
  const context = await browser.newContext();
  // ① 模拟 APK：apiBase() 才会返回绝对基址 ⇒ 清单请求真的变成跨域
  await context.addInitScript(() => {
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: {} };
    try { localStorage.setItem('moxiaoming:welcomed_v1', '1'); } catch (e) {}
  });
  const page = await context.newPage();
  const seen = [], errors = [];
  page.on('request', (r) => {
    const u = r.url();
    if (/version(\.json|\/latest|-latest\.js)/.test(u)) seen.push(u.replace(/\?.*$/, ''));
  });
  page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));

  // ② 线上真实条件：静态托管没有后端 ⇒ /api/version/* 恒 404（带 ACAO 只是为了让"404"被看清楚，不影响结果）
  await page.route('**/api/version/latest*', (route) =>
    route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found', headers: { 'Access-Control-Allow-Origin': '*' } }));
  await page.route('**/api/version/history*', (route) =>
    route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found', headers: { 'Access-Control-Allow-Origin': '*' } }));

  // ③ 🔴 /version.json：复刻线上"没有 Access-Control-Allow-Origin"。
  //    不能直接 omit —— 实测 Playwright 的 route.fulfill 会自动给跨源响应补 ACAO，
  //    那样 JSON 通道根本拦不住，本探针测的就是一条假通道（老坑：判据落在没被影响的链路上）。
  //    这里显式给一个「对不上的 Origin」⇒ 浏览器 CORS 检查必然失败，与线上等价。
  await page.route('**/version.json*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': 'https://not-the-apk-origin.invalid' },
      body: JSON.stringify({
        latest_version: CURRENT, release_notes: [], download_url: `${HOSTED}/apk/Xiaoting-v${CURRENT}-release.apk`, web_url: `${HOSTED}/#/say`,
      }),
    }));

  // ④ 脚本通道：经典 <script src>，跨源本来就允许执行，不需要 ACAO
  await page.route('**/version-latest.js*', (route) => {
    if (mode === 'none') return route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
    const mv = mode === 'new' ? BUMPED : CURRENT;
    return route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      headers: { 'Cache-Control': 'no-store' },
      body: `window.__VERSION_MANIFEST__ = ${JSON.stringify({
        latest_version: mv, force_update: false, web_url: `${HOSTED}/#/say`,
        download_url: `${HOSTED}/apk/Xiaoting-v${mv}-release.apk`, release_notes: ['测试用发布说明'],
      })};`,
    });
  });

  // 旁路口子挡掉（避免打到真实公网，拖慢且不可控）
  await page.route('**/api/health*', (route) => route.fulfill({ status: 503, body: '{}' }));
  await page.route('**/api/events*', (route) => route.fulfill({ status: 204, body: '' }));

  await page.goto(BASE + '/', { waitUntil: 'load', timeout: 40000 });
  await sleep(2000); // 等 initUpdate 的异步检测落地（真实 boot 链路）

  // 守卫：先证明"JSON 通道确实被 CORS 拒了"。
  //    这条不通过，后面所有结论都是在假通道上得出的（防假绿的第一道闸）。
  const corsGuard = await page.evaluate(async (h) => {
    try { const r = await fetch(`${h}/version.json?corsGuard=1`); await r.text(); return 'reachable'; }
    catch (e) { return 'blocked'; }
  }, HOSTED);

  const state = await page.evaluate(async () => {
    const ov = document.querySelector('.update-overlay');
    const title = document.querySelector('.update-title');
    const mod = await import('/js/update.js');
    const d = await mod.fetchLatest();
    const desc = mod.describeCheckResult({ reason: 'no_update', current: window.APP_VERSION, latest: d.latest_version, source: d._source });
    return {
      appVersion: window.APP_VERSION || null,
      shown: !!ov,
      title: title ? title.textContent.trim() : '',
      latest: d.latest_version, source: d._source, via: d._via || '',
      descText: desc.text || '',
    };
  });

  await context.close();
  return { label, mode, seen, corsGuard, errors, ...state };
}

(async () => {
  log(`【版本清单·跨域脚本通道探针】当前 v${CURRENT} / 新版本 v${BUMPED}`);
  log(`服务：${BASE}`);

  const server = await startServer();
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome' });

    /* ---- 静态证据：产物与 MIME ---- */
    log('');
    log('① 产物与协议');
    const wwwJs = path.join(ROOT, 'www', 'version-latest.js');
    ok(fs.existsSync(wwwJs), '① www/version-latest.js 存在（脚本通道的产物）',
      '没有它 = 打包阶段就没生成，这条通道在真机上根本不存在');
    if (fs.existsSync(wwwJs)) {
      const txt = fs.readFileSync(wwwJs, 'utf8');
      const mm = txt.match(/latest_version["']?\s*:\s*["']([\d.]+)/);
      const ssot = JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'version.json'), 'utf8'));
      ok(!!mm && mm[1] === ssot.latest_version,
        `① 脚本清单里的版本号与 SSOT（server/version.json）一致 = ${ssot.latest_version}`,
        mm ? mm[1] : '(没解析到版本号)');
      ok(/window\.__VERSION_MANIFEST__\s*=/.test(txt), '① 是 JS 赋值脚本（window.__VERSION_MANIFEST__ = {...}）');
      ok(!/history\s*:/.test(txt), '① 不带 history 体量（更新日志仍走 /version.json）');
    }
    const ct = await new Promise((resolve) => {
      require('http').get(`${BASE}/version-latest.js`, (res) => { res.resume(); resolve(res.headers['content-type'] || ''); })
        .on('error', () => resolve(''));
    });
    ok(/javascript/i.test(ct), `① 服务返回 text/javascript（脚本标签才肯执行）← ${ct || '(空)'}`);

    // 清单里的下载链接必须真能下到包（不是 200+HTML 那种托管兜底页）
    // 🔴 收"够 4 字节"再判魔数。第一版写成 `if (n <= 5) bufs.push(c)` —— 这里的 n 是**累计**长度，
    //    而 3.6MB 的包在第一个 chunk 里就到齐了，条件当场不成立 ⇒ head 恒为空 ⇒
    //    魔数永远判不出来，日志打印 `head=`（空），看起来像在跑实际啥也没验。
    //    判据本身也必须被复核：断言抓不到东西，比断言抓到坏东西更隐蔽。
    //    另外收够 4 字节立刻 destroy，不为验个魔数把整个 3.6MB 拉下来。
    const dl = await new Promise((resolve) => {
      const got = [];
      const len = () => got.reduce((s, b) => s + b.length, 0);
      const req = require('https').get(`${HOSTED}/apk/Xiaoting-v${CURRENT}-release.apk`, (res) => {
        res.on('data', (c) => {
          const need = 4 - len();
          if (need > 0) got.push(c.slice(0, need));
          if (len() >= 4) req.destroy();
        });
        res.on('end', () => resolve({ status: res.statusCode, ct: res.headers['content-type'] || '', head: Buffer.concat(got) }));
        // 🔴 destroy() 之后 res 会抛一个 erro('aborted')：不接住这个事件，Promise 永远不落地，
        //    整条探针就挂着不退出（实测踩过：surface 上看不出哪卡住，只能干等超时）。
        res.on('error', () => resolve({ status: res.statusCode, ct: res.headers['content-type'] || '', head: Buffer.concat(got) }));
      });
      req.on('error', (e) => resolve({ status: 0, ct: String(e && e.message) || 'err', head: Buffer.alloc(0) }));
      req.setTimeout(25000, () => { req.destroy(); resolve({ status: 0, ct: 'timeout_25s', head: Buffer.alloc(0) }); });
    });
    const magic = dl.head.length >= 4 && dl.head[0] === 0x50 && dl.head[1] === 0x4b && dl.head[2] === 0x03 && dl.head[3] === 0x04;
    ok(dl.status === 200 && magic, `① 清单里的下载链接指向真安装包（HTTP ${dl.status} + ZIP 魔数 PK\\x03\\x04）`,
      `status=${dl.status} ct=${dl.ct} head=${dl.head.slice(0, 4).toString('hex')}`);

    /* ---- A 处理臂 ---- */
    log('');
    log('② A 臂：JSON 通道全挂 + 脚本通道给新版本 ⇒ 必须弹窗（真机那条死路被绕开）');
    const A = await runArm(browser, 'new', 'A');
    ok(A.corsGuard === 'blocked', '② 守卫：跨源 fetch /version.json 确实被 CORS 拒（本臂不是在测假通道）', A.corsGuard);
    ok(A.seen.some((u) => /version-latest\.js$/.test(u)), '② 脚本通道真的被请求了（不是"加了代码没人走"）', A.seen.join(' | '));
    ok(A.source === 'remote' && A.via === 'version-latest.js',
      '② 版本信息来源是脚本清单（_source=remote, via=version-latest.js）',
      `source=${A.source} via=${A.via} latest=${A.latest}`);
    ok(A.latest === BUMPED, `② 识别到的最新版本 = ${BUMPED}`, `实际 ${A.latest}`);
    ok(A.shown, '② 启动后弹出了更新弹窗（initUpdate → checkUpdate → showModal 真链路）');
    ok(A.title.includes(BUMPED), `② 弹窗标题写明新版本号 = ${BUMPED}`, A.title);
    ok(A.errors.length === 0, '② 页面无 JS 错误', A.errors.join(' | '));

    /* ---- B 对照臂 ---- */
    log('');
    log('③ B 臂：脚本通道给的是当前版本 ⇒ 不该弹（证明弹窗是按版本号比出来的，不是永远弹）');
    const B = await runArm(browser, 'current', 'B');
    ok(!B.shown, '③ 当前版本时不弹窗');
    ok(B.source === 'remote', '③ 此时仍走脚本通道读到清单（通道本身是通的）', `source=${B.source}`);

    /* ---- C 兜底臂：文案不许再谎称「已是最新」 ---- */
    log('');
    log('④ C 臂：三条通道全挂 ⇒ 不弹，且文案必须承认「无法确认」');
    const C = await runArm(browser, 'none', 'C');
    ok(!C.shown, '④ 读不到任何清单时不弹窗（不会拿本地常量硬说有新版）');
    ok(C.source === 'hardcoded', '④ 落到硬编码兜底', `source=${C.source}`);
    ok(C.descText.includes('无法确认'), '④ 文案如实说「无法确认有没有新版本」', C.descText);
    ok(!/已是最新/.test(C.descText), '④ 文案不再谎称「已是最新」（v1.4.6 那句真机谎言的回归护栏）', C.descText);

    log('');
    log(`结果：${pass} 通过 / ${fail} 失败`);
    if (fail) { console.error('\n❌ 有失败项'); process.exitCode = 1; }
    else console.log('\n✅ 全绿');
  } catch (e) {
    console.error('探针异常：', e);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) server.kill();
  }
})();
