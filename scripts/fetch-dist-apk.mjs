// 把 CI 产出的安装包取回本地 apk-dist/，供 `npm run build:web` 暂存进 www/apk/。
//
// 为什么需要它：应用内更新的「立即更新」下载的是
//   https://xiaoting.app.workbuddy.host/apk/Xiaoting-vX.Y.Z-release.apk
// 这个文件必须真的躺在发布的 www/ 里，否则按钮点下去是 404。
// 安装包属于构建产物，不进源码仓库（apk-dist/ 已 gitignore），所以要有个确定的取回路径。
//
// ── 通道实测（2026-09-30，本机）────────────────────────────────────────────
//   github.com/.../releases/download/...    → 000（被拦）
//   raw.githubusercontent.com/...           → 000（被拦）
//   cdn / gcore.jsdelivr.net/gh/<repo>@dist → 200 ✅（gcore 更稳）
//   git 协议（git fetch / git show）         → ✅ 最可靠，且不依赖第三方
//
// 🔴 两个必须知道的坑：
//   ① jsDelivr 对**冷缓存**的 gh 文件会 301 跳到 raw.githubusercontent.com（被拦），
//      而且这个 301 会被缓存住（max-age=604800）。刚推完 dist 立刻取，很容易撞上。
//      对策：多镜像轮询 + 退避重试；实在不行走 git（见下面的兜底提示）。
//   ② **本机 Node 里没法 spawn 任何子进程**（实测连 `node --version` 都 EBUSY），
//      所以这个脚本不能 shell out 去调 git —— 取包只能走 HTTPS，
//      取不到时把 git 命令**打印给用户**手工跑。
//
// 用法：
//   node scripts/fetch-dist-apk.mjs              # 取 server/version.json 里的最新版
//   node scripts/fetch-dist-apk.mjs 1.1.4 1.1.5  # 取指定版本（可多个）
//   GH_REPO=owner/repo 覆盖仓库（默认见下）

import { mkdir, writeFile, stat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'apk-dist');
const REPO = process.env.GH_REPO || 'Dukekang0124/xiaoting-app';
const BRANCH = process.env.GH_BRANCH || 'dist';

// gcore 放最前：实测对新文件它更少走 301
const MIRRORS = [
  'https://gcore.jsdelivr.net/gh/',
  'https://cdn.jsdelivr.net/gh/',
  'https://fastly.jsdelivr.net/gh/',
];

const manifest = JSON.parse(await readFile(path.join(root, 'server', 'version.json'), 'utf8'));
const latest = manifest.latest_version;
const versions = process.argv.slice(2).filter((a) => /^\d+\.\d+\.\d+/.test(a));
if (!versions.length) versions.push(latest);

await mkdir(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询所有镜像 + 重试；返回 {buf, via} 或 null。
 *  redirect:'follow' 后若最终落在 raw.githubusercontent 视为失败（那条通道本机不通）。 */
async function download(file) {
  let lastErr = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    for (const base of MIRRORS) {
      const url = `${base}${REPO}@${BRANCH}/${file}`;
      const host = url.split('/')[2];
      try {
        const res = await fetch(url, { redirect: 'follow' });
        if (res.url && res.url.includes('raw.githubusercontent.com')) {
          lastErr = `${host}: 301→raw.githubusercontent（被拦，多因 CDN 冷缓存）`;
          continue;
        }
        if (!res.ok) { lastErr = `${host}: http_${res.status}`; continue; }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50) return { buf, via: host };
        lastErr = `${host}: 返回的不是 APK（前 4 字节 ${buf.subarray(0, 4).toString('hex')}）`;
      } catch (e) {
        let c = e.cause, msg = e.message;
        while (c) { msg = `${c.code || ''} ${c.message || c}`.trim(); c = c.cause; }
        lastErr = `${host}: ${msg}`;
      }
    }
    if (attempt < 2) await sleep(2500); // 冷缓存要几秒让 CDN 回源，重试一次通常就通了
  }
  console.warn(`[fetch-apk] ⚠ ${file} 所有镜像都没取到：${lastErr}`);
  return null;
}

let bad = 0;
for (const v of versions) {
  const file = `Xiaoting-v${v}-release.apk`;
  const dest = path.join(outDir, file);
  process.stdout.write(`[fetch-apk] v${v} 取包中…\n`);

  let buf = null;
  let via = '';
  const got = await download(file);
  if (got) { buf = got.buf; via = got.via; }

  // HTTPS 全挂时：若本地已有该文件，就用手上这份（仍要通过下面全部校验才算数）
  if (!buf) {
    try {
      const existed = await readFile(dest);
      console.warn(`[fetch-apk] ↷ 改用本地已有的 apk-dist/${file}（${(existed.length / 1048576).toFixed(2)} MB）——校验不过就作废`);
      buf = existed;
      via = 'local-existing';
    } catch (e) {
      bad++;
      console.error(`[fetch-apk] ✗ v${v} 取不到，本地也没有。请手工用 git 兜底（本机 Node 无法调子进程）：`);
      console.error(`    git fetch origin ${BRANCH}`);
      console.error(`    git show origin/${BRANCH}:${file} > apk-dist/${file}`);
      continue;
    }
  }

  const md5 = createHash('md5').update(buf).digest('hex');
  const size = buf.length;

  if (size < 1_000_000 || size > 20_000_000) {
    bad++;
    console.error(`[fetch-apk] ✗ v${v} 体积异常：${size} 字节`);
    continue;
  }
  // 最新版必须与 server/version.json 记录一致 —— 这是「线上清单 = 真实安装包」的锚点。
  // 该 md5 由 CI 出包后写进 git，是一条**独立于下载通道**的可信参照，所以这条校验有意义。
  if (v === latest) {
    const expect = (manifest.apk && manifest.apk.md5) || '';
    if (!expect) {
      console.warn(`[fetch-apk] ⚠ v${v} 是 latest 但 server/version.json 的 apk.md5 为空（CI 还没回填？）`);
    } else if (expect !== md5) {
      bad++;
      console.error(`[fetch-apk] ✗ v${v} md5 不一致：清单=${expect} 实际=${md5}`);
      continue;
    } else {
      console.log(`[fetch-apk] ✓ v${v} md5 与清单一致 ${md5}`);
    }
  }

  await writeFile(dest, buf);
  const { size: onDisk } = await stat(dest);
  console.log(`[fetch-apk] ✓ ${file}（${(onDisk / 1048576).toFixed(2)} MB, md5=${md5}, 来源=${via}）`);
}

if (bad) {
  console.error(`[fetch-apk] ✗ ${bad} 个版本失败`);
  process.exit(1);
}
console.log(`[fetch-apk] 完成：${versions.length} 个版本就绪 → npm run build:web 会把它们放进 www/apk/`);
