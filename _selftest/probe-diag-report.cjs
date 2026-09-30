/**
 * 验证 v1.4.0 的「一键复制诊断报告」（Task #143）。
 * 判据不是"按钮在"，而是报告文本里**真的含**真机排障需要的五段事实。
 */
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:4177';
let pass = 0, fail = 0;
const check = (n, ok, d) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`); };

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 430, height: 932 }, locale: 'zh-CN', serviceWorkers: 'block',
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  await ctx.addInitScript(() => {
    try { localStorage.setItem('moxiaoming:welcomed_v1', '1'); localStorage.setItem('xiaoting:ai', 'mock'); } catch (e) {}
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));

  await page.goto(`${BASE}/#/diag`, { waitUntil: 'load' });
  await page.waitForSelector('#diagReport', { timeout: 15000 });
  const btnText = await page.textContent('#diagReport');
  check('诊断页存在「一键复制诊断报告」按钮', /诊断报告/.test(btnText || ''), String(btnText).trim());

  await page.click('#diagReport');
  await page.waitForTimeout(4000); // 报告含实时探测（ASR/更新），给足时间

  const log = await page.textContent('#diagLog');
  const must = [
    ['报告头', '真机诊断报告'],
    ['① ASR 能力实测', '语音识别能力（实时探测）'],
    ['① 含插件就位一行', '语音插件是否就位'],
    ['① 含云端通道一行', '云端 ASR 通道'],
    ['① 含结论', '结论：'],
    ['② 录音/识别链路', '最近一次录音与识别链路'],
    ['③ 更新链路', '版本更新链路（实时探测）'],
    ['③ 含本地版本', '本地版本(APP_VERSION)'],
    ['③ 含线上版本', '线上版本'],
    ['③ 含真实失败原因', 'lastError'],
    ['④ 阶段摘要', '各阶段耗时与成败'],
    ['⑤ 原始日志', '条原始日志'],
    ['隐私说明', '不上传任何内容'],
  ];
  for (const [label, needle] of must) {
    check(`报告含【${label}】`, (log || '').includes(needle));
  }

  // 报告里必须能读到真实版本号与页面源（否则用户发来也定位不了）
  const appVer = await page.evaluate(() => window.APP_VERSION);
  check('报告含真实 APP_VERSION', (log || '').includes(appVer), `APP_VERSION=${appVer}`);
  check('报告含页面源', /页面源：https?:\/\//.test(log || ''));

  // 报告长度得够（太短说明某段没生成）
  check('报告长度合理（> 800 字）', (log || '').length > 800, `${(log || '').length} 字`);

  check('无未捕获异常', errs.length === 0, errs.slice(0, 2).join(' | '));

  console.log('\n----- 报告开头 700 字预览 -----');
  console.log((log || '').slice(0, 700));
  console.log(`\n==== ${pass}/${pass + fail} ====`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('异常：', e); process.exit(2); });
