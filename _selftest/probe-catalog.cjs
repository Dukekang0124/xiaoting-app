// 一次性探针：把 WorkBuddy 网关的**真实模型目录**全量拉出来，回答三个问题：
//   1) 目录里到底有哪些模型 id？（用户点名的 GLM-4-Flash / GLM-4.7-Flash / Qwen2.5-7B-Instruct 存不存在）
//   2) 每个模型的关键字段是什么（onlyReasoning / maxOutputTokens / credits）
//   3) 我们前端按档位实际会选到谁（fast / strong）
// 运行：NODE_PATH=<managed-node-workspace>/node_modules node _selftest/probe-catalog.cjs
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.LIVE || 'https://xiaoting.app.workbuddy.host';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
};

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  await ctx.route(`${BASE}/**`, async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.startsWith('/.cloud/')) return route.continue();
    if (u.pathname.startsWith('/api/')) {
      if (u.pathname === '/api/health') return route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: '{"ok":true,"version":"0.0.0-nobackend","asr":"unconfigured"}' });
      return route.fulfill({ status: 503, contentType: 'application/json; charset=utf-8', body: '{"ok":false,"error":"asr_not_configured"}' });
    }
    const rel = u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname).replace(/^\/+/, '');
    const f = path.join(ROOT, rel);
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) return route.continue();
    return route.fulfill({ status: 200, contentType: MIME[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f) });
  });
  const page = await ctx.newPage();
  await page.goto(BASE + '/#/say', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#talkbtn', { timeout: 30000 });

  const out = await page.evaluate(async () => {
    const llm = await import('/js/llm.js');
    const cat = (await llm.modelCatalog()) || [];
    const rankFast = (await llm.modelRanking('fast')) || [];
    const rankStrong = (await llm.modelRanking('strong')) || [];
    const keys = new Set();
    cat.forEach((m) => Object.keys(m).forEach((k) => keys.add(k)));
    return {
      size: cat.length,
      fields: Array.from(keys),
      rows: cat.map((m) => ({
        id: m.id || m.model || m.name,
        onlyReasoning: m.onlyReasoning,
        maxOutputTokens: m.maxOutputTokens,
        credits: m.credits,
      })),
      rankFast, rankStrong,
    };
  });

  console.log('=== 网关模型目录（真实拉取）===');
  console.log('模型数: ' + out.size);
  console.log('字段集: ' + out.fields.join(', '));
  console.log('\nid | onlyReasoning | maxOutputTokens | credits');
  out.rows.forEach((r) => console.log(`  ${String(r.id).padEnd(34)} ${String(r.onlyReasoning).padEnd(6)} ${String(r.maxOutputTokens).padEnd(8)} ${String(r.credits)}`));

  const want = ['GLM-4-Flash', 'GLM-4.7-Flash', 'Qwen2.5-7B-Instruct', 'glm-4-flash', 'glm-4.7-flash', 'qwen2.5-7b-instruct'];
  console.log('\n=== 用户点名模型是否在目录内 ===');
  want.forEach((w) => {
    const hit = out.rows.filter((r) => String(r.id).toLowerCase().includes(w.toLowerCase()));
    console.log(`  ${w.padEnd(24)} ${hit.length ? '命中: ' + hit.map((h) => h.id).join(', ') : '不存在'}`);
  });

  console.log('\n=== 前端档位实际选型序 ===');
  console.log('  fast  (安全识别): ' + JSON.stringify(out.rankFast));
  console.log('  strong(主分析等): ' + JSON.stringify(out.rankStrong));

  await browser.close();
})().catch((e) => { console.error('异常:', e); process.exit(2); });
