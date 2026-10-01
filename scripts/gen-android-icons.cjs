// 从 icons/icon.svg 生成 Android 各密度图标（ic_launcher / round / foreground）
// 用法：NODE_PATH=<workspace>/node_modules node scripts/gen-android-icons.cjs
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const NODE_PATH = process.env.NODE_PATH || '';
if (NODE_PATH) module.paths.push(...NODE_PATH.split(path.delimiter));

const ROOT = path.resolve(__dirname, '..');
const SVG = fs.readFileSync(path.join(ROOT, 'icons', 'icon.svg'), 'utf8');
const TMP = path.join(ROOT, '_probe');

const DENSITIES = [
  ['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192],
];
// adaptive icon foreground 画布是 108dp（内容安全区约 66/108）
const FG_SIZES = [
  ['mdpi', 108], ['hdpi', 162], ['xhdpi', 216], ['xxhdpi', 324], ['xxxhdpi', 432],
];

(async () => {
  const b = await chromium.launch({ channel: 'chrome' });

  async function shoot(size, transparent) {
    const p = await b.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    const body = transparent
      ? SVG.replace(/<rect width="1024" height="1024" rx="220" fill="url\(#bg\)"/,
          '<rect width="1024" height="1024" rx="220" fill="none"')   // 去背景，保留墨鱼
      : SVG;
    await p.setContent(`<style>svg{width:${size}px;height:${size}px;display:block}</style>
      <body style="margin:0">${body}</body>`);
    await p.waitForTimeout(400);
    const buf = await p.screenshot({ omitBackground: transparent });
    await p.close();
    return buf;
  }

  console.log('渲染 1024 完整图与透明前景…');
  const fullBuf = await shoot(1024, false);
  const fgBufRaw = await shoot(1024, true);
  fs.writeFileSync(path.join(TMP, 'icon_full_1024.png'), fullBuf);
  fs.writeFileSync(path.join(TMP, 'icon_fg_1024.png'), fgBufRaw);
  await b.close();
  console.log('✅ 源图已渲染');
})();
