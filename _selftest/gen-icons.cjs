// 墨小溟 App 图标资源生成（一次性工具，产物提交进仓库）
// 运行：NODE_PATH=<managed-node-workspace>/node_modules node _selftest/gen-icons.cjs
//
// 为什么自己栅格化而不是用 @capacitor/assets：
//   · 该工具 3.0.5 已三年未更新，生成规则（留白/安全区）不可控；
//   · 这里直接按 Capacitor 8 模板的实际尺寸表出图，产物可肉眼验收、可进 git diff。
// 尺寸表（从 @capacitor/cli 8.5.1 的 android-template.tar.gz 里实测得到）：
//   ic_launcher.png / ic_launcher_round.png : 48 72 96 144 192（mdpi→xxxhdpi）
//   ic_launcher_foreground.png              : 108 162 216 324 432（108dp 自适应图标画布）
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CREAM = '#FFF8F0';

/** 墨小溟头部：圆乎乎、大眼睛、两根触角，无嘴（与 IP 契约一致） */
const MASCOT = `
<defs>
  <linearGradient id="bd" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#A794F4"/>
    <stop offset="60%" stop-color="#8B7BE8"/>
    <stop offset="100%" stop-color="#6F5CC8"/>
  </linearGradient>
  <radialGradient id="sh" cx="35%" cy="26%" r="46%">
    <stop offset="0%" stop-color="#FFFFFF" stop-opacity=".38"/>
    <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
  </radialGradient>
</defs>
<g>
  <!-- 触角 + 暖色末端光点（墨小溟的标志） -->
  <path d="M79 70 C71 52 72 36 80 27" fill="none" stroke="#8C78DE" stroke-width="8" stroke-linecap="round"/>
  <path d="M121 70 C129 52 128 36 120 27" fill="none" stroke="#8C78DE" stroke-width="8" stroke-linecap="round"/>
  <circle cx="80" cy="24" r="8" fill="#FFD9A8"/>
  <circle cx="120" cy="24" r="8" fill="#FFD9A8"/>
  <!-- 身体 -->
  <ellipse cx="100" cy="120" rx="70" ry="60" fill="url(#bd)"/>
  <ellipse cx="100" cy="120" rx="70" ry="60" fill="url(#sh)"/>
  <!-- 大眼睛（安静感来自上眼睑柔光，不是靠放大瞳孔） -->
  <ellipse cx="78" cy="114" rx="13.5" ry="15.5" fill="#413B5C"/>
  <ellipse cx="122" cy="114" rx="13.5" ry="15.5" fill="#413B5C"/>
  <circle cx="73.5" cy="107" r="4.6" fill="#FFFFFF"/>
  <circle cx="117.5" cy="107" r="4.6" fill="#FFFFFF"/>
  <circle cx="82" cy="121" r="2.2" fill="#FFFFFF" opacity=".55"/>
  <circle cx="126" cy="121" r="2.2" fill="#FFFFFF" opacity=".55"/>
  <!-- 腮红（很淡，只在浅底上看得出） -->
  <ellipse cx="58" cy="133" rx="9" ry="5" fill="#FFC4A2" opacity=".5"/>
  <ellipse cx="142" cy="133" rx="9" ry="5" fill="#FFC4A2" opacity=".5"/>
</g>`;

/** 生成一张图的 SVG 文档：bg=none|square|round；scale=墨小溟占画布比例 */
const svgDoc = (size, { bg = 'none', scale = 0.78 } = {}) => {
  const k = scale;
  const bgSvg = bg === 'square'
    ? `<rect width="200" height="200" fill="${CREAM}"/>`
    : bg === 'round'
      ? `<circle cx="100" cy="100" r="100" fill="${CREAM}"/>`
      : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 200 200">
  ${bgSvg}
  <g transform="translate(100 100) scale(${k}) translate(-100 -100)">${MASCOT}</g>
</svg>`;
};

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
  const out = (p) => path.join(ROOT, p);
  const ensure = (p) => { const d = path.dirname(out(p)); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); };

  const render = async (file, size, opts) => {
    ensure(file);
    await page.setContent(`<body style="margin:0">${svgDoc(size, opts)}</body>`);
    await page.waitForTimeout(60);
    const el = await page.$('svg');
    await el.screenshot({ path: out(file), omitBackground: opts.bg === 'none' });
    console.log('  →', file, size + 'px');
  };

  const densities = [
    ['mdpi', 48, 108], ['hdpi', 72, 162], ['xhdpi', 96, 216], ['xxhdpi', 144, 324], ['xxxhdpi', 192, 432],
  ];
  console.log('生成 ic_launcher（方形，奶油底）…');
  for (const [d, s] of densities) await render(`android-assets/res/mipmap-${d}/ic_launcher.png`, s, { bg: 'square', scale: 0.74 });
  console.log('生成 ic_launcher_round（圆形，奶油底）…');
  for (const [d, s] of densities) await render(`android-assets/res/mipmap-${d}/ic_launcher_round.png`, s, { bg: 'round', scale: 0.74 });
  console.log('生成 ic_launcher_foreground（透明底 + 安全区留白）…');
  for (const [d, , f] of densities) await render(`android-assets/res/mipmap-${d}/ic_launcher_foreground.png`, f, { bg: 'none', scale: 0.62 });

  // 自适应图标背景色（values/ic_launcher_background.xml）
  ensure('android-assets/res/values/ic_launcher_background.xml');
  fs.writeFileSync(out('android-assets/res/values/ic_launcher_background.xml'),
    `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${CREAM}</color>\n</resources>\n`);
  console.log('  → android-assets/res/values/ic_launcher_background.xml');

  // 顺手出一个 1024 的 PWA/应用商店用大图，便于以后复用
  await render('assets/icon.png', 1024, { bg: 'square', scale: 0.74 });

  await browser.close();
})();
