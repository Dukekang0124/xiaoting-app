// 墨小溟 · 内部模型调度层（后端核心机制，不对用户展示）
//
// 存在这件事的理由：
//   在它之前，前端 js/llm.js 自己扛着「选模型 + 重试 + 换模型 + 解析」，于是有三件事做不好 ——
//   ① 密钥只能免密钥网关，想直连任何一家厂商就得把 key 放进浏览器（不可接受）；
//   ② 换模型策略写死在代码里，改一个优先级就要重新发版、重新出 APK；
//   ③ 调用日志散在前端 trace 里，出了线上问题看不到「这一跳用的是谁、为什么降级」。
//   这一层把「调用谁、失败怎么办」从代码里搬到配置里，前端只负责说「我要做哪个模块的事」。
//
// 四条硬纪律：
//   1. 永不抛错。任何异常都归一成 { ok:false, code }，让调用方决定兜底。
//   2. 密钥只在本进程内存里，绝不出现在任何响应体、任何日志、任何前端文件里。
//   3. 每一次尝试都留痕（模型名、耗时、错误码、是不是降级），失败也要留。
//   4. 降级判定不猜：按配置的 degradeOn 名单走，参数类错误不重试（重试也不会变对）。

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/* ==================== 配置加载（文件 + 环境变量覆盖） ==================== */

const CONFIG_FILE = process.env.LLM_CONFIG_FILE || path.join(__dirname, 'llm.config.json');

let configCache = null;
let configError = null;

function readJsonSafe(abs) {
  try { return JSON.parse(fs.readFileSync(abs, 'utf8')); } catch (e) { return null; }
}

function loadConfig(force = false) {
  if (configCache && !force) return configCache;
  configError = null;
  const cfg = readJsonSafe(CONFIG_FILE);
  if (!cfg) {
    configError = 'config_unreadable:' + CONFIG_FILE;
    configCache = { providers: {}, tiers: { default: [] }, modules: {}, defaults: {}, degradeOn: { codes: [] }, retry: {} };
    return configCache;
  }

  // 环境变量覆盖提供商开关（部署时不想改文件就用它）
  const enable = (process.env.LLM_ENABLE_PROVIDERS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const disable = (process.env.LLM_DISABLE_PROVIDERS || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const [pid, p] of Object.entries(cfg.providers || {})) {
    if (disable.includes(pid)) p.enabled = false;
    if (enable.length && enable.includes(pid)) p.enabled = true;
  }

  // 按模块覆盖优先级：LLM_TIER_analysis=zhipu:glm-4-flash,workbuddy:glm-5.0
  for (const [k, v] of Object.entries(process.env)) {
    const m = /^LLM_TIER_([A-Za-z0-9_]+)$/.exec(k);
    if (!m || !v) continue;
    const mod = m[1];
    cfg.modules = cfg.modules || {};
    cfg.modules[mod] = { ...(cfg.modules[mod] || {}), tier: v.split(',').map((s) => s.trim()).filter(Boolean) };
  }
  if (process.env.LLM_DISABLE_MODULES) {
    const off = process.env.LLM_DISABLE_MODULES.split(',').map((s) => s.trim());
    for (const mod of off) {
      if (cfg.modules && cfg.modules[mod]) cfg.modules[mod].enabled = false;
    }
  }

  configCache = cfg;
  return configCache;
}

/* ==================== 密钥解析（文件 → 环境变量，永不回传） ==================== */

let keysCache = null;

function loadKeys(provider, providerId) {
  if (!provider) return {};
  if (!keysCache) keysCache = {};
  // 缓存键必须用 provider 的**配置键**，不能用 label：label 是人看的文案，改文案就会换缓存键；
  // 而两个 provider 万一 label 撞了，还会互相读到对方的密钥。调用方一律显式传 id。
  const pid = providerId || provider.__id || provider.endpoint || 'default';
  if (keysCache[pid]) return keysCache[pid];

  let out = {};
  // ① 环境变量优先（部署环境用它，文件可以不存在）
  if (provider.keysEnv && process.env[provider.keysEnv]) {
    const raw = readJsonSafeFromString(process.env[provider.keysEnv]);
    if (raw) out = { ...out, ...(raw.keys || {}), ...(raw.defaultKey ? { __default: raw.defaultKey } : {}) };
  }
  // ② 密钥文件
  if (provider.keysFile) {
    const abs = path.isAbsolute(provider.keysFile) ? provider.keysFile : path.join(ROOT, provider.keysFile);
    const j = readJsonSafe(abs);
    if (j) out = { ...out, ...(j.keys || {}), ...(j.defaultKey ? { __default: j.defaultKey } : {}) };
  }
  keysCache[pid] = out;
  return out;
}

function readJsonSafeFromString(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

function resolveKey(provider, modelCfg, modelName, providerId) {
  const keys = loadKeys(provider, providerId);
  const ref = (modelCfg && modelCfg.keyRef) || modelName;
  const k = keys[ref] || keys[modelName] || keys.__default || '';
  // 兜底网关（免密钥）本来就没有 key，那是设计如此，不算错误
  if (!k && provider.kind === 'workbuddy-gateway') return { key: provider.publishableKey || '', source: 'publishable' };
  return { key: k, source: k ? 'configured' : 'missing' };
}

/** 配置脱敏快照：给前端/运维看「现在跑的是哪套规则」，但一个字符的 key 都不带出去 */
function inspectConfig() {
  const cfg = loadConfig();
  const out = { version: cfg.version, configError, providers: {}, tiers: cfg.tiers, modules: {}, degradeOn: (cfg.degradeOn && cfg.degradeOn.codes) || [], retry: cfg.retry, defaults: cfg.defaults };
  for (const [pid, p] of Object.entries(cfg.providers || {})) {
    const keys = loadKeys(p, pid);
    const models = {};
    for (const [m, mc] of Object.entries(p.models || {})) {
      const rk = resolveKey(p, mc, m, pid);
      models[m] = { enabled: mc.enabled !== false, hasKey: !!rk.key, keySource: rk.source, timeoutMs: mc.timeoutMs || p.timeoutMs || cfg.defaults.timeoutMs, note: mc.note || '' };
    }
    out.providers[pid] = { label: p.label, kind: p.kind, endpoint: p.endpoint, enabled: p.enabled !== false, models };
  }
  for (const [mod, mc] of Object.entries(cfg.modules || {})) {
    out.modules[mod] = { enabled: mc.enabled !== false, tier: resolveTier(mod).map((t) => t.id), timeoutMs: mc.timeoutMs, temperature: mc.temperature, note: mc.note || '' };
  }
  return out;
}

/* ==================== 优先级解析 ==================== */

const TIER_DEFAULT = 'default';

/** "zhipu:glm-4-flash" → { providerId:'zhipu', model:'glm-4-flash', id:'zhipu:glm-4-flash' } */
function parseRef(ref) {
  const s = String(ref || '').trim();
  const i = s.indexOf(':');
  if (i < 0) return null;
  return { providerId: s.slice(0, i), model: s.slice(i + 1), id: s };
}

/**
 * 解析某个模块实际生效的候选链。
 * 顺序：模块 tier → default tier（补位）。已被封禁/缺 key/不存在的条目在这里就被剔除，
 * 而不是等到调用时才失败 —— 一次注定失败的请求也是延迟。
 */
function resolveTier(module) {
  const cfg = loadConfig();
  const mod = (cfg.modules && cfg.modules[module]) || {};
  const chain = (Array.isArray(mod.tier) && mod.tier.length ? mod.tier : null) || (cfg.tiers && cfg.tiers[TIER_DEFAULT]) || [];
  const out = [];
  const seen = new Set();
  for (const ref of chain) {
    const r = parseRef(ref);
    if (!r || seen.has(r.id)) continue;
    const p = (cfg.providers || {})[r.providerId];
    if (!p || p.enabled === false) continue;
    const mc = (p.models || {})[r.model];
    if (!mc || mc.enabled === false) continue;
    const rk = resolveKey(p, mc, r.model, r.providerId);
    if (!rk.key) continue;
    seen.add(r.id);
    out.push({
      ...r,
      label: p.label,
      kind: p.kind,
      endpoint: p.endpoint,
      key: rk.key,
      authHeader: p.authHeader,
      authPrefix: p.authPrefix,
      streamOnly: !!p.streamOnly,
      timeoutMs: mc.timeoutMs || p.timeoutMs || cfg.defaults.timeoutMs || 12000,
      attempts: mc.attempts || cfg.defaults.attempts || 2,
    });
  }
  return out;
}

/**
 * 某个模块当前是否启用。
 *
 * 为什么需要它：配置里被 enabled:false 关掉的模块（如 asr_cleanup），调用 route() 会**立刻**返回
 * module_disabled —— 看似免费，其实每次都要落一条日志（logEntry 是同步写盘）。
 * 放在 ASR 这种每轮都走的热路径上，就是每说一句都多一次磁盘 I/O 换一条"我又被跳过了"的记录。
 * 调用方先用这个函数短路，才是真的零成本。
 */
function isModuleEnabled(module) {
  const cfg = loadConfig();
  const mod = (cfg.modules && cfg.modules[module]) || null;
  if (!mod) return false;
  return mod.enabled !== false;
}

/* ==================== 传输：一次调用 ==================== */
/** 把 HTTP 状态与厂商错误码归一成我们自己的降级码 */
function normalizeCode(httpStatus, errCode, msg) {
  const e = String(errCode || '');
  if (e === '1113') return 'quota_exhausted';          // 智谱：余额不足/无资源包
  if (e === '1305') return 'rate_limited';             // 智谱：访问量过大
  if (e === '1211') return 'model_not_found';          // 智谱：模型不存在
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
 *   · openai-compatible  —— 智谱直连，非流式拿完整 JSON
 *   · workbuddy-gateway  —— 只支持流式，必须解析 SSE 拼正文
 */
async function callOnce(target, { system, user, temperature, maxTokens, json, timeoutMs }) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || target.timeoutMs);
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
      { role: 'system', content: String(system || '你是墨小溟，一个温和的情绪复盘助手。') },
      { role: 'user', content: String(user || '') },
    ],
    temperature: typeof temperature === 'number' ? temperature : 0.3,
  };
  if (maxTokens) body.max_tokens = maxTokens;
  if (json) body.response_format = { type: 'json_object' };
  if (useStream) { body.stream = true; body.stream_options = { include_usage: true }; }

  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    const raw = await res.text();
    const ms = Date.now() - t0;
    clearTimeout(timer);

    if (!res.ok) {
      let j = null; try { j = JSON.parse(raw); } catch (e) {}
      const ec = (j && j.error && (j.error.code || j.error.type)) || '';
      const em = (j && j.error && j.error.message) || raw.slice(0, 200);
      // 参数不被支持（不同厂商对 response_format 的支持不一）→ 给出可恢复信号
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

/* ==================== 调用日志 ==================== */

const LOG_DIR = path.join(ROOT, 'server', 'logs');
let memStats = { total: 0, ok: 0, fail: 0, degraded: 0, byModule: {}, byModel: {}, recent: [] };
const RECENT_MAX = 60;

function logEntry(entry) {
  // 内存统计（给 /api/llm/stats，不读盘、不怕日志轮转）
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

  // 落盘 JSONL（不写用户正文）
  const cfg = loadConfig();
  if (cfg.logging && cfg.logging.dir === false) return;
  const dir = (cfg.logging && cfg.logging.dir) || 'server/logs';
  const abs = path.isAbsolute(dir) ? dir : path.join(ROOT, dir);
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const file = path.join(abs, `${(cfg.logging && cfg.logging.filePrefix) || 'llm-'}${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.jsonl`);
  try {
    fs.mkdirSync(abs, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
  } catch (e) { /* 日志失败绝不影响调用 */ }
}

function stats() { return JSON.parse(JSON.stringify(memStats)); }
function recent(n = 20) { return memStats.recent.slice(-n); }

/* ==================== 对外主入口 ==================== */

const cfg0 = loadConfig();
const DEGRADE = new Set((cfg0.degradeOn && cfg0.degradeOn.codes) || []);
const RETRY_CODES = new Set((cfg0.retry && cfg0.retry.onlyCodes) || []);

function shouldDegrade(code) {
  if (DEGRADE.has(String(code))) return true;
  return /^http_5/.test(String(code));
}
function shouldRetrySameModel(code) {
  return RETRY_CODES.has(String(code)) || /^http_5/.test(String(code));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 按模块调度一次模型调用。
 *
 * @param {object} opts
 * @param {string} opts.module   功能模块名（safety/analysis/followup/card/timeline/weekly/…）
 * @param {string} opts.system   system 提示词
 * @param {string} opts.user     user 提示词
 * @param {boolean} opts.json    是否要求 JSON 输出
 * @returns {Promise<{ok:boolean, text?:string, model?:string, provider?:string, degraded:boolean, attempts:number, ms:number, tried:Array, code?:string}>}
 */
async function route({ module = 'default', system, user, json = false, temperature, maxTokens, timeoutMs } = {}) {
  const t0 = Date.now();
  const cfg = loadConfig();
  const modCfg = (cfg.modules && cfg.modules[module]) || {};
  if (modCfg.enabled === false) {
    const entry = { ts: new Date().toISOString(), module, ok: false, code: 'module_disabled', provider: '', model: '', ms: 0, degraded: false, attempts: 0, tried: [] };
    logEntry(entry);
    return { ok: false, code: 'module_disabled', degraded: false, attempts: 0, ms: 0, tried: [] };
  }

  const chain = resolveTier(module);
  if (!chain.length) {
    const entry = { ts: new Date().toISOString(), module, ok: false, code: 'no_available_model', provider: '', model: '', ms: 0, degraded: false, attempts: 0, tried: [] };
    logEntry(entry);
    return { ok: false, code: 'no_available_model', degraded: false, attempts: 0, ms: 0, tried: [] };
  }

  const temp = typeof temperature === 'number' ? temperature : modCfg.temperature;
  const deadline = typeof timeoutMs === 'number' ? timeoutMs : modCfg.timeoutMs;
  const tried = [];
  let attemptNo = 0;

  for (let i = 0; i < chain.length; i++) {
    const target = chain[i];
    const perModel = Math.max(1, target.attempts || 2);
    for (let k = 0; k < perModel; k++) {
      attemptNo++;
      const r = await callOnce(target, {
        system, user, json, temperature: temp, maxTokens,
        timeoutMs: deadline || target.timeoutMs,
      });
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
      if (r.recoverableParam && json) {
        attemptNo++;
        const r2 = await callOnce(target, { system, user, json: false, temperature: temp, maxTokens, timeoutMs: deadline || target.timeoutMs });
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
    // 这一档失败 → 记录原因后进入下一档（这就是「自动降级」）
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
async function ping(module = 'safety') {
  const chain = resolveTier(module);
  const out = [];
  for (const t of chain) {
    const r = await callOnce(t, { system: '你是助手。', user: '只回复两个字：收到', json: false, temperature: 0, maxTokens: 16, timeoutMs: Math.min(t.timeoutMs, 8000) });
    out.push({ provider: t.providerId, model: t.model, ok: !!r.ok, code: r.code || '', ms: r.ms, message: (r.message || '').slice(0, 120) });
  }
  return out;
}

function resetStats() {
  memStats = { total: 0, ok: 0, fail: 0, degraded: 0, byModule: {}, byModel: {}, recent: [] };
  return true;
}

module.exports = { route, ping, stats, recent, inspectConfig, resolveTier, loadConfig, resetStats, callOnce, normalizeCode, isModuleEnabled, CONFIG_FILE };
