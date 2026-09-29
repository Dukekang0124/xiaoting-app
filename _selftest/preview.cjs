// 墨小溟 · 视觉快速预览（迭代视觉用，不做断言）
// 运行：NODE_PATH=<managed-node-workspace>/node_modules node _selftest/preview.cjs [页面...]
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = process.env.BASE || 'http://127.0.0.1:4173';
const SETTLE = Number(process.env.SETTLE || 900);
const OUT = path.join(__dirname, 'shots', 'preview');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

// 造一张卡片（不经过 AI 流程，直接写 localStorage）以便预览列表/详情页
const CARD = {
  id: 'c_demo1', created_at: new Date().toISOString(),
  title: '又和男朋友吵架，让我觉得不被重视',
  event: '他很晚才回我消息', emotion: ['委屈', '愤怒'], intensity: 8,
  body: ['胸口发紧', '眼眶发热'], thought: '他根本不在乎我',
  need: ['被重视', '被看见'], behavior: '我发了很长一段消息', result: '他没回，我更难受',
  pattern: '读心', experiment: '下次先说出"我需要你回应我"', summary: '你不是太敏感，你只是很在意。',
  tags: ['亲密关系', '不被重视'], ip_state: 'empathy',
};

const SEED = {
  cards: [CARD],
  // 确认页/追问页需要草稿
  draft: {
    recordId: 'r_demo', transcript: '今天又和男朋友吵架了，他很晚才回我消息，我觉得他根本不在乎我。',
    safety: { level: 'none', action: 'continue', hit: [], evidence: '' },
    analysis: {
      event: '他很晚才回我消息', emotion: ['委屈', '愤怒'], intensity: 8,
      body: ['胸口发紧'], thought: '他根本不在乎我', need: ['被重视'],
      behavior: '我发了很长一段消息', result: '他没回',
      pattern: '读心', experiment: '先说出我需要你回应我',
      summary: '你不是太敏感，你只是很在意。', needs_followup: true,
    },
    asked: ['这件事里，你最希望他当时做什么？'],
    currentQuestion: '如果他知道你其实是想被回应，你觉得他会怎么反应？',
    empathy: '这种感觉，真的挺委屈的。',
    card: CARD,
    round: 1, createdAt: Date.now(),
  },
  user: { id: 'local-user', nickname: '', createdAt: Date.now(), settings: { autoDeleteAudio: true, ttsHint: true, cloudAsr: true } },
  risk: { level: 'none', action: 'continue', hit: false, evidence: '' },
};

const ALL = [
  ['01-home', '#/say', false],
  ['02-cards-empty', '#/cards', false],
  ['03-me', '#/me', false],
  ['04-cards', '#/cards', true],
  ['05-card-detail', '#/card/c_demo1', true],
  ['06-followup', '#/followup', true],
  ['07-confirm', '#/confirm', true],
  ['08-risk', '#/risk?level=high', false],
  ['09-emergency', '#/risk?level=critical', false],
  ['10-gentle', '#/gentle', false],
  ['11-record', '#/record?mode=text', false],
];

// 命令行按名字过滤：node preview.cjs 01-home 03-me（不给就全跑）
const argv = process.argv.slice(2);
const ROUTES = argv.length
  ? ALL.filter((r) => argv.some((a) => r[0].includes(a) || r[1].includes(a)))
  : ALL;
if (!ROUTES.length) { console.error('没匹配到页面，可用：' + ALL.map((r) => r[0]).join(', ')); process.exit(1); }

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
    locale: 'zh-CN', isMobile: true, hasTouch: true,
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  for (const [name, hash, seeded] of ROUTES) {
    // 注意：先导航到目标 URL，写好 localStorage 后 **reload**。
    // 不能靠"再 goto 一次只改 hash"——那是同文档导航，浏览器不重新加载，store 不会重读 localStorage。
    await page.goto(`${BASE}/index.html?p=${encodeURIComponent(name)}${hash}`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((s) => {
      localStorage.setItem('xiaoting:v1', JSON.stringify(s));
    }, seeded ? SEED : { ...SEED, cards: [] });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(SETTLE);
    // 长截图：固定层（底部 Tab / toast）会停在视口位置压住正文 ⇒ 截图期间改为静态
    await page.evaluate(() => {
      const s = document.createElement('style'); s.id = '__shotfix';
      // margin:auto 会取消防伸缩（stretch）⇒ 静态化后必须显式 width:100% + margin:0，否则 Tab 被压成竖排
      s.textContent = '.tabbar{position:static !important;margin:0 !important;width:100% !important}.view{padding-bottom:22px !important}.toast{display:none !important}';
      document.head.appendChild(s);
    });
    await page.waitForTimeout(90);
    await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true });
    const n = await page.evaluate(() => (JSON.parse(localStorage.getItem('xiaoting:v1') || '{}').cards || []).length);
    console.log('shot', name, '| cards in storage:', n);
  }
  console.log('errors:', errs.length ? errs : 'none');
  await browser.close();
})();
