// 墨小溟 CF 网关 · 无密钥本地逻辑验证（不发真请求、不花真钱）
//
// 做法：把全局 fetch 替换成可控的 mock，断言网关的路由/降级/门禁/脱敏逻辑符合预期。
// 运行：node cloudflare/llm/_selftest.mjs
//
// 缓存已按「影响配置的环境变量组合」分 key（见 [[path]].js 的 CONFIG_CACHE），
// 不同 env 天然隔离，不再需要靠 ?v=N 重载模块来清缓存 —— 保留 ?v=N 只为绕开 ESM 导入缓存。

import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const FUNC = resolve(dirname(fileURLToPath(import.meta.url)), 'functions/api/[[path]].js');
let passed = 0, failed = 0;
const fails = [];

function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✓', msg); }
  else { failed++; fails.push(msg); console.log('  ✗', msg); }
}

function loadHandler(v) {
  const url = pathToFileURL(FUNC).href + '?v=' + v;
  return import(url);
}

function makeRequest(url, method, body, headers = {}) {
  const h = { 'content-type': 'application/json', ...headers };
  return new Request('https://x' + url, { method, headers: h, body: body != null ? JSON.stringify(body) : undefined });
}

// 构造可控的 mock fetch：根据 scenario 决定每个模型返回什么
async function withMockFetch(scenario, fn) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body || '{}');
    calls.push({ url, model: body.model, reasoning_effort: body.reasoning_effort, hasAuth: !!(opts.headers && (opts.headers.Authorization || opts.headers['x-wb-webapp-access-key'])), stream: !!body.stream });
    const decision = scenario(body, calls);
    if (decision.sse) {
      const sse = 'data: ' + JSON.stringify({ choices: [{ delta: { content: decision.text } }] }) + '\n\ndata: [DONE]\n';
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify(decision.json || {}), { status: decision.status || 200, headers: { 'content-type': 'application/json' } });
  };
  try { return await fn(calls); }
  finally { globalThis.fetch = orig; }
}

async function main() {
  // ===== 用例 1：首档成功（openrouter glm-5.3-flash），验证 reasoning_effort 逃生门 =====
  console.log('\n[1] 首档 openrouter:glm-5.3-flash 成功 + params 逃生门');
  {
    const { onRequest } = await loadHandler(1);
    const env = { OPENROUTER_KEY: 'or_k', AGNES_KEY: 'ag_k', ZHIPU_KEY: 'zp_k', ALLOWED_ORIGINS: 'https://xiaoting.app.workbuddy.host' };
    const res = await withMockFetch((body) => {
      if (body.model === 'z-ai/glm-5.3-flash') return { json: { choices: [{ message: { content: '{"ok":true}' } }] } };
      return { status: 500, json: { error: { message: 'x' } } };
    }, async (calls) => {
      const r = await onRequest({ request: makeRequest('/api/llm', 'POST', { module: 'analysis', system: 's', user: '今天很累' }, { origin: 'https://xiaoting.app.workbuddy.host' }), env });
      return { r, calls };
    });
    const data = await res.r.json();
    assert(res.r.status === 200, 'HTTP 200');
    assert(data.ok === true, 'ok=true');
    assert(data.model === 'z-ai/glm-5.3-flash', '用了首档 openrouter glm-5.3-flash，实际=' + data.model);
    assert(data.channel === 'openrouter', 'channel=openrouter');
    assert(data.degraded === false, '未降级');
    const first = res.calls[0];
    assert(first.model === 'z-ai/glm-5.3-flash', '首跳模型正确');
    assert(first.reasoning_effort === 'low', 'glm-5.3-flash 带 reasoning_effort=low（逃生门生效），实际=' + JSON.stringify(first.reasoning_effort));
    assert(first.hasAuth === true, '请求带了 Authorization');
  }

  // ===== 用例 2：首档失败 → 自动降级到 workbuddy 流式 =====
  console.log('\n[2] 首档 openrouter 500 → 降级 workbuddy 流式');
  {
    const { onRequest } = await loadHandler(2);
    const env = { OPENROUTER_KEY: 'or_k', AGNES_KEY: 'ag_k', ZHIPU_KEY: 'zp_k', ALLOWED_ORIGINS: 'https://xiaoting.app.workbuddy.host' };
    const res = await withMockFetch((body) => {
      if (body.model === 'z-ai/glm-5.3-flash') return { status: 500, json: { error: { message: 'boom' } } };
      if (body.model === 'glm-5.3-flash') return { sse: true, text: '{"ok":true}' }; // workbuddy 流式
      return { status: 500, json: { error: { message: 'x' } } };
    }, async (calls) => {
      const r = await onRequest({ request: makeRequest('/api/llm', 'POST', { module: 'analysis', system: 's', user: 'u' }, { origin: 'https://xiaoting.app.workbuddy.host' }), env });
      return { r, calls };
    });
    const data = await res.r.json();
    assert(data.ok === true, 'ok=true');
    assert(data.degraded === true, '降级标记=true');
    assert(data.attempts >= 2, 'attempts>=2，实际=' + data.attempts);
    assert(data.tried.length >= 2, 'tried 记录了两档，实际=' + data.tried.length);
    assert(res.calls.some((c) => c.model === 'z-ai/glm-5.3-flash' && !c.stream), '第一跳是 openrouter 非流');
    assert(res.calls.some((c) => c.model === 'glm-5.3-flash' && c.stream), '第二跳是 workbuddy 流式');
  }

  // ===== 用例 3：缺 key 的 provider 被剔除，不进候选链 =====
  console.log('\n[3] 缺 OPENROUTER_KEY → openrouter 两档被剔除，首档变 workbuddy');
  {
    const { onRequest } = await loadHandler(3);
    const env = { AGNES_KEY: 'ag_k', ZHIPU_KEY: 'zp_k', ALLOWED_ORIGINS: 'https://xiaoting.app.workbuddy.host' }; // 无 OPENROUTER_KEY
    const res = await withMockFetch((body) => ({ json: { choices: [{ message: { content: 'ok' } }] } }), async (calls) => {
      const r = await onRequest({ request: makeRequest('/api/llm', 'POST', { module: 'analysis', system: 's', user: 'u' }, { origin: 'https://xiaoting.app.workbuddy.host' }), env });
      return { r, calls };
    });
    const data = await res.r.json();
    assert(data.ok === true, 'ok=true');
    assert(data.tried[0].provider !== 'openrouter', '首跳不是 openrouter，实际=' + data.tried[0].provider);
    assert(!res.calls.some((c) => c.model && c.model.includes('z-ai/glm-5.3-flash')), 'openrouter 模型完全没被请求');
  }

  // ===== 用例 4：Origin 门禁 =====
  console.log('\n[4] Origin 门禁：放行白名单 / 拦截未知来源 / 原生无 Origin 放行');
  {
    const { onRequest } = await loadHandler(4);
    const env = { OPENROUTER_KEY: 'or_k', AGNES_KEY: 'ag_k', ZHIPU_KEY: 'zp_k', ALLOWED_ORIGINS: 'https://xiaoting.app.workbuddy.host' };
    // 4a 白名单内 → 200
    const ok = await onRequest({ request: makeRequest('/api/llm', 'POST', { module: 'analysis', system: 's', user: 'u' }, { origin: 'https://xiaoting.app.workbuddy.host' }), env });
    assert(ok.status === 200, '白名单来源 200');
    // 4b 未知来源 → 403
    const bad = await onRequest({ request: makeRequest('/api/llm', 'POST', { module: 'analysis', system: 's', user: 'u' }, { origin: 'https://evil.example' }), env });
    assert(bad.status === 403, '未知来源 403，实际=' + bad.status);
    const badBody = await bad.json();
    assert(badBody.error === 'origin_not_allowed', '错误码 origin_not_allowed');
    // 4c 原生（无 Origin）→ 放行
    const native = await onRequest({ request: makeRequest('/api/llm', 'POST', { module: 'analysis', system: 's', user: 'u' }), env });
    assert(native.status === 200, '原生无 Origin 放行 200');
  }

  // ===== 用例 5：config 端点脱敏（不带任何 key） =====
  console.log('\n[5] /api/llm/config 脱敏：不泄露任何密钥字符串');
  {
    const { onRequest } = await loadHandler(5);
    const env = { OPENROUTER_KEY: 'sk-or-secret-123', AGNES_KEY: 'sk-ag-secret-456', ZHIPU_KEY: 'sk-zp-secret-789', ALLOWED_ORIGINS: 'https://xiaoting.app.workbuddy.host' };
    const r = await onRequest({ request: makeRequest('/api/llm/config', 'GET', null, { origin: 'https://xiaoting.app.workbuddy.host' }), env });
    const data = await r.json();
    const dumped = JSON.stringify(data);
    assert(data.ok === true, 'ok=true');
    assert(!dumped.includes('sk-or-secret-123'), '不含 OPENROUTER_KEY 明文');
    assert(!dumped.includes('sk-ag-secret-456'), '不含 AGNES_KEY 明文');
    assert(!dumped.includes('sk-zp-secret-789'), '不含 ZHIPU_KEY 明文');
    assert(!dumped.includes('Bearer'), '不含 Bearer');
    // 有 key 的模型 hasKey=true，但无 key 值
    const orModel = data.providers.openrouter.models['z-ai/glm-5.3-flash'];
    assert(orModel.hasKey === true && orModel.keySource === 'configured', 'openrouter 模型标记 hasKey=true');
    assert(!('key' in orModel), '模型快照不含 key 字段');
    assert(data.build === 'llm-2026-10-03-v1', '回带 BUILD 标记，便于核对线上版本');
  }

  // ===== 用例 6：场景分流 light 档位（跳过思考型 glm-5.3-flash） =====
  console.log('\n[6] light 模块档位：以 deepseek-v4-flash 打头，不含 glm-5.3-flash');
  {
    const { onRequest } = await loadHandler(6);
    const env = { OPENROUTER_KEY: 'or_k', AGNES_KEY: 'ag_k', ZHIPU_KEY: 'zp_k', ALLOWED_ORIGINS: 'https://xiaoting.app.workbuddy.host' };
    const r = await onRequest({ request: makeRequest('/api/llm/config', 'GET', null, { origin: 'https://xiaoting.app.workbuddy.host' }), env });
    const data = await r.json();
    const tier = data.modules.light.tier;
    assert(Array.isArray(tier) && tier.length > 0, 'light 档位存在');
    assert(tier[0].includes('deepseek-v4-flash'), 'light 首档是 deepseek-v4-flash，实际=' + tier[0]);
    assert(!tier.some((t) => t.includes('glm-5.3-flash')), 'light 档位不含 glm-5.3-flash（跳过思考型）');
  }

  // ===== 用例 7：全缺 key → no_available_model =====
  console.log('\n[7] 三把 key 全缺 → no_available_model');
  {
    const { onRequest } = await loadHandler(7);
    const env = { ALLOWED_ORIGINS: 'https://xiaoting.app.workbuddy.host' }; // 全缺（workbuddy 网关仍可用，除非也关）
    // workbuddy 网关无 key 也可用（publishableKey），所以这里额外禁用 workbuddy 来构造全缺
    env.LLM_DISABLE_PROVIDERS = 'workbuddy';
    const r = await onRequest({ request: makeRequest('/api/llm', 'POST', { module: 'analysis', system: 's', user: 'u' }, { origin: 'https://xiaoting.app.workbuddy.host' }), env });
    const data = await r.json();
    assert(data.ok === false, 'ok=false');
    assert(data.code === 'no_available_model', 'code=no_available_model，实际=' + data.code);
  }

  // ===== 用例 8：health 带回 BUILD =====
  console.log('\n[8] /api/health 带回 BUILD 与 providers 列表');
  {
    const { onRequest } = await loadHandler(8);
    const env = {};
    const r = await onRequest({ request: makeRequest('/api/health', 'GET', null, { origin: 'https://xiaoting.app.workbuddy.host' }), env });
    const data = await r.json();
    assert(data.ok === true && data.build === 'llm-2026-10-03-v1', 'health 带回 BUILD');
    assert(Array.isArray(data.providers) && data.providers.includes('openrouter'), 'providers 列表含 openrouter');
  }

  console.log(`\n==== 结果：通过 ${passed}，失败 ${failed} ====`);
  if (failed) { console.log('失败项：\n - ' + fails.join('\n - ')); process.exit(1); }
}

main().catch((e) => { console.error('harness error:', e); process.exit(2); });
