#!/usr/bin/env node
/**
 * 内部模型调度 · HTTP 层「降级链」实证（A/B 的 B 面）
 *
 * 为什么还要单独跑一份：
 *   llm-http-verify.cjs 跑的是生产配置，safety 第一档直接成功 ⇒ degraded=false，
 *   「降级」这条分支在 HTTP 层其实一次都没走到。只测成功路径 = 没测降级。
 *
 * 这份用 _selftest/llm.config.http-degrade.json（把第一档换成必然失败的桩），
 * 证明三件事过了真 HTTP 依然成立：
 *   ① 第一档挂了 → 自动落到下一档，且回包 degraded=true、tried[] 如实记录失败原因
 *   ② 解析期就把「没配密钥」的档剔除了（nokey:ghost-model 不该出现在 tried 里）
 *   ③ 整条链全挂 → ok=false 且带明确 code，绝不抛异常、绝不返回空 ok
 *
 * 用法：
 *   PORT=4175 LLM_CONFIG_FILE=_selftest/llm.config.http-degrade.json node server.cjs
 *   BASE=http://127.0.0.1:4175 node _selftest/llm-http-degrade.cjs
 */

const http = require('http');
const BASE = process.env.BASE || 'http://127.0.0.1:4175';

let pass = 0, fail = 0;
const lines = [];
const ok = (c, n, e) => { if (c) { pass++; lines.push(`  ✅ ${n}`); } else { fail++; lines.push(`  ❌ ${n}${e ? '  ← ' + e : ''}`); } };

function req(method, path, body) {
  return new Promise((resolve) => {
    const u = new URL(path, BASE);
    const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      // /api/llm 有同源门禁 ⇒ 显式带同源 Origin，模拟真实浏览器
      headers: data
        ? { 'Content-Type': 'application/json', 'Content-Length': data.length, Origin: BASE }
        : { Origin: BASE },
      timeout: 60000,
    }, (res) => {
      const ch = []; res.on('data', (c) => ch.push(c));
      res.on('end', () => { const t = Buffer.concat(ch).toString('utf8'); let j = null; try { j = JSON.parse(t); } catch (e) {} resolve({ status: res.statusCode, text: t, json: j }); });
    });
    r.on('error', (e) => resolve({ status: 0, text: '', json: null, err: String(e.message || e) }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, text: '', json: null, err: 'timeout' }); });
    if (data) r.write(data);
    r.end();
  });
}

const showTried = (tried) => {
  for (const t of (tried || [])) lines.push(`       - [${t.provider}] ${t.model}  ok=${t.ok}  code=${t.code || '-'}  ${t.ms}ms  attempt#${t.attempt}${t.message ? '  msg=' + String(t.message).slice(0, 60) : ''}`);
};

(async () => {
  lines.push('==============================================');
  lines.push(' 内部模型调度 · HTTP 降级链实证（B 面）');
  lines.push(' BASE = ' + BASE);
  lines.push(' 配置 = _selftest/llm.config.http-degrade.json');
  lines.push('==============================================');

  // ---- ① 第一档必挂 → 落到第二档 ----
  lines.push('');
  lines.push('① safety（第一档 broken:always-down，第二档 zhipu:glm-4-flash）');
  const s = await req('POST', '/api/llm', { module: 'safety', system: '只回两个字。', user: '只回复两个字：收到' });
  ok(s.status === 200, 'HTTP 200（降级不该以错误码收场）', 'got ' + s.status + ' ' + (s.err || ''));
  const sj = s.json || {};
  ok(sj.ok === true, '最终 ok:true（降级成功）', 'got ok=' + sj.ok + ' code=' + sj.code);
  ok(sj.model === 'glm-4-flash', '实际用的是第二档 glm-4-flash', 'got ' + sj.model);
  ok(sj.degraded === true, 'degraded:true（如实标注发生过降级）', 'got ' + sj.degraded);
  ok(Array.isArray(sj.tried) && sj.tried.length >= 2, 'tried[] 至少两档（看得见失败的那一档）', 'got ' + (sj.tried || []).length);
  if (sj.tried && sj.tried[0]) {
    ok(sj.tried[0].ok === false, 'tried[0] 是失败档（第一档确实挂了）');
    ok(!!sj.tried[0].code, 'tried[0] 带失败原因 code', 'got ' + sj.tried[0].code);
  }
  ok(sj.attempts >= 2, 'attempts ≥ 2（计数包含失败尝试）', 'got ' + sj.attempts);
  lines.push(`     回包：model=${sj.model} degraded=${sj.degraded} attempts=${sj.attempts} ms=${sj.ms} code=${sj.code || '-'}`);
  lines.push('     尝试轨迹：'); showTried(sj.tried);

  // ---- ② 解析期剔除「没配密钥」的档 ----
  lines.push('');
  lines.push('② analysis（链首故意放 nokey:ghost-model —— 应在解析期被剔除，不出现在 tried 里）');
  const a = await req('POST', '/api/llm', { module: 'analysis', system: '只回两个字。', user: '只回复两个字：收到' });
  const aj = a.json || {};
  ok(a.status === 200, 'HTTP 200', 'got ' + a.status);
  ok(aj.model === 'glm-4-flash', '最终落到 zhipu:glm-4-flash', 'got ' + aj.model);
  const ghosts = (aj.tried || []).filter((t) => t.model === 'ghost-model');
  ok(ghosts.length === 0, 'ghost-model 从未被真正调用（无密钥档解析期已剔除）', '出现了 ' + ghosts.length + ' 次');
  const brokens = (aj.tried || []).filter((t) => String(t.provider) === 'broken');
  ok(brokens.length >= 1, 'broken 档出现在 tried 里（证明它确实试过并失败）', 'got ' + brokens.length);
  lines.push(`     回包：model=${aj.model} degraded=${aj.degraded} attempts=${aj.attempts} ms=${aj.ms}`);
  lines.push('     尝试轨迹：'); showTried(aj.tried);

  // ---- ③ 整条链全挂 ----
  lines.push('');
  lines.push('③ card（整条链两档全挂）——必须优雅失败，不抛异常');
  const c = await req('POST', '/api/llm', { module: 'card', system: '只回两个字。', user: '只回复两个字：收到' });
  ok(c.status === 200, 'HTTP 仍是 200（优雅失败，不是 500）', 'got ' + c.status);
  const cj = c.json || {};
  ok(cj.ok === false, 'ok:false（如实承认全挂了）', 'got ok=' + cj.ok);
  ok(!!cj.code, '带明确失败 code', 'got ' + cj.code);
  ok(typeof cj.ms === 'number' && cj.ms >= 0, '带 ms');
  ok((cj.tried || []).length === 2, 'tried 恰好 2 档（两档都试过）', 'got ' + (cj.tried || []).length);
  ok((cj.tried || []).every((t) => t.ok === false), 'tried 全为失败');
  ok(!/at Object\.|at async |TypeError|ReferenceError/.test(c.text), '回包里没有堆栈（异常被接住了）');
  lines.push(`     回包：ok=${cj.ok} code=${cj.code} degraded=${cj.degraded} attempts=${cj.attempts} ms=${cj.ms}`);
  lines.push('     尝试轨迹：'); showTried(cj.tried);

  // ---- ④ 降级是否被记进统计 ----
  lines.push('');
  lines.push('④ /api/llm/stats —— 降级率有没有被记下来');
  const st = await req('GET', '/api/llm/stats?recent=10');
  const stats = (st.json && st.json.stats) || {};
  lines.push(`     total=${stats.total} ok=${stats.ok} fail=${stats.fail} degraded=${stats.degraded}`);
  ok(stats.total >= 3, '统计到 ≥3 次调用', 'got ' + stats.total);
  ok(stats.degraded >= 2, 'degraded 计数 ≥2（两次降级成功被记下）', 'got ' + stats.degraded);
  ok(stats.fail >= 1, 'fail 计数 ≥1（card 全挂被记下）', 'got ' + stats.fail);
  if (stats.byModel) lines.push(`     byModel：${JSON.stringify(stats.byModel)}`);

  lines.push('');
  lines.push('==============================================');
  lines.push(` HTTP 降级链实证：${pass} 通过 / ${fail} 失败`);
  lines.push('==============================================');

  const out = lines.join('\n');
  console.log(out);
  require('fs').writeFileSync(__dirname + '/llm-http-degrade.out.txt', out, 'utf8');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('脚本自身崩溃：', e); process.exit(2); });
