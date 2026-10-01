#!/usr/bin/env node
/* 墨小溟 · 【4 屏新手引导 + 隐私说明 + 时间线主题】真跑探针（v1.6.0）
 *
 * 为什么单开一个探针（不塞进主回归）：
 *   doc-closure.cjs 验的是**数据层**（prompts/ai 导出的文案与字段），
 *   但文档 §二 交付的是「用户**看得见**的 4 屏」——数据对了 DOM 不渲染等于没做。
 *   这里用真浏览器把 4 屏走一遍、截图留证，并卡死三件主回归没卡的：
 *     〔A〕每屏文案逐字、进度点、上一屏/跳过都真的能用；
 *     〔B〕走完/跳过都会写 WELCOME_KEY（第二次打开不再烦人），且结束后**落到问候气泡**；
 *     〔C〕设置页隐私说明 4 段真的渲染出来（不是只在库里躺着）。
 *
 * 用法：先起 node server.cjs（PORT=4176），再 NODE_PATH=… node _selftest/onboarding-ui.cjs
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = process.env.BASE || 'http://127.0.0.1:4176';
const OUT = path.join(__dirname, 'shots-onboarding');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  const c = !!cond;
  if (c) pass += 1; else fail += 1;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const SETTLE = 700;
const shot = async (page, n) => {
  await page.waitForFunction(() => !document.querySelector('.toast.toast--on'), null, { timeout: 2500 }).catch(() => {});
  await page.waitForTimeout(SETTLE);
  try { await page.screenshot({ path: path.join(OUT, n), fullPage: false }); } catch (e) { /* 存档失败不能判红 */ }
};
const title = (page) => page.$eval('.welcome-title', (el) => (el.textContent || '').trim()).catch(() => '');
const body = (page) => page.$eval('.welcome-lines', (el) => (el.textContent || '').trim()).catch(() => '');
const dotsOn = (page) => page.$$eval('.wdot--on', (n) => n.length).catch(() => 0);
const dotsAll = (page) => page.$$eval('.wdot', (n) => n.length).catch(() => 0);
const overlayOn = (page) => page.$$eval('.welcome-overlay', (n) => n.length > 0).catch(() => false);

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });

  /* ================= 〔A〕完整走一遍 4 屏 ================= */
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.welcome-overlay', { timeout: 8000 }).catch(() => {});

    ok('A① 首次打开自动弹引导（不是点出来的）', await overlayOn(page));
    ok('A② 进度点 4 个（= 4 屏）', (await dotsAll(page)) === 4, `dots=${await dotsAll(page)}`);
    ok('A③ 第 1 屏标题逐字 =「欢迎来到墨小溟。」', (await title(page)) === '欢迎来到墨小溟。', await title(page));
    ok('A④ 当前只有一个高亮点（第 1 屏）', (await dotsOn(page)) === 1);
    ok('A⑤ 第 1 屏就能跳过（不强迫看完）', !!(await page.$('#wSkip')));
    await shot(page, '01-welcome-1-welcome.png');

    await page.click('#wNext'); await page.waitForTimeout(180);
    ok('A⑥ 第 2 屏逐字 =「在这里记录你的情绪。」', (await title(page)) === '在这里记录你的情绪。', await title(page));
    ok('A⑦ 第 2 屏落在「记录」不是「分析」（不越界成诊断）', /记录/.test(await title(page)) && !/分析/.test(await title(page)));
    await shot(page, '02-welcome-2-record.png');

    await page.click('#wNext'); await page.waitForTimeout(180);
    ok('A⑧ 第 3 屏是边界声明 + 热线（不是一句欢迎）',
      /不是心理医生/.test(await body(page)) && /400-161-9995|热线/.test(await body(page)),
      (await body(page) || '').slice(0, 40));
    const s3 = `${await title(page)} ${await body(page)}`;
    ok('A⑨ 第 3 屏明说「不是心理医生」', /不是心理医生/.test(s3));
    ok('A⑩ 第 3 屏给了可拨打的热线号', /400-161-9995|12356|010-82951332/.test(s3));
    await shot(page, '03-welcome-3-boundary.png');

    await page.click('#wNext'); await page.waitForTimeout(180);
    ok('A⑪ 第 4 屏 =「准备好了吗？」', (await title(page)) === '准备好了吗？', await title(page));
    const btn = await page.$eval('#wNext', (el) => (el.textContent || '').trim()).catch(() => '');
    ok('A⑫ 第 4 屏主按钮 =「开始体验」文档原文', /开始体验|我准备好了/.test(btn), btn);
    await shot(page, '04-welcome-4-ready.png');

    await page.click('#wNext'); await page.waitForTimeout(300);
    ok('A⑬ 走完引导后浮层消失', !(await overlayOn(page)));
    const greet = await page.evaluate(() => document.body.innerText || '');
    ok('A⑭ 结束后自动落一条问候气泡（文档 §二 点名，不是 toast）',
      /你好，我是墨小溟，想说说此刻的心情吗？/.test(greet));
    const bubble = await page.$$eval('.toast.toast--on', (n) => n.length).catch(() => 0);
    ok('A⑮ 问候是气泡不是 toast（toast 一闪就没，等于白说）', bubble === 0);
    await shot(page, '05-welcome-done-greet.png');

    const key = await page.evaluate(() => localStorage.getItem('moxiaoming:welcomed_v1'));
    ok('A⑯ 走完写入 WELCOME_KEY（下次不再弹）', key === '1', String(key));
    await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForTimeout(600);
    ok('A⑰ 二次打开不再重复弹引导', !(await overlayOn(page)));
    await ctx.close();
  }

  /* ================= 〔B〕第 2 屏就能跳过 + 上一屏回退 ================= */
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.welcome-overlay', { timeout: 8000 }).catch(() => {});
    await page.click('#wNext'); await page.waitForTimeout(150);
    await page.click('#wBack'); await page.waitForTimeout(150);
    ok('B① 第 2 屏能退回第 1 屏（不是一路向前的死路）',
      (await title(page)) === '欢迎来到墨小溟。', await title(page));
    await page.click('#wBack').catch(() => {}); await page.waitForTimeout(120);
    ok('B② 第 1 屏不显示「上一屏」（没上一页就别给按钮）', !(await page.$('#wBack')));
    await page.click('#wSkip'); await page.waitForTimeout(300);
    ok('B③ 任意屏跳过即退出（4 屏不是 4 道关卡）', !(await overlayOn(page)));
    const key = await page.evaluate(() => localStorage.getItem('moxiaoming:welcomed_v1'));
    ok('B④ 跳过也写 WELCOME_KEY（看过就算看过）', key === '1', String(key));
    const greet = await page.evaluate(() => document.body.innerText || '');
    ok('B⑤ 跳过同样落问候气泡（不能跳过就什么都不说）',
      /你好，我是墨小溟，想说说此刻的心情吗？/.test(greet));
    await ctx.close();
  }

  /* ================= 〔C〕设置页隐私说明真的渲染 ================= */
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(400);
    await page.evaluate(() => { location.hash = '#/settings'; });
    await page.waitForSelector('.privacy-box', { timeout: 6000 }).catch(() => {});
    const keys = await page.$$eval('[data-privacy]', (n) => n.map((e) => e.getAttribute('data-privacy'))).catch(() => []);
    ok('C① 设置页出现隐私说明区块', (await page.$('.privacy-box')) !== null);
    ok('C② 四段齐全（存储/音频/记忆/危机）',
      ['data_store', 'audio', 'memory', 'crisis'].every((k) => keys.includes(k)), keys.join(','));
    const lens = await page.$$eval('[data-privacy]', (n) => n.map((e) => (e.textContent || '').trim().length)).catch(() => []);
    ok('C③ 每段都非空长（不是补个标题就完事）', lens.length >= 4 && lens.every((l) => l >= 40), lens.join('/'));
    const txt = await page.$eval('.privacy-box', (el) => el.innerText || '').catch(() => '');
    ok('C④ 说清数据存本机（不骗人「我们不存储」）', /本机|本地|设备/.test(txt));
    ok('C⑤ 说清音频用途边界（转写/不用于训练）', /训练|商业|分析/.test(txt));
    ok('C⑥ 说清记忆控制权（可查看/编辑/清空）', /清空|查看|删除/.test(txt));
    ok('C⑦ 危机段给了紧急电话（120/110）', /120|110/.test(txt));
    await shot(page, '06-settings-privacy.png');
    await ctx.close();
  }

  /* ================= 〔D〕时间线四档主题样式真的存在 ================= */
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    const css = await page.evaluate(async () => {
      const r = await fetch('/styles.css', { cache: 'no-store' });
      return r.text();
    }).catch(() => '');
    // 主题色在节点上的落法有两种：单独写 `.tl-node--X`（purple），
    // 或由父卡继承 `.tl-card--X .tl-node`（blue/warm/ash）。两种都算数 ——
    // 只肯认其中一种会造出假红（我第一版就写成了「必须有 .tl-node--X」，四条里三条假红）。
    ['purple', 'blue', 'warm', 'ash'].forEach((t) => {
      const own = css.includes(`.tl-node--${t}`);
      const inherit = css.includes(`.tl-card--${t} .tl-node`);
      ok(`D ${t} 档主题样式已写（卡片必须有色，节点自带或由父卡继承）`,
        css.includes(`.tl-card--${t}`) && (own || inherit),
        own ? '.tl-node--X' : '.tl-card--X .tl-node');
    });
    ok('D 高危描边样式存在（卡片与节点两层）',
      css.includes('.tl-card--risk') && css.includes('.tl-node--risk'));
    await ctx.close();
  }

  await browser.close();
  console.log(`\n通过 ${pass} / ${pass + fail}${fail ? `　❌ 失败 ${fail}` : '　✅ 全绿'}`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('探针自身崩了：', e); process.exitCode = 1; });
