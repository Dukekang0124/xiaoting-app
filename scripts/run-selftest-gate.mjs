/**
 * 全链路自测门禁（CI 与本机共用同一份实现）。
 *
 * 顺序（顺序即因果，不能调）：
 *   ① 源码 ≡ 产物 —— 这一条不通过，后面跑的全是**旧码**，全绿也没有意义
 *   ② 起 server.cjs（静态根 = www/，与线上发的是同一份产物）
 *   ③ 主自测（591 条）+ 动效音效配置探针 + 产物冒烟
 *   ④ 任一步失败 → 非零退出 ⇒ CI 不再出包、也就不可能回填新 APK 元数据
 *
 * 🔴 为什么必须放在**出包之前**：出包前红了，就不会有 APK、不会有用新 APK 覆盖 main 的元数据。
 *    放在出包之后，"线上跑旧代码"这件事已经发生了。
 *
 * 用法：node scripts/run-selftest-gate.mjs
 *      PW_CHANNEL=chromium   # CI 里用 Playwright 自带 chromium；本机默认用已装的 Chrome
 *      SELFTEST_PORT=4173
 */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBuildSync, ROOT } from './verify-build-sync.mjs';

const NODE = process.execPath;
const PORT = Number(process.env.SELFTEST_PORT || 4173);
const BASE = `http://127.0.0.1:${PORT}`;
const SMOKE_PORT = process.env.SMOKE_PORT || '4210';

const log = (m) => console.log(m);
const fail = (m) => { console.error('\n[gate] ✗ ' + m); process.exit(1); };

/* ── ① 源码 ≡ 产物 ── */
log('\n[gate] ① 构建同步门禁：源码 ≡ www/ 产物');
{
  let r;
  try { r = verifyBuildSync(); } catch (e) { fail('构建同步门禁无法执行：' + e.message); }
  if (!r.ok) {
    console.error(`[gate] ✗ 源码与产物不一致（${r.drift.length} 处）：`);
    r.drift.forEach((d) => console.error(`   - ${d.file}  [${d.kind}] ${d.detail}`));
    fail('先跑 node scripts/build-web.mjs 再重试；否则自测跑的是旧码，全绿也无效。');
  }
  log(`[gate] ✓ 源码 ≡ 产物（${r.checked} 个文件逐字节一致，白名单无漏项）`);
}

/* ── ② 起自测服务 ── */
log(`\n[gate] ② 起自测服务 ${BASE}（静态根 = www/）`);
const server = spawn(NODE, ['server.cjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), STATS_KEY: 'selftest' },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: process.platform !== 'win32',
});
server.stdout.on('data', (d) => process.stdout.write('[server] ' + d));
server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

function killServer() {
  if (!server || server.exitCode !== null) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-server.pid, 'SIGKILL');
  } catch (e) { try { server.kill('SIGKILL'); } catch (e2) { /* 已退出 */ } }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let up = false;
for (let i = 0; i < 40; i++) {
  try {
    const res = await fetch(BASE + '/api/health');
    if (res.ok) { up = true; log('[gate] ✓ 自测服务已就绪 ' + JSON.stringify(await res.json())); break; }
  } catch (e) { /* 还没起来 */ }
  await sleep(500);
}
if (!up) { killServer(); fail('自测服务 40 次探测仍未就绪'); }

/* ── ③ 三套真跑 ── */
const SUITES = [
  { name: '主自测（全链路）', file: '_selftest/selftest.cjs', env: { BASE } },
  { name: '动效音效配置探针', file: '_selftest/motion-sound-config.cjs', env: { BASE } },
  { name: '产物冒烟（跑 www/）', file: '_selftest/www-artifact-smoke.cjs', env: { SMOKE_PORT } },
];

const failed = [];
for (const s of SUITES) {
  log(`\n[gate] ③ ${s.name} —— node ${s.file}`);
  const code = await new Promise((resolve) => {
    const p = spawn(NODE, [s.file], { cwd: ROOT, env: { ...process.env, ...s.env }, stdio: 'inherit' });
    p.on('close', resolve);
    p.on('error', () => resolve(-1));
  });
  if (code === 0) log(`[gate] ✓ ${s.name} 通过`);
  else { console.error(`[gate] ✗ ${s.name} 失败（exit ${code}）`); failed.push(s.name); }
}

killServer();

/* ── ④ 汇总 ── */
if (failed.length) {
  console.error(`\n[gate] ✗✗ 自测门禁未通过：${failed.join('、')}`);
  console.error('[gate] 出包已阻断 —— 线上不会拿到这一版；先修好再重新打 tag。');
  process.exit(1);
}
log('\n[gate] ✓✓ 全链路自测门禁通过：源码 ≡ 产物，主自测 / 动效 / 产物冒烟 三套全绿。');
