// 墨小溟 · LLM 传输层（可插拔 provider）
//
// 设计立场：这一层只负责「把一段 Prompt 送出去、把文本收回来」，不做业务判断。
//   provider = 'cloud' → WorkBuddy 云服务免密钥 LLM 网关（服务端真实模型调用）
//   provider = 'mock'  → 不调模型，返回 ok:false，由 js/api.js 降级到本地规则引擎
//
// 四条硬纪律（对应 v1.2 §2「不要直接白屏」）：
//   1. 本模块**永不抛错**，一律返回 { ok:false, code }，降级策略交给调用方决定。
//   2. 任何一步（SDK 加载 / 建客户端 / 取模型目录 / 调用 / 解析）失败都可被绕过。
//   3. 全程记 trace，供自测与线上排查拿到「哪一步、什么错误码、原文长什么样」。
//   4. 模型目录里绝大多数是「只思考」模型（onlyReasoning），对短结构化任务是纯延迟 —— 必须选型。

import { CLOUD, SDK_URL, SDK_URL_FALLBACK, AI, AI_OVERRIDE_KEY } from './config.js';
import * as diag from './diag.js';

const trace = [];
let client = null;
let catalogCache = null;
let lastUsedModel = null;
let sdkPromise = null;
let lastError = null;

/* ---------------- 环境判定 ---------------- */

function forcedMock() {
  try {
    if (new URLSearchParams(window.location.search).get('ai') === 'mock') return true;
    return window.localStorage.getItem(AI_OVERRIDE_KEY) === 'mock';
  } catch (e) {
    return false;
  }
}

/** 当前 provider 名称（'mock' 表示不调模型） */
export function providerName() {
  if (!AI.enabled) return 'mock';
  if (forcedMock()) return 'mock';
  return client ? 'cloud' : 'cloud-pending';
}

/** 是否已具备真实模型调用能力 */
export function isReal() {
  return AI.enabled && !forcedMock() && !!client;
}

/** 自测 / 排查用：不做业务副作用，可安全反复调用 */
export function debug() {
  return { provider: providerName(), real: isReal(), model: lastUsedModel, lastError, trace: trace.slice(-30) };
}

export function stats() {
  const byStage = {};
  let ok = 0, fail = 0;
  for (const t of trace) {
    byStage[t.stage] = byStage[t.stage] || { ok: 0, fail: 0, ms: 0 };
    if (t.ok) { ok++; byStage[t.stage].ok++; } else { fail++; byStage[t.stage].fail++; }
    byStage[t.stage].ms += t.ms || 0;
  }
  return { calls: trace.length, ok, fail, byStage, provider: providerName(), model: lastUsedModel, lastError };
}

export function resetTrace() { trace.length = 0; lastError = null; return true; }

/* ---------------- 错误归一 ---------------- */

function errOf(e) {
  if (!e) return { code: 'unknown' };
  const inner = e.error || {};
  return {
    code: inner.code || e.name || 'unknown',
    message: String(inner.message || e.message || e).slice(0, 200),
    requestId: e.requestId || '',
    status: e.status || 0,
  };
}

/** 可重试的瞬时故障（模型/网关抖动、流中断）；request_/auth_/quota_ 不重试 */
function transient(code) {
  return /^(gateway_|model_|internal_|network|timeout|abort)/.test(String(code || ''));
}

/** 换一个模型可能就能解决的错误（参数不认、模型侧故障、只思考不给正文、输出被截断） */
function worthSwitchingModel(code) {
  return /^(request_|gateway_|model_|internal_|reasoning_only|output_truncated|json_parse_failed|empty_response)/.test(String(code || ''));
}

/**
 * 「结构性不可用」——不是模型答错，而是根本没有模型可问
 * （被显式指定走本地、SDK 加载不到、模型目录为空）。
 * 业务侧据此区分：结构性不可用 → 交给本地规则引擎；其余失败 → 按保守策略兜底。
 */
const STRUCTURAL = ['provider_mock', 'sdk_unavailable', 'model_list_empty', 'sdk_init_failed'];
export function isStructural(code) { return STRUCTURAL.includes(String(code || '')); }

/* ---------------- SDK 与会话（懒加载，单飞） ---------------- */

/**
 * 加载云服务 SDK：本地副本优先，CDN 兜底。
 * 单个来源失败就换下一个，两个都失败才算 sdk_unavailable（那时才降级到本地规则引擎）。
 */
function loadSdk() {
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve) => {
    if (window.WorkBuddyCloud) return resolve(window.WorkBuddyCloud);
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v || null); } };
    const tryUrl = (src, onFail) => {
      try {
        const s = document.createElement('script');
        s.src = src;
        s.async = true;
        s.onload = () => (window.WorkBuddyCloud ? finish(window.WorkBuddyCloud) : onFail());
        s.onerror = onFail;
        document.head.appendChild(s);
      } catch (e) {
        onFail();
      }
    };
    try {
      tryUrl(SDK_URL, () => tryUrl(SDK_URL_FALLBACK, () => finish(null)));
      setTimeout(() => finish(window.WorkBuddyCloud), AI.sdkTimeoutMs);
    } catch (e) {
      finish(null);
    }
  }).then((v) => {
    // 留痕：SDK 是从哪条路拿到的。真机上若出现「AI 一直不工作」，第一眼就该看到这一行。
    try {
      diag.note('llm', 'sdk', {
        ok: !!v,
        detail: v ? `云服务客户端已就绪（先本地副本，失败回 CDN）` : 'SDK 两条来源都没加载成功 → 本次将降级到本地规则引擎',
      });
    } catch (e) { /* ignore */ }
    return v || null;
  });
  return sdkPromise;
}

async function ensureClient() {
  if (client) return client;
  if (!AI.enabled || forcedMock()) return null;
  // 离线时不必等 SDK 超时：直接判定通道结构性不可用，交回本地规则引擎
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    lastError = { code: 'sdk_unavailable', message: '浏览器处于离线状态' };
    return null;
  }
  const WB = await loadSdk();
  if (!WB || typeof WB.createWorkBuddyCloud !== 'function') {
    lastError = { code: 'sdk_unavailable', message: '云服务 SDK 未加载成功' };
    return null;
  }
  try {
    // endpoint 与 publishableKey 都必须来自 publicConfig，且必须同时传
    client = WB.createWorkBuddyCloud({ endpoint: CLOUD.endpoint, publishableKey: CLOUD.publishableKey });
  } catch (e) {
    lastError = errOf(e);
    client = null;
  }
  return client;
}

/** 诊断用：原样返回云服务模型目录（选型与排查用，不参与业务逻辑） */
export async function modelCatalog() {
  if (catalogCache) return catalogCache;
  const c = await ensureClient();
  if (!c) return null;
  try {
    catalogCache = await c.llm.models.list();
    if (!Array.isArray(catalogCache)) catalogCache = null;
  } catch (e) {
    lastError = errOf(e);
    catalogCache = null;
  }
  return catalogCache;
}

/* ---------------- 模型选型 ----------------
 *
 * 为什么这件事必须做：云服务目录里 30 个模型绝大多数是 onlyReasoning:true 的「思考模型」，
 * 每次调用都先写一大段 reasoning_content。对「判断风险等级 / 吐一小段 JSON」这种短结构化任务，
 * 那是纯粹的延迟与截断风险 —— 实测 auto(effort=high) 单次 23.9 秒且正文为空。
 * 实测（同一 Prompt，同一条件）：deepseek-v4.1-flash 1.3s ✓ / glm-5.0 2.4s ✓ / hunyuan-chat 3.0s ✓
 * 所以：① 先试作者实测过的优先序；② 不命中时按「公开字段」打分兜底（不拿模型名猜能力）。
 */

/**
 * v1.5 §2.1/§2.2 模型分级：网关抽象了厂商模型，前端只做「档位优先级」，不写死任何厂商密钥
 * （密钥只在服务端）。两个档位都先试作者实测过的模型，命中不到就按公开字段打分兜底。
 *   fast   —— 安全识别：极速 + 高召回（deepseek-v4.1-flash 实测 1.3s 最快，宁可快不可漏）。
 *   strong —— 主分析 / 追问 / 卡片 / 周报：更强推理（glm-5.0 实测 2.4s），治「追问泛泛而谈」与 JSON 不稳。
 */
const TIERS = {
  fast: ['deepseek-v4.1-flash', 'glm-5.0', 'hunyuan-chat'],     // 安全识别：极速 + 高召回
  strong: ['glm-5.0', 'deepseek-v4.1-flash', 'hunyuan-chat'],  // 主分析/追问/卡片/周报：更强推理
};

function scoreModel(m) {
  let s = 0;
  if (m.onlyReasoning === true) s += 100;          // 每次都先思考 → 短任务是纯延迟
  const cr = typeof m.credits === 'string' ? parseFloat(String(m.credits).replace(/[^0-9.]/g, '')) : NaN;
  if (Number.isFinite(cr) && cr > 0) s += cr;       // 更便宜的优先（credits 只是展示信息，不作为计费依据）
  if (typeof m.maxOutputTokens !== 'number') s += 50; // 连输出上限都没声明的，多半不是纯文本模型
  return s;
}

let rankingCache = {}; // 按档位缓存，避免每次调用都打一次模型目录
export async function modelRanking(tier) {
  const key = TIERS[tier] ? tier : 'strong';
  if (rankingCache[key]) return rankingCache[key];
  const list = await modelCatalog();
  if (!list) return (rankingCache[key] = []);
  const usable = list.filter((m) => m && m.id && m.disabled !== true && m.enabled !== false);
  if (!usable.length) { lastError = { code: 'model_list_empty', message: '模型目录为空' }; return (rankingCache[key] = []); }

  const preferred = TIERS[key];
  const ids = new Set(usable.map((m) => m.id));
  const out = preferred.filter((id) => ids.has(id));
  const rest = usable.filter((m) => !out.includes(m.id)).sort((a, b) => scoreModel(a) - scoreModel(b));
  rest.forEach((m) => out.push(m.id));
  rankingCache[key] = out;
  // 诊断留痕：路由到底选了谁，只能在这里取到真实答案（档位 → 优先序 ∩ 目录）。
  // 「是不是被降级 / 是不是还在调错模型」这类问题，看这一条就能定案，不用再靠猜。
  try {
    diag.note('llm', 'ranking', {
      ok: true,
      model: out[0] || '',
      detail: `tier=${key} 目录=${usable.length} 命中优先序=${preferred.filter((id) => ids.has(id)).join(',') || '无'} 实际序前3=${out.slice(0, 3).join(',')}`,
    });
  } catch (e) { /* 日志绝不能影响调用 */ }
  return rankingCache[key];
}

/* ---------------- 文本 → JSON ---------------- */

/**
 * 截断修复：模型输出被 max_tokens 截到一半时，JSON 是残缺的（缺引号/缺右括号）。
 * 这里从尾部逐步回退，把残缺片段补成合法 JSON —— 能救回就救，救不回返回 null。
 */
function repairJson(t) {
  let s = t.replace(/[,\s]+$/, '');
  for (let cut = 0; cut < 200 && s.length > 2; cut++) {
    let fixed = s;
    let inStr = false, esc = false;
    const stack = [];
    for (let i = 0; i < fixed.length; i++) {
      const ch = fixed[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
      else if (ch === '}' || ch === ']') stack.pop();
    }
    if (inStr) fixed += '"';
    while (stack.length) fixed += stack.pop();
    try { return JSON.parse(fixed); } catch (e) { /* 继续回退一个字符 */ }
    s = s.slice(0, -1).replace(/[,\s]+$/, '');
  }
  return null;
}

/**
 * 从模型输出里抠出 JSON。真实模型的输出常带 ```json 围栏、前后废话，或被截断。
 * @returns {object|null}
 */
export function extractJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch (e) { /* 继续做括号配对扫描 */ }

  const start = t.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(t.slice(start, i + 1)); } catch (e) { return repairJson(t.slice(start, i + 1)); }
      }
    }
  }
  // 扫到结尾括号还没闭合 → 被截断了，走修复
  return repairJson(t.slice(start));
}

/* ---------------- 单模型单次调用 ---------------- */

async function runOnce(model, opts) {
  const { system, user, temperature = 0.3, maxTokens, timeoutMs, onProgress } = opts;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || AI.callTimeoutMs);
  let text = '';
  let reasoning = '';
  let finish = null;
  let err = null;
  try {
    // 客户端必须在这里显式取一次：上一版从"内联建客户端"重构到"选型后再调用"时漏了这一步，
    // 导致 runOnce 里引用了不存在的变量，所有模型调用在发请求前就抛 ReferenceError。
    const c = await ensureClient();
    if (!c) {
      clearTimeout(timer);
      return { text: '', reasoning: '', finish: null, err: { error: { code: (lastError && lastError.code) || 'sdk_unavailable', message: '云服务客户端不可用' } } };
    }
    const req = {
      model,
      // 云服务要求 messages[0] 必须是应用自带的 system，否则直接报错
      messages: [
        { role: 'system', content: String(system || '你是墨小溟，一个温和的情绪复盘助手。') },
        { role: 'user', content: String(user || '') },
      ],
      stream: true, // 该网关只支持流式，非流式会被直接拒掉
      stream_options: { include_usage: true },
      temperature,
      signal: ctrl.signal,
    };
    if (maxTokens && opts.useMaxTokens !== false) req.max_tokens = maxTokens;
    if (opts.useJsonMode !== false) req.response_format = { type: 'json_object' };

    for await (const chunk of c.llm.chat.completions.create(req)) {
      const choice = chunk && chunk.choices && chunk.choices[0];
      const d = choice && choice.delta;
      if (d && d.content) {
        text += d.content;
        // v1.5 §2.2 流式输出：每收到一段正文就回调，前端可用于「逐字显示」抵消延迟感。
        // 包在 try 里，回调里任何异常都不该中断模型调用本身。
        if (onProgress) { try { onProgress(text, d.content); } catch (e) { /* 忽略回调异常 */ } }
      }
      if (d && d.reasoning_content) reasoning += d.reasoning_content; // 思考过程与正文分开
      if (choice && choice.finish_reason) finish = choice.finish_reason;
    }
  } catch (e) {
    err = e;
  }
  clearTimeout(timer);
  return { text, reasoning, finish, err };
}

/* ---------------- 就绪状态缓存（供调用方做「值不值得发请求」的判断） ---------------- */

/** 预解析状态：null=未探测 true=有可用模型 false=结构性不可用 */
let readyState = null;
export function readyHint() { return readyState; }

/* ---------------- 主调用 ---------------- */

/**
 * 调一次模型，返回纯文本。
 * 内部会：选模型 → 该模型重试规则 → 失败就换下一个候选模型。
 * @returns {Promise<{ok:boolean, text?:string, code?:string, model?:string}>}
 */
export async function call({ stage = 'llm', system, user, temperature = 0.3, maxTokens, json = false, timeoutMs, tier, onProgress } = {}) {
  const t0 = Date.now();
  const record = (ok, code, chars, model, sample) => {
    trace.push({ stage, ok, code, ms: Date.now() - t0, chars: chars || 0, model: model || '', sample: sample || '' });
  };

  if (!AI.enabled || forcedMock()) { record(false, 'provider_mock', 0, ''); return { ok: false, code: 'provider_mock' }; }

  const ranking = await modelRanking(tier);
  if (!ranking.length) {
    readyState = false;
    const code = (lastError && lastError.code) || 'model_list_empty';
    record(false, code, 0, '');
    return { ok: false, code };
  }

  const errors = [];
  for (const model of ranking.slice(0, Math.max(1, AI.modelAttempts))) {
    const opts = { system, user, temperature, maxTokens, timeoutMs, useJsonMode: !!json, useMaxTokens: true, onProgress };
    let r = await runOnce(model, opts);

    // 该模型不认 response_format → 去掉它再试（不改 Prompt，只改传输参数）
    if (r.err && json && /^request_/.test(String(errOf(r.err).code || ''))) {
      r = await runOnce(model, { ...opts, useJsonMode: false });
    }
    // 瞬时故障重试一次
    if (r.err && AI.retry > 0 && transient(errOf(r.err).code)) {
      r = await runOnce(model, opts);
    }
    // 输出被 max_tokens 截断（finish_reason=length）→ 去掉上限重来一次，换一份完整 JSON
    // 实测教训：思考型模型会消耗大量思考 token，"上限给小一点压延迟" 会把 JSON 截成半截
    if (!r.err && r.finish === 'length' && maxTokens) {
      trace.push({ stage, ok: false, code: 'output_truncated_retry', ms: Date.now() - t0, chars: r.text.length, model, sample: r.text.slice(-60) });
      r = await runOnce(model, { ...opts, useMaxTokens: false });
    }

    let code = null;
    if (r.err) {
      lastError = errOf(r.err);
      code = lastError.code;
    } else if (r.finish === 'content_filter') {
      lastError = { code: 'response_content_filter' };
      code = 'response_content_filter';
    } else if (r.finish === 'length') {
      lastError = { code: 'output_truncated' };
      code = 'output_truncated';
    } else if (!r.text.trim()) {
      code = r.reasoning.trim() ? 'reasoning_only' : 'empty_response';
      lastError = { code };
    } else if (json && !extractJson(r.text)) {
      code = 'json_parse_failed';
      lastError = { code };
    }

    if (!code) {
      readyState = true;
      lastUsedModel = model;
      record(true, 'ok', r.text.length, model);
      return { ok: true, text: r.text, model };
    }

    errors.push(model + ':' + code);
    if (json && code === 'json_parse_failed') { record(false, code, r.text.length, model, r.text.slice(0, 120)); }
    if (!worthSwitchingModel(code)) break; // 换模型也救不了的（如内容被过滤）就不折腾了
  }

  const last = errors[errors.length - 1] || '';
  const failCode = last.includes(':') ? last.split(':')[1] : (last || 'unknown');
  record(false, failCode, 0, '', errors.join(' | '));
  return { ok: false, code: failCode, tried: errors };
}

/**
 * 调一次模型并解析出 JSON。解析失败时带上原始文本与结尾片段，便于定位是「没按格式说」还是「被截断了」。
 * @returns {Promise<{ok:boolean, data?:object, code?:string, text?:string}>}
 */
export async function callJson(opts) {
  const r = await call(opts);
  if (!r.ok) return { ok: false, code: r.code, text: r.partial || '' };
  const data = extractJson(r.text);
  if (!data || typeof data !== 'object') {
    lastError = { code: 'json_parse_failed' };
    trace.push({ stage: opts.stage || 'llm', ok: false, code: 'json_parse_failed', ms: 0, chars: r.text.length, model: r.model, sample: r.text.slice(0, 120) });
    return { ok: false, code: 'json_parse_failed', text: r.text };
  }
  return { ok: true, data, text: r.text, model: r.model };
}

export { CLOUD, SDK_URL };
