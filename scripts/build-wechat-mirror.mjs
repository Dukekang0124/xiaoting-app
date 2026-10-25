/* 把 site/ 下的多页官网汇编成「单文件微信版」（供资料库页面托管 / 微信内打开）
 *
 * 为什么需要它：
 *   WorkBuddy 发布的应用域名形如 <随机>.workbuddy.host，**微信判定其有风险并拦截（403 拦截页）**。
 *   而「资料库页面」的公开链接（workbuddy.link/p/xxx）微信内可正常访问 ⇒ 需要一份能塞进资料库
 *   单页托管的自包含 HTML。本脚本从 site/ 源文件汇编，保证与官网内容同源、不手抄漂移。
 *
 * 用法：node scripts/build-wechat-mirror.mjs
 * 产物：docs/墨小溟-官网-微信版.html（1 个 h1、6 段、内联 CSS/JS、IP 图内联为 data-URI、无第三方图片外链）
 * 之后：上传该文件到资料库（LibraryUpload，kind=web）→ publish_page.py 发布拿 workbuddy.link 链接。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'site');
const OUT = path.join(ROOT, 'docs', '墨小溟-官网-微信版.html');

const css = fs.readFileSync(path.join(SITE, 'site.css'), 'utf8');
const js = fs.readFileSync(path.join(SITE, 'site.js'), 'utf8');
const svg = fs.readFileSync(path.join(SITE, 'assets', 'moxiaoming.svg'), 'utf8');
const svgUri = 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');

const PAGES = [
  { file: 'index.html', id: 'home', label: '首页' },
  { file: 'features.html', id: 'features', label: '功能与优势' },
  { file: 'scenarios.html', id: 'scenarios', label: '使用场景' },
  { file: 'pricing.html', id: 'pricing', label: '价格方案' },
  { file: 'about.html', id: 'about', label: '关于我们' },
  { file: 'contact.html', id: 'contact', label: '联系方式' },
];

const fixLinks = (h) => h
  .replace(/src="assets\/moxiaoming\.svg"/g, `src="${svgUri}"`)
  .replace(/href="index\.html"/g, 'href="#home"')
  .replace(/href="features\.html"/g, 'href="#features"')
  .replace(/href="scenarios\.html"/g, 'href="#scenarios"')
  .replace(/href="pricing\.html"/g, 'href="#pricing"')
  .replace(/href="about\.html#privacy"/g, 'href="#privacy"')
  .replace(/href="about\.html"/g, 'href="#about"')
  .replace(/href="contact\.html#crisis"/g, 'href="#crisis"')
  .replace(/href="contact\.html"/g, 'href="#contact"');

let sections = '';
for (const p of PAGES) {
  const src = fs.readFileSync(path.join(SITE, p.file), 'utf8');
  let main = (src.match(/<main>([\s\S]*?)<\/main>/) || [])[1];
  if (!main) throw new Error('no <main> in ' + p.file);
  main = fixLinks(main);
  if (p.id !== 'home') main = main.replace(/<h1(\s|>)/g, '<h2$1').replace(/<\/h1>/g, '</h2>');
  sections += `\n<div class="wp-section" id="${p.id}">${main}</div>\n`;
}

const nav = PAGES.map((p, i) =>
  `<a class="nav__link${i === 0 ? ' nav__link--active' : ''}" href="#${p.id}">${p.label}</a>`).join('\n      ');

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
<title>墨小溟 · 说出来，就轻一点</title>
<meta name="description" content="墨小溟是一款会追问、会记住、不评判的语音情绪复盘教练。只一个动作：按住说。本地优先、免费、不诊断，把情绪轻轻接住。"/>
<meta name="theme-color" content="#FFF8F0"/>
<style>
${css}
.wp-section{ scroll-margin-top: calc(var(--header-h) + 8px); }
.wp-section + .wp-section{ border-top: 1px solid var(--line); }
.nav__menu{ flex-wrap: wrap; }
</style>
<script>document.documentElement.classList.add('js');</script>
</head>
<body>
<header class="site-header">
  <div class="container nav">
    <a class="brand" href="#home" aria-label="墨小溟首页">
      <img class="brand__mark" src="${svgUri}" alt="" width="34" height="34"/>
      <span class="brand__name">墨小溟<small>情绪倾诉陪伴</small></span>
    </a>
    <span class="nav__spacer"></span>
    <input type="checkbox" id="navtoggle" class="nav__cb"/>
    <label for="navtoggle" class="nav__burger" aria-label="展开菜单"><span></span></label>
    <nav class="nav__menu" aria-label="主导航">
      ${nav}
      <a class="btn btn--primary nav__cta" href="https://xiaoting.app.workbuddy.host" target="_blank" rel="noopener">打开应用</a>
    </nav>
  </div>
</header>

<main>
${sections}
</main>

<footer class="site-footer">
  <div class="container">
    <div class="footer-grid">
      <div class="footer-brand">
        <div class="footer-brand__name">
          <img width="28" height="28" src="${svgUri}" alt=""/> 墨小溟
        </div>
        <p>一只会追问、会记住、不评判的紫色小墨鱼。说出来，就轻一点。</p>
      </div>
      <div class="footer-col"><h4>产品</h4><ul><li><a href="#features">功能与优势</a></li><li><a href="#scenarios">使用场景</a></li><li><a href="#pricing">价格方案</a></li><li><a href="https://xiaoting.app.workbuddy.host" target="_blank" rel="noopener">打开应用</a></li></ul></div>
      <div class="footer-col"><h4>关于</h4><ul><li><a href="#about">关于我们</a></li><li><a href="#contact">联系方式</a></li><li><a href="https://github.com/Dukekang0124/xiaoting-app/issues" target="_blank" rel="noopener">意见反馈</a></li></ul></div>
      <div class="footer-col"><h4>支持</h4><ul><li><a href="#crisis">心理援助热线</a></li><li><a href="#privacy">隐私说明</a></li><li><a href="https://xiaoting.app.workbuddy.host/apk/xiaoting-latest.apk" target="_blank" rel="noopener">下载 APK</a></li></ul></div>
    </div>
    <div class="footer-bottom"><span>© <span id="year">2026</span> 墨小溟 · 情绪倾诉陪伴</span><span>本产品不提供心理诊疗、诊断或治疗方案。</span></div>
  </div>
</footer>

<script>
${js}
</script>
</body>
</html>
`;

fs.writeFileSync(OUT, html);
console.log('✓ 微信版单文件已生成:', path.relative(ROOT, OUT));
console.log('  字节数:', fs.statSync(OUT).size, '| h1:', (html.match(/<h1[\s>]/g) || []).length,
  '| 残留页内链接:', (html.match(/\.html["#]/g) || []).length);
