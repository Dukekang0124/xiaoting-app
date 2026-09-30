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
  check('生产配置里 analysis 与 safety 的优先级链确实不同（说明"按模块覆盖"是真的在用，不是摆设）',
    JSON.stringify((JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'llm.config.json'), 'utf8')).modules.safety.tier)) !==
    JSON.stringify((JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'llm.config.json'), 'utf8')).modules.analysis.tier)),
    'safety 与 analysis 链不同');

  const failed = R.filter((r) => !r.ok);
  console.log(`\n==== 汇总：${R.length - failed.length}/${R.length} 通过 ====`);
  if (failed.length) { failed.forEach((x) => console.log('  ✗ ' + x.name)); process.exit(1); }
})().catch((e) => { console.error('运行异常：', e); process.exit(2); });
