// 小红书推广素材专用截图：真跑产品，截 6 张真实界面。
// 预置数据走浏览器内 import('/js/store.js') 真实模块（格式由真函数保证）。
const { chromium } = require('playwright-core');
const path = require('path');

const BASE = process.env.BASE || 'http://127.0.0.1:4173';
const OUT = path.join(__dirname, 'shots-xhs');

const SEED = `
(async () => {
  const store = await import('/js/store.js');
  const mk = (daysAgo, title, emotion, intensity, summary, body, tags, event) => {
    const d = new Date(Date.now() - daysAgo * 86400000);
    const c = store.addCard({ title, emotion: [emotion], intensity, summary, body, tags, event, text: event, ip_state: 'empathy' });
    c.created_at = d.toISOString();
    return c;
  };
  mk(0.02, '被同事一句话戳到了', '委屈', 6,
     '同事当众说「这个你都不会？」，你笑着带过去了，但心里咯噔了一下。',
     '你没有小题大做，你只是需要有人告诉你：那一刻的不舒服是真实的。被当众否定确实不好受，你笑着接住它，已经是很大的体面了。',
     ['职场', '被否定'], '今天开会时，同事当着大家的面说「这个你都不会？」');
  mk(3, '加班到十点的疲惫', '疲惫', 7,
     '连着三周加班，回到家连灯都不想开。',
     '疲惫不是矫情，是身体在替你说「够了」。今晚早点洗漱，把手机放远一点，你已经撑得够久了。',
     ['加班', '身体'], '连着加班三周，今天又是十点才到家');
  mk(7, '和妈妈打电话有点堵', '烦闷', 5,
     '妈妈又催婚了，你敷衍地「嗯嗯」，挂了电话却半天缓不过来。',
     '你爱她，也知道她是关心你，可关心变成催促的时候，委屈和愧疚会一起涌上来。两种情绪同时存在，不冲突。',
     ['家人', '催婚'], '晚上和妈妈通话，又被催婚了');
  // 一条情绪时间线（nodes.emotions 驱动列表页 flow 文案）
  store.addTimeline({
    card_title: '10月18日 · 情绪时间线',
    card_subtitle: '这一次的起伏，被你留住了',
    nodes: [
      { emotions: ['委屈'], label: '开会时被当众怼了一句' },
      { emotions: ['委屈', '自责'], label: '回家路上一直在想' },
      { emotions: ['平静'], label: '说出来之后，松了一口气' },
    ],
    summary_text: '从委屈到平静，中间隔了一次「说出来」。',
    footer_note: '只存在你的手机里，不发给任何人。',
    type: 'normal',
  });
  return store.getState().cards.length;
})()
`;

(async () => {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    locale: 'zh-CN',
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();

  // —— 1) 首次欢迎页（干净上下文，IP 露出）——
  await page.goto(BASE + '/#/say', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.welcome-overlay', { timeout: 8000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, '01-welcome.png') });
  console.log('01-welcome ok');

  // 关掉欢迎层：多步引导，直接点「跳过全部」；仍残留则写已读标记兜底
  const skipBtn = await page.$('.welcome-overlay a, .welcome-overlay button');
  if (skipBtn) {
    const txt = (await skipBtn.textContent()) || '';
    const skip = (await page.$$('.welcome-overlay a, .welcome-overlay button')).find(
      async (b) => ((await b.textContent()) || '').includes('跳过'),
    );
    await (skip || skipBtn).click();
    await page.waitForTimeout(400);
  }
  await page.evaluate(() => {
    document.querySelector('.welcome-overlay')?.remove();
    try { localStorage.setItem('moxiaoming:welcomed_v1', '1'); } catch (e) {}
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  await page.evaluate(() => document.querySelector('.welcome-overlay')?.remove());

  // —— 2) 倾诉首页（按住说 + IP）——
  await page.goto(BASE + '/#/say', { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT, '02-say.png') });
  console.log('02-say ok');

  // —— 3) 按住说话中（模拟 pointerdown 长按）——
  try {
    const hold = await page.$('.say__hold, [data-hold], .hold-btn, .mic-btn');
    if (hold) {
      const box = await hold.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.waitForTimeout(1600); // 录音态 UI 出现
        await page.screenshot({ path: path.join(OUT, '03-holding.png') });
        await page.mouse.up();
        console.log('03-holding ok');
      }
    } else { console.log('03-holding SKIP: no hold btn'); }
  } catch (e) { console.log('03-holding SKIP:', String(e).slice(0, 80)); await page.mouse.up().catch(() => {}); }

  // —— 预置 3 张情绪卡（真实模块写入）——
  const n = await page.evaluate(SEED);
  console.log('seeded cards:', n);

  // —— 4) 情绪卡片列表页：全新 page 直接加载目标 hash（同页 hash 直跳不触发 SPA 重渲染）——
  const p4 = await ctx.newPage();
  p4.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 150)));
  p4.on('console', (m) => { if (m.type() === 'error') console.log('  [console-err]', m.text().slice(0, 150)); });
  await p4.goto(BASE + '/#/cards', { waitUntil: 'domcontentloaded' });
  await p4.waitForFunction(() => (document.querySelector('#view')?.textContent || '').includes('卡片'), { timeout: 8000 }).catch(() => {});
  await p4.waitForTimeout(700);
  await p4.screenshot({ path: path.join(OUT, '04-cards.png') });
  console.log('04-cards ok');
  console.log('  view:', (await p4.evaluate(() => (document.querySelector('#view')?.textContent || '').replace(/\s+/g, ' ').slice(0, 120))));
  await p4.close();

  // —— 5) 情绪时间线 ——
  await page.goto(BASE + '/#/timelines', { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, '05-timelines.png') });
  console.log('05-timelines ok');

  // —— 6) 打字页（不方便说，打字也行）——
  await page.goto(BASE + '/#/record?mode=text', { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(500);
  // 填入一段真实感文字
  const ta = await page.$('textarea, [contenteditable="true"], input[type="text"]');
  if (ta) {
    await ta.type('今天开会又被当众怼了一句，我笑着带过去了，但其实心里特别不舒服，回来的路上一直在想是不是我太敏感了……', { delay: 5 }).catch(() => {});
    await page.waitForTimeout(300);
  }
  await page.screenshot({ path: path.join(OUT, '06-record-text.png') });
  console.log('06-record-text ok');

  // —— 7) 「我」页（隐私 / 全部本机）——
  await page.goto(BASE + '/#/me', { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, '07-me.png') });
  console.log('07-me ok');

  await browser.close();
})().catch((e) => { console.error('xhs shots failed:', e); process.exit(1); });
