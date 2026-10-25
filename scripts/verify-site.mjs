/* 墨小溟官网 · 上线前验证门禁（可重复运行）
 *
 * 用法：
 *   NODE_PATH=<受管 node workspace>/node_modules node scripts/verify-site.mjs
 *
 * 它做三件事：
 *   ① 静态一致性：6 页 SEO head 唯一完整 / h1 唯一 / 内链(含锚点)可达 / og 图存在 / 关键对比度数学复核
 *   ② 自起零依赖静态服务（serve 仓库根），Playwright 驱动**本机 Chrome** 真跑 6 页 × 2 视口：
 *      200 / 零控制台错误 / 无横向溢出 / h1 唯一 / reveal 不卡隐藏 / 正文有内容
 *   ③ 禁 JS：内容默认可见（html 无 .js 类、h1 可见、正文有内容）
 * 另：桌面 / 移动 / 移动菜单展开 三张截图写入 docs/官网-截图/。
 *
 * 设计约束（对齐本仓「判据素养」）：
 *   · 判据打在消费方：验证的是"页面真跑起来的样子"，不是"文件里有没有这个词"。
 *   · 假绿防线：禁 JS 分支单独测（证明内容不靠脚本才可见），reveal 兜底单独测（证明不卡隐藏）。
 *   · 可移植：不写死本机绝对路径（脚本自带静态服务，不依赖外部 python）。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');       // 仓库根（dev 静态服务的根）
const SITE = path.join(ROOT, 'site');
const SHOTS = path.join(ROOT, 'docs', '官网-截图');
const PAGES = ['index.html', 'features.html', 'scenarios.html', 'pricing.html', 'about.html', 'contact.html'];
const BASE = 'https://xiaoting.app.workbuddy.host/site/';

let fails = 0, checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { fails++; console.log('  ❌ ' + msg); } else console.log('  ✅ ' + msg); };

/* ---------- ① 静态一致性 ---------- */
console.log('\n== ① 静态一致性 ==');
const titles = new Set();
for (const p of PAGES) {
  const file = path.join(SITE, p);
  ok(fs.existsSync(file), `${p} 存在`);
  const html = fs.readFileSync(file, 'utf8');
  const title = (html.match(/<title>([^<]+)<\/title>/) || [])[1];
  ok(!!title, `${p} 有 title`);
  if (title) titles.add(title);
  ok(/<meta name="description" content="[^"]{20,}"\s*\/>/.test(html), `${p} 有 meta description(≥20字)`);
  ok(html.includes(`<link rel="canonical" href="${BASE}${p === 'index.html' ? '' : p}"/>`), `${p} canonical 正确`);
  ok(/property="og:title"/.test(html) && /property="og:description"/.test(html) && /property="og:image"/.test(html), `${p} og 三件套`);
  ok((html.match(/<h1[\s>]/g) || []).length === 1, `${p} 恰好一个 h1`);
  ok(html.includes('site.css') && html.includes('site.js'), `${p} 引共享样式/脚本`);
}
ok(titles.size === PAGES.length, `title 全站唯一（${titles.size}/${PAGES.length}）`);
ok(fs.existsSync(path.join(SITE, 'assets/og-cover.jpg')), 'og-cover.jpg 存在');

console.log('-- 内链可达性 --');
const linked = new Set();
for (const p of PAGES) {
  const html = fs.readFileSync(path.join(SITE, p), 'utf8');
  for (const m of html.matchAll(/href="([^"]+)"/g)) {
    const href = m[1];
    if (/^(https?:|#|tel:|mailto:)/.test(href)) continue;
    linked.add(href);
  }
}
for (const href of linked) {
  const [filePart, hash] = href.split('#');
  const target = path.normalize(path.join(SITE, filePart));
  ok(fs.existsSync(target), `内链可达 ${href}`);
  if (hash) ok(fs.readFileSync(target, 'utf8').includes(`id="${hash}"`), `锚点存在 ${href} (#${hash})`);
}

console.log('-- 对比度复核 (WCAG AA) --');
const lum = (hex) => {
  const c = hex.replace('#', '');
  return [0, 2, 4].map(i => parseInt(c.slice(i, i + 2), 16) / 255)
    .map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
    .reduce((acc, v, i) => acc + [0.2126, 0.7152, 0.0722][i] * v, 0);
};
const contrast = (fg, bg) => { const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x); return (a + 0.05) / (b + 0.05); };
const pairs = [
  ['正文 ink/bg', '#3A3A3A', '#FFF8F0', 4.5],
  ['次文 ink-2/bg', '#6B6478', '#FFF8F0', 4.5],
  ['弱文 ink-3/bg', '#726C84', '#FFFBF7', 4.5],
  ['按钮白字/浅端', '#FFFFFF', '#7764C4', 4.5],
  ['按钮白字/深端', '#FFFFFF', '#5744A8', 4.5],
  ['品牌紫字/浅紫底', '#6E5CB8', '#F3EDFF', 4.5],
  ['品牌紫字/页面底', '#6E5CB8', '#FFF8F0', 4.5],
  ['徽章绿字/薄荷底', '#1F4A3A', '#A8D8C8', 4.5],
  ['页脚白字/紫底', '#FFFFFF', '#5744A8', 4.5],
  ['图标绿/浅绿底', '#2E6B55', '#EAF6F1', 3.0],
  ['图标蓝/浅蓝底', '#2E5A78', '#EAF1F8', 3.0],
  ['图标橙/浅橙底', '#A85E3A', '#FBEFE7', 3.0],
];
for (const [name, fg, bg, min] of pairs) ok(contrast(fg, bg) >= min, `${name}: ${contrast(fg, bg).toFixed(2)}:1 ≥ ${min}:1`);

/* ---------- 自起零依赖静态服务 ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8' };
function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      if (p.endsWith('/')) p += 'index.html';
      const abs = path.normalize(path.join(ROOT, p));
      if (!abs.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
      fs.readFile(abs, (err, buf) => {
        if (err) { res.writeHead(404); return res.end('404'); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream' });
        res.end(buf);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

/* ---------- ②③ 真跑 ---------- */
(async () => {
  const srv = await startServer();
  const port = srv.address().port;
  const origin = `http://127.0.0.1:${port}`;
  console.log(`\n== ②③ Playwright 真跑（内置静态服务 ${origin}/site/） ==`);
  const browser = await chromium.launch({ channel: 'chrome' });
  const vps = [{ name: 'desktop', width: 1280, height: 800 }, { name: 'mobile', width: 375, height: 812 }];
  for (const vp of vps) {
    for (const p of PAGES) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const page = await ctx.newPage();
      const errs = [];
      page.on('pageerror', e => errs.push('pageerror: ' + e.message));
      page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
      const resp = await page.goto(`${origin}/site/${p}`, { waitUntil: 'load' });
      ok(resp.status() === 200, `[${vp.name}] ${p} HTTP 200`);
      await page.waitForTimeout(2000);
      const st = await page.evaluate(() => ({
        h1: document.querySelectorAll('h1').length,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        stuck: [...document.querySelectorAll('.reveal')].filter(el => !el.classList.contains('is-visible')).length,
        textLen: document.body.innerText.length,
      }));
      ok(st.h1 === 1, `[${vp.name}] ${p} h1 唯一`);
      ok(st.overflow <= 1, `[${vp.name}] ${p} 无横向溢出 (delta=${st.overflow})`);
      ok(st.stuck === 0, `[${vp.name}] ${p} reveal 无卡隐藏 (${st.stuck})`);
      ok(st.textLen > 300, `[${vp.name}] ${p} 正文有内容 (${st.textLen})`);
      // 🔴 品牌 IP 图必须真的加载出来：<img> 加载失败不产生 console error ⇒ 只测"无错误"会假绿。
      const img = await page.evaluate(() => {
        const els = [...document.querySelectorAll('img[src$="moxiaoming.svg"]')];
        return { count: els.length, broken: els.filter(e => !(e.complete && e.naturalWidth > 0)).length };
      });
      ok(img.count > 0 && img.broken === 0, `[${vp.name}] ${p} IP 图加载成功 (${img.count} 张, 坏 ${img.broken})`);
      if (errs.length) { fails++; console.log(`  ❌ [${vp.name}] ${p} 页面错误: ${errs.join(' | ')}`); }
      else { checks++; console.log(`  ✅ [${vp.name}] ${p} 零控制台错误`); }
      await ctx.close();
    }
  }
  console.log('-- 禁 JS 内容可见 --');
  for (const p of PAGES) {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, javaScriptEnabled: false });
    const page = await ctx.newPage();
    await page.goto(`${origin}/site/${p}`, { waitUntil: 'load' });
    const st = await page.evaluate(() => ({
      js: document.documentElement.classList.contains('js'),
      h1Visible: (() => { const h = document.querySelector('h1'); if (!h) return false; const s = getComputedStyle(h); return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0.9; })(),
      textLen: document.body.innerText.length,
    }));
    ok(!st.js, `[noJS] ${p} 无 .js 类（默认可见路径）`);
    ok(st.h1Visible, `[noJS] ${p} h1 可见`);
    ok(st.textLen > 300, `[noJS] ${p} 正文有内容 (${st.textLen})`);
    await ctx.close();
  }
  /* 截图（写入 docs/，不进部署） */
  fs.mkdirSync(SHOTS, { recursive: true });
  const d = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const dp = await d.newPage();
  await dp.goto(`${origin}/site/`, { waitUntil: 'networkidle' });
  await dp.waitForTimeout(2100);
  await dp.screenshot({ path: path.join(SHOTS, 'home-desktop.png'), fullPage: true });
  await d.close();
  const m = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const mp = await m.newPage();
  await mp.goto(`${origin}/site/`, { waitUntil: 'networkidle' });
  await mp.waitForTimeout(2100);
  await mp.screenshot({ path: path.join(SHOTS, 'home-mobile.png'), fullPage: true });
  await mp.click('.nav__burger');
  await mp.waitForTimeout(400);
  const menuOpen = await mp.evaluate(() => getComputedStyle(document.querySelector('.nav__menu')).display !== 'none');
  ok(menuOpen, '移动菜单点击后展开');
  await mp.screenshot({ path: path.join(SHOTS, 'home-mobile-menu.png') });
  await m.close();
  console.log('截图已存 docs/官网-截图/');

  await browser.close();
  srv.close();
  console.log(`\n== 结果：${checks - fails}/${checks} 通过，${fails} 失败 ==`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
