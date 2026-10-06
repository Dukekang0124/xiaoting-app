/**
 * 全链路自测门禁（CI 与本机共用同一份实现）。
 *
 * 顺序（顺序即因果，不能调）：
 *   ① 源码 ≡ 产物 —— 这一条不通过，后面跑的全是**旧码**，全绿也没有意义
 *   ② 起 server.cjs（静态根 = www/，与线上发的是同一份产物）
 *   ③ 主自测（591 条）+ 动效音效配置探针 + 更新弹窗单次性探针 + 产物冒烟
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
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBuildSync, ROOT } from './verify-build-sync.mjs';

const NODE = process.execPath;
const PORT = Number(process.env.SELFTEST_PORT || 4173);
const BASE = `http://127.0.0.1:${PORT}`;
const SMOKE_PORT = process.env.SMOKE_PORT || '4210';

const log = (m) => console.log(m);
const fail = (m) => { console.error('\n[gate] ✗ ' + m); process.exit(1); };

/* 要真跑的套件清单（提前定义：下面的步骤 ⓪ 可移植性门禁要先扫它们的源码） */
const SUITES = [
  { name: '主自测（全链路）', file: '_selftest/selftest.cjs', env: { BASE } },
  { name: '动效音效配置探针', file: '_selftest/motion-sound-config.cjs', env: { BASE } },
  // v1.7.10：更新弹窗只弹一次（DM 完成时刻单次唤起 / 弹窗互斥 / 启动单弹窗）——自带 4193 端口服务
  { name: '更新弹窗单次性探针', file: '_selftest/update-popup-once.cjs', env: {} },
  // #261：时间线页左滑退出落点（实时→首页 / 回看→我的）——用门禁 BASE 服务
  { name: '时间线左滑退出落点探针', file: '_selftest/timeline-exit.cjs', env: { BASE } },
  { name: '产物冒烟（跑 www/）', file: '_selftest/www-artifact-smoke.cjs', env: { SMOKE_PORT } },
];

/* ── ⓪ 可移植性门禁：套件不许写死本机绝对路径 ──
 *
 * 🔴 为什么需要它（v1.8.0 的真实事故，代价是一整轮发版）：
 *   新入库的 _selftest/timeline-exit.cjs 用
 *     require('C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules/playwright')
 *   引入 playwright。本机永远绿；CI（Linux runner）上直接 MODULE_NOT_FOUND ⇒
 *   该套 0/2 秒退 ⇒ 门禁红 ⇒ **不出包、不回填**。而它是全仓唯一一个这么写的
 *   （其余 60+ 个探针都是裸 require('playwright')）。
 *
 * 这类失效最恶劣的性质是**只在别的机器上出现**：本地干净检出 + 同款构建 + 同款
 * chromium + TZ=UTC 全部复现为全绿，只能靠「不依赖本机路径」这条判据本身来拦。
 * 判据打在「模块解析的写法」上，而不是「跑起来的结果」上 —— 结果在这台机器上永远是对的。
 */
{
  // 只认「模块解析里出现的 Windows 盘符字面量」：精确命中 require/import 的实参，
  // 避免把 /signal:\s*/ 这类正则字面量误判成路径（selftest.cjs 里有 12 处这种）。
  // 🔴 必须先去掉注释再扫：本探针自己的修复注释里就写着 require('C:/Users/…') 这个反例，
  //    不去注释 ⇒ 护栏会把「已经修好的文件」判红（实测踩到）。去注释时用等长空白替换、
  //    只保留换行 ⇒ 报出来的行号仍然对应原文。
  const stripComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/gm, '$1');
  const re = /(?:require|from)\s*\(?\s*['"]([A-Za-z]:[\\/][^'"]*)['"]/;
  const offenders = [];
  for (const s of SUITES) {
    let src;
    try { src = readFileSync(path.join(ROOT, s.file), 'utf8'); }
    catch (e) { offenders.push(`${s.file}（读不到：${e.message}）`); continue; }
    stripComments(src).split('\n').forEach((line, i) => {
      const m = re.exec(line);
      if (m) offenders.push(`${s.file}:${i + 1}  →  ${m[1]}`);
    });
  }
  if (offenders.length) {
    console.error('[gate] ✗ 门禁套件写死了本机绝对路径（本机绿、CI 必红）：');
    offenders.forEach((o) => console.error('   - ' + o));
    fail('改成裸写法 require(\'playwright\')：本机由 NODE_PATH 解析、CI 由仓库 node_modules 解析。');
  }
  log('[gate] ⓪ 可移植性门禁：套件不依赖本机绝对路径 ✓');
}

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

/* ── ③ 真跑（套件清单见文件顶部的 SUITES） ──
 * 每套的完整输出边跑边打印（保持原来肉眼可见），同时**留一份在内存里**：
 * 一旦某套失败，把它的原因搬到日志最末尾 —— 见下方汇总处的说明。 */
const failed = [];
const outputs = {};
for (const s of SUITES) {
  log(`\n[gate] ③ ${s.name} —— node ${s.file}`);
  const { code, out } = await new Promise((resolve) => {
    const p = spawn(NODE, [s.file], { cwd: ROOT, env: { ...process.env, ...s.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    const sink = (d) => { const t = d.toString(); buf += t; process.stdout.write(t); };
    p.stdout.on('data', sink);
    p.stderr.on('data', sink);
    p.on('close', (c) => resolve({ code: c, out: buf }));
    p.on('error', () => resolve({ code: -1, out: buf }));
  });
  if (code === 0) log(`[gate] ✓ ${s.name} 通过`);
  else {
    console.error(`[gate] ✗ ${s.name} 失败（exit ${code}）`);
    failed.push(s.name);
    outputs[s.name] = out;
  }
}

killServer();

/* ── ④ 汇总 ── */
if (failed.length) {
  console.error(`\n[gate] ✗✗ 自测门禁未通过：${failed.join('、')}`);
  /* 🔴 为什么必须把失败原因**搬到最末尾**（v1.8.0 实测）：
   *   CI 只把本日志的末尾 1.5KB 写进 Checks 注解（见 .github/workflows/apk.yml）。
   *   中间那套失败的输出会被它后面那些套件的输出挤出去 ⇒ 注解里只剩
   *     「✗✗ 自测门禁未通过：时间线左滑退出落点探针」+ 最后一套的 PASS 行，
   *   知道「哪套失败」却看不到「为什么失败」。把原因复述到最后一段就解决了。 */
  for (const name of failed) {
    const lines = (outputs[name] || '').split('\n');
    const hits = lines.filter((l) => /✗/.test(l) || /^\s*FAIL/.test(l)).slice(0, 12);
    console.error(`\n[gate] ── 失败原因 · ${name} ──`);
    if (hits.length) hits.forEach((l) => console.error('   ' + l.trim()));
    else console.error('   （该套没打印任何 ✗/FAIL —— 多半是它自己起不来/加载失败，末尾 12 行如下）');
    lines.slice(-12).forEach((l) => console.error('   | ' + l));
  }
  console.error('\n[gate] 出包已阻断 —— 线上不会拿到这一版；先修好再重新打 tag。');
  process.exit(1);
}
log('\n[gate] ✓✓ 全链路自测门禁通过：源码 ≡ 产物，主自测 / 动效 / 更新弹窗单次性 / 产物冒烟 全绿。');
