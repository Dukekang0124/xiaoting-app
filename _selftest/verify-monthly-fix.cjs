// 验证：月度复盘卡（timelineBody）不再把开发注释渲染成可见文本。
// 直接导入「真实构建产物」www/js/app.js 的 __test__ 导出，调用真实渲染函数，
// 用月度复盘卡的真实入参渲染，断言：(a) 不漏出开发注释；(b) 正确显示「高频情绪 N」；
// (c) 无 node_label 时兜底「第 N 段」且同样不漏字。
const { chromium } = require('playwright-core');
const BASE = process.env.BASE || 'http://localhost:8137';

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console:' + m.text()); });

  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  // 等 app.js 模块加载完成（index.html 以 module 方式 import 了它）
  await page.waitForFunction(() => !!window.__tbReady || document.querySelector('#view'), { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(600);

  const result = await page.evaluate(async () => {
    const m = await import('/js/app.js');
    const t = m.__test__;
    if (!t || !t.monthlyCardView || !t.timelineBody) {
      return { ok: false, reason: 'missing exports (monthlyCardView/timelineBody)' };
    }
    // 月度复盘卡的真实入参形状（来自 monthly.buildMonthlyReview 的输出）
    const rev = {
      top_emotion_tags: ['愤怒 + 疲惫', '焦虑', '委屈'],
      card_id: 'emo_month_202610',
      create_time: Date.now(),
      target_month: '2026-10',
      record_count: 5,
      emotion_trend_desc: '这个月情绪起伏较大',
      insight_text: '你比想象中更坚韧',
      monthly_tip: '给自己一点温柔',
      timeline_group: 'monthly',
      card_theme: 'purple',
    };
    const view = t.monthlyCardView(rev);
    const html = t.timelineBody(view);
    // 兜底情形：节点没有 node_label（普通倾诉时间线）也应不漏字，并显示「第 N 段」
    const html2 = t.timelineBody({
      timeline_list: [{ node_index: 1, emotion_text: '愤怒', desc_text: '今天因为我没带钥匙 多花了钱' }],
      nodes: [],
    });
    return {
      ok: true,
      leakInMonthly: html.includes('node_label：可选'),
      hasHighFreq: html.includes('高频情绪 1') && html.includes('高频情绪 2'),
      leakInFallback: html2.includes('node_label：可选'),
      hasFallbackLabel: html2.includes('第 1 段'),
    };
  });

  console.log(JSON.stringify({ result, errors }, null, 2));
  await browser.close();

  const pass = result.ok
    && !result.leakInMonthly
    && result.hasHighFreq
    && !result.leakInFallback
    && result.hasFallbackLabel
    && errors.length === 0;
  console.log(pass ? 'VERIFY_MONTHLY_FIX: PASS' : 'VERIFY_MONTHLY_FIX: FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
