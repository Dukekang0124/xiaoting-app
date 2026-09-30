#!/usr/bin/env node
/**
 * 内部模型调度 · HTTP 集成验证
 *
 * 前面 llm-router.cjs 那套自测是「模块内直调」；这份是「过真 HTTP」——
 * 走 server.cjs 的路由表、真发请求、真读响应，验的是
 *   ① 路由表挂对了没有  ② 脱敏有没有漏 key  ③ 鉴权边界对不对
 *   ④ 前端只报模块名能不能跑通  ⑤ 日志/统计端点在独立进程里到底有没有数据
 *
 * 用法：
 *   PORT=4173 STATS_KEY=selftest node server.cjs          # 另开一个终端
 *   BASE=http://127.0.0.1:4173 STATS_KEY=selftest node _selftest/llm-http-verify.cjs
 */

const http = require('http');

const BASE = process.env.BASE || 'http://127.0.0.1:4173';
const STATS_KEY = process.env.STATS_KEY || 'selftest';

let pass = 0, fail = 0;
const lines = [];

function ok(cond, name, extra) {
  if (cond) { pass++; lines.push(`  ✅ ${name}`); }
  else { fail++; lines.push(`  ❌ ${name}${extra ? '  ← ' + extra : ''}`); }
}
function head(t) { lines.push(''); lines.push(t); }

function req(method, path, body) {
  return new Promise((resolve) => {
    const u = new URL(path, BASE);
    const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method,
      headers: data
        ? {
          'Content-Type': 'application/json',
          'Content-Length': data.length,
          // /api/llm 有同源门禁（它会真花钱调模型）⇒ 裸 http.request 不带 Origin 会被 403。
          // 这里显式带同源 Origin，模拟真实浏览器发出的请求。
          Origin: BASE,
        }
        : { Origin: BASE },
      timeout: 90000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* 非 JSON 就留 null */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    r.on('error', (e) => resolve({ status: 0, text: '', json: null, err: String(e.message || e) }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, text: '', json: null, err: 'timeout' }); });
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  lines.push('==============================================');
  lines.push(' 内部模型调度 · HTTP 集成验证');
  lines.push(' BASE = ' + BASE);
  lines.push(' 时间 = ' + new Date().toISOString());
  lines.push('==============================================');

  // ---------- ① 配置快照 + 脱敏 ----------
  head('① GET /api/llm/config —— 配置快照与脱敏');
  const cfg = await req('GET', '/api/llm/config');
  ok(cfg.status === 200, 'HTTP 200', 'got ' + cfg.status + ' ' + (cfg.err || ''));
  ok(!!(cfg.json && cfg.json.ok), 'ok:true');
  const cj = cfg.json || {};
  ok(!!cj.providers, '返回 providers');
  ok(Array.isArray(cj.modules) || (cj.modules && typeof cj.modules === 'object'), '返回 modules');

  // 脱敏：整个响应体（原始字符串）里不能出现任何 key 片段
  const KEY_FRAGS = ['c7de7465', 'sk-H6rL', '4vfH5GEJ', 'lcid_'];
  const hits = KEY_FRAGS.filter((f) => cfg.text.includes(f));
  ok(hits.length === 0, '响应体中不含任何密钥片段', '命中了: ' + hits.join(', '));

  // publishableKey 是「可公开」的，但也不该出现在 config 里（config 只讲规则）
  ok(!cfg.text.includes('publishableKey'), 'config 不抛出 publishableKey 字段');

  if (cj.providers) {
    for (const [pid, p] of Object.entries(cj.providers)) {
      lines.push(`     · provider ${pid}  label=${p.label || '-'}  enabled=${p.enabled}`);
      if (p.models) {
        const ms = Array.isArray(p.models) ? p.models : Object.entries(p.models).map(([k, v]) => ({ name: k, ...v }));
        for (const m of ms) lines.push(`         - ${m.name || m}  enabled=${m.enabled}`);
      }
    }
  }
  if (cj.modules) {
    const mods = Array.isArray(cj.modules) ? cj.modules : Object.entries(cj.modules).map(([k, v]) => ({ module: k, ...v }));
    for (const m of mods) {
      lines.push(`     · module ${m.module || m.name}  tier=${JSON.stringify(m.tier || [])}`);
    }
  }

  // ---------- ② 鉴权与协议边界 ----------
  head('② 路由边界 —— 方法/入参/越权');
  const get405 = await req('GET', '/api/llm');
  ok(get405.status === 405, 'GET /api/llm → 405 use_post', 'got ' + get405.status);

  const badJson = await req('POST', '/api/llm', null);
  // body 为空 → JSON.parse('{}') 成功 → 但 user 为空 → 400 empty_user
  ok(badJson.status === 400 && badJson.json && badJson.json.error === 'empty_user',
    '空 body → 400 empty_user', 'got ' + badJson.status + '/' + (badJson.json && badJson.json.error));

  const emptyUser = await req('POST', '/api/llm', { module: 'safety', user: '   ' });
  ok(emptyUser.status === 400 && emptyUser.json && emptyUser.json.error === 'empty_user',
    '空白 user → 400 empty_user', 'got ' + emptyUser.status);

  const badModule = await req('POST', '/api/llm', { module: '../../../etc/passwd', user: '只回两个字：收到' });
  ok(badModule.status === 200, '非法 module 名不报错（回退 default 档）', 'got ' + badModule.status);

  const pingNoKey = await req('POST', '/api/llm/ping', { module: 'safety' });
  ok(pingNoKey.status === 404, '未带 key 的 ping → 404（运维动作不裸奔）', 'got ' + pingNoKey.status);

  const pingBadKey = await req('POST', '/api/llm/ping?key=wrong-key', { module: 'safety' });
  ok(pingBadKey.status === 404, '错误 key 的 ping → 404', 'got ' + pingBadKey.status);

  // 🔴 护栏：/api/llm 必须拒绝异源（它会真花钱调模型，没有门禁就是个免费额度池）
  // 修复前这条必须失败 —— 曾经实测 `Origin: https://evil.example` 返回 200 且真调了模型。
  const crossOrigin = await new Promise((resolve) => {
    const u = new URL('/api/llm', BASE);
    const data = Buffer.from(JSON.stringify({ module: 'safety', system: '只回两个字', user: '只回复两个字：收到' }), 'utf8');
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', timeout: 30000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, Origin: 'https://evil.example' },
    }, (res) => { const ch = []; res.on('data', (c) => ch.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(ch).toString('utf8') })); });
    r.on('error', () => resolve({ status: 0, body: '' }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: 'timeout' }); });
    r.write(data); r.end();
  });
  ok(crossOrigin.status === 403, '异源调用 /api/llm → 403（不为陌生来源花模型额度）',
    'got ' + crossOrigin.status + ' ' + crossOrigin.body.slice(0, 120));
  ok(/origin_not_allowed/.test(crossOrigin.body), '拒绝原因是 origin_not_allowed（说得清）', crossOrigin.body.slice(0, 120));

  // ---------- ③ 真路由：前端只报模块名 ----------
  head('③ POST /api/llm —— 前端只传模块名，后端自己选模型');
  const t0 = Date.now();
  const safety = await req('POST', '/api/llm', {
    module: 'safety',
    system: '你是风险识别器，只输出一个词：SAFE 或 RISK。',
    user: '今天和同事吵了一架，有点烦。',
  });
  const t1 = Date.now();
  ok(safety.status === 200, 'safety 返回 200', 'got ' + safety.status + ' ' + (safety.err || ''));
  const sj = safety.json || {};
  ok(sj.model !== undefined, '响应带 model 字段（用了谁）');
  ok(sj.channel !== undefined, '响应带 channel 字段（走哪条链路）');
  ok(typeof sj.degraded === 'boolean', '响应带 degraded 布尔（降没降档）');
  ok(typeof sj.ms === 'number', '响应带 ms（耗时）');
  ok(Array.isArray(sj.tried), '响应带 tried[]（每一档的尝试轨迹）');
  lines.push(`     本次：model=${sj.model} channel=${sj.channel} degraded=${sj.degraded} ms=${sj.ms} 端到端=${t1 - t0}ms`);
  if (Array.isArray(sj.tried) && sj.tried.length) {
    lines.push('     尝试轨迹：');
    for (const t of sj.tried) lines.push(`       - ${t.model}  ok=${t.ok}  code=${t.code || '-'}  ${t.ms}ms  attempt#${t.attempt}`);
  }
  // 前端回包绝不能带 endpoint / key
  ok(!/https?:\/\/open\.bigmodel\.cn/.test(safety.text), '响应体不含上游 endpoint');
  ok(!KEY_FRAGS.some((f) => safety.text.includes(f)), '响应体不含任何密钥片段');

  // 降级链要真实发生才算验到：safety 第一顺位是 zhipu:glm-4-flash，正常应 ok 且未降级
  ok(sj.ok === true || sj.ok === false, 'ok 字段是布尔（无论成败都有明确结果）');

  // ---------- ④ 默认档 ----------
  head('④ POST /api/llm（不传 module）—— default 档');
  const dflt = await req('POST', '/api/llm', { user: '只回复两个字：收到' });
  ok(dflt.status === 200, 'default 返回 200', 'got ' + dflt.status);
  lines.push(`     default：model=${dflt.json && dflt.json.model} ms=${dflt.json && dflt.json.ms} ok=${dflt.json && dflt.json.ok}`);

  // ---------- ⑤ 统计与日志 ----------
  head('⑤ GET /api/llm/stats —— 独立进程内的日志聚合');
  const st = await req('GET', '/api/llm/stats?recent=10');
  ok(st.status === 200, 'stats 返回 200', 'got ' + st.status);
  ok(!!(st.json && st.json.ok), 'stats ok:true');
  const stats = (st.json && st.json.stats) || {};
  const recent = (st.json && st.json.recent) || [];
  lines.push(`     stats：total=${stats.total} ok=${stats.ok} fail=${stats.fail} degraded=${stats.degraded}`);
  if (stats.byModel) lines.push(`     byModel：${JSON.stringify(stats.byModel)}`);
  if (stats.byModule) lines.push(`     byModule：${JSON.stringify(stats.byModule)}`);
  ok(typeof stats.total === 'number', 'stats.total 是数字');
  ok(stats.total >= 2, `stats.total=${stats.total} ≥ 2（本次至少打了 2 次）`, 'got ' + stats.total);
  lines.push(`     recent 条数=${recent.length}`);
  if (recent.length) {
    const r0 = recent[recent.length - 1];
    lines.push(`     最近一条：ts=${r0.ts} module=${r0.module} ok=${r0.ok} provider=${r0.provider} model=${r0.model} ms=${r0.ms} degraded=${r0.degraded} attempts=${r0.attempts}`);
    lines.push(`     字段集：${Object.keys(r0).join(', ')}`);
    ok(!('user' in r0) && !('system' in r0) && !('text' in r0) && !('prompt' in r0),
      'recent 不含用户正文/Prompt（只留可观测字段）');
    ok(!!r0.model && !!r0.module, 'recent 含 model 与 module');
    ok(typeof r0.degraded === 'boolean' && typeof r0.ms === 'number',
      'recent 含 degraded(是否降级) 与 ms(耗时) —— 第 4 条要求');
  }

  // 落盘日志：四个必录字段（用了哪个模型 / 耗时 / 是否降级 / 失败原因）
  head('⑤b server/logs/*.jsonl —— 落盘日志字段与脱敏');
  let logFile = null;
  try {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const p = require('path').join(__dirname, '..', 'server', 'logs',
      `llm-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.jsonl`);
    if (require('fs').existsSync(p)) logFile = p;
  } catch (e) { /* 无日志文件不算失败 */ }
  if (logFile) {
    const rows = require('fs').readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
    lines.push(`     日志文件：server/logs/${require('path').basename(logFile)}（${rows.length} 行）`);
    const last = JSON.parse(rows[rows.length - 1]);
    const fields = Object.keys(last);
    lines.push(`     末行字段：${fields.join(', ')}`);
    ok(fields.includes('model'), '日志含 model（用了哪个模型）');
    ok(fields.includes('ms'), '日志含 ms（耗时）');
    ok(fields.includes('degraded'), '日志含 degraded（是否降级）');
    ok(fields.includes('failReasons') || fields.includes('code'), '日志含 failReasons/code（失败原因）');
    const raw = rows.join('\n');
    ok(!KEY_FRAGS.some((f) => raw.includes(f)), '日志全文不含任何密钥片段');
    ok(!raw.includes('只回复两个字：收到'), '日志不含用户原文（可验证的脱敏）');
  } else {
    lines.push('     ⚠ 今日日志文件不存在（可能日志目录被配置关闭），跳过落盘断言');
  }

  // ---------- ⑥ 运维探活（真打模型） ----------
  head('⑥ POST /api/llm/ping?key=*** —— 真探活');
  const ping = await req('POST', `/api/llm/ping?key=${encodeURIComponent(STATS_KEY)}`, { module: 'safety' });
  if (ping.status === 404) {
    lines.push('     ⚠ 服务端未配置 STATS_KEY 或与本次不一致 ⇒ ping 不可用（跳过，不计失败）');
  } else {
    ok(ping.status === 200, '带正确 key 的 ping → 200', 'got ' + ping.status);
    const pj = ping.json || {};
    ok(Array.isArray(pj.results), 'ping 回 results[]');
    for (const r of (pj.results || [])) {
      lines.push(`       - ${r.model || r.id}  ok=${r.ok}  ${r.ms ? r.ms + 'ms' : ''}  ${r.code || r.error || ''}`);
    }
  }

  // ---------- 汇总 ----------
  lines.push('');
  lines.push('==============================================');
  lines.push(` HTTP 集成验证：${pass} 通过 / ${fail} 失败`);
  lines.push('==============================================');

  const out = lines.join('\n');
  console.log(out);
  require('fs').writeFileSync(__dirname + '/llm-http-verify.out.txt', out, 'utf8');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('验证脚本自身崩溃：', e);
  process.exit(2);
});
