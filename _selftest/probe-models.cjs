// 墨小溟 · 强推理档模型横评（v1.1.3）
//
// 用户点名的 GLM-4.7-Flash 在网关目录里不存在（目录只有 30 个自家 id，实测确认）。
// 那「强推理档到底该用谁」就不能拍脑袋 —— 这里用**真实的主分析 Prompt**，
// 对候选模型各跑 2 次，比：耗时、是否拿到合法 JSON、正文是否为空、字段完整度。
//
// 运行：NODE_PATH=<managed-node-workspace>/node_modules node _selftest/probe-models.cjs
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.LIVE || 'https://xiaoting.app.workbuddy.host';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  await ctx.route(`${BASE}/**`, async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.startsWith('/.cloud/')) return route.continue();
    if (u.pathname.startsWith('/api/')) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false}' });
    const rel = u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname).replace(/^\/+/, '');
    const f = path.join(ROOT, rel);
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) return route.continue();
    return route.fulfill({ status: 200, contentType: MIME[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f) });
  });
  const page = await ctx.newPage();
  await page.goto(BASE + '/#/say', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#talkbtn', { timeout: 30000 });

  const CANDIDATES = process.env.MODELS ? process.env.MODELS.split(',') : ['glm-5.0', 'deepseek-v4.1-flash', 'glm-4.7'];
  const INPUTS = [
    '我今天很烦。',
    '今天又和男朋友吵架了，他很晚才回我消息，我觉得他根本不在乎我。',
  ];

  const result = await page.evaluate(async ({ models, inputs }) => {
    const cfg = await import('/js/config.js');
    const prompts = await import('/js/prompts.js');
    const llm = await import('/js/llm.js');
    const api = await import('/js/api.js');
    await llm.modelCatalog();

    const PK = cfg.CLOUD.publishableKey;
    const EP = cfg.CLOUD.endpoint + '/.cloud/llm/chat/completions';

    async function one(model, user, temp, jsonMode = true) {
      const t0 = Date.now();
      try {
        const bodyObj = {
          model,
          messages: [{ role: 'system', content: prompts.SYSTEM.main }, { role: 'user', content: prompts.buildMainPrompt(user, null) }],
          stream: true,
          temperature: temp,
        };
        if (jsonMode) bodyObj.response_format = { type: 'json_object' };
        const res = await fetch(EP, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'x-wb-webapp-access-key': PK },
          body: JSON.stringify(bodyObj),
        });
        const txt = await res.text();
        const ms = Date.now() - t0;
        if (!res.ok) return { ms, ok: false, code: 'http_' + res.status, chars: 0, fields: 0, text: txt.slice(0, 120) };
        // 手动拼 SSE 正文
        let body = '';
        for (const line of txt.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const d = line.slice(5).trim();
          if (!d || d === '[DONE]') continue;
          try {
            const j = JSON.parse(d);
            const c = j.choices && j.choices[0];
            if (c && c.delta && c.delta.content) body += c.delta.content;
          } catch (e) { /* ignore */ }
        }
        const data = llm.extractJson(body);
        const fields = data ? Object.keys(data).length : 0;
        return {
          ms, ok: !!data, code: data ? '' : (body.trim() ? 'json_parse_failed' : 'empty_response'),
          chars: body.length, fields,
          intensity: data ? data.intensity : null,
          emotion: data ? (data.emotion || []).join('、') : '',
          summary: data ? String(data.summary || '').slice(0, 46) : '',
          // 追问质量信号：主分析自带的 followup_questions 越具体，后续追问越不空泛
          fu: data && Array.isArray(data.followup_questions) ? String(data.followup_questions[0] || '').slice(0, 30) : '',
        };
      } catch (e) {
        return { ms: Date.now() - t0, ok: false, code: String(e && e.message || e), chars: 0, fields: 0, text: '' };
      }
    }

    const out = [];
    for (const m of models) {
      for (const inp of inputs) {
        const a = await one(m, inp, 0.3, !(m === 'glm-4.7'));
        const b = await one(m, inp, 0.3, !(m === 'glm-4.7'));
        out.push({ model: m, input: inp.slice(0, 12), runs: [a, b] });
      }
    }
    return out;
  }, { models: CANDIDATES, inputs: INPUTS });

  console.log('模型横评（真实主分析 Prompt，每个组合跑 2 次）\n');
  const byModel = {};
  for (const r of result) {
    byModel[r.model] = byModel[r.model] || [];
    byModel[r.model].push(r);
  }
  console.log('模型'.padEnd(24) + '成功  平均耗时  正文长度  字段数  强度  情绪');
  for (const m of CANDIDATES) {
    const rows = (byModel[m] || []);
    const runs = rows.flatMap((r) => r.runs);
    const oks = runs.filter((r) => r.ok);
    const avg = Math.round(runs.reduce((s, r) => s + r.ms, 0) / runs.length);
    const avgChars = Math.round(oks.reduce((s, r) => s + r.chars, 0) / (oks.length || 1));
    const avgFields = (oks.reduce((s, r) => s + r.fields, 0) / (oks.length || 1)).toFixed(1);
    console.log(
      m.padEnd(24) +
      `${oks.length}/${runs.length}`.padEnd(6) +
      `${avg}ms`.padEnd(10) +
      String(avgChars).padEnd(10) +
      String(avgFields).padEnd(8) +
      String(oks.map((r) => r.intensity).join(',')).padEnd(6) +
      (oks[0] ? oks[0].emotion : (runs[0].code || ''))
    );
  }
  console.log('\n明细：');
  result.forEach((r) => {
    r.runs.forEach((x, i) => console.log(`  ${r.model.padEnd(22)} #${i + 1} ${String(x.ms).padStart(6)}ms ${x.ok ? 'OK ' : 'FAIL ' + x.code} 字段=${x.fields} 强度=${x.intensity} 情绪=${x.emotion}\n      摘要: ${x.summary || x.text || ''}\n      追问: ${x.fu || '-'}`));
  });

  await browser.close();
})().catch((e) => { console.error('异常:', e); process.exit(2); });
