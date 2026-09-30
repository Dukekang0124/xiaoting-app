// 墨小溟 v1.2.0 · IP 状态巡览 + @property 平滑过渡验收（本机 Chrome，截图证据）
// 运行：NODE_PATH=<managed-node-workspace>/node_modules node _selftest/ip-states-tour.cjs
// 前置：先起本地服务（node server.cjs PORT=4191），或本脚本会提示你。
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = process.env.BASE || 'http://127.0.0.1:4191';
const OUT = path.join(__dirname, 'shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const STATES = ['idle', 'listening', 'thinking', 'empathy', 'empathy_tears', 'tender', 'worried', 'happy', 'calm', 'angry', 'anxious'];
const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 480, height: 980 }, deviceScaleFactor: 2 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

  await page.goto(BASE + '/#/say', { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);

  // 动态导入真实 ip.js（站点静态托管，可直接 import）
  await page.evaluate(async () => { window.__ip = await import('/js/ip.js'); });

  // 1) 渲染全部状态到画廊（真实 styles.css + 真实 ip.js + 真实 @property 过渡）
  await page.evaluate((states) => {
    document.body.innerHTML = '';
    const g = document.createElement('div');
    g.id = 'gallery';
    g.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px;justify-content:center;align-items:flex-start;padding:24px;background:#FFF8F0;min-height:100vh';
    for (const s of states) {
      const cell = document.createElement('div');
      cell.dataset.role = 'ipcell';
      cell.dataset.state = s;
      cell.style.cssText = 'width:140px;display:flex;flex-direction:column;align-items:center';
      cell.innerHTML = window.__ip.mascot(s, 130) + `<div style="font-size:12px;color:#8A8A8A;margin-top:2px">${s}</div>`;
      g.appendChild(cell);
    }
    document.body.appendChild(g);
  }, STATES);
  await page.waitForTimeout(900); // 让入场/过渡稳定
  await page.screenshot({ path: path.join(OUT, 'ip-states-tour.png'), fullPage: true });

  // 2) 每个状态类确实落到 svg 上（证明状态机 + CSS 块生效）
  const clsReport = await page.evaluate((states) => {
    return states.map((s) => {
      const cell = document.querySelector(`[data-state="${s}"][data-role="ipcell"]`);
      const svg = cell && cell.querySelector('svg.mascot');
      const cls = svg ? svg.getAttribute('class') : '';
      return { s, ok: !!svg && cls.split(' ').includes('mascot--' + s) };
    });
  }, STATES);
  clsReport.forEach((r) => check(`状态类 mascot--${r.s} 已渲染`, r.ok));

  // 3) angry / anxious 的专属配色生效（证明新增两态不像退化成 idle）
  const colorReport = await page.evaluate(() => {
    const read = (s) => {
      const svg = document.querySelector(`[data-state="${s}"][data-role="ipcell"] svg.mascot`);
      const stop = svg && svg.querySelector('stop');
      return stop ? getComputedStyle(stop).stopColor : '';
    };
    return { idle: read('idle'), angry: read('angry'), anxious: read('anxious'), empathy: read('empathy') };
  });
  check('angry 配色 ≠ idle（暗红）', colorReport.angry && colorReport.angry !== colorReport.idle, `${colorReport.idle} → ${colorReport.angry}`);
  check('anxious 配色 ≠ idle（紫）', colorReport.anxious && colorReport.anxious !== colorReport.idle, `${colorReport.idle} → ${colorReport.anxious}`);
  check('empathy 配色 ≠ idle（暖橙）', colorReport.empathy && colorReport.empathy !== colorReport.idle, `${colorReport.idle} → ${colorReport.empathy}`);

  // 4) @property 平滑过渡：idle→angry 中途的值应介于两者之间（证明不是硬跳变）
  const interp = await page.evaluate(async () => {
    const host = document.createElement('div');
    host.innerHTML = window.__ip.mascot('idle', 160);
    document.body.appendChild(host);
    const svg = host.querySelector('svg.mascot');
    const stop = svg.querySelector('stop');
    const mid = () => getComputedStyle(stop).stopColor;
    const idle = mid();
    svg.classList.remove('mascot--idle');
    svg.classList.add('mascot--angry'); // 触发 .55s 过渡
    await new Promise((r) => setTimeout(r, 250)); // 过渡进行中（未结束）
    const tMid = mid();
    await new Promise((r) => setTimeout(r, 500)); // 过渡结束
    const settled = mid();
    host.remove();
    return { idle, tMid, settled };
  });
  check('@property 过渡中途值介于起止（非硬跳变）',
    interp.tMid && interp.tMid !== interp.idle && interp.tMid !== interp.settled,
    `idle=${interp.idle} 中途=${interp.tMid} 终=${interp.settled}`);

  // 5) 单独高亮截图：angry / anxious（交付物）
  for (const s of ['angry', 'anxious']) {
    await page.evaluate((st) => {
      document.body.innerHTML = '';
      const w = document.createElement('div');
      w.style.cssText = 'display:flex;justify-content:center;align-items:center;height:100vh;background:#FFF8F0';
      w.innerHTML = window.__ip.mascot(st, 220);
      document.body.appendChild(w);
    }, s);
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(OUT, `ip-state-${s}.png`), fullPage: true });
  }

  // 6) 眨眼规则存在（CSS 里有 .mascot--idle .mascot__eyes 的 blink 动画）
  const blinkRule = await page.evaluate(() => {
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
      for (const r of rules) {
        if (r.selectorText && r.selectorText.includes('mascot__eyes') && /ip-blink-eye/.test(r.cssText || '')) return true;
      }
    }
    return false;
  });
  check('待机/倾听眨眼规则 ip-blink-eye 已注册', blinkRule);

  check('页面无运行期 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));

  await browser.close();
  const passed = results.filter(Boolean).length, total = results.length;
  console.log(`\n===== 巡览验收：${passed}/${total} 通过 =====`);
  process.exit(passed === total ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
