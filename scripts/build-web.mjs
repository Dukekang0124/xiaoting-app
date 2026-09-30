// 把"真正属于 App 的前端静态资产"拷贝到 www/，供 Capacitor 打包。
// 目的：webDir 不能指向仓库根（会把 node_modules / server / _selftest 一起塞进 APK）。
// 注：墨小溟后端（server.cjs 的 /api/*）不在包内 —— APK 走网络调用已部署的后端（见 APK 发布 SOP）。
import { cp, mkdir, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(root, '..'); // 墨小溟App/
const out = path.join(src, 'www');

// 需要进包的目录 / 文件（其余一律不带）
const DIRS = ['js', 'icons', 'vendor'];
const FILES = ['index.html', 'styles.css', 'sw.js', 'manifest.webmanifest'];

// 明确不上线的根级条目
const EXCLUDE = new Set([
  '.git', '.github', '.gitignore', '.wrangler', '.dev.vars', '.env',
  'node_modules', 'android', 'www', 'scripts', '_selftest', 'data', '.workbuddy',
  'server', 'server.cjs', 'package.json', 'package-lock.json',
  'capacitor.config.json', 'README.md', '.assetsignore', 'apk-icons',
  'android-assets', 'assets', 'keystore',
]);

/* 归类断言：仓库根新加一个条目后若忘了归类，构建直接失败
   （防"该上线的没上线 / 内部文件被上线"——沿用 Sinoky v0.21.2 的纪律）。 */
const unclassified = (await readdir(src, { withFileTypes: true }))
  .map((e) => e.name)
  .filter((n) => !DIRS.includes(n) && !FILES.includes(n) && !EXCLUDE.has(n) && !/\.(log|jks|genie)$/.test(n));
if (unclassified.length) {
  console.error('[build:web] ✗ 仓库根有未归类条目：');
  unclassified.forEach((n) => console.error('   - ' + n));
  console.error('   → 该上线：加进 DIRS / FILES；不该上线：加进 EXCLUDE');
  throw new Error('unclassified root entries: ' + unclassified.join(', '));
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

for (const d of DIRS) {
  await cp(path.join(src, d), path.join(out, d), { recursive: true });
}
for (const f of FILES) {
  try { await cp(path.join(src, f), path.join(out, f)); }
  catch (e) { console.warn('skip missing file:', f); }
}

console.log('[build:web] ✓ www/ 已生成（前端静态资产，不含后端 /api/*）');
