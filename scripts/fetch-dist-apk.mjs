// 把 CI 产出的安装包取回本地 apk-dist/，供 `npm run build:web` 暂存进 www/apk/。
//
// 为什么需要它：应用内更新的「立即更新」下载的是
//   https://xiaoting.app.workbuddy.host/apk/Xiaoting-vX.Y.Z-release.apk
// 这个文件必须真的躺在发布的 www/ 里，否则按钮点下去是 404。
// 安装包属于构建产物，不进源码仓库（apk-dist/ 已 gitignore），所以要有个确定的取回路径。
//
// 🔴 为什么不走 git（`git show origin/dist:xxx.apk`）：
//   本机 Node 里 spawn git 一律 EBUSY（execFileSync/execSync 都复现过，
//   2026-09-30 再次实测确认）——是环境问题，不是命令行写法问题。
//   所以取包走 HTTPS，不依赖子进程。
//
// 🔴 为什么是 jsDelivr：2026-09-30 实测三条通道
//   github.com/releases/download/...  → 000（被代理拦）
//   raw.githubusercontent.com/...     → 000（同上）
//   cdn.jsdelivr.net/gh/<repo>@dist/  → 200 ✅（仓库公开，dist 分支可直取）
//   注意 jsDelivr 对同名文件有缓存：换了新文件名（新版本）不受影响，
//   重新推同一个文件名（force push 覆盖）可能拿到旧内容——所以下面必须校验 md5。
//
// 用法：
//   node scripts/fetch-dist-apk.mjs              # 取 server/version.json 里的最新版
//   node scripts/fetch-dist-apk.mjs 1.1.4 1.1.5  # 取指定版本（可多个）
//   GH_REPO=owner/repo 可覆盖仓库（默认见下）

import { mkdir, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'apk-dist');
const REPO = process.env.GH_REPO || 'Dukekang0124/xiaoting-app';

const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(root, 'server', 'version.json'), 'utf8'));
const latest = manifest.latest_version;
const versions = process.argv.slice(2).filter((a) => /^\d+\.\d+\.\d+/.test(a));
if (!versions.length) versions.push(latest);

await mkdir(outDir, { recursive: true });

let bad = 0;
for (const v of versions) {
  const file = `Xiaoting-v${v}-release.apk`;
  const url = `https://cdn.jsdelivr.net/gh/${REPO}@dist/${file}`;
  const dest = path.join(outDir, file);
  process.stdout.write(`[fetch-apk] v${v} ← ${url}\n`);
  let buf;
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error('http_' + res.status);
    buf = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    console.error(`[fetch-apk] ✗ v${v} 下载失败：${(e && e.message) || e}`);
    bad++;
    continue;
  }

  // ① 必须是个 APK（ZIP 魔数 PK\x03\x04）
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) {
    console.error(`[fetch-apk] ✗ v${v} 不是 APK（魔数不符，前 4 字节 ${buf.subarray(0, 4).toString('hex')}）`);
    bad++;
    continue;
  }
  // ② 太大太小都不对（正常 2–8MB）。这条能抓住 jsDelivr 把 HTML 错误页当文件返回的情况。
  if (buf.length < 1_000_000 || buf.length > 20_000_000) {
    console.error(`[fetch-apk] ✗ v${v} 体积异常：${buf.length} 字节`);
    bad++;
    continue;
  }
  const md5 = createHash('md5').update(buf).digest('hex');
  // ③ 最新版必须与 server/version.json 记录一致 —— 这是「线上清单 = 真实安装包」的锚点
  if (v === latest) {
    const expect = (manifest.apk && manifest.apk.md5) || '';
    if (!expect) {
      console.warn(`[fetch-apk] ⚠ v${v} 是 latest 但 server/version.json 的 apk.md5 为空（CI 还没回填？）`);
    } else if (expect !== md5) {
      console.error(`[fetch-apk] ✗ v${v} md5 不一致：清单=${expect} 实际=${md5}（jsDelivr 缓存？或 CI 被覆盖）`);
      bad++;
      continue;
    } else {
      console.log(`[fetch-apk] ✓ v${v} md5 与线上清单一致 ${md5}`);
    }
  }

  await writeFile(dest, buf);
  const { size } = await stat(dest);
  console.log(`[fetch-apk] ✓ ${dest}（${(size / 1048576).toFixed(2)} MB, md5=${md5}）`);
}

if (bad) {
  console.error(`[fetch-apk] ✗ ${bad} 个版本取回失败`);
  process.exit(1);
}
console.log(`[fetch-apk] 完成：${versions.length} 个版本就绪，接下来 npm run build:web 会把它们放进 www/apk/`);
