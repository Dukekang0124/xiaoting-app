// 墨小溟 · Cloudflare 模型调度网关
//
// 端口自 server/llm-router.cjs（v1.7.6 实测全量重排），把「调哪个模型、失败怎么办」搬到 serverless，
// 密钥只在服务端（Cloudflare Secrets）存在，前端完全不暴露任何 Key。
//
// 与本地 server.cjs /api/llm 契约一致，前端业务代码无需改动（js/llm.js 把 selfChannel 指过来即可）。
//
// 端点：
//   POST /api/llm          主入口：{module, system, user, json?, temperature?, maxTokens?, timeoutMs?}
//   GET  /api/llm/config   脱敏配置快照（一个字符的 key 都不带）
//   GET  /api/llm/stats    内存统计 + 最近调用
//   POST /api/llm/ping     探活（需 ?key=LLM_PING_KEY）
//   GET  /api/health       健康检查（带回 BUILD 标记，用于证明线上跑的是哪一版）
//
// 四条硬纪律（与本地一致）：
//   1. 永不抛错，任何异常归一成 { ok:false, code }。
//   2. 密钥只在本函数内存里，绝不出现在任何响应体 / 日志 / 前端文件。
//   3. 每次尝试都留痕（模型名、耗时、错误码、是否降级）。
//   4. 降级判定不猜：按配置的 degradeOn 名单走，参数类错误不重试。

import { CONFIG } from './llm.config.js';

// 构建标记：用来确认「线上跑的到底是哪一版」。文件名、md5 都不能证明版本，只有代码里真写着的标记能证明。
const BUILD = 'llm-2026-10-03-v1';

// 原生 App（Capacitor WebView）通常不发 Origin，放行（与本地 sameOrigin 对原生的处理一致）。
const NATIVE_ORIGINS = ['capacitor://localhost', 'http://localhost', 'ionic://localhost'];

/* ==================== 配置加载（嵌入式 + env 覆盖） ==================== */

// 🔴 缓存必须按「影响配置的环境变量组合」分 key，不能用无 key 的单例：
//   ① Cloudflare Pages Functions 同一 isolate 会跨请求复用模块级变量，无 key 缓存会让
//      不同 env 的调用互相串味（探针里表现为：改了 LLM_TIER_/LLM_DISABLE_PROVIDERS 却完全没效果，
//      三次"不同档位"的验证全落在同一档 falsely-green）。
//   ② 同 key 仍复用缓存，避免每次请求都 structuredClone。
const CONFIG_CACHE = new Map();
let configError = null;

function configCacheKey(env) {
  const e = env || {};
  const parts = [];
  for (const k of Object.keys(e).sort()) {
    if (k === 'LLM_ENABLE_PROVIDERS' || k === 'LLM_DISABLE_PROVIDERS' ||
        k === 'LLM_DISABLE_MODULES' || k.startsWith('LLM_TIER_')) {
      // 值本身可能含 key（理论上不会），只取其长度+名字做 key，不落 key 明文
      parts.push(k + '=' + String(e[k]).length);
    }
  }
  return parts.join('|');
}

function getConfig(env) {
  const ck = configCacheKey(env);
  if (CONFIG_CACHE.has(ck)) return CONFIG_CACHE.get(ck);

  let cfg;
  try { cfg = structuredClone(CONFIG); } catch (e) { cfg = JSON.parse(JSON.stringify(CONFIG)); }
  configError = null;

  const enable = ((env && env.LLM_ENABLE_PROVIDERS) || '').split(',').map((s) => s.trim()).filter(Boolean);
  const disable = ((env && env.LLM_DISABLE_PROVIDERS) || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const [pid, p] of Object.entries(cfg.providers || {})) {
    if (disable.includes(pid)) p.enabled = false;
    if (enable.length && enable.includes(pid)) p.enabled = true;
  }
  for (const [k, v] of Object.entries(env || {})) {
    const m = /^LLM_TIER_([A-Za-z0-9_]+)$/.exec(k);
    if (!m || !v) continue;
    const mod = m[1];
    cfg.modules = cfg.modules || {};
    cfg.modules[mod] = { ...(cfg.modules[mod] || {}), tier: String(v).split(',').map((s) => s.trim()).filter(Boolean) };
  }
  if (env && env.LLM_DISABLE_MODULES) {
    const off = String(env.LLM_DISABLE_MODULES).split(',').map((s) => s.trim());
    for (const mod of off) {
      if (cfg.modules && cfg.modules[mod]) cfg.modules[mod].enabled = false;
    }
  }
  CONFIG_CACHE.set(ck, cfg);
  return cfg;
}

/* ==================== 密钥解析（env 注入，永不回传） ==================== */

function resolveKey(provider, env) {
  if (!provider) return { key: '', source: 'missing' };
  // 兜底网关（免密钥）本来就没有 key，那是设计如此，不算错误
  if (provider.kind === 'workbuddy-gateway') return { key: provider.publishableKey || '', source: 'publishable' };
  const k = (env && env[provider.keyEnv]) || '';
  return { key: k, source: k ? 'configured' : 'missing' };
}

/** 配置脱敏快照：给前端/运维看「现在跑的是哪套规则」，但一个字符的 key 都不带出去 */
function inspectConfig(env) {
  const cfg = getConfig(env);
  const out = {
    version: cfg.version,
    configError,
    build: BUILD,
    providers: {},
    tiers: cfg.tiers,
    modules: {},
    degradeOn: (cfg.degradeOn && cfg.degradeOn.codes) || [],
    retry: cfg.retry,
    defaults: cfg.defaults,
  };
  for (const [pid, p] of Object.entries(cfg.providers || {})) {
    const models = {};
    for (const [m, mc] of Object.entries(p.models || {})) {
      const rk = resolveKey(p, env);
      models[m] = {
        enabled: mc.enabled !== false,
        hasKey: !!rk.key,
        keySource: rk.source,
        timeoutMs: mc.timeoutMs || p.timeoutMs || cfg.defaults.timeoutMs,
        params: mc.params || null,
        note: mc.note || '',
      };
    }
    out.providers[pid] = { label: p.label, kind: p.kind, endpoint: p.endpoint, enabled: p.enabled !== false, models };
  }
  for (const [mod, mc] of Object.entries(cfg.modules || {})) {
    out.modules[mod] = {
      enabled: mc.enabled !== false,
      tier: resolveTier(mod, env).map((t) => t.id),
      timeoutMs: mc.timeoutMs,
      temperature: mc.temperature,
      note: mc.note || '',
    };
  }
  return out;
}

/* ==================== 优先级解析 ==================== */

/** "zhipu:glm-4-flash" → { providerId, model, id } */
function parseRef(ref) {
  const s = String(ref || '').trim();
  const i = s.indexOf(':');
  if (i < 0) return null;
  return { providerId: s.slice(0, i), model: s.slice(i + 1), id: s };
}

/**
 * 解析某个模块实际生效的候选链。被封禁 / 缺 key / 不存在的条目在这里就被剔除，
 * 而不是等到调用时才失败 —— 一次注定失败的请求也是延迟。
 */
function resolveTier(module, env) {
  const cfg = getConfig(env);
  const mod = (cfg.modules && cfg.modules[module]) || {};
  const chain = (Array.isArray(mod.tier) && mod.tier.length ? mod.tier : null) || (cfg.tiers && cfg.tiers.default) || [];
  const out = [];
  const seen = new Set();
  for (const ref of chain) {
    const r = parseRef(ref);
    if (!r || seen.has(r.id)) continue;
    const p = (cfg.providers || {})[r.providerId];
    if (!p || p.enabled === false) continue;
    const mc = (p.models || {})[r.model];
    if (!mc || mc.enabled === false) continue;
    const rk = resolveKey(p, env);
    if (!rk.key) continue;
    seen.add(r.id);
    out.push({
      ...r,
      providerId: r.providerId,
      label: p.label,
      kind: p.kind,
      endpoint: p.endpoint,
      key: rk.key,
      authHeader: p.authHeader,
      authPrefix: p.authPrefix,
      streamOnly: !!p.streamOnly,
      timeoutMs: mc.timeoutMs || p.timeoutMs || cfg.defaults.timeoutMs || 12000,
      attempts: mc.attempts || cfg.defaults.attempts || 2,
      // 🔴 按模型追加请求体参数（reasoning_effort:low 逃生门）：放最后，但绝不覆盖契约字段。
      params: mc.params || null,
    });
  }
  return out;
}

function isModuleEnabled(module, env) {
  const cfg = getConfig(env);
  const mod = (cfg.modules && cfg.modules[module]) || null;
  if (!mod) return false;
  return mod.enabled !== false;
}

/* ==================== 传输：一次调用 ==================== */

function normalizeCode(httpStatus, errCode, msg) {
  const e = String(errCode || '');
  if (e === '1113') return 'quota_exhausted';
  if (e === '1305') return 'rate_limited';
  if (e === '1211') return 'model_not_found';
  if (e === '1301' || e === '1302') return 'rate_limited';
  if (e === '1000' || e === '1001' || e === '1002' || e === '401') return 'http_401';
  if (httpStatus === 429) return 'rate_limited';
  if (httpStatus >= 500) return 'http_5xx';
  if (httpStatus >= 400) return 'http_' + httpStatus;
  if (/timeout|abort/i.test(String(msg || ''))) return 'timeout';
  return e || 'unknown';
}

function isAbort(e) { return !!(e && (e.name === 'AbortError' || e.code === 'ABORT_ERR')); }

/**
 * 真正发一次请求。统一处理两种 provider 形态：
 *   · openai-compatible  —— 非流式拿完整 JSON
 *   · workbuddy-gateway  —— 只支持流式，必须解析 SSE 拼正文
 */
async function callOnce(target, opts, env) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || target.timeoutMs);
  const useStream = target.streamOnly || target.forceStream;
  const url = target.kind === 'workbuddy-gateway'
    ? String(target.endpoint).replace(/\/+$/, '') + (target.path || '/.cloud/llm/chat/completions')
    : target.endpoint;

  const headers = { 'Content-Type': 'application/json' };
  if (target.authHeader) headers[target.authHeader] = (target.authPrefix || '') + target.key;
  if (useStream) headers.Accept = 'text/event-stream';

  const body = {
    model: target.model,
    messages: [
      { role: 'system', content: String(opts.system || '你是墨小溟，一个温和的情绪复盘助手。') },
      { role: 'user', content: String(opts.user || '') },
    ],
    temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.3,
  };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  if (opts.json) body.response_format = { type: 'json_object' };
  if (useStream) { body.stream = true; body.stream_options = { include_usage: true }; }
  // 按模型追加参数：放最后，但**不许覆盖**上面四个契约字段。
  if (target.params && typeof target.params === 'object') {
    for (const [k, v] of Object.entries(target.params)) {
      if (['model', 'messages', 'stream', 'stream_options'].includes(k)) continue;
      body[k] = v;
    }
  }

  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    const raw = await res.text();
    const ms = Date.now() - t0;
    clearTimeout(timer);

    if (!res.ok) {
      let j = null; try { j = JSON.parse(raw); } catch (e) {}
      const ec = (j && j.error && (j.error.code || j.error.type)) || '';
      const em = (j && j.error && j.error.message) || raw.slice(0, 200);
      const unsupported = /invalid_parameter|unsupported|response_format|not support/i.test(String(em) + String(ec));
      return {
        ok: false, ms, httpStatus: res.status,
        code: unsupported && res.status === 400 ? 'unsupported_parameter' : normalizeCode(res.status, ec, em),
        message: String(em).slice(0, 200), recoverableParam: unsupported && res.status === 400,
      };
    }

    if (useStream) {
      let text = '';
      let reasoning = '';
      let finish = '';
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const d = line.slice(5).trim();
        if (!d || d === '[DONE]') continue;
        try {
          const j = JSON.parse(d);
          const c = j.choices && j.choices[0];
          if (c && c.delta && c.delta.content) text += c.delta.content;
          if (c && c.delta && c.delta.reasoning_content) reasoning += c.delta.reasoning_content;
          if (c && c.finish_reason) finish = c.finish_reason;
        } catch (e) { /* 单行坏了不该毁掉整段 */ }
      }
      if (!text.trim()) {
        return { ok: false, ms, code: reasoning.trim() ? 'reasoning_only' : 'empty_response', message: '流式返回里没有正文', reasoning: reasoning.slice(0, 200) };
      }
      if (finish === 'length') return { ok: false, ms, code: 'output_truncated', message: '输出被 max_tokens 截断', text };
      return { ok: true, ms, text, reasoning, finish, httpStatus: res.status };
    }

    let j = null; try { j = JSON.parse(raw); } catch (e) {}
    if (!j || !j.choices || !j.choices[0]) {
      return { ok: false, ms, code: 'empty_response', message: '响应里没有 choices', httpStatus: res.status };
    }
    const ch = j.choices[0];
    const text = String((ch.message && ch.message.content) || '');
    if (!text.trim()) {
      const reasoning = String((ch.message && ch.message.reasoning_content) || '');
      return { ok: false, ms, code: reasoning ? 'reasoning_only' : 'empty_response', message: '模型没给正文', reasoning: reasoning.slice(0, 200), httpStatus: res.status };
    }
    if (ch.finish_reason === 'length') return { ok: false, ms, code: 'output_truncated', message: '输出被 max_tokens 截断', text };
    return { ok: true, ms, text, finish: ch.finish_reason || '', usage: j.usage || null, httpStatus: res.status };
  } catch (e) {
    clearTimeout(timer);
    const aborted = isAbort(e);
    return { ok: false, ms: Date.now() - t0, code: aborted ? 'timeout' : 'network', message: String((e && e.message) || e).slice(0, 200) };
  }
}

/* ==================== 调用统计（CF 下内存 + console，不落盘） ==================== */

let memStats = { total: 0, ok: 0, fail: 0, degraded: 0, byModule: {}, byModel: {}, recent: [] };
const RECENT_MAX = 60;

function logEntry(entry) {
  memStats.total++;
  if (entry.ok) memStats.ok++; else memStats.fail++;
  if (entry.degraded) memStats.degraded++;
  const mod = entry.module || 'unknown';
  memStats.byModule[mod] = memStats.byModule[mod] || { calls: 0, ok: 0, fail: 0, degraded: 0, ms: 0 };
  memStats.byModule[mod].calls++;
  if (entry.ok) memStats.byModule[mod].ok++; else memStats.byModule[mod].fail++;
  if (entry.degraded) memStats.byModule[mod].degraded++;
  memStats.byModule[mod].ms += entry.ms || 0;
  const mk = entry.model ? (entry.provider + ':' + entry.model) : 'none';
  memStats.byModel[mk] = memStats.byModel[mk] || { calls: 0, ok: 0, fail: 0, ms: 0 };
  memStats.byModel[mk].calls++;
  if (entry.ok) memStats.byModel[mk].ok++; else memStats.byModel[mk].fail++;
  memStats.byModel[mk].ms += entry.ms || 0;

  memStats.recent.push(entry);
  if (memStats.recent.length > RECENT_MAX) memStats.recent.shift();

  // CF 可观测：只记元数据，不记正文、不记 key
  console.log('[llm]', JSON.stringify({
    ts: entry.ts, module: entry.module, ok: entry.ok, provider: entry.provider,
    model: entry.model, ms: entry.ms, degraded: entry.degraded, attempts: entry.attempts,
    code: entry.code, tried: (entry.tried || []).map((t) => ({ p: t.provider, m: t.model, ok: t.ok, code: t.code, ms: t.ms })),
  }));
}

function stats() { return JSON.parse(JSON.stringify(memStats)); }
function recent(n = 20) { return memStats.recent.slice(-n); }

/* ==================== 对外主入口 ==================== */

function shouldDegrade(code) {
  const DEGRADE = new Set((getConfig({}).degradeOn && getConfig({}).degradeOn.codes) || []);
  if (DEGRADE.has(String(code))) return true;
  return /^http_5/.test(String(code));
}
function shouldRetrySameModel(code) {
  const RETRY = new Set((getConfig({}).retry && getConfig({}).retry.onlyCodes) || []);
  return RETRY.has(String(code)) || /^http_5/.test(String(code));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 按模块调度一次模型调用。契约与本地 server.cjs /api/llm 完全一致。
 */
async function route(opts, env) {
  const t0 = Date.now();
  const cfg = getConfig(env);
  const module = opts.module || 'default';
  const modCfg = (cfg.modules && cfg.modules[module]) || {};
  if (modCfg.enabled === false) {
    const entry = { ts: new Date().toISOString(), module, ok: false, code: 'module_disabled', provider: '', model: '', ms: 0, degraded: false, attempts: 0, tried: [] };
    logEntry(entry);
    return { ok: false, code: 'module_disabled', degraded: false, attempts: 0, ms: 0, tried: [] };
  }

  const chain = resolveTier(module, env);
  if (!chain.length) {
    const entry = { ts: new Date().toISOString(), module, ok: false, code: 'no_available_model', provider: '', model: '', ms: 0, degraded: false, attempts: 0, tried: [] };
    logEntry(entry);
    return { ok: false, code: 'no_available_model', degraded: false, attempts: 0, ms: 0, tried: [] };
  }

  const temp = typeof opts.temperature === 'number' ? opts.temperature : modCfg.temperature;
  const deadline = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : modCfg.timeoutMs;
  const tried = [];
  let attemptNo = 0;

  for (let i = 0; i < chain.length; i++) {
    const target = chain[i];
    const perModel = Math.max(1, target.attempts || 2);
    for (let k = 0; k < perModel; k++) {
      attemptNo++;
      const r = await callOnce(target, {
        system: opts.system, user: opts.user, json: opts.json, temperature: temp, maxTokens: opts.maxTokens,
        timeoutMs: deadline || target.timeoutMs,
      }, env);
      tried.push({
        provider: target.providerId, model: target.model, ok: !!r.ok,
        code: r.code || '', ms: r.ms, attempt: k + 1, message: (r.message || '').slice(0, 120),
      });

      if (r.ok) {
        const degraded = i > 0 || attemptNo > 1;
        const entry = {
          ts: new Date().toISOString(), module, ok: true,
          provider: target.providerId, model: target.model,
          ms: Date.now() - t0, degraded, attempts: attemptNo,
          failReasons: tried.filter((x) => !x.ok).map((x) => `${x.provider}:${x.model}/${x.code}`),
        };
        logEntry(entry);
        return { ok: true, text: r.text, model: target.model, provider: target.providerId, degraded, attempts: attemptNo, ms: entry.ms, tried, usage: r.usage || null };
      }

      // 该厂商不认 response_format → 去掉它再试一次同模型（不改 Prompt，只改传输参数）
      if (r.recoverableParam && opts.json) {
        attemptNo++;
        const r2 = await callOnce(target, { system: opts.system, user: opts.user, json: false, temperature: temp, maxTokens: opts.maxTokens, timeoutMs: deadline || target.timeoutMs }, env);
        tried.push({ provider: target.providerId, model: target.model, ok: !!r2.ok, code: r2.code || '', ms: r2.ms, attempt: k + 1, message: (r2.message || '').slice(0, 120), recoveredParam: true });
        if (r2.ok) {
          const entry = { ts: new Date().toISOString(), module, ok: true, provider: target.providerId, model: target.model, ms: Date.now() - t0, degraded: true, attempts: attemptNo, failReasons: tried.filter((x) => !x.ok).map((x) => `${x.provider}:${x.model}/${x.code}`) };
          logEntry(entry);
          return { ok: true, text: r2.text, model: target.model, provider: target.providerId, degraded: true, attempts: attemptNo, ms: entry.ms, tried };
        }
      }

      // 同一模型重试只对瞬时故障有意义；参数错/无 key 重试一百次也是一样的结果
      if (k < perModel - 1 && shouldRetrySameModel(r.code)) {
        await sleep((cfg.retry && cfg.retry.backoffMs) || 250);
        continue;
      }
      break;
    }
    // 这一档失败 → 记录原因后进入下一档（自动降级）
  }

  const entry = {
    ts: new Date().toISOString(), module, ok: false,
    provider: '', model: '',
    ms: Date.now() - t0, degraded: attemptedMoreThanOne(tried), attempts: attemptNo,
    failReasons: tried.filter((x) => !x.ok).map((x) => `${x.provider}:${x.model}/${x.code}`),
  };
  logEntry(entry);
  const last = tried.filter((x) => !x.ok).pop();
  return { ok: false, code: (last && last.code) || 'all_models_failed', degraded: entry.degraded, attempts: attemptNo, ms: entry.ms, tried };
}

function attemptedMoreThanOne(tried) { return tried.length > 1; }

/** 探活：对指定模块的第一档真发一次极短请求，回答「现在到底能不能调通」 */
async function ping(module = 'safety', env) {
  const chain = resolveTier(module, env);
  const out = [];
  for (const t of chain) {
    const r = await callOnce(t, { system: '你是助手。', user: '只回复两个字：收到', json: false, temperature: 0, maxTokens: 16, timeoutMs: Math.min(t.timeoutMs, 8000) }, env);
    out.push({ provider: t.providerId, model: t.model, ok: !!r.ok, code: r.code || '', ms: r.ms, message: (r.message || '').slice(0, 120) });
  }
  return out;
}

function resetStats() {
  memStats = { total: 0, ok: 0, fail: 0, degraded: 0, byModule: {}, byModel: {}, recent: [] };
  return true;
}

/* ==================== HTTP 层（CORS + Origin 门禁 + 路由） ==================== */

function corsHeaders(request, env) {
  const origin = request.headers.get('origin');
  let allow;
  if (!origin) {
    allow = '*'; // 原生 App 常不带 Origin
  } else if (NATIVE_ORIGINS.includes(origin)) {
    allow = origin;
  } else {
    const allowed = (env && env.ALLOWED_ORIGINS ? String(env.ALLOWED_ORIGINS) : 'https://xiaoting.app.workbuddy.host')
      .split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    allow = allowed.includes(origin) ? origin : '';
  }
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
  if (allow) h['Access-Control-Allow-Origin'] = allow;
  return h;
}

function originAllowed(request, env) {
  const origin = request.headers.get('origin');
  if (!origin) return true; // 原生 App
  if (NATIVE_ORIGINS.includes(origin)) return true;
  const allowed = (env && env.ALLOWED_ORIGINS ? String(env.ALLOWED_ORIGINS) : 'https://xiaoting.app.workbuddy.host')
    .split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  return allowed.includes(origin);
}

function json(obj, status = 200, cors = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors },
  });
}

// 模块名白名单：不允许前端凭空指定一个模块名去打模型（越权防护）
const LLM_MODULES = ['default', 'safety', 'analysis', 'followup', 'card', 'timeline', 'weekly', 'light', 'asr_cleanup'];

async function handleLlm(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'use_post' }, 405, corsHeaders(request, env));
  if (!originAllowed(request, env)) return json({ ok: false, error: 'origin_not_allowed' }, 403, corsHeaders(request, env));

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return json({ ok: false, error: 'bad_json' }, 400, corsHeaders(request, env));
  }

  const module = LLM_MODULES.includes(payload.module) ? payload.module : 'default';
  const system = typeof payload.system === 'string' ? payload.system : '';
  const user = typeof payload.user === 'string' ? payload.user : '';
  if (!user || !user.trim()) return json({ ok: false, error: 'empty_user' }, 400, corsHeaders(request, env));

  const maxChars = (getConfig(env).defaults || {}).maxInputChars || 4000;
  const r = await route({
    module,
    system,
    user: user.slice(0, maxChars),
    json: !!payload.json,
    temperature: typeof payload.temperature === 'number' ? payload.temperature : undefined,
    maxTokens: typeof payload.maxTokens === 'number' ? payload.maxTokens : undefined,
    timeoutMs: typeof payload.timeoutMs === 'number' ? payload.timeoutMs : undefined,
  }, env);

  // 回给前端的结构里没有 provider 的 endpoint 与 key，只有「用了谁、降了几档」
  return json({
    ok: !!r.ok,
    text: r.text || '',
    model: r.model || '',
    channel: r.provider || '',
    degraded: !!r.degraded,
    attempts: r.attempts || 0,
    ms: r.ms || 0,
    code: r.code || '',
    tried: (r.tried || []).map((t) => ({ provider: t.provider, model: t.model, ok: t.ok, code: t.code, ms: t.ms, attempt: t.attempt })),
  }, 200, corsHeaders(request, env));
}

function handleLlmConfig(request, env) {
  return json({ ok: true, ...inspectConfig(env) }, 200, corsHeaders(request, env));
}

function handleLlmStats(request, env) {
  const url = new URL(request.url);
  const n = Math.min(60, Math.max(1, Number(url.searchParams.get('recent') || 20)));
  return json({ ok: true, stats: stats(), recent: recent(n) }, 200, corsHeaders(request, env));
}

async function handleLlmPing(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'use_post' }, 405, corsHeaders(request, env));
  const url = new URL(request.url);
  const key = url.searchParams.get('key') || '';
  const PING_KEY = (env && env.LLM_PING_KEY) || '';
  if (!PING_KEY || key !== PING_KEY) return json({ ok: false, error: 'not_found' }, 404, corsHeaders(request, env));
  let payload = {};
  try { payload = await request.json(); } catch (e) { /* 允许空 body */ }
  const module = LLM_MODULES.includes(payload.module) ? payload.module : 'safety';
  const results = await ping(module, env);
  return json({ ok: true, module, results }, 200, corsHeaders(request, env));
}

function handleHealth(request, env) {
  return json({
    ok: true,
    service: 'xiaoting-llm',
    build: BUILD,
    version: CONFIG.version,
    providers: Object.keys(CONFIG.providers),
    msg: '墨小溟 CF 模型网关就绪',
  }, 200, corsHeaders(request, env));
}

export async function onRequest(context) {
  const { request, env } = context;
  const cors = corsHeaders(request, env);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  const url = new URL(request.url);
  const p = url.pathname;

  if (p === '/api/health' || p === '/') return handleHealth(request, env);
  if (p === '/api/llm') return await handleLlm(request, env);
  if (p === '/api/llm/config') return handleLlmConfig(request, env);
  if (p === '/api/llm/stats') return handleLlmStats(request, env);
  if (p === '/api/llm/ping') return await handleLlmPing(request, env);
  return json({ ok: false, error: 'not_found' }, 404, cors);
}
