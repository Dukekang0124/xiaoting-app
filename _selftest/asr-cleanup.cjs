#!/usr/bin/env node
/**
 * ASR 文本顺句模块 · 穷举断言（桩替换 router，无需百度密钥）
 *
 * 为什么必须这样测：
 *   本机没有百度 ASR 密钥 ⇒ /api/asr 只会返回 503 ⇒ 顺句分支在 HTTP 层跑不到。
 *   如果把逻辑内联进 handleAsr，这段代码就是「写了但从未被执行过」。
 *   依赖注入让 route() 可控，于是每条护栏都能被真跑、并且能被证伪。
 *
 * 四类要证的事：
 *   ① 关掉的模块 = 零成本（连 route 都不该被调用，更不该写日志）
 *   ② 采纳判定（长度比 / 换行 / 无变化）边界正确 —— 这是本模块唯一的实质逻辑
 *   ③ 任何失败都退回原文，绝不抛错、绝不把「识别成功」变成失败
 *   ④ 模型输出的形态容错（```json 围栏、纯文本、非法 JSON）
 *
 * 运行：node _selftest/asr-cleanup.cjs
 */

const path = require('path');
const { createAsrCleanup, mergeCleaned, extractText, POLICY } = require('../server/asr-cleanup.cjs');

let pass = 0, fail = 0;
const lines = [];
const ok = (c, n, e) => { if (c) { pass++; lines.push(`  ✅ ${n}`); } else { fail++; lines.push(`  ❌ ${n}${e ? '  ← ' + e : ''}`); } };
const sec = (t) => { lines.push(''); lines.push(t); };

/** 造一个可控的 router 桩：记录调用次数，按脚本返回 */
function stubRouter({ enabled = true, reply = null, throwOnRoute = false, throwOnEnabled = false } = {}) {
  const calls = [];
  return {
    calls,
    isModuleEnabled(name) {
      if (throwOnEnabled) throw new Error('boom');
      calls.push({ kind: 'enabled', name });
      return enabled;
    },
    async route(opts) {
      if (throwOnRoute) throw new Error('route exploded');
      calls.push({ kind: 'route', opts });
      return typeof reply === 'function' ? reply(opts) : reply;
    },
  };
}

(async () => {
  lines.push('==============================================');
  lines.push(' ASR 文本顺句 · 穷举断言（桩替换 router）');
  lines.push('==============================================');

  /* ============ ① 关掉的模块 = 零成本 ============ */
  sec('① 模块关闭 —— 必须零成本');
  {
    const r = stubRouter({ enabled: false });
    const clean = createAsrCleanup(r);
    const out = await clean('嗯我今天就是有点累');
    ok(out.text === '嗯我今天就是有点累', '文本原样返回', out.text);
    ok(out.applied === false, 'applied=false', String(out.applied));
    ok(out.reason === 'module_disabled', "reason='module_disabled'", out.reason);
    ok(r.calls.filter((c) => c.kind === 'route').length === 0, 'route() 一次都没被调用（真零成本，不产生日志 I/O）',
      'route 被调了 ' + r.calls.filter((c) => c.kind === 'route').length + ' 次');
  }
  {
    const r = stubRouter({ enabled: false });
    const clean = createAsrCleanup(r);
    const out = await clean('   ');
    ok(out.reason === 'empty', "空文本先短路：reason='empty'", out.reason);
    ok(r.calls.length === 0, '空文本连开关都不查（顺序正确）', 'calls=' + r.calls.length);
  }

  /* ============ ② 采纳判定 ============ */
  sec('② 采纳判定 —— 各条护栏与边界');
  const A = '嗯那个我今天就是有点累不太想说话';   // 19 字
  {
    const r = stubRouter({ reply: { ok: true, text: '{"text":"我今天有点累，不太想说话"}', model: 'glm-4-flash' } });
    const out = await createAsrCleanup(r)(A);
    ok(out.applied === true, '正常顺句 → 采纳', out.reason);
    ok(out.text === '我今天有点累，不太想说话', '文本被替换为顺句结果', out.text);
    ok(out.model === 'glm-4-flash', '带回 model（可观测）', out.model);
    ok(typeof out.ratio === 'number', '带回 ratio（采纳依据）', String(out.ratio));
  }
  {
    const r = stubRouter({ reply: { ok: true, text: '{"text":"累"}' } });
    const out = await createAsrCleanup(r)(A);
    ok(out.applied === false, '过短（概括）→ 拒绝', out.reason);
    ok(out.reason === 'rejected_too_short', "reason='rejected_too_short'", out.reason);
    ok(out.text === A, '拒绝时保留原文', out.text);
  }
  {
    const r = stubRouter({ reply: { ok: true, text: '{"text":"' + '啊'.repeat(60) + '"}' } });
    const out = await createAsrCleanup(r)(A);
    ok(out.applied === false && out.reason === 'rejected_too_long', '过长（扩写）→ 拒绝', out.reason);
  }
  {
    const r = stubRouter({ reply: { ok: true, text: '{"text":"我今天有点累\\n不太想说话\\n就这样"}' } });
    const out = await createAsrCleanup(r)(A);
    ok(out.applied === false && out.reason === 'rejected_multiline', '出现换行（被排成列表）→ 拒绝', out.reason);
  }
  {
    const r = stubRouter({ reply: { ok: true, text: '{"text":"' + A + '"}' } });
    const out = await createAsrCleanup(r)(A);
    ok(out.applied === false && out.reason === 'rejected_unchanged', '与原文一致 → 不标记为已采纳（不制造假动作）', out.reason);
  }
  // 模型回空
  {
    const r = stubRouter({ reply: { ok: true, text: '{"text":""}' } });
    const out = await createAsrCleanup(r)(A);
    ok(out.applied === false && out.reason === 'rejected_empty_cleaned', '模型回空 → 拒绝', out.reason);
  }

  sec('②b 边界值（阈值本身，不是阈值以内）');
  {
    // 恰好 60%：19 * 0.6 = 11.4 → 取 12 字（ratio≥0.6）
    const a = '一二三四五六七八九十甲乙';  // 12 字
    const b = '一二三四五六七八';          // 8 字 → 0.667 采纳
    ok(mergeCleaned(a, b).applied === true, 'ratio 略高于下限 → 采纳', String(mergeCleaned(a, b).ratio));
    // 精确构造 ratio = 0.6：原文 10 字、结果 6 字（零一二三四五 = 6 字）
    const r6 = mergeCleaned('零一二三四五六七八九', '零一二三四五');
    ok(r6.ratio === 0.6 && r6.applied === true, 'ratio 恰为下限 0.6 → 采纳（含边界）', JSON.stringify(r6));
    // 精确 ratio > 1.6：10 → 17
    const r17 = mergeCleaned('零一二三四五六七八九', '零一二三四五六七八九ABCDEFG');
    ok(r17.ratio > POLICY.maxRatio && r17.applied === false, 'ratio 超上限 → 拒绝', JSON.stringify(r17));
    // 精确 ratio = 1.6：10 → 16
    const r16 = mergeCleaned('零一二三四五六七八九', '零一二三四五六七八九ABCDEF');
    ok(r16.ratio === 1.6 && r16.applied === true, 'ratio 恰为上限 1.6 → 采纳（含边界）', JSON.stringify(r16));
  }

  /* ============ ③ 失败一律退回原文 ============ */
  sec('③ 失败退回原文 —— 绝不抛错、绝不连累识别结果');
  {
    const r = stubRouter({ reply: { ok: false, code: 'rate_limited', model: 'glm-4.7-flash' } });
    const out = await createAsrCleanup(r)(A);
    ok(out.applied === false && out.reason === 'rate_limited', 'route 失败 → 保留原文并带失败码', out.reason);
    ok(out.text === A, '文本仍是原文', out.text);
    ok(out.model === 'glm-4.7-flash', '仍记录是哪一档失败的', out.model);
  }
  {
    const r = stubRouter({ throwOnRoute: true });
    let threw = false;
    let out = null;
    try { out = await createAsrCleanup(r)(A); } catch (e) { threw = true; }
    ok(!threw, 'route 抛异常 → 本模块不向外抛（调用方不会因此 500）');
    ok(out && out.reason === 'call_threw', "reason='call_threw'", out && out.reason);
    ok(out && out.text === A, '文本仍是原文', out && out.text);
  }
  {
    const r = stubRouter({ throwOnEnabled: true });
    let threw = false;
    let out = null;
    try { out = await createAsrCleanup(r)(A); } catch (e) { threw = true; }
    ok(!threw, 'isModuleEnabled 抛异常 → 也不向外抛');
    ok(out && out.reason === 'module_disabled', '视为关闭（失败默认保守）', out && out.reason);
    ok(r.calls.filter((c) => c.kind === 'route').length === 0, '视为关闭后不调用 route()', '');
  }
  {
    const r = stubRouter({ reply: { ok: true, text: '{"text":"一"}', degraded: true } });
    const out = await createAsrCleanup(r)(A);
    ok(out.applied === false && out.reason === 'rejected_too_short', '降级后的结果同样要过护栏（不因降级就放宽）', out.reason);
  }

  /* ============ ④ 模型输出形态容错 ============ */
  sec('④ 模型输出形态容错');
  {
    ok(extractText('{"text":"你好"}') === '你好', '标准 JSON 取出 text');
    ok(extractText('```json\n{"text":"你好"}\n```') === '你好', '```json 围栏被剥掉');
    ok(extractText('  你好  ') === '你好', '纯文本直接可用');
    ok(extractText('{"other":1}') === '{"other":1}', 'JSON 但没有 text 字段 → 当纯文本（不崩）');
    ok(extractText('') === '', '空输入 → 空');
    ok(extractText(null) === '', 'null → 空（不抛错）');
    // 围栏里的答案应能被正常采纳
    const fenced = '{"text":"' + '我'.repeat(12) + '"}';
    const r = stubRouter({ reply: { ok: true, text: '```json\n' + fenced + '\n```' } });
    const out = await createAsrCleanup(r)(A);
    ok(out.applied === true, '围栏包裹的答案能被正常采纳', out.reason + '/' + out.text);
  }

  /* ============ ⑤ 契约与副作用 ============ */
  sec('⑤ 契约与副作用');
  {
    const r = stubRouter({ reply: { ok: true, text: '{"text":"我今天有点累，不太想说话"}' } });
    const clean = createAsrCleanup(r);
    const before = A;
    const out = await clean(A);
    ok(A === before, '不修改传入的字符串（纯函数式，无副作用）');
    ok(typeof out.text === 'string' && out.text.length > 0, '始终返回非空 text');
    ok(typeof out.applied === 'boolean', '始终返回 applied 布尔');
    ok(typeof out.reason === 'string', '始终返回 reason（可解释）');
    const ro = r.calls.find((c) => c.kind === 'route');
    ok(!!ro, '确实发起了 route 调用');
    ok(ro && ro.opts.module === 'asr_cleanup', "route 用的是 asr_cleanup 模块", ro && ro.opts.module);
    ok(ro && ro.opts.json === true, '要求 JSON 输出', ro && String(ro.opts.json));
    ok(ro && ro.opts.temperature === 0, 'temperature=0（后处理要确定性，不要发挥）', ro && String(ro.opts.temperature));
    ok(ro && ro.opts.user === A, 'user 就是原文（不做二次加工）');
    ok(ro && typeof ro.opts.system === 'string' && /严禁/.test(ro.opts.system), 'system 里明确写了「严禁改写」等约束');
  }
  {
    // 日志回调：关闭时不写，开启时写，且不写用户正文
    const logged = [];
    const r = stubRouter({ enabled: false });
    await createAsrCleanup(r, { log: (a, b) => logged.push([a, b]) })('测试文本内容');
    ok(logged.length === 0, '模块关闭 → 一条日志都不写', 'logged=' + logged.length);

    const r2 = stubRouter({ reply: { ok: true, text: '{"text":"测试文本内容被顺句了"}' } });
    await createAsrCleanup(r2, { log: (a, b) => logged.push([a, b]) })('测试文本内容');
    ok(logged.length === 1, '模块开启 → 写一条日志', 'logged=' + logged.length);
    ok(logged.length && !JSON.stringify(logged).includes('测试文本内容'), '日志不含用户正文（可验证的脱敏）', JSON.stringify(logged[0] || {}).slice(0, 120));
  }

  lines.push('');
  lines.push('==============================================');
  lines.push(` ASR 顺句断言：${pass} 通过 / ${fail} 失败`);
  lines.push('==============================================');

  const out = lines.join('\n');
  console.log(out);
  require('fs').writeFileSync(path.join(__dirname, 'asr-cleanup.out.txt'), out, 'utf8');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('脚本自身崩溃：', e); process.exit(2); });
