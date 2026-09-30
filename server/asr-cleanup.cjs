/**
 * 墨小溟 · ASR 文本后处理（「顺句」）—— 走 llm-router 的可选模块
 *
 * ============ 这个文件为什么存在 ============
 *
 * 需求里有一条是「说明如何把这套模型调度机制接入核心语音识别流程」。诚实的答案分两半：
 *
 *   ① 语音识别的**主体**（百度一句话识别）不是大模型，也不该假装是。
 *      把它塞进模型调度里换不来任何好处，只会多一层可能失败的转发。所以主体一行不动。
 *
 *   ② 模型与 ASR 真正合理的交集只有一个：**识别文本的顺句/错别字纠正**。
 *      它对应配置里的 asr_cleanup 模块，且**默认关闭** —— 对一个情绪复盘产品，
 *      用户的原话本身就是证据，改写它是有风险的（而这份风险换来的收益很小）。
 *
 * 所以这个文件提供的不是"必须启用的功能"，而是"一个随时可开、开了也有硬护栏的口子"。
 *
 * ============ 为什么做成依赖注入 ============
 *
 * 本机没有百度 ASR 密钥（见项目记忆），/api/asr 会直接返回 503 asr_not_configured
 * ⇒ 如果把顺句逻辑内联进 handleAsr，那段分支永远跑不到，等于写了段没被验证过的代码。
 * 把 router 作为参数注入，就可以在测试里塞一个可控的桩，把每条护栏都真跑一遍。
 *
 * ============ 硬护栏（每一条都有对应断言） ============
 *
 *   · 绝不抛错、绝不阻塞：任何异常都退回原文，识别结果不受影响。
 *   · 绝不静默改写：只有同时通过全部长度/形态校验才采用，否则保留原文并记下拒绝原因。
 *   · 绝不丢证据：调用方始终能拿到原文（router 的调用日志也不落用户正文）。
 */

/** system 提示词：只做最小修整，严禁改写、概括、解释、回答内容 */
const SYSTEM = [
  '你在做语音转写的后处理。输入是一段语音识别结果，可能有口语赘词、重复、同音错别字。',
  '只做三件事：删掉无意义的口语赘词（嗯、那个、就是）、合并重复词、修正明显的同音错别字。',
  '严禁：改写句式、概括、缩写、补充内容、回答输入里的问题、添加任何解释。',
  '保持说话人原本的用词和语气，保持全部实质内容。',
  '只输出 JSON：{"text":"修整后的文本"}。',
].join('\n');

/** 采纳阈值的集中定义 —— 与断言一一对应 */
const POLICY = {
  minRatio: 0.6,   // 修整后不得短于原文 60%：更短说明它在概括，不是在顺句
  maxRatio: 1.6,   // 也不得长于 160%：更长说明它在扩写
  maxNewlines: 0,  // 不允许出现换行：出现换行基本等于被排成了列表
};

/** 从模型回包里取正文：容忍 ```json 围栏，也容忍它直接吐纯文本 */
function extractText(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  // 去掉 markdown 代码围栏
  const fence = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/;
  const m = fence.exec(s);
  if (m) s = m[1].trim();
  // 尝试 JSON
  if (s.startsWith('{')) {
    try {
      const j = JSON.parse(s);
      if (j && typeof j.text === 'string') return j.text.trim();
    } catch (e) { /* 不是 JSON 就按纯文本处理 */ }
  }
  return s;
}

/**
 * 采纳判定：把「要不要用模型给的新文本」这件事写成纯函数，便于穷举断言。
 * @returns {{text:string, applied:boolean, reason:string, ratio:number}}
 */
function mergeCleaned(original, cleaned) {
  const a = String(original == null ? '' : original);
  const b = String(cleaned == null ? '' : cleaned).trim();
  const ratio = a.length ? Number((b.length / a.length).toFixed(3)) : 0;

  if (!b) return { text: a, applied: false, reason: 'empty_cleaned', ratio };
  const nl = (b.match(/\n/g) || []).length;
  if (nl > POLICY.maxNewlines) return { text: a, applied: false, reason: 'multiline', ratio };
  if (ratio < POLICY.minRatio) return { text: a, applied: false, reason: 'too_short', ratio };
  if (ratio > POLICY.maxRatio) return { text: a, applied: false, reason: 'too_long', ratio };
  if (b === a.trim()) return { text: a, applied: false, reason: 'unchanged', ratio };
  return { text: b, applied: true, reason: 'ok', ratio };
}

/**
 * 造一个「ASR 文本顺句器」。
 * @param {object} router  必须提供 isModuleEnabled(name) 与 route(opts)，通常就是 server/llm-router.cjs
 * @param {object} [opts]  { log } 可选，注入日志函数（默认不记，避免污染主日志）
 * @returns {(text:string) => Promise<{text:string, applied:boolean, reason:string, model?:string, degraded?:boolean, ms?:number, ratio?:number}>}
 */
function createAsrCleanup(router, opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {};

  return async function cleanupAsrText(text) {
    const original = String(text == null ? '' : text);
    const out = { text: original, applied: false, reason: '' };

    if (!original.trim()) { out.reason = 'empty'; return out; }

    // ① 开关短路：关掉的模块不该产生任何成本（连一条"被跳过"的日志都不该写）
    let enabled = false;
    try { enabled = !!(router && router.isModuleEnabled && router.isModuleEnabled('asr_cleanup')); }
    catch (e) { enabled = false; }
    if (!enabled) { out.reason = 'module_disabled'; return out; }

    // ② 调用：任何异常都退回原文 —— 顺句失败绝不能让"识别成功"变成"识别失败"
    const t0 = Date.now();
    let r = null;
    try {
      r = await router.route({
        module: 'asr_cleanup',
        system: SYSTEM,
        user: original,
        temperature: 0,
        json: true,
      });
    } catch (e) {
      out.reason = 'call_threw';
      log('asr_cleanup', { ok: false, code: 'call_threw', ms: Date.now() - t0 });
      return out;
    }
    out.ms = Date.now() - t0;
    out.model = (r && r.model) || '';
    out.degraded = !!(r && r.degraded);

    if (!r || !r.ok) {
      out.reason = (r && r.code) || 'route_failed';
      log('asr_cleanup', { ok: false, code: out.reason, model: out.model, ms: out.ms });
      return out;
    }

    // ③ 采纳判定
    const m = mergeCleaned(original, extractText(r.text));
    log('asr_cleanup', { ok: true, code: m.applied ? '' : 'rejected_' + m.reason, model: out.model, ms: out.ms, ratio: m.ratio });
    if (!m.applied) { out.reason = 'rejected_' + m.reason; out.ratio = m.ratio; return out; }

    out.text = m.text;
    out.applied = true;
    out.reason = 'ok';
    out.ratio = m.ratio;
    return out;
  };
}

module.exports = { createAsrCleanup, mergeCleaned, extractText, SYSTEM, POLICY };
