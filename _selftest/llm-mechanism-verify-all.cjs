#!/usr/bin/env node
/**
 * 内部模型配置与调度机制 · 一键全量验证
 *
 * 一条命令跑完这套机制的全部验证面，输出一张汇总表。用途有二：
 *   ① 本次交付的可复现证据（每项都写了期望通过数，改坏了立刻看得出来是坏了哪一面）；
 *   ② 以后改这套机制时的回归入口 —— 不用再记「哪个脚本要配哪个端口/哪份配置」。
 *
 * 七个子件各自覆盖一个面，缺一面就是漏一条降级分支：
 *   llm-router.cjs           模块级调度（优先级/降级/过滤/密钥零泄漏/日志四要素）
 *   llm-http-verify.cjs      过真 HTTP 的生产配置（路由表、脱敏、鉴权边界、统计、探活）
 *   llm-http-degrade.cjs     过真 HTTP 的降级链（第一档必挂 → 自动落到下一档）
 *   llm-front-self-channel.cjs  浏览器内真跑前端接入（自通道通/缺后端回落/脏结构停用/冷却）
 *   asr-cleanup.cjs          ASR 顺句策略穷举（护栏与边界，桩替换 router）
 *   asr-cleanup-wire.cjs     ASR 顺句接线端到端（真实 /api/asr + 开关 A/B + 零成本证伪）
 *   selftest.cjs             项目全量自测（条数基线见 expected-counts.json，确认这套机制没有回归既有功能）
 *
 * 运行：node _selftest/llm-mechanism-verify-all.cjs
 *
 * 🔴 期望条数一律从 _selftest/expected-counts.json 读，不要往本文件里写数字：
 *   曾经这里硬编码 selftest 期望 402，主套件涨到 422 后第 ⑦ 项就每次假红
 *   —— 期望值散落两处 = 每次加断言都要记得改两个地方，迟早忘。
 */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

/** 断言条数基线（单一来源）。读不到就返回 null ⇒ 该项退化为「只看失败数」，不阻塞。 */
const EXPECTED = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'expected-counts.json'), 'utf8')); } catch (e) { return {}; }
})();

const ROOT = path.join(__dirname, '..');
const PORT_PROD = Number(process.env.PORT_PROD || 4173);
const PORT_DEGRADE = Number(process.env.PORT_DEGRADE || 4175);
const STATS_KEY = 'selftest';
const NODE_PATH = process.env.NODE_PATH || 'C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules';

const kids = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(port, p) {
  return new Promise((resolve) => {
    const r = http.request({ hostname: '127.0.0.1', port, path: p, method: 'GET', timeout: 4000 }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    r.on('error', () => resolve(0));
    r.on('timeout', () => { r.destroy(); resolve(0); });
    r.end();
  });
}

async function waitReady(port, label) {
  for (let i = 0; i < 80; i++) {
    if (await get(port, '/api/health') === 200) return;
    await sleep(250);
  }
  throw new Error(label + ' 未就绪（port ' + port + '）');
}

function startServer(port, env) {
  const c = spawn(process.execPath, ['server.cjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  c.stdout.on('data', () => {});
  c.stderr.on('data', () => {});
  kids.push(c);
  return c;
}

function runNode(args, env) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, NODE_PATH, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    c.stdout.on('data', (d) => { out += d.toString(); });
    c.stderr.on('data', (d) => { out += d.toString(); });
    c.on('close', (code) => resolve({ code, out }));
  });
}

/** 从输出里抠出「N 通过 / M 失败」；抠不到就回 null（那是脚本崩了，不是断言红了） */
function parseTally(out) {
  const m = /(\d+)\s*通过\s*\/\s*(\d+)\s*失败/.exec(out);
  if (m) return { pass: Number(m[1]), fail: Number(m[2]) };
  const m2 = /(\d+)\/(\d+)\s*通过/.exec(out);
  if (m2) return { pass: Number(m2[1]), fail: Number(m2[2]) - Number(m2[1]) };
  return null;
}

const RESULTS = [];
async function run(title, args, env, expect) {
  process.stdout.write(`\n▶ ${title} …\n`);
  const t0 = Date.now();
  const r = await runNode(args, env);
  const ms = Date.now() - t0;
  const tally = parseTally(r.out);
  const crashed = /脚本自身崩溃|运行异常/.test(r.out);
  let verdict;
  if (crashed) verdict = { ok: false, note: '脚本崩溃' };
  else if (!tally) verdict = { ok: false, note: '未取到断言计数（可能提前退出）' };
  else verdict = { ok: tally.fail === 0 && tally.pass === expect, note: `${tally.pass} 通过 / ${tally.fail} 失败` + (expect && tally.pass !== expect ? `（期望 ${expect}）` : '') };

  RESULTS.push({ title, ...verdict, ms, out: r.out });
  console.log(`  ${verdict.ok ? '✅' : '❌'} ${verdict.note}  (${(ms / 1000).toFixed(1)}s)`);
  return r.out;
}

(async () => {
  console.log('================================================');
  console.log(' 内部模型配置与调度机制 · 一键全量验证');
  console.log('================================================');

  // 先把两个常驻服务起好（前端真跑与 HTTP 验证都依赖它们）
  startServer(PORT_PROD, { STATS_KEY });
  startServer(PORT_DEGRADE, { LLM_CONFIG_FILE: '_selftest/llm.config.http-degrade.json' });
  await waitReady(PORT_PROD, '生产配置实例');
  await waitReady(PORT_DEGRADE, '降级配置实例');
  console.log(`\n常驻服务就绪：生产配置 :${PORT_PROD}   降级配置 :${PORT_DEGRADE}`);

  // ①②③ 模块级 + HTTP 级
  await run('① 模块级调度自测（优先级/降级/过滤/密钥零泄漏/日志四要素）', ['_selftest/llm-router.cjs'], {}, 24);
  await run('② HTTP 集成验证（生产配置：路由表/脱敏/鉴权/统计/探活/异源门禁）', ['_selftest/llm-http-verify.cjs'], { BASE: `http://127.0.0.1:${PORT_PROD}`, STATS_KEY }, 39);
  await run('③ HTTP 降级链实证（第一档必挂 → 自动落下一档 → 全挂优雅失败）', ['_selftest/llm-http-degrade.cjs'], { BASE: `http://127.0.0.1:${PORT_DEGRADE}` }, 22);
  await run('④ 前端自通道真跑（浏览器内 import：通/回落/脏结构/冷却）', ['_selftest/llm-front-self-channel.cjs'],
    { BASE: `http://127.0.0.1:${PORT_PROD}`, DEGRADE_BASE: `http://127.0.0.1:${PORT_DEGRADE}` }, 22);

  // ⑤⑥ ASR 侧
  await run('⑤ ASR 顺句策略穷举（护栏/边界/异常不外抛/脱敏日志）', ['_selftest/asr-cleanup.cjs'], {}, 51);
  await run('⑥ ASR 顺句接线端到端（真 /api/asr + 开关 A/B + 关闭零成本）', ['_selftest/asr-cleanup-wire.cjs'], {}, 22);

  // ⑦ 项目全量自测（需要生产服务在跑）
  await run('⑦ 项目全量自测（确认这套机制未回归既有功能）', ['_selftest/selftest.cjs'], { BASE: `http://127.0.0.1:${PORT_PROD}` }, EXPECTED.selftest);

  // ⑧ 更新弹窗「APK 启动即弹」A/B 鉴别力校验（自带服务与端口，不依赖上面两个实例）
  //    含反向断言：拿修复前的基线夹具跑同一套断言，必须"表现差" —— 否则说明断言没鉴别力。
  await run('⑧ 更新弹窗 APK 启动即弹（A/B 鉴别力 + SW 不缓存清单）', ['_selftest/update-apk-abi.cjs'], {}, 16);

  // 收尾
  for (const k of kids) { try { k.kill('SIGKILL'); } catch (e) {} }

  console.log('\n================================================');
  console.log(' 汇总');
  console.log('================================================');
  const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
  for (const r of RESULTS) {
    console.log(` ${r.ok ? '✅' : '❌'} ${pad(r.title, 62)} ${r.note}`);
  }
  const bad = RESULTS.filter((r) => !r.ok);
  console.log('');
  console.log(` 共 ${RESULTS.length} 项，${RESULTS.length - bad.length} 项通过，${bad.length} 项失败`);
  console.log('================================================');

  require('fs').writeFileSync(path.join(__dirname, 'llm-mechanism-verify-all.out.txt'),
    RESULTS.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.title}  —  ${r.note}\n\n${r.out}`).join('\n'), 'utf8');

  process.exit(bad.length === 0 ? 0 : 1);
})().catch((e) => {
  for (const k of kids) { try { k.kill('SIGKILL'); } catch (x) {} }
  console.error('编排脚本自身崩溃：', e);
  process.exit(2);
});
