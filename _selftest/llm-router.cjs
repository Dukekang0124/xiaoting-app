// 墨小溟 · 内部模型调度层自测（v1.1.4）
//
// 这一份不测 UI，只测「调度机制本身」。要证的四件事，每件都必须是可证伪的：
//   ① 优先级按配置走，不是写死在代码里；
//   ② 降级链真的会往下走 —— 用必然失败的第一档来证，不靠"本机恰好网络不好"；
//   ③ 配置里指向不存在/无密钥的模型，在**解析阶段**就被剔除，而不是等到调用才失败；
//   ④ 密钥一个字符都不会出现在任何响应或日志里。
//
// 运行：node _selftest/llm-router.cjs
const path = require('path');
const fs = require('fs');

// 先指到自测配置，再 require —— 配置路径在模块加载时读取
process.env.LLM_CONFIG_FILE = path.join(__dirname, 'llm.config.test.json');
process.env.STATS_KEY = 'selftest';

const R = [];
const check = (name, ok, detail = '') => {
  R.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const router = require('../server/llm-router.cjs');
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'llm.config.test.json'), 'utf8'));

const sys = '你是墨小溟，一个温和的情绪复盘助手。';
const usr = '我今天很烦。';

(async () => {
  console.log('=== 内部模型调度层自测 ===\n');

  /* ---------- ① 配置解析：不可用的档位在解析阶段就被剔除 ---------- */
  console.log('--- ① 优先级解析 ---');
  const tierDefault = router.resolveTier('default');
  check('配置里的 default 链被正确解析', tierDefault.length === 1 && tierDefault[0].id === 'zhipu:glm-4-flash', tierDefault.map((t) => t.id).join(' > '));
  check('解析结果里带上了密钥（进程内可用），但不带 endpoint 之外的任何厂商信息泄漏', !!tierDefault[0].key, '有 key');

  // 强制一个「第一档必然失败 + 第二档可用」的链，这才是降级链的真实验证环境
  process.env.LLM_TIER_default = 'broken:always-down,zhipu:glm-4-flash';
  router.loadConfig(true);
  const tierForced = router.resolveTier('default');
  check('环境变量 LLM_TIER_<MODULE> 能覆盖优先级（不用改代码）', tierForced.length === 2 && tierForced[0].id === 'broken:always-down' && tierForced[1].id === 'zhipu:glm-4-flash', tierForced.map((t) => t.id).join(' > '));

  // 未配密钥的模型应当被静默剔除（它注定失败，留着只是白等一次网络往返）
  process.env.LLM_TIER_default = 'nokey:ghost-model,zhipu:glm-4-flash';
  router.loadConfig(true);
  const tierNoKey = router.resolveTier('default');
  check('未配密钥的模型在解析阶段就被剔除（不浪费一次注定失败的往返）', tierNoKey.length === 1 && tierNoKey[0].id === 'zhipu:glm-4-flash', tierNoKey.map((t) => t.id).join(' > '));

  /* ---------- ② 降级链：真的会往下走 ---------- */
  console.log('\n--- ② 降级链（第一档必然失败）---');
  process.env.LLM_TIER_default = 'broken:always-down,zhipu:glm-4-flash';
  router.loadConfig(true);
  router.resetStats();
  const t0 = Date.now();
  const r1 = await router.route({ module: 'default', system: sys, user: usr });
  const wallMs = Date.now() - t0;
  console.log(`  结果: ok=${r1.ok} model=${r1.model} degraded=${r1.degraded} attempts=${r1.attempts} ${r1.ms}ms`);
  (r1.tried || []).forEach((t) => console.log(`    · ${t.provider}:${t.model} #${t.attempt} ${t.ok ? 'OK' : 'FAIL ' + t.code} ${t.ms}ms`));
  check('第一档连不上时自动降级到下一档并成功', r1.ok && r1.model === 'glm-4-flash', `${r1.model}`);
  check('降级被标记（degraded=true）——排查时要能一眼看出"这次不是正常路径"', r1.degraded === true, String(r1.degraded));
  check('降级过程被完整记录（每一跳都在 tried 里，含失败原因）', (r1.tried || []).length >= 2 && r1.tried[0].ok === false && !!r1.tried[0].code, JSON.stringify(r1.tried.map((t) => t.model + ':' + (t.ok ? 'ok' : t.code))));
  check('失败原因是网络类错误码（而不是被吞成 unknown）', ['network', 'timeout', 'http_404', 'http_5xx'].includes(r1.tried[0].code), r1.tried[0].code);

  /* ---------- ③ 全链失败：必须明确失败，不许假装成功 ---------- */
  console.log('\n--- ③ 全链失败 ---');
  process.env.LLM_TIER_default = 'broken:always-down,broken:model-missing';
  router.loadConfig(true);
  const r2 = await router.route({ module: 'default', system: sys, user: usr });
  console.log(`  结果: ok=${r2.ok} code=${r2.code} attempted=${r2.attempts} 次`);
  check('所有档位都失败时返回 ok:false 且带最后的失败码（绝不由调度层伪造内容）', r2.ok === false && !!r2.code, `code=${r2.code}`);
  check('全链失败时也留下了 tried 记录（能回答"到底试过谁"）', (r2.tried || []).length >= 2, String((r2.tried || []).length));

  /* ---------- ④ 真实档位：用户点名的三个模型各自的实际行为 ---------- */
  console.log('\n--- ④ 用户点名的三个模型（真实调用）---');
  const facts = [];
  for (const ref of ['zhipu:glm-5.2', 'zhipu:glm-4.7-flash', 'zhipu:glm-4-flash']) {
    process.env.LLM_TIER_default = ref;
    router.loadConfig(true);
    const t = Date.now();
    const r = await router.route({ module: 'default', system: sys, user: usr });
    facts.push({ ref, ok: r.ok, code: r.code || '', ms: Date.now() - t, model: r.model });
    console.log(`  ${ref.padEnd(22)} ${r.ok ? 'OK  ' : 'FAIL'} code=${(r.code || '-').padEnd(16)} ${Date.now() - t}ms`);
  }
  const f = (ref) => facts.find((x) => x.ref === ref);
  check('glm-4-flash（兜底档）实测可用 —— 这是本账号上唯一扛得住流量的模型', f('zhipu:glm-4-flash').ok === true, `${f('zhipu:glm-4-flash').ms}ms`);
  check('glm-5.2 实测不可用（账号侧限制），且失败原因被正确归一（不是 unknown）', f('zhipu:glm-5.2').ok === false && f('zhipu:glm-5.2').code !== 'unknown', `code=${f('zhipu:glm-5.2').code}`);

  /* ---------- ⑤ JSON 模式与结构化返回 ---------- */
  console.log('\n--- ⑤ JSON 模式 ---');
  process.env.LLM_TIER_default = 'zhipu:glm-4-flash';
  router.loadConfig(true);
  const r3 = await router.route({ module: 'default', system: '只输出 JSON，不要任何多余文字。', user: '输出 {"ok":true,"n":1}', json: true, temperature: 0 });
  let parsed = null;
  try { parsed = JSON.parse(r3.text); } catch (e) { /* 抽出花括号再试 */ const m = String(r3.text).match(/\{[\s\S]*\}/); if (m) { try { parsed = JSON.parse(m[0]); } catch (e2) {} } }
  check('json=true 时能拿到可解析的 JSON（response_format 真实生效）', !!parsed && typeof parsed === 'object', JSON.stringify(parsed));

  /* ---------- ⑥ 调用日志：字段齐全、不含用户正文、不含密钥 ---------- */
  console.log('\n--- ⑥ 调用日志 ---');
  const st = router.stats();
  check('统计能按模块与模型聚合', st.total > 0 && Object.keys(st.byModel).length > 0, `total=${st.total} 模型数=${Object.keys(st.byModel).length}`);
  check('降级次数被单独计数（能算降级率）', typeof st.degraded === 'number' && st.degraded >= 1, `degraded=${st.degraded}`);

  const logDir = path.join(__dirname, '..', CFG.logging.dir);
  const files = fs.existsSync(logDir) ? fs.readdirSync(logDir).filter((x) => x.startsWith('llm-test-')) : [];
  check('调用日志已落盘（JSONL，按天分文件）', files.length > 0, files.join(', '));
  let logText = '';
  if (files.length) logText = fs.readFileSync(path.join(logDir, files[files.length - 1]), 'utf8');
  const logLines = logText.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  check('日志每行含 模型/耗时/是否降级/失败原因/模块（排查四要素）',
    logLines.length > 0 && logLines.every((l) => 'model' in l && 'ms' in l && 'degraded' in l && 'module' in l),
    `共 ${logLines.length} 条`);
  check('日志记录了失败原因（failReasons 非空）', logLines.some((l) => Array.isArray(l.failReasons) && l.failReasons.length > 0), JSON.stringify(logLines.find((l) => (l.failReasons || []).length) || {}).slice(0, 120));

  /* ---------- ⑦ 密钥零泄漏（这条是红线） ---------- */
  console.log('\n--- ⑦ 密钥零泄漏 ---');
  const keys = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'model.keys.json'), 'utf8'));
  const allKeys = [keys.defaultKey, ...Object.values(keys.keys)].filter(Boolean);
  const inspectStr = JSON.stringify(router.inspectConfig());
  check('配置脱敏快照里不含任何密钥', allKeys.every((k) => !inspectStr.includes(k)), `检查了 ${allKeys.length} 把 key`);
  check('配置脱敏快照里能看出"某个模型有没有配好 key"（运维要知道，但不该知道 key 本身）',
    /hasKey/.test(inspectStr), (inspectStr.match(/"hasKey":(true|false)/g) || []).slice(0, 3).join(' '));
  check('调用日志里不含任何密钥', allKeys.every((k) => !logText.includes(k)), `日志 ${logText.length} 字符`);
  check('调用日志里不含用户正文（主打敢说真话的产品，自己的日志不能成为泄露源）', !logText.includes('我今天很烦'), '已核查');

  /* ---------- ⑧ 模块级覆盖 ---------- */
  console.log('\n--- ⑧ 按模块覆盖优先级 ---');
  const cfg = router.inspectConfig();
  check('每个功能模块都能各自指定优先级链', cfg.modules && Object.keys(cfg.modules).length >= 1, Object.keys(cfg.modules || {}).join(', '));
  /* 🔴 v1.7.6 换判据：原来这条是「生产配置里 analysis 与 safety 的链必须不同」。
     它拦的假象是对的（怕"按模块覆盖"是摆设），但 v1.7.6 用户明确要求**统一一条优先序**
     （GLM-5.3-Flash → deepseek-v4-flash → agnes-2.5-flash → GLM-4-Flash），两条链因此变得相同
     —— 那是需求变了，不是能力没了。所以改判「机制还活着」的两种更有区分力的证据：
       · 横向上有模块的链**确实不同**（asr_cleanup 仍单独指 zhipu:glm-4-flash）；
       · 纵向上模块级**参数覆盖真的落到配置里**（safety 9s/temp0 vs analysis 无上限/temp0.3）——
         这比"链不同"更本质：链可以统一，参数不该被顺手统一掉。 */
  const prodCfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'llm.config.json'), 'utf8'));
  check('仍存在链不同的模块（按模块覆盖不是摆设）',
    JSON.stringify(prodCfg.modules.asr_cleanup.tier) !== JSON.stringify(prodCfg.modules.safety.tier),
    'asr_cleanup=' + prodCfg.modules.asr_cleanup.tier.join(','));
  check('模块级参数覆盖真的生效（safety 与 analysis 的超时/温度不同，没被顺手统一掉）',
    prodCfg.modules.safety.timeoutMs !== prodCfg.modules.analysis.timeoutMs &&
    prodCfg.modules.safety.temperature !== prodCfg.modules.analysis.temperature,
    `safety ${prodCfg.modules.safety.timeoutMs}ms/${prodCfg.modules.safety.temperature} vs analysis ${prodCfg.modules.analysis.timeoutMs}ms/${prodCfg.modules.analysis.temperature}`);

  /* ---------- ⑨ v1.7.6：四模型优先序 + 按模型参数真的进了请求体 ---------- */
  console.log('\n--- ⑨ v1.7.6 优先序与按模型参数 ---');
  const refs = prodCfg.tiers.default || [];
  // 去重后看「模型顺序」：同一模型可能挂两条路由（换路由比换模型便宜），那不是顺序错误
  const uniqOrder = [...new Set(refs.map((r) => String(r).split(':')[1].replace(/^(z-ai|deepseek)\//, '')))];
  check('默认链的模型顺序 = 用户指定序（GLM-5.3-Flash → deepseek-v4-flash → agnes-2.5-flash → GLM-4-Flash）',
    uniqOrder.join(' > ') === 'glm-5.3-flash > deepseek-v4-flash > agnes-2.5-flash > glm-4-flash', uniqOrder.join(' > '));
  /* glm-5.3-flash 是 onlyReasoning 思考模型：实测不传 reasoning_effort 时主分析 26.8s 且正文 0 字符。
     ⇒ 它的**每一条路由**都必须带这个参数，漏一条就等于留了一条"白等 27 秒再降级"的路。 */
  const g53 = [prodCfg.providers.openrouter.models['z-ai/glm-5.3-flash'], prodCfg.providers.workbuddy.models['glm-5.3-flash']];
  check('glm-5.3-flash 的每一条路由都带 reasoning_effort=low（否则这一档必空正文）',
    g53.every((m) => m && m.params && m.params.reasoning_effort === 'low'),
    g53.map((m) => (m && m.params ? m.params.reasoning_effort : 'MISSING')).join(' / '));
  check('不需要该参数的模型不带 params（少一次注定被拒的往返）',
    !prodCfg.providers.workbuddy.models['deepseek-v4-flash'].params &&
    !prodCfg.providers.agnes.models['agnes-2.5-flash'].params &&
    !prodCfg.providers.zhipu.models['glm-4-flash'].params);

  /* 光看配置里写了 params 不算验到 —— 必须证明它真的进了 HTTP 请求体。
     起一个本地桩记录 body，再把配置指向它，这是唯一能证伪的做法。 */
  const http = require('http');
  const captured = [];
  const stub = http.createServer((rq, rs) => {
    let buf = '';
    rq.on('data', (d) => { buf += d; });
    rq.on('end', () => {
      captured.push({ url: rq.url, auth: rq.headers.authorization || '', body: JSON.parse(buf || '{}') });
      rs.writeHead(200, { 'Content-Type': 'application/json' });
      rs.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise((res) => stub.listen(0, '127.0.0.1', res));
  const stubPort = stub.address().port;
  const tmpCfg = path.join(__dirname, '..', '_probe', '_tmp_llm_params.json');
  fs.writeFileSync(tmpCfg, JSON.stringify({
    version: 1,
    defaults: { timeoutMs: 8000, attempts: 1 },
    providers: {
      stub: {
        label: '本地桩', kind: 'openai-compatible',
        endpoint: `http://127.0.0.1:${stubPort}/v1/chat/completions`,
        authHeader: 'Authorization', authPrefix: 'Bearer ',
        keysFile: 'server/model.keys.json',
        models: {
          'with-params': { keyRef: 'glm-4-flash', enabled: true, params: { reasoning_effort: 'low', top_k: 5 } },
          'no-params': { keyRef: 'glm-4-flash', enabled: true },
          // 恶意配置：想通过 params 覆盖契约字段。配置是可编辑的，所以它也是可攻击面。
          'evil-params': { keyRef: 'glm-4-flash', enabled: true, params: { model: 'HACKED', messages: [{ role: 'user', content: 'HACKED' }], stream: true } },
        },
      },
    },
    tiers: { default: ['stub:with-params'] },
    degradeOn: { codes: ['http_4xx', 'http_5xx', 'network'] },
    retry: { perModel: 1, onlyCodes: ['network'] },
    logging: { dir: false },
  }), 'utf8');

  process.env.LLM_CONFIG_FILE = tmpCfg;
  /* 🔴 两个坑叠在一起，都会让桩收不到请求，而现象都是「桩没收到请求」——看起来像 params 链路坏了：
     ① 前面第 ⑤ 节设过 LLM_TIER_default=zhipu:glm-4-flash，环境变量优先级高于配置文件；
     ② 更根本的：server/llm-router.cjs 的 CONFIG_FILE 是**模块加载时求值的常量**，
        加载后再改 process.env.LLM_CONFIG_FILE 完全无效。必须清 require.cache 重新 require。 */
  delete process.env.LLM_TIER_default;
  delete require.cache[require.resolve('../server/llm-router.cjs')];
  const routerStub = require('../server/llm-router.cjs');
  await routerStub.route({ module: 'default', system: sys, user: usr });
  const b1 = captured[captured.length - 1];
  check('配置里的 params 真的进了请求体（不只是配置里写着好看）',
    !!b1 && b1.body.reasoning_effort === 'low' && b1.body.top_k === 5,
    b1 ? JSON.stringify({ reasoning_effort: b1.body.reasoning_effort, top_k: b1.body.top_k }) : '桩没收到请求');
  check('params 是「追加」不是「替换」：契约字段仍在（model 指到桩、messages 完整、非流式）',
    !!b1 && b1.body.model === 'with-params' && Array.isArray(b1.body.messages) && b1.body.messages.length === 2 && b1.body.stream === undefined,
    b1 ? JSON.stringify({ model: b1.body.model, msgs: b1.body.messages.length, stream: b1.body.stream }) : '-');

  process.env.LLM_TIER_default = 'stub:no-params';
  routerStub.loadConfig(true);
  await routerStub.route({ module: 'default', system: sys, user: usr });
  const b2 = captured[captured.length - 1];
  check('不带 params 的模型请求体里确实没有那个字段（没被"顺手统一加"）',
    !!b2 && !('reasoning_effort' in b2.body), b2 ? Object.keys(b2.body).join(',') : '-');

  process.env.LLM_TIER_default = 'stub:evil-params';
  routerStub.loadConfig(true);
  await routerStub.route({ module: 'default', system: sys, user: usr });
  const b3 = captured[captured.length - 1];
  check('params 不许覆盖契约字段（model/messages/stream 有白名单挡着）',
    !!b3 && b3.body.model === 'evil-params' && b3.body.messages[0].content !== 'HACKED' && b3.body.stream === undefined,
    b3 ? JSON.stringify({ model: b3.body.model, first: String(b3.body.messages[0].content).slice(0, 12), stream: b3.body.stream }) : '-');

  await new Promise((res) => stub.close(res));
  try { fs.unlinkSync(tmpCfg); } catch (e) { /* 清理失败无所谓，_probe/ 本来就不入库 */ }
  process.env.LLM_TIER_default = '';
  process.env.LLM_CONFIG_FILE = path.join(__dirname, 'llm.config.test.json');
  delete require.cache[require.resolve('../server/llm-router.cjs')];
  router.loadConfig(true);

  const failed = R.filter((r) => !r.ok);
  console.log(`\n==== 汇总：${R.length - failed.length}/${R.length} 通过 ====`);
  if (failed.length) { failed.forEach((x) => console.log('  ✗ ' + x.name)); process.exit(1); }
})().catch((e) => { console.error('运行异常：', e); process.exit(2); });
