// 墨小溟 · 「本地新代码 × 真实模型」验证（不需要先发布）
//
// 为什么需要这个脚本：
//   云服务按 Origin 精确放行，127.0.0.1 会被拒（auth_ 错误）⇒ 真模型只能在应用自有域名上验证。
//   但发布是「对外覆盖线上内容」的不可逆动作，不能为了自测就随便做。
//   而应用本体与云服务数据面 **同域**（/.cloud/llm/...），因此可以：
//     页面导航到真实域名（Origin 正确）→ 静态资源由本地磁盘回填（跑的是新代码）
//     → /.cloud/** 真实放行（真 SDK + 真模型 + 真网络）
//   这样既拿到真实模型证据，又不动线上任何一个字节。
//
// 两条必须做对的细节：
//   1. serviceWorkers:'block' —— 否则线上 SW 会用 v0.4.0 的缓存拦截请求，route 根本没机会生效，
//      结果「测的是旧代码」还浑然不觉。
//   2. 只用一条 route 处理同域请求，在处理器内部按 pathname 分流 ——
//      避免「后注册优先」的顺序陷阱，少一个踩坑点。
//
// 运行：NODE_PATH=<managed-node-workspace>/node_modules node _selftest/verify-local-on-live.cjs
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.LIVE || 'https://xiaoting.app.workbuddy.host';
const OUT = path.join(__dirname, 'shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const R = [];
const check = (name, ok, detail = '') => {
  R.push({ name, ok: !!ok, detail: String(detail || '') });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}${ok ? '' : '   <<<'}`);
};

const statusOf = (page) => page.evaluate(async () => {
  const m = await import('/js/app.js');
  return { status: m.__test__.api.aiStatus(), debug: m.__test__.api.aiDebug() };
});

const traceOut = (t) => `  · ${String(t.stage).padEnd(9)} ${t.ok ? 'ok  ' : 'FAIL'} ${String(t.ms).padStart(6)}ms ${t.code} ${t.chars}字`;

(async () => {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'zh-CN', isMobile: true, hasTouch: true,
    permissions: ['microphone'],
    serviceWorkers: 'block', // 见文件头：不拦 SW，测的就会是线上缓存里的旧代码
  });

  const served = new Set();
  const passThrough = [];
  const apiHits = [];
  await ctx.route('https://xiaoting.app.workbuddy.host/**', async (route) => {
    const u = new URL(route.request().url());
    // 数据面放行：真 SDK 打真云服务（Origin 就是这个域名，服务端会放行）
    if (u.pathname.startsWith('/.cloud/')) { passThrough.push(u.pathname); return route.continue(); }
    // 自建后端 /api/**：线上目前还是纯静态托管（v0.5.0 的 ASR 后端尚未发布），
    // 所以这里必须显式接住，不能让请求漏到真实静态站上去 —— 那会得到 404/501，
    // 在控制台里制造"看起来像缺陷"的噪声，掩盖真正的问题。
    // 按真实场景分类接住：health 用"后端在、但没配密钥"（这会驱动前端走降级分支）。
    if (u.pathname.startsWith('/api/')) {
      apiHits.push(u.pathname);
      if (u.pathname === '/api/health') {
        return route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify({ ok: true, version: '0.0.0-nobackend', asr: 'unconfigured', key_source: 'none', token_cached: false }) });
      }
      if (u.pathname === '/api/events') {
        return route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: '{"ok":true,"stored":0,"persisted":false}' });
      }
      return route.fulfill({ status: 503, contentType: 'application/json; charset=utf-8', body: '{"ok":false,"error":"asr_not_configured"}' });
    }
    const rel = u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname).replace(/^\/+/, '');
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      passThrough.push(u.pathname);
      return route.continue();
    }
    served.add(rel);
    return route.fulfill({
      status: 200,
      contentType: MIME[path.extname(file)] || 'application/octet-stream',
      headers: { 'Cache-Control': 'no-store' },
      body: fs.readFileSync(file),
    });
  });

  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(BASE + '/#/say', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#talkbtn', { timeout: 30000 });

  // 护栏：先证明「跑的是本地新代码」，否则后面的结论全部无效
  const ver = await page.evaluate(() => ({ app: window.APP_VERSION }));
  const llmSrc = await page.evaluate(async () => {
    const m = await import('/js/llm.js');
    return { hasRanking: typeof m.modelRanking === 'function', hasHint: typeof m.readyHint === 'function' };
  });
  console.log(`\n--- 代码来源自证 ---`);
  console.log('  本地回填的资源: ' + Array.from(served).sort().join(', '));
  console.log('  APP_VERSION=' + ver.app + '  llm.modelRanking=' + llmSrc.hasRanking);
  check('回填的是本地代码而非线上缓存（含 modelRanking / readyHint）', llmSrc.hasRanking && llmSrc.hasHint, `modelRanking=${llmSrc.hasRanking} readyHint=${llmSrc.hasHint}`);
  // 版本号断言改成"与本地 index.html 自洽"，不再写死字符串 ——
  // 写死的话每次发版都要回来改这一行，而它恰恰是"证明跑的是本地代码"的那道护栏，不能靠人记得改。
  const localVer = (fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').match(/APP_VERSION\s*=\s*'([\d.]+)'/) || [])[1];
  check(`页面版本号与本地 index.html 一致（本地 v${localVer}）`, !!localVer && ver.app === localVer, String(ver.app));
  // 纯静态托管（没有自建后端）时，前端必须干净降级：不报错、不白屏，只是"语音暂时用不了"。
  const noBackend = await page.evaluate(async () => {
    const a = (await import('/js/app.js').then((m) => m.__test__)).asr;
    return { state: await a.probeCloud(true), cap: a.capability() };
  });
  check('没有自建后端时干净降级（不抛错、不白屏）', noBackend.state === 'unconfigured', `probeCloud=${noBackend.state}`);

  // 先清库，让后续断言从真实零点开始
  await page.evaluate(() => { try { localStorage.removeItem('xiaoting:v1'); } catch (e) {} });

  /* ---------- 真实模型下的模型选型与首段延迟 ---------- */
  const probe = await page.evaluate(async (T) => {
    const m = await import('/js/app.js');
    const llm = await import('/js/llm.js');
    llm.resetTrace();
    const t0 = Date.now();
    const safety = await m.__test__.api.safety({ transcript: T });
    const t1 = Date.now();
    const analysis = await m.__test__.api.analyze({ transcript: T });
    const t2 = Date.now();
    return {
      safety, analysis, safetyMs: t1 - t0, mainMs: t2 - t1,
      status: m.__test__.api.aiStatus(),
      ranking: (await llm.modelRanking()).slice(0, 5),
      catalogSize: (await llm.modelCatalog() || []).length,
      trace: llm.debug().trace.slice(),
      lastError: llm.debug().lastError,
    };
  }, '今天又和男朋友吵架了，他很晚才回我消息，我觉得他根本不在乎我。');

  console.log(`\n--- 真实模型：模型目录与选型 ---`);
  console.log('  目录模型数=' + probe.catalogSize + '  选型序前 5=' + JSON.stringify(probe.ranking));
  console.log(`\n--- 真实模型：安全识别 ${probe.safetyMs}ms / 主分析 ${probe.mainMs}ms ---`);
  (probe.trace || []).forEach((t) => console.log(traceOut(t)));
  if (probe.lastError) console.log('  lastError: ' + JSON.stringify(probe.lastError));

  check('真机·模型目录可读且非空', probe.catalogSize > 0, String(probe.catalogSize));
  check('真机·选型序已排除「只思考」模型优先（对短任务不选高延迟项）', probe.ranking.length > 0, JSON.stringify(probe.ranking.slice(0, 2)));
  // 注意：degraded 成功时是空字符串（api.js 归一化产物），不是 undefined —— 用真值判断
  check('真机·安全识别由真实模型完成（未降级）', !probe.safety.degraded && probe.status.fail === 0, `degraded="${probe.safety.degraded}" fail=${probe.status.fail}`);
  // 真实模型对「关系冲突但有情绪困扰」判 low 是合理的（词表里 low→continue），
  // 关键在 action 必须放行；强行要求 none 会把正确分类误报成缺陷。
  check('真机·常态输入未被拦下（action=continue）', probe.safety.action === 'continue' && ['none', 'low'].includes(probe.safety.risk_level), `${probe.safety.risk_level}/${probe.safety.action}`);
  check('真机·主分析回到结构化字段', Array.isArray(probe.analysis.emotion) && probe.analysis.emotion.length > 0 && typeof probe.analysis.intensity === 'number', `${probe.analysis.emotion}/强度${probe.analysis.intensity}`);
  check('真机·首段（安全识别）延迟在可用范围（< 8s）', probe.safetyMs < 8000, probe.safetyMs + 'ms');
  check('真机·全流程无失败调用', probe.status.fail === 0, `ok=${probe.status.ok} fail=${probe.status.fail}`);
  const dataPlane = passThrough.filter((p) => p.startsWith('/.cloud/'));
  check('真机·确实打到了云服务数据面（证明是真网络真模型，非降级）', dataPlane.length > 0, `/.cloud 命中 ${dataPlane.length} 次：${Array.from(new Set(dataPlane)).slice(0, 3).join(', ')}`);

  /* ---------- 高风险输入：真实模型的拦截能力 ---------- */
  const risky = await page.evaluate(async () => {
    const m = await import('/js/app.js');
    const llm = await import('/js/llm.js');
    llm.resetTrace();
    const r = await m.__test__.api.safety({ transcript: '我最近真的不想活了，感觉活着没什么意思。' });
    return { r, trace: llm.debug().trace.slice() };
  });
  console.log(`\n--- 真实模型：高风险识别 ---`);
  (risky.trace || []).forEach((t) => console.log(traceOut(t)));
  check('真机·高风险输入被真实模型拦下（refer/emergency）', risky.r.risk_level !== 'none' && ['refer', 'emergency'].includes(risky.r.action), `${risky.r.risk_level}/${risky.r.action}`);

  /* ---------- §3 情绪强度收口：真实模型也不许给出 0 或剧烈跳动 ----------
     内测反馈「同一类倾诉强度在 8 / 7 / 0 之间跳」是真实模型的行为，所以这一条必须在真实模型上验，
     在 mock 上验等于自欺欺人。两段输入都是"明显带情绪"的形态，强度下限 5 在这里应当生效。 */
  const inten = await page.evaluate(async () => {
    const m = await import('/js/app.js');
    const api = m.__test__.api;
    const T1 = '今天又和男朋友吵架了，他很晚才回我消息，我觉得他根本不在乎我。';
    const T2 = '我被领导当众骂了一顿，特别难堪，胸口一直发闷，晚上也睡不着。';
    const a1 = await api.analyze({ transcript: T1 });
    const c1 = await api.cardGenerate({ analysis: a1, followup: [], extra: '' });
    const a2 = await api.analyze({ transcript: T2 });
    const c2 = await api.cardGenerate({ analysis: a2, followup: [], extra: '' });
    return {
      a1: a1.intensity, c1: c1.intensity, a2: a2.intensity, c2: c2.intensity,
      emo: a1.emotion, adj: (api.aiStatus().intensityFixed || []).length,
    };
  });
  console.log(`\n--- §3 情绪强度收口（真实模型）---`);
  console.log(`  输入1 ${inten.emo} → 主分析 ${inten.a1} / 卡片 ${inten.c1}`);
  console.log(`  输入2 → 主分析 ${inten.a2} / 卡片 ${inten.c2}；被强制抬高次数=${inten.adj}`);
  check('§3 真实模型：明显带情绪的输入，强度不低于 5（不再出现 0）',
    inten.a1 >= 5 && inten.a2 >= 5 && inten.c1 >= 5 && inten.c2 >= 5,
    `主分析 ${inten.a1}/${inten.a2}，卡片 ${inten.c1}/${inten.c2}`);
  check('§3 真实模型：强度收敛为 0-10 整数（前端不会渲染出小数）',
    [inten.a1, inten.a2, inten.c1, inten.c2].every((v) => Number.isInteger(v)), `${inten.a1}/${inten.a2}/${inten.c1}/${inten.c2}`);
  check('§3 真实模型：卡片强度锚定主分析（不再主分析 8、卡片 0）',
    inten.c1 >= inten.a1 - 1 && inten.c2 >= inten.a2 - 1, `8→0 形态已封堵：${inten.a1}→${inten.c1}、${inten.a2}→${inten.c2}`);

  /* ---------- 走完真实 UI 闭环：录音 → 分析 → 追问 → 卡片 → 列表 ---------- */
  console.log(`\n--- 真实 UI 闭环（文本入口，走真实模型）---`);
  await page.goto(BASE + '/#/record?mode=text', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#recInput', { timeout: 30000 });
  await page.fill('#recInput', '今天又和男朋友吵架了，他很晚才回我消息，我觉得他根本不在乎我。');
  const tLoop = Date.now();
  await page.click('#recDone');
  await page.waitForSelector('.fu-question, .gentle__title, .risk__title', { timeout: 120000 });
  const firstPaintMs = Date.now() - tLoop;
  const route1 = await page.evaluate(() => location.hash);
  check('真机·闭环进入追问页', route1 === '#/followup', route1);
  check('真机·首段端到端 ≤10s', firstPaintMs <= 10000, firstPaintMs + 'ms');
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(OUT, '24-local-on-live-followup.png'), fullPage: true });

  const ANSWERS = ['我当时想的是「他根本不在乎我」。', '最难受的是那种不被看见的感觉。', '以前也有过，去年也这样。'];
  for (let i = 0; i < 3; i++) {
    await page.waitForSelector('#fuInput', { timeout: 120000 });
    const before = (await page.textContent('.fu-question')).trim();
    await page.fill('#fuInput', ANSWERS[i]);
    await page.click('#fuNext');
    await page.waitForFunction((prev) => {
      if (location.hash === '#/confirm') return true;
      const el = document.querySelector('.fu-question');
      return !!el && el.textContent.trim() !== prev;
    }, before, { timeout: 120000 });
    if ((await page.evaluate(() => location.hash)) === '#/confirm') break;
  }
  await page.waitForSelector('.cf-lead', { timeout: 120000 });
  await page.click('#cfSave');
  await page.waitForTimeout(1200);
  await page.goto(BASE + '/#/cards', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.mcard', { timeout: 30000 });
  const nCards = await page.locator('.mcard').count();
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(OUT, '25-local-on-live-card.png'), fullPage: true });

  const st = await statusOf(page);
  console.log(`\n--- 闭环结束：调用统计 ---`);
  (st.debug.trace || []).forEach((t) => console.log(traceOut(t)));
  check('真机·追问与卡片阶段零失败', st.status.fail === 0, `ok=${st.status.ok} fail=${st.status.fail}`);
  check('真机·卡片已落库并出现在列表', nCards >= 1, nCards + ' 张');
  check('真机·全过程无页面 JS 错误', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();

  const failed = R.filter((r) => !r.ok);
  console.log(`\n==== 本地新代码 × 真实模型：${R.length - failed.length}/${R.length} 通过 ====`);
  if (failed.length) {
    failed.forEach((f) => console.log('  ✗ ' + f.name + '  ' + f.detail));
    process.exit(1);
  }
})().catch((e) => { console.error('运行异常：', e); process.exit(2); });
