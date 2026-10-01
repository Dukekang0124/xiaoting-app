// 把"真正属于 App 的前端静态资产"拷贝到 www/，供 Capacitor 打包。
// 目的：webDir 不能指向仓库根（会把 node_modules / server / _selftest 一起塞进 APK）。
// 注：墨小溟后端（server.cjs 的 /api/*）不在包内 —— APK 走网络调用已部署的后端（见 APK 发布 SOP）。
import { cp, mkdir, rm, readdir, readFile, writeFile, stat } from 'node:fs/promises';
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
  // cloudflare/：云端 ASR 的 Pages Functions 工程（部署在 xiaoting-asr.pages.dev），
  //   它是**服务端**代码，不是 App 静态资产 ⇒ 进包只会白白增大体积，且有误用风险。
  'cloudflare',
  // _probe/：临时排障脚本（CF 探测等），用完即弃，不进包也不入库。
  '_probe',
  // docs/：产品文档（含导出脚本 scripts/export-product-doc.mjs 生成的 .md）。
  //   它是**给人读的文档**，不是 App 运行时要的东西 —— 进包只会白白增大体积，
  //   而且产品文档里有完整话术表，属于内部资料，不该跟着 APK 外发。
  //   🔴 v1.5.0 踩坑：导出产品文档后忘了归类，build:web 的归类断言直接把 CI 打成红灯
  //      （apk.yml 首步就 build:web，tag 推完 16 秒就红）。新增根级条目必同步这里。
  'docs',
  'server', 'server.cjs', 'package.json', 'package-lock.json',
  'capacitor.config.json', 'README.md', '.assetsignore', 'apk-icons',
  'android-assets', 'assets', 'keystore', 'apk-dist', 'release',
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

/* 版本清单：单一真相源是 server/version.json，这里生成一份静态副本进 www/。
 *
 * 🔴 为什么必须随静态站发布：公开站是**静态托管**（CloudStudio Gateway），没有 Node 后端
 *   ⇒ `/api/version/*` 恒 404。APK 想知道"有没有新版"就只能读这个静态清单。
 *   不生成它 = 更新弹窗永远不会出现，且不会报错——静默失效最难查。
 *
 * 失败一律抛错，不吞：清单缺失属于"发出去也是坏的"，应当在构建期就红。 */
let manifest; // 提到外层：下面生成「安装包稳定别名」时还要用它的 latest_version
try {
  const raw = await readFile(path.join(src, 'server', 'version.json'), 'utf8');
  manifest = JSON.parse(raw);
  if (!manifest.latest_version) throw new Error('latest_version 缺失');
  await writeFile(path.join(out, 'version.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`[build:web] ✓ www/version.json（latest_version=${manifest.latest_version}）`);
} catch (e) {
  console.error('[build:web] ✗ 无法生成 www/version.json：' + (e && e.message));
  console.error('   → 更新检测会静默失效（用户永远看不到「有新版本」）。先修 server/version.json。');
  throw e;
}

/* 安装包暂存：apk-dist/*.apk → www/apk/
 *
 * 🔴 为什么必须做这一步：应用内更新的「立即更新」按钮，最终加载的是
 *     https://xiaoting.app.workbuddy.host/apk/Xiaoting-vX.Y.Z-release.apk
 *   这个地址必须真实存在。v1.1.4 之前它是 404 —— 弹窗弹得出来、按钮点下去却什么都没有，
 *   属于「看起来闭环、实际断在最后一步」的静默失效（同一类问题这个项目已经踩过三次：
 *   更新取数、ASR 取数、SDK 加载）。
 *
 * 为什么放在 apk-dist/ 而不是直接放 www/：www/ 每次构建都被整目录重建，
 *   而且它整个会被 Capacitor 打进 APK —— 安装包套安装包，白白多 3MB+。
 *
 * 🔴 为什么 CI 里要跳过：CI 也跑 build:web（那台机器上的仓库是干净检出，本来就没有
 *   apk-dist；这里显式短路是为了防止将来有人把 apk-dist 提交进仓库后，出包凭空变胖）。
 *   GitHub Actions 自带 CI=true，用它自动区分，不需要额外开关。 */
if (process.env.CI === 'true') {
  console.log('[build:web] · CI 环境：跳过安装包暂存（避免安装包被套进安装包）');
} else {
  const apkSrc = path.join(src, 'apk-dist');
  let apkFiles = [];
  try {
    apkFiles = (await readdir(apkSrc)).filter((n) => n.toLowerCase().endsWith('.apk'));
  } catch (e) {
    console.warn('[build:web] ⚠ 没有 apk-dist/ 目录 ⇒ www/apk/ 为空');
    console.warn('   → 线上 /apk/*.apk 会 404，用户点「立即更新」下不到包。');
    console.warn('   → 发布前请先执行：node scripts/fetch-dist-apk.mjs');
  }
  if (apkFiles.length) {
    await mkdir(path.join(out, 'apk'), { recursive: true });
    for (const f of apkFiles) {
      await cp(path.join(apkSrc, f), path.join(out, 'apk', f));
      const { size } = await stat(path.join(apkSrc, f));
      console.log(`[build:web] ✓ www/apk/${f}（${(size / 1048576).toFixed(2)} MB）`);
    }
    // 稳定别名：`/apk/xiaoting-latest.apk` 永远指向最新版。
    // 为什么要它：应用里给用户的下载入口必须是个**不会过期**的地址 ——
    // 写死版本号的话，下次发版那个链接就指向旧包了（或者干脆没了）。
    const latestApk = `Xiaoting-v${manifest.latest_version}-release.apk`;
    if (apkFiles.includes(latestApk)) {
      await cp(path.join(apkSrc, latestApk), path.join(out, 'apk', 'xiaoting-latest.apk'));
      console.log('[build:web] ✓ www/apk/xiaoting-latest.apk → 指向最新版（稳定别名）');
    } else {
      console.warn(`[build:web] ⚠ apk-dist/ 里没有最新版 ${latestApk} ⇒ 稳定别名没生成`);
      console.warn('   → 站内「下载安卓安装包」会 404。先 node scripts/fetch-dist-apk.mjs 取包。');
    }
  }
}

console.log('[build:web] ✓ www/ 已生成（前端静态资产，不含后端 /api/*）');
