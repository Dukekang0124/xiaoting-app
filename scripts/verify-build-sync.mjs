/**
 * 构建同步门禁：证明「源码 ≡ 要发出去的产物」。
 *
 * 🔴 为什么需要它（v1.7.8 的实测现场）：
 *   `js/prompts.js` 源码里有 5 处改动，而 `www/js/prompts.js` 里是 0 处。
 *   自测跑的是 `www/`（server.cjs 的静态根），线上发的也是 `www/`
 *   ⇒ 两边都在跑旧码，而我拿着源码里的修复宣称"已生效"。
 *
 * 🔴 为什么行为断言抓不到：它不看文件是否同源，只看行为，而**旧码的行为同样能过掉大部分断言**。
 *   所以判据必须打在「文件系统同源」上，而不是「行为」上。
 *
 * 双向校验（少一侧就有漏洞）：
 *   正向：www/ 里每个文件都必须能从源码逐字节复现 —— 抓「产物里是旧码 / 是没人要的残留」。
 *   反向：源码里每个该上线的文件都必须出现在 www/ —— 抓「白名单漏项」。
 *   白名单漏项的表现是**页面照常打开、功能静默降级**（动态 import 404），源码目录自测永远发现不了。
 *
 * 唯一真相源：DIRS / FILES 直接从 `scripts/build-web.mjs` 里解析，避免两处各写一份然后漂移。
 *
 * 用法：
 *   本地/CI：node scripts/verify-build-sync.mjs      （漂移则 exit 1）
 *   代码内：  const { verifyBuildSync } = await import('./verify-build-sync.mjs')
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');

/** 产物目录里由构建**生成**的条目（不对应源码文件，天然不该参与比对） */
const GENERATED = new Set(['version.json', 'version-latest.js']);
/** 产物目录里由构建**搬运/生成**的子目录（apk/ 来自 apk-dist/，不比对） */
const GENERATED_DIRS = new Set(['apk']);

/** 从 build-web.mjs 解析 DIRS / FILES（单一真相源，不在这里各写一份） */
export function readAssetManifest(root = ROOT) {
  const src = fs.readFileSync(path.join(root, 'scripts', 'build-web.mjs'), 'utf8');
  const grab = (name, re) => {
    const m = re.exec(src);
    if (!m) throw new Error(`verify-build-sync: 无法从 build-web.mjs 解析 ${name}（构建脚本结构变了？必须同步修本文件，否则这条门禁会静默空转）`);
    return JSON.parse(m[1].replace(/'/g, '"').replace(/,\s*]/g, ']'));
  };
  // 兼容单引号写法：['js', 'icons', 'vendor']
  const DIRS = grab('DIRS', /const\s+DIRS\s*=\s*(\[[^\]]*\])/);
  const FILES = grab('FILES', /const\s+FILES\s*=\s*(\[[^\]]*\])/);
  return { DIRS, FILES };
}

const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } };

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, base, out);
    else out.push(path.relative(base, f).split(path.sep).join('/'));
  }
  return out;
}

/**
 * @returns {{ok:boolean, checked:number, drift:Array<{file:string,kind:string,detail:string}>}}
 */
export function verifyBuildSync(root = ROOT) {
  const webRoot = path.join(root, 'www');
  const drift = [];
  const { DIRS, FILES } = readAssetManifest(root);

  if (!fs.existsSync(webRoot)) {
    return { ok: false, checked: 0, drift: [{ file: 'www/', kind: 'missing-artifact', detail: 'www/ 不存在 —— 先跑 node scripts/build-web.mjs' }] };
  }

  // ── 正向：www/ 里的一切都必须能从源码逐字节复现 ──
  let checked = 0;
  for (const rel of walk(webRoot)) {
    const top = rel.split('/')[0];
    if (GENERATED.has(rel) || GENERATED_DIRS.has(top)) continue;
    const srcPath = path.join(root, rel);
    const outPath = path.join(webRoot, rel);
    if (!isFile(srcPath)) {
      drift.push({ file: rel, kind: 'stale-artifact', detail: '产物里有、源码里已经没有（残留，别再上线）' });
      continue;
    }
    checked++;
    if (md5(srcPath) !== md5(outPath)) drift.push({ file: rel, kind: 'stale-artifact', detail: '产物 ≠ 源码（改了源码没重跑 build:web）' });
  }

  // ── 反向：源码里该上线的每个文件都必须出现在 www/ ──
  for (const d of DIRS) {
    const srcDir = path.join(root, d);
    if (!fs.existsSync(srcDir)) continue;
    for (const rel of walk(srcDir)) {
      const r = `${d}/${rel}`;
      if (!isFile(path.join(webRoot, r))) drift.push({ file: r, kind: 'missing-in-artifact', detail: `源码有、产物缺失（build-web 白名单漏项 ⇒ 线上会 404 并静默降级）` });
    }
  }
  for (const f of FILES) {
    if (isFile(path.join(root, f)) && !isFile(path.join(webRoot, f))) {
      drift.push({ file: f, kind: 'missing-in-artifact', detail: '源码有、产物缺失（build-web 白名单漏项）' });
    }
  }

  return { ok: drift.length === 0, checked, drift };
}

// CLI 入口
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  let r;
  try { r = verifyBuildSync(); } catch (e) { console.error('[build-sync] ✗ ' + e.message); process.exit(2); }
  if (r.ok) {
    console.log(`[build-sync] ✓ 源码 ≡ 产物（${r.checked} 个文件逐字节一致，DIRS/FILES 白名单无漏项）`);
  } else {
    console.error(`[build-sync] ✗ 源码与产物不一致（${r.drift.length} 处）：`);
    r.drift.forEach((d) => console.error(`   - ${d.file}  [${d.kind}] ${d.detail}`));
    console.error('   → 先跑 node scripts/build-web.mjs 再重试。若仍不一致，检查 build-web.mjs 的 DIRS / FILES / EXCLUDE。');
    process.exit(1);
  }
}
