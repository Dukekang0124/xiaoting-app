/**
 * 上线完整性审计 · 真浏览器 SDK 探针
 *
 * 为什么需要它：
 *   用 curl 裸 POST `/.cloud/llm/chat/completions` 带 `Authorization: Bearer <publishableKey>` 会得到
 *   401 invalid_client —— 但这不是 SDK 的真实协议（SDK 要先拿 token 再用 Bearer token）。
 *   若不实测真实路径，就会把「协议不对」误报成「密钥被吊销」。这正是必须排除的假阳性。
 *
 * 做法：
 *   用本机 Chrome 打开线上站点 → 在页面里 import 真实链路 → 发一句话 → 观察是否流式返回。
 *   同时对 index.html 里实际引用的资源逐个探活，找出线上缺失文件。
 */
const path = require('path');
const NODE_PATH = process.env.NODE_PATH || '';
if (NODE_PATH) module.paths.push(...NODE_PATH.split(path.delimiter));

const { chromium } = require('playwright');

const BASE = process.env.BASE || 'https://xiaoting.app.workbuddy.host';
const out = [];
const log = (...a) => { const s = a.join(' '); out.push(s); console.log(s); };

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();

  const errors = [];
  const netFail = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  page.on('response', (r) => { if (r.status() >= 400) netFail.push(r.status() + ' ' + r.url()); });

  log('=== 1. 打开线上站点 ===');
  await page.goto(BASE + '/', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(2500);

  const ver = await page.evaluate(() => window.APP_VERSION || '(无)');
  log('  window.APP_VERSION = ' + ver);

  log('=== 2. index.html 引用资源逐个探活（找线上缺失文件）===');
  const refs = await page.evaluate(() => {
    const urls = [];
    document.querySelectorAll('script[src],link[href]').forEach((el) => {
      const u = el.getAttribute('src') || el.getAttribute('href');
      if (u && !/^https?:/.test(u) && !u.startsWith('data:')) urls.push(u);
    });
    return urls;
  });
  for (const u of refs) {
    const r = await page.request.get(new URL(u, BASE).toString()).catch(() => null);
    log('  ' + String(r ? r.status() : 'ERR').padEnd(5) + u);
  }

  log('=== 3. 真浏览器调 SDK（AI 对话真路径）===');
  const sdk = await page.evaluate(async () => {
    // index.html 里 config.js 是 module，SDK 是动态加载的全局脚本。
    // 直接 import 业务模块，走真实链路。
    try {
      const cfg = await import('/js/config.js');
      const info = {
        endpoint: cfg.CLOUD && cfg.CLOUD.endpoint,
        keyPrefix: (cfg.CLOUD && cfg.CLOUD.publishableKey || '').slice(0, 12),
        hasSDKGlobal: typeof window.WorkBuddyCloud !== 'undefined',
      };
      // 触发 SDK 加载（config.js 里 loadSDK 的等价动作）
      if (!window.WorkBuddyCloud && cfg.loadCloudSDK) { try { await cfg.loadCloudSDK(); } catch (e) {} }
      info.hasSDKGlobalAfterLoad = typeof window.WorkBuddyCloud !== 'undefined';
      return info;
    } catch (e) {
      return { error: String(e && e.message || e) };
    }
  });
  log('  ' + JSON.stringify(sdk));

  // 用真实 llm.js 发一句话。
  // ⚠️ 导出名随版本变：1.1.x 是 ask()，0.6.0 是 call/callJson()。两个都试，避免因名字不对误判。
  const chat = await page.evaluate(async () => {
    try {
      const m = await import('/js/llm.js');
      const state = {
        exports: Object.keys(m).sort(),
        isReal: typeof m.isReal === 'function' ? m.isReal() : '(无 isReal)',
        provider: typeof m.providerName === 'function' ? m.providerName() : '(无 providerName)',
        hint: typeof m.readyHint === 'function' ? m.readyHint() : '(无 readyHint)',
      };
      const fn = m.callJson || m.call || m.ask;
      if (typeof fn !== 'function') return { ...state, error: '找不到可调用的导出函数' };
      if (typeof m.readyInit === 'function') { try { await m.readyInit(); } catch (e) {} }
      const t0 = Date.now();
      let r;
      try {
        r = await fn({ stage: 'demo', system: '你是测试。只回答一个词。', user: '说“好”', json: false, timeoutMs: 20000 });
      } catch (e) { return { ...state, throw: String(e && e.message || e), ms: Date.now() - t0 }; }
      return { ...state, ms: Date.now() - t0, got: r == null ? null : String(typeof r === 'string' ? r : JSON.stringify(r)).slice(0, 160) };
    } catch (e) {
      return { error: String(e && e.message || e) };
    }
  });
  log('  ' + JSON.stringify(chat));
  log('  （got/throw 有内容 = 真链路跑通了；got=null 且 isReal=false = 云端不可用走了兜底）');

  log('=== 4. 找实际发往云端的请求 ===');
  const cloudReqs = [];
  page.on('request', (r) => { if (/\.cloud\//.test(r.url())) cloudReqs.push(r.method() + ' ' + r.url()); });
  const chat2 = await page.evaluate(async () => {
    try {
      const m = await import('/js/llm.js');
      const fn = m.callJson || m.call || m.ask;
      if (typeof fn !== 'function') return { error: '找不到可调用的导出函数' };
      const r = await fn({ stage: 'demo', system: '你是测试。只回答一个词。', user: '说“好”', json: false, timeoutMs: 20000 });
      return { got: r == null ? null : String(typeof r === 'string' ? r : JSON.stringify(r)).slice(0, 160) };
    } catch (e) { return { error: String(e && e.message || e) }; }
  });
  log('  第二次调用 → ' + JSON.stringify(chat2));
  log('  捕获到的 .cloud/* 请求：' + (cloudReqs.length ? cloudReqs.join(' | ') : '（无 —— 说明没走云端）'));

  log('=== 5. 同源 API 探活 ===');
  const apis = ['/api/health', '/api/version/latest', '/api/llm/ping'];
  for (const p of apis) {
    const r = await page.request.post(BASE + p).catch(() => null);
    log('  POST ' + p.padEnd(22) + ' → ' + (r ? r.status() : 'ERR'));
  }

  log('=== 6. 页面错误汇总 ===');
  log('  pageerror/console.error: ' + (errors.length ? errors.slice(0, 8).join(' || ') : '无'));
  log('  >=400 网络响应: ' + (netFail.length ? [...new Set(netFail)].slice(0, 12).join(' || ') : '无'));

  await browser.close();
  const txt = out.join('\n');
  require('fs').writeFileSync(path.join(__dirname, 'audit-sdk-live-probe.out.txt'), txt);
  console.log('\n→ 已写 _selftest/audit-sdk-live-probe.out.txt');
})().catch((e) => { console.error('探针自身失败:', e); process.exit(1); });
