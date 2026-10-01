/**
 * 墨小溟 · 更新弹窗「APK 启动即弹」A/B 鉴别力校验（v1.1.4）
 *
 * 为什么需要这个脚本：
 *   v1.1.4 修的是「APK 里更新弹窗从来不弹」。这类缺陷**静态检查绝对抓不到**
 *   （`node --check` 全绿、代码看着完全正确），只有把真实动作序列跑一遍才看得见。
 *
 * 它模拟了什么（这是关键）：
 *   ① APK 环境：注入 `window.Capacitor.isNativePlatform()===true`
 *      ⇒ `apiBase()` 返回 HOSTED_ORIGIN ⇒ 取数走**绝对基址**。
 *      （只加 ?app=android 没用——那只影响 platform()，不影响 apiBase()，别搞混。）
 *   ② 生产公开站是**静态托管**（CloudStudio Gateway），没有 Node 后端
 *      ⇒ 强制 `/api/version/latest` 恒 404，逼出「静态清单 version.json」这条兜底。
 *   ③ 真浏览器（本机 Chrome）加载真实页面，跑真实 boot → initUpdate → checkUpdate。
 *
 * 两臂：
 *   A 控制臂：清单版本 == 当前版本（从 index.html 读）→ **不该**弹
 *   B 处理臂：清单版本 >  当前版本（补丁位 +1）→ **必须**弹
 *   A/B 同时成立才说明「弹窗是按版本号比较出来的」，而不是"永远弹"或"永远不弹"。
 *
 * A/B 鉴别力校验（variant=old）：
 *   用 `git show HEAD:js/update.js` 取出修复前的版本，跑同一套断言 ——
 *   期望 B 臂**不弹**、且取数地址是**页面同源**（缺陷本体）。
 *   若旧版也全绿，说明这套断言没有鉴别力，等于没测。
 */
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const NODE_PATH = process.env.NODE_PATH || '';
if (NODE_PATH) module.paths.push(...NODE_PATH.split(path.delimiter));
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 4210); // 安全端口（避开 WHATWG 不良端口黑名单，4190 在内）
const BASE = `http://127.0.0.1:${PORT}`;
const HOSTED = 'https://xiaoting.app.workbuddy.host';

/* 🔴 版本号必须从真相源读，绝不写死。
 * 踩过的坑（v1.1.5 升版时实测）：这里原本写死 `CURRENT = '1.1.4'`，升到 1.1.5 后就漂了 ——
 * 页面真实版本变成 1.1.5，而 B 臂还拿 1.1.5 当"更高的版本"，等于"清单==当前"，
 * 弹窗按定义就不该弹，于是 5 条断言集体变红，看着像功能坏了，其实只是测试常量过期。
 * 写死的版本常量一定会漂；真相源只有一个：index.html 的 APP_VERSION。 */
const CURRENT = (fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
  .match(/APP_VERSION\s*=\s*'([\d.]+)/) || [])[1];
if (!CURRENT) {
  console.error('✗ 无法从 index.html 读到 APP_VERSION —— 版本真相源缺失，测试无法进行');
  process.exit(1);
}
/** B 臂用的"更高版本"：补丁位 +1，必然 > CURRENT */
const BUMPED = (() => {
  const p = CURRENT.split('.').map((n) => Number(n) || 0);
  p[2] = (p[2] || 0) + 1;
  return p.join('.');
})();

const out = [];
const log = (...a) => { const s = a.join(' '); out.push(s); console.log(s); };

let pass = 0, fail = 0;
function ok(cond, label, extra = '') {
  if (cond) { pass++; log(`  ✅ ${label}`); }
  else { fail++; log(`  ❌ ${label}${extra ? '  ← ' + extra : ''}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  return new Promise((resolve, reject) => {
    const p = spawn('node', ['server.cjs'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), STATS_KEY: 'selftest' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let done = false;
    const onData = (d) => {
      const s = d.toString();
      if (!done && /listening|started|on http|:[0-9]{4}/i.test(s)) { done = true; resolve(p); }
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('error', reject);
    setTimeout(() => { if (!done) { done = true; resolve(p); } }, 2500);
  });
}

/** 跑一个臂，返回观测结果 */
async function runArm(browser, variant, manifestVersion, label, wantVia = false) {
  const context = await browser.newContext();
  // ① 模拟 APK：apiBase() 才会返回绝对基址
  await context.addInitScript(() => {
     try { localStorage.setItem('monthly:done_' + (new Date().getFullYear() * 100 + (new Date().getMonth() + 1)), '1'); } catch (e) {}
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: {} };
    try { localStorage.setItem('moxiaoming:welcomed_v1', '1'); } catch (e) {}
  });
  const page = await context.newPage();

  const seen = [];
  const errors = [];
  page.on('request', (r) => {
    const u = r.url();
    // 注意：API 路径是 `version/latest`（斜杠），静态清单是 `version.json`（点），
    // 脚本通道是 `version-latest.js`（带 -latest 的 .js）。
    // 第一版这里写成 `/version\.(json|latest)/` 只匹配了前两者，导致"先试后端接口"这条断言
    // 永远红 —— 是断言写错，不是代码错。断言自身也必须被复核。
    // v1.6.2：漏掉 version-latest.js 的后果更糟 —— 新通道明明被加载了，断言却当它不存在，
    // 于是把「通道其实通了」误判成「功能坏了」（实测 7 条红全这么来的）。
    // 🔴 一律去掉 query 再存：`?cb=xxx` 是每次请求现算的防缓存串，
    //    存带 query 的原样会让下面所有 `/\/version\.json$/` 这类**结尾锚定**的判据全部失配
    //    （实测就是这么红的：明明日志里打出了 /version.json，断言却说"没探过"）。
    if (/version(\.json|\/latest|-latest\.js)/.test(u)) seen.push(u.replace(/\?.*$/, ''));
  });
  page.on('pageerror', (e) => errors.push(String(e && e.message)));
  // 🔴 CORS 自证守卫：先证明「给的是对不上的 ACAO，而且真的被拒了」。
  //    没有这一步，下面那条 via 断言就是**在一条假通路**上通过 ——
  //    Playwright 的 route.fulfill 会给跨源响应补 ACAO，如果它偷偷补成了 `*`，
  //    那么 JSON 通道也通了，我们等于白测。守卫红 ⇒ 说明环境变了，得先看它再谈结论。
  const corsBlocked = [];
  page.on('requestfailed', (r) => {
    const u = r.url().replace(/\?.*$/, '');
    if (/version\.json$/.test(u)) corsBlocked.push(`${u} :: ${(r.failure() && r.failure().errorText) || 'failed'}`);
  });

  // ⚠️ route 后注册优先 ⇒ 先注册通用（此处无需），再注册具体。
  // 模拟静态托管：没有后端 ⇒ /api/version/* 恒 404
  await page.route('**/api/version/latest', (route) =>
    route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found', headers: { 'Access-Control-Allow-Origin': '*' } }));
  await page.route('**/api/version/history', (route) =>
    route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found', headers: { 'Access-Control-Allow-Origin': '*' } }));
  // 静态清单：本臂的受控变量
  // 🔴 ACAO 必须是**一个对不上的 Origin**（线上真实值：根本没有 ACAO 头 ⇒ CORS 拒）。
  //    Playwright 的 route.fulfill 会给跨源响应自动补 ACAO；照抄 `*` 就等于把线上那条
  //    致命约束抹掉了，测出来的"通道通了"是假通。自证守卫 corsGuard 会先证明它确确实实被拒。
  const hostileAcao = { 'Access-Control-Allow-Origin': 'https://not-the-apk-origin.invalid' };
  await page.route('**/version.json*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: hostileAcao,
      body: JSON.stringify({
        latest_version: manifestVersion,
        force_update: false,
        release_notes: ['测试用发布说明'],
        download_url: `${HOSTED}/apk/Xiaoting-v${manifestVersion}-release.apk`,
        web_url: `${HOSTED}/#/say`,
      }),
    }));
  // v1.6.2 新增第三通道：把同一份清单再发一次「脚本形态」。
  // 跨源 <script src> 是经典脚本标签，从诞生起就允许跨源执行，**不受 CORS 读回限制** ——
  // 这就是线上 APK 里唯一还能通的那条路。所以这里同样给"对不上的 ACAO"：
  //  intentional —— 它必须在这种 hostile 头下照样加载成功，否则等于我没忠实复刻线上。
  await page.route('**/version-latest.js*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/javascript', // 必须显式给：不给的话 Chrome 走 ORB 判定，跨源脚本会被拦掉
      headers: hostileAcao,
      body: `window.__VERSION_MANIFEST__ = ${JSON.stringify({
        latest_version: manifestVersion,
        force_update: false,
        release_notes: ['测试用发布说明'],
        download_url: `${HOSTED}/apk/Xiaoting-v${manifestVersion}-release.apk`,
        web_url: `${HOSTED}/#/say`,
      })};`,
    }));
  // 把与本次断言无关的旁路请求挡掉（避免打到真实公网，拖慢且不可控）
  await page.route('**/api/health', (route) => route.fulfill({ status: 503, body: '{}', headers: { 'Access-Control-Allow-Origin': '*' } }));
  await page.route('**/api/events', (route) => route.fulfill({ status: 204, body: '', headers: { 'Access-Control-Allow-Origin': '*' } }));

  await page.goto(BASE + '/', { waitUntil: 'load', timeout: 40000 });
  await sleep(1800); // 等 initUpdate 的异步检测落地

  // wantVia：额外问一次「这次是哪个通道胜出的」。这条信息很关键 ——
  // 弹窗弹出来只能证明"有效果"，证明不了"效果来自哪条路"。
  // 静态检查看不出来，只能真跑：读 update.js 自己的 manifest_pick 落点 _via。
  const state = await page.evaluate(async (want) => {
    const ov = document.querySelector('.update-overlay');
    const title = document.querySelector('.update-title');
    let via = '';
    if (want) {
      try {
        const u = await import('/js/update.js');
        via = (await u.fetchLatest())._via || '';
      } catch (e) { via = 'read_error:' + String((e && e.message) || e).slice(0, 60); }
    }
    return {
      appVersion: window.APP_VERSION || null,
      shown: !!ov,
      title: title ? title.textContent.trim() : '',
      force: ov ? ov.classList.contains('update-overlay--force') : null,
      hasNowBtn: !!document.getElementById('updateNow'),
      hasLaterBtn: !!document.getElementById('updateLater'),
      via,
    };
  }, wantVia);

  await context.close();
  return { label, variant, manifestVersion, seen, errors, corsBlocked, ...state };
}

/** SW 缓存行为验证：版本清单绝不能被 Service Worker 缓存住。
 *
 *  这是本功能最阴的失效模式：清单被缓存 ⇒ 永远读到"当前即最新" ⇒ 更新弹窗再也不出现，
 *  而且**不报任何错**。所以必须做行为验证，不能只看源码里有没有那行排除。 */
async function runSwCacheArm(browser) {
  const context = await browser.newContext();
  await context.addInitScript(() => {
     try { localStorage.setItem('monthly:done_' + (new Date().getFullYear() * 100 + (new Date().getMonth() + 1)), '1'); } catch (e) {}
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: {} };
    try { localStorage.setItem('moxiaoming:welcomed_v1', '1'); } catch (e) {}
  });
  const page = await context.newPage();

  let manifestVersion = CURRENT;
  const jsonHeaders = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
  // 🔴 尾部星号不能省：update.js 给清单请求加 ?cb=，实测 `**/version.json` 匹配不到带 query 的 URL，
  //    这条 fulfill 会静默不生效，注入的 manifestVersion 永远到不了页面（脚本通道顶上来的假绿）。
  //    同坑见 _selftest/swipe-selftest.cjs:107（本轮一并修掉）。
  await page.route('**/version.json*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', headers: jsonHeaders, body: JSON.stringify({ latest_version: manifestVersion }) }));
  await page.route('**/api/version/latest', (route) => route.fulfill({ status: 404, body: 'not found', headers: jsonHeaders }));
  await page.route('**/api/health', (route) => route.fulfill({ status: 503, body: '{}', headers: jsonHeaders }));
  await page.route('**/api/events', (route) => route.fulfill({ status: 204, body: '', headers: jsonHeaders }));

  await page.goto(BASE + '/', { waitUntil: 'load', timeout: 40000 });

  // 等 SW 注册并接管（sw.js 在 activate 里 clients.claim()，无需 reload）
  let controlled = false;
  try {
    await page.evaluate(() => navigator.serviceWorker.ready);
    for (let i = 0; i < 20; i++) {
      controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
      if (controlled) break;
      await sleep(400);
    }
  } catch (e) { /* 下面按 controlled=false 处理 */ }

  const first = await page.evaluate(async () => {
    const r = await fetch('/version.json', { cache: 'no-store' });
    return (await r.json()).latest_version;
  });
  manifestVersion = BUMPED;                          // 服务端"发了新版"
  const second = await page.evaluate(async () => {
    const r = await fetch('/version.json', { cache: 'no-store' });
    return (await r.json()).latest_version;
  });

  await context.close();
  return { controlled, first, second };
}

(async () => {
  log('=== 墨小溟 · 更新弹窗 APK 启动即弹 · A/B 鉴别力校验 ===');
  log(`目标：${BASE}   模拟 APK 基址：${HOSTED}   当前版本：${CURRENT}`);
  log('');

  // 准备两种 update.js：新版（当前工作区）与旧版（修复前）
  // ⚠️ 必须换**源码** js/update.js —— server.cjs 托管的是仓库根目录，
  //    换 www/js/update.js 不会生效（第一版这里踩过：换了构建产物，被测的却是源码）。
  //    finally 里无条件复原，避免脚本中途失败把工作区留在旧版。
  const targetPath = path.join(ROOT, 'js', 'update.js');
  const newSrc = fs.readFileSync(targetPath, 'utf8');
  // 修复前的基线版本，作为**夹具**随仓库提交（_selftest/fixtures/），保证这套 A/B 可复现。
  // ⚠️ 不要在脚本里 spawn git 取 HEAD：① 本机实测 Node 里 spawnSync('git') 一律 EBUSY
  //    （execSync/execFileSync 都一样，与 shell 无关）；② 更关键的是 —— 修复一旦提交，
  //    HEAD 就变成"新版"，再取 HEAD 等于拿新版跟新版比，鉴别力直接归零。
  const baselinePath = process.env.OLD_UPDATE_JS
    || path.join(__dirname, 'fixtures', 'update-prefix-v1.1.4.js');
  let oldSrc = '';
  try {
    oldSrc = fs.readFileSync(baselinePath, 'utf8');
    if (!oldSrc.trim()) oldSrc = '';
  } catch (e) {
    log('（未找到修复前基线 ' + path.relative(ROOT, baselinePath) + '，跳过 old 臂）');
    oldSrc = '';
  }

  const server = await startServer();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });

  const results = {};

  try {
    for (const variant of ['new', 'old']) {
      if (variant === 'old' && !oldSrc) { log('（跳过 old 臂：取不到 HEAD 版本的 js/update.js）'); continue; }
      fs.writeFileSync(targetPath, variant === 'new' ? newSrc : oldSrc);

      log(`──────── variant = ${variant} ${variant === 'old' ? '（修复前，期望红）' : '（当前，期望全绿）'} ────────`);
      const a = await runArm(browser, variant, CURRENT, 'A 控制臂（清单==当前）');
      const b = await runArm(browser, variant, BUMPED, 'B 处理臂（清单>当前）', variant === 'new');
      results[variant] = { a, b };

      log(`  [A] 清单=${a.manifestVersion} → shown=${a.shown}  title="${a.title}"`);
      log(`  [B] 清单=${b.manifestVersion} → shown=${b.shown}  title="${b.title}"  via=${b.via || '-'}`);
      log(`  [B] 捕获到的版本清单请求：${b.seen.length ? b.seen.join('  |  ') : '（无）'}`);
      if (b.errors.length) log(`  [B] 页面错误：${b.errors.slice(0, 3).join(' || ')}`);
      log('');
    }
  } finally {
    // 无条件复原源码；并自检确实复原了
    fs.writeFileSync(targetPath, newSrc);
    const back = fs.readFileSync(targetPath, 'utf8');
    if (back !== newSrc) { fail++; log('  ❌ js/update.js 未能复原！请手工恢复。'); }
  }

  // ───────────────── SW 缓存行为断言 ─────────────────
  log('');
  log('=== Service Worker 不缓存版本清单（行为验证）===');
  const sw = await runSwCacheArm(browser);
  log(`  SW 是否接管页面：${sw.controlled}   第一次读到：${sw.first}   服务端改成 ${BUMPED} 后再读：${sw.second}`);
  ok(sw.controlled === true, 'SW 已注册并接管页面（否则这条验证不成立，不能算通过）', String(sw.controlled));
  if (sw.controlled) {
    ok(sw.first === CURRENT, '第一次读到的就是服务端清单', sw.first);
    ok(sw.second === BUMPED, '★ 服务端发新版后能立刻读到新值（清单没被 SW 缓存住）', sw.second);
  }

  // ───────────────── 断言 ─────────────────
  const N = results.new;
  if (N) {
    log('=== 新版（当前代码）断言 ===');
    ok(N.a.shown === false, 'A 控制臂：清单版本 == 当前版本 → 不弹（不是"永远弹"）');
    ok(N.b.shown === true, 'B 处理臂：清单版本 > 当前版本 → **启动即自动弹出**');
    ok(new RegExp(BUMPED.replace(/\./g, '\\.')).test(N.b.title), 'B 弹窗标题带上了新版本号（用户看得到"更新到什么"）', N.b.title);
    ok(N.b.hasNowBtn === true, 'B 弹窗有「立即更新」按钮');
    ok(N.b.hasLaterBtn === true, 'B 弹窗有「稍后再说」（非强制，不强推）');
    ok(N.b.force === false, 'B 弹窗是非强制模式（清单 force_update=false）');

    // ★ 缺陷本体：取数地址必须是**绝对基址**，不能是页面同源相对路径
    const hostedHits = N.b.seen.filter((u) => u.startsWith(HOSTED));
    const sameOriginHits = N.b.seen.filter((u) => u.startsWith(BASE));
    ok(hostedHits.length > 0, '★ 取数走绝对基址（APK 里唯一能到达服务端的路径）', `hosted=${hostedHits.length}`);
    ok(sameOriginHits.length === 0, '★ 没有把请求打到页面同源（APK 里那是 WebView 本地资产，必然 404）', sameOriginHits.join(','));
    // v1.6.2 改判据：线上 /version.json 没有 ACAO ⇒ JSON 通道一定被 CORS 拒，
    // 「唯一可行路径」早就不是它了，是**跨域脚本清单通道**。断言必须跟着事实走，
    // 否则测的还是旧架构（实测：旧判据会让 7 条断言假红，逼人去改一处根本没坏的代码）。
    ok(hostedHits.some((u) => /\/api\/version\/latest$/.test(u)), '先探了后端接口 /api/version/latest（有后端时以后端为准）');
    ok(hostedHits.some((u) => /\/version\.json$/.test(u)), '再探了静态清单 version.json（静态托管下唯一还有的 JSON 路）');
    ok(hostedHits.some((u) => /\/version-latest\.js$/.test(u)), '★ 跨域脚本清单 version-latest.js 被真的加载了');
    ok(N.b.corsBlocked.length > 0, '★ CORS 守卫：/version.json 确实被拒了（否则 via 断言是在假通路上通过）', N.b.corsBlocked.join(' | ') || '没有被拒，hostileAcao 没生效');
    ok(N.b.via === 'version-latest.js', '★ 胜出通道 = 脚本通道（JSON 那条被 ACAO 挡住，弹窗不是靠它蒙对的）', String(N.b.via));
    ok(N.b.shown === true && N.a.shown === false && N.b.via !== '', '弹窗效果与通道选择是同一条因果链（不是"永远弹"碰巧撞上）');

    log('');
    log('=== 旧版（修复前）断言：期望**红**，用来证明这套断言有鉴别力 ===');
    const O = results.old;
    if (O) {
      ok(O.b.shown === false, '旧版 B 臂：清单更高却**没弹**（复现缺陷：更新提示从来没出现过）');
      ok(O.b.seen.every((u) => !u.startsWith(HOSTED)), '旧版取数**没有**走绝对基址（根因：没 import apiBase）');
      ok(O.b.seen.some((u) => u.startsWith(BASE)), '旧版请求打在页面同源上（APK 里即 WebView 本地资产 → 404）');
    } else {
      log('  （无 old 臂数据，跳过）');
    }
  }

  await browser.close();
  server.kill();

  log('');
  log('========================================');
  // 汇总行格式与其它自测脚本保持一致（「N 通过 / M 失败」），
  // 否则 llm-mechanism-verify-all.cjs 的 parseTally 抠不到计数，会误报"脚本提前退出"。
  log(` ${pass} 通过 / ${fail} 失败`);
  log('========================================');
  log('说明：old 臂的 3 条断言是**刻意的反向断言**——它们期望旧版表现差。');
  log('      真正的验收标准是：new 臂全绿，且 old 臂那 3 条也成立（=旧版确实坏）。');

  fs.writeFileSync(path.join(__dirname, 'update-apk-abi.out.txt'), out.join('\n'));
  console.log('\n→ 已写 _selftest/update-apk-abi.out.txt');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('脚本自身失败:', e); try { fs.writeFileSync(path.join(__dirname, 'update-apk-abi.out.txt'), out.join('\n') + '\n\n脚本失败: ' + e.message); } catch (_) {} process.exit(1); });
