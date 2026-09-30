#!/usr/bin/env node
/**
 * ASR 顺句接线 · 端到端真跑（本地桩同时扮演百度 + 顺句模型）
 *
 * ============ 这份测的是什么，不是什么 ============
 *
 * 测：`POST /api/asr` 这条真链路里，我们加的那一截接线到底通不通，以及关掉时是不是真的零成本。
 *     具体四件事：
 *       ① /api/asr 仍然返回识别文本（接线没有破坏原有契约）
 *       ② asr_cleanup 开启时：返回顺句后的文本，并把原文放在 text_raw 里（证据不丢）
 *       ③ asr_cleanup 关闭时（= 生产默认）：响应结构与改动前**完全一致**（没有多出任何字段）
 *       ④ 关闭时顺句模型**一次都没被调用** —— 「零成本」这句话要能被证伪，不能只是注释里说说
 *
 * 不测：百度识别的准确率（那是 asr-e2e.cjs 的事，且需要真密钥）。这里百度侧也是桩，
 *       因为本机没有百度密钥；桩只负责让响应可预期，不是用来模仿百度的。
 *
 * 关键设计：顺句那一档也指向本地桩 provider（见 llm.config.asr-on.json）。
 *   否则就要依赖真模型返回什么 —— 它可能把「嗯那个我今天就是有点累不太想说话」原样吐回，
 *   于是「未被采纳」被误判成接线不通。接线的对错不该由模型的心情决定。
 *
 * 运行：node _selftest/asr-cleanup-wire.cjs
 */

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// ⚠ 桩端口**不要**随手选。Node 的 fetch（undici）会拒绝 WHATWG 的「不良端口」黑名单，
// 报出来的却是含糊的 `fetch failed`，得挖到 e.cause.code === 'bad port' 才看得出来。
// 4190 就在黑名单里（曾在这里白查一轮）。下面这几个端口（4210/4191/4192/4194）都不在黑名单上。
const STUB_PORT = Number(process.env.STUB_PORT || 4210);
const PORT_ON = Number(process.env.PORT_ON || 4191);
const PORT_OFF = Number(process.env.PORT_OFF || 4192);

// 桩数据
const RAW = '嗯那个我今天就是有点累不太想说话';
const CLEANED = '我今天有点累，不太想说话';

let pass = 0, fail = 0;
const lines = [];
const ok = (c, n, e) => { if (c) { pass++; lines.push(`  ✅ ${n}`); } else { fail++; lines.push(`  ❌ ${n}${e ? '  ← ' + e : ''}`); } };
const sec = (t) => { lines.push(''); lines.push(t); };

/* ---------------- 桩服务器：百度 token / 百度 ASR / 顺句模型 ---------------- */
let aiHits = 0, asrHits = 0, tokenHits = 0;

const stub = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };

    if (req.url.startsWith('/oauth/2.0/token')) {
      tokenHits++;
      return json({ access_token: 'stub-access-token', expires_in: 2592000, scope: 'audio_voice_assistant_get' });
    }
    if (req.url.startsWith('/server_api')) {
      asrHits++;
      return json({ err_no: 0, err_msg: 'success.', sn: 'stub-sn-1', corpus_no: '1', result: [RAW] });
    }
    if (req.url.startsWith('/v1/chat/completions')) {
      aiHits++;
      // 注意：这里刻意回「与原文不同、且在采纳阈值内」的文本，让断言能分辨
      // 「接线通了但被护栏拒绝」和「接线根本每通」。
      return json({
        id: 'stub', object: 'chat.completion', model: 'cleaner',
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ text: CLEANED }) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      });
    }
    res.writeHead(404); res.end('no stub route');
  });
});

/* ---------------- 小工具 ---------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function post(port, urlPath, payload) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(payload), 'utf8');
    const r = http.request({
      hostname: '127.0.0.1', port, path: urlPath, method: 'POST', timeout: 30000,
      headers: {
        'Content-Type': 'application/json', 'Content-Length': data.length,
        // sameOrigin() 要求 Origin 与 Host 一致，否则 403
        Origin: 'http://127.0.0.1:' + port,
      },
    }, (res) => {
      const ch = []; res.on('data', (c) => ch.push(c));
      res.on('end', () => {
        const t = Buffer.concat(ch).toString('utf8');
        let j = null; try { j = JSON.parse(t); } catch (e) {}
        resolve({ status: res.statusCode, text: t, json: j });
      });
    });
    r.on('error', (e) => resolve({ status: 0, text: '', json: null, err: String(e.message || e) }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, text: '', json: null, err: 'timeout' }); });
    r.write(data); r.end();
  });
}

function get(port, urlPath) {
  return new Promise((resolve) => {
    const r = http.request({ hostname: '127.0.0.1', port, path: urlPath, method: 'GET', timeout: 5000 }, (res) => {
      const ch = []; res.on('data', (c) => ch.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(ch).toString('utf8') }));
    });
    r.on('error', () => resolve({ status: 0, text: '' }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, text: '' }); });
    r.end();
  });
}

async function waitReady(port, label) {
  for (let i = 0; i < 60; i++) {
    const r = await get(port, '/api/health');
    if (r.status === 200) return true;
    await sleep(250);
  }
  throw new Error(label + ' 未能在 15s 内就绪（port ' + port + '）');
}

function startServer(port, env) {
  const child = spawn(process.execPath, ['server.cjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      ASR_BAIDU_AK: 'stub-ak',
      ASR_BAIDU_SK: 'stub-sk',
      ASR_TOKEN_URL: `http://127.0.0.1:${STUB_PORT}/oauth/2.0/token`,
      ASR_API_URL: `http://127.0.0.1:${STUB_PORT}/server_api`,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  return child;
}

/* ---------------- 主流程 ---------------- */
const kids = [];

(async () => {
  lines.push('==============================================');
  lines.push(' ASR 顺句接线 · 端到端真跑');
  lines.push(` 桩=${STUB_PORT}  开启顺句的服务=${PORT_ON}  生产配置的服务=${PORT_OFF}`);
  lines.push('==============================================');

  await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));
  lines.push('桩已就绪：/oauth/2.0/token、/server_api、/v1/chat/completions');

  const kidOn = startServer(PORT_ON, { LLM_CONFIG_FILE: '_selftest/llm.config.asr-on.json' });
  const kidOff = startServer(PORT_OFF, {});   // 不带 LLM_CONFIG_FILE ⇒ 生产配置（asr_cleanup 关闭）
  kids.push(kidOn, kidOff);

  await waitReady(PORT_ON, '顺句开启实例');
  await waitReady(PORT_OFF, '生产配置实例');
  lines.push('两个服务实例已就绪');

  const b64 = Buffer.from('not-a-real-wav-just-needs-to-be-nonempty').toString('base64');

  /* ---- A：顺句开启 ---- */
  sec('A 顺句开启（LLM_CONFIG_FILE=llm.config.asr-on.json）');
  const aiBefore = aiHits;
  const a = await post(PORT_ON, '/api/asr', { speech: b64, lang: 'zh' });
  ok(a.status === 200, 'HTTP 200', 'got ' + a.status + ' ' + (a.err || ''));
  const aj = a.json || {};
  ok(aj.ok === true, '识别链路本身仍然成功（接线没破坏原契约）', 'ok=' + aj.ok + ' err=' + aj.error);
  ok(aj.engine === 'baidu', "engine 仍是 'baidu'（没有偷换识别主体）", 'got ' + aj.engine);
  ok(aj.text === CLEANED, '返回的是顺句后的文本', 'got ' + JSON.stringify(aj.text));
  ok(aj.text_raw === RAW, '原文放在 text_raw 里（证据不丢）', 'got ' + JSON.stringify(aj.text_raw));
  ok(aj.cleanup && aj.cleanup.applied === true, 'cleanup.applied=true（明确标注发生过改写）', JSON.stringify(aj.cleanup));
  ok(aj.cleanup && aj.cleanup.model === 'cleaner', 'cleanup.model 记录了用了哪一档', aj.cleanup && aj.cleanup.model);
  ok(typeof (aj.cleanup && aj.cleanup.ratio) === 'number', 'cleanup.ratio 记录了采纳依据（长度比）', aj.cleanup && String(aj.cleanup.ratio));
  ok(aiHits - aiBefore === 1, '顺句模型被调用了恰好 1 次', 'got ' + (aiHits - aiBefore));

  /* ---- B：生产配置（顺句关闭） ---- */
  sec('B 生产配置（asr_cleanup 默认关闭）');
  const aiBefore2 = aiHits;
  const b = await post(PORT_OFF, '/api/asr', { speech: b64, lang: 'zh' });
  ok(b.status === 200, 'HTTP 200', 'got ' + b.status + ' ' + (b.err || ''));
  const bj = b.json || {};
  ok(bj.ok === true, '识别成功', 'ok=' + bj.ok);
  ok(bj.text === RAW, 'text 就是识别原文（未被任何改写）', 'got ' + JSON.stringify(bj.text));
  ok(!('cleanup' in bj), '响应里没有 cleanup 字段（结构不变 = 真最小侵入）', Object.keys(bj).join(','));
  ok(!('text_raw' in bj), '响应里没有 text_raw 字段', Object.keys(bj).join(','));
  ok(aiHits - aiBefore2 === 0, '顺句模型一次都没被调用 —— 「关闭即零成本」被证伪性验证', 'got ' + (aiHits - aiBefore2));

  /* ---- C：A/B 对照 ---- */
  sec('C A/B 对照 —— 同一请求、同一桩，两种配置给出不同且各自正确的形态');
  ok(JSON.stringify(Object.keys(aj).sort()) !== JSON.stringify(Object.keys(bj).sort()),
    '两个响应字段集不同（说明开关真的在起作用，不是同一条路走到黑）',
    'A=' + Object.keys(aj).sort().join(',') + ' | B=' + Object.keys(bj).sort().join(','));
  ok(aj.text !== bj.text, '同一段识别原文，A 被顺句、B 保持原样', `A=${aj.text} | B=${bj.text}`);
  lines.push(`     A: text=${aj.text}`);
  lines.push(`     B: text=${bj.text}`);
  lines.push(`     桩计数：token=${tokenHits} asr=${asrHits} 顺句模型=${aiHits}`);

  /* ---- D：失败不阻塞（顺句档挂掉时，识别结果照样返回） ---- */
  sec('D 顺句档挂掉 —— 必须不影响识别结果');
  {
    const PORT_BAD = Number(process.env.PORT_BAD || 4194);
    const kidBad = startServer(PORT_BAD, { LLM_CONFIG_FILE: '_selftest/llm.config.asr-bad.json' });
    kids.push(kidBad);
    await waitReady(PORT_BAD, '顺句端点坏掉的实例');
    const d = await post(PORT_BAD, '/api/asr', { speech: b64, lang: 'zh' });
    ok(d.status === 200, 'HTTP 仍是 200（顺句失败没有把识别拖成 5xx）', 'got ' + d.status);
    const dj = d.json || {};
    ok(dj.ok === true, 'ok 仍是 true（识别本身是成功的）', 'ok=' + dj.ok);
    ok(dj.text === RAW, '退回原文（这是最关键的兜底）', 'got ' + JSON.stringify(dj.text));
    ok(!dj.cleanup || dj.cleanup.applied === false, 'cleanup 里如实标注 applied=false', JSON.stringify(dj.cleanup));
    ok(!('text_raw' in dj), '没发生改写就不该出现 text_raw（不留无意义的字段）', Object.keys(dj).join(','));
    lines.push(`     回包：ok=${dj.ok} text=${JSON.stringify(dj.text)} cleanup=${JSON.stringify(dj.cleanup)}`);
  }

  /* ---- 收尾 ---- */
  for (const k of kids) { try { k.kill('SIGKILL'); } catch (e) {} }
  await new Promise((r) => stub.close(r));

  lines.push('');
  lines.push('==============================================');
  lines.push(` ASR 顺句接线端到端：${pass} 通过 / ${fail} 失败`);
  lines.push('==============================================');

  const out = lines.join('\n');
  console.log(out);
  require('fs').writeFileSync(path.join(__dirname, 'asr-cleanup-wire.out.txt'), out, 'utf8');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  for (const k of kids) { try { k.kill('SIGKILL'); } catch (x) {} }
  try { stub.close(); } catch (x) {}
  console.error('脚本自身崩溃：', e);
  process.exit(2);
});
