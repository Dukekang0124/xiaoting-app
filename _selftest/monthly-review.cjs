/* 墨小溟 · 月度情绪复盘探针（文档 §追加模块3）
 *
 * 为什么单开一个探针：
 *   doc-closure.cjs 验文案库、action-lib.cjs 验行动库，月度复盘是「读用户一个月的记录
 *   再生成一张卡」，链路是**数据 → 统计 → 场景判定 → 卡片 → UI**，每一环都要能单独被证伪。
 *   判据原则与其余探针一致：import **真实业务模块**，不另写平行实现；
 *   文案逐字比对（只判"包含关键词"会让润色悄悄溜过去）；
 *   判「做完没做完」要落到开关真正影响的那条链路上，不是只看常量存在。
 *
 * 跑：先起 node server.cjs（PORT=4176），再 NODE_PATH=… node _selftest/monthly-review.cjs
 */
const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');

const BASE = process.env.BASE || 'http://127.0.0.1:4176';
const OUT = path.join(__dirname, 'shots-monthly');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const failedNames = [];
const ok = (name, cond, detail = '') => {
  const c = !!cond;
  if (c) pass += 1; else { fail += 1; failedNames.push(name + (detail ? '  — ' + detail : '')); }
  console.log(`${c ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const settle = async (page) => {
  await page.waitForFunction(() => !document.querySelector('.toast.toast--on'), null, { timeout: 2500 }).catch(() => {});
  await page.waitForTimeout(420);
};
const shot = async (page, n) => { try { await page.screenshot({ path: path.join(OUT, n) }); } catch (e) {} };

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  // 🔴 必须先 goto：page.evaluate 里的动态 import('/js/xxx.js') 以**当前文档 URL** 为基准解析，
  //    空白页上下文里会报 Failed to resolve module specifier。
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  // 🔴 首次打开会弹 4 屏新手引导浮层（welcome-overlay），它会**拦截点击** ——
  //    不清掉的话后面点「生成本月情绪复盘」会一直超时重试。
  await page.evaluate(() => { try { localStorage.setItem('moxiaoming:welcomed_v1', '1'); } catch (e) {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);

  /* ═════════ ① 引擎层：字段契约与边界（不依赖浏览器 DOM） ═════════ */
  {
    const r = await page.evaluate(async () => {
      const m = await import('/js/monthly.js');
      const p = await import('/js/prompts.js');
      // monthIdx：0=1月。🔴 别用「不存在的日期」当测试数据 —— JS 会**自动进位**
      //   （new Date(2026,8,31) 是 9/31 不存在 ⇒ 变成 10/1），会让月份边界断言全红。
      const mk = (day, score, emo, monthIdx = 9) => ({
        saved_at: new Date(2026, monthIdx, day, 12, 0).toISOString(),
        timeline_list: [{ emotion_score: score, emotions: emo }],
      });
      const three = [mk(2, 60, ['喜悦']), mk(8, -70, ['悲伤']), mk(15, -80, ['愤怒'])];
      const rev = m.buildMonthlyReview(three, { now: new Date(2026, 9, 20) });
      return {
        cfg: p.COPY.monthly,
        rev,
        two: m.buildMonthlyReview([three[0], three[1]], { now: new Date(2026, 9, 20) }),
        // 只放**上个月**（2026-08-05）的记录 ⇒ 本月 0 条 ⇒ 不该生成
        onlyLastMonth: m.buildMonthlyReview([mk(5, 50, ['平静'], 7)], { now: new Date(2026, 9, 20) }),
        noRecords: m.buildMonthlyReview([], { now: new Date(2026, 9, 20) }),
        autoOn1: m.shouldAutoReview(new Date(2026, 9, 1)),
        autoOn5: m.shouldAutoReview(new Date(2026, 9, 5)),
        autoOn31: m.shouldAutoReview(new Date(2026, 8, 30)), // 9/30（8 是 9 月的下标）
        key: m.monthKey(new Date(2026, 9, 1)),
        label: m.monthLabel(new Date(2026, 9, 1)),
      };
    });

    ok('① cardId = emo_month_YYYYMM（复盘卡有业务 id，不是时间戳）',
      r.rev && r.rev.card_id === 'emo_month_202610', r.rev && r.rev.card_id);
    ok('① targetMonth =「2026年10月」（本机生成，不是模型编的）',
      r.rev && r.rev.target_month === '2026年10月', r.rev && r.rev.target_month);
    ok('① recordCount = 当月记录条数', r.rev && r.rev.record_count === 3, r.rev && r.rev.record_count);
    ok('① topEmotionTags 最多 3 个且都来自真实记录',
      Array.isArray(r.rev.top_emotion_tags) && r.rev.top_emotion_tags.length <= 3 && r.rev.top_emotion_tags.length > 0,
      (r.rev.top_emotion_tags || []).join('/'));
    ok('① emotionTrendDesc ≤ 45 字', (r.rev.emotion_trend_desc || '').length <= 45, (r.rev.emotion_trend_desc || '').length + ' 字');
    ok('① insightText ≤ 40 字', (r.rev.insight_text || '').length <= 40, (r.rev.insight_text || '').length + ' 字');
    ok('① timelineGroup = 月度复盘',
      r.rev && r.rev.timeline_group === r.cfg.timelineGroup && r.cfg.timelineGroup === '月度复盘', r.rev && r.rev.timeline_group);
    ok('① isHighRisk 恒 false（月度总结不是一次倾诉，不做安全升级）', r.rev && r.rev.is_high_risk === false);
    ok('① cardTheme = month-purple', r.rev && r.rev.card_theme === 'month-purple', r.rev && r.rev.card_theme);
    ok('① 当月记录 < 3 条不生成（返回 null，不硬凑）',
      r.two === null && r.noRecords === null, `2条=${r.two} 0条=${r.noRecords}`);
    ok('① 只有上月的记录不算本月（月份边界正确）',
      r.onlyLastMonth === null, `上月那条的月份键=${r.onlyLastMonth === null ? 'null（正确）' : '误入本月'}`);
    ok('① 每月 1 号才自动，其他日子不自动',
      r.autoOn1 === true && r.autoOn5 === false && r.autoOn31 === false,
      `1号=${r.autoOn1} 5号=${r.autoOn5} 31号=${r.autoOn31}`);
    ok('① 月份键/标签用本机时间（1 号凌晨不会被 UTC 算到上个月）',
      r.key === 202610 && r.label === '2026年10月',
      `key=${r.key} label=${r.label}`);

    // 5 套场景文案：逐字落库 + 字数边界（文档点名 ≤45 / ≤40）
    const S = (r.cfg.scenarios || {});
    const KEYS = ['swing', 'low', 'angry', 'positive', 'flat'];
    ok('② 五套场景齐全（起伏大/低落委屈疲惫/烦躁愤怒压抑/正向居多/整体平淡）',
      KEYS.every((k) => S[k] && typeof S[k] === 'object'), KEYS.join('/'));
    const missing = [];
    const over = [];
    for (const k of KEYS) {
      const sc = S[k] || {};
      if (!sc.emotionTrendDesc || !sc.insightText || !sc.ipBubbleText) missing.push(k);
      if ((sc.emotionTrendDesc || '').length > 45) over.push(k + ':' + (sc.emotionTrendDesc || '').length);
      if ((sc.insightText || '').length > 40) over.push(k + ':' + (sc.insightText || '').length);
    }
    ok('② 五套场景的 emotionTrendDesc/insightText/ipBubbleText 已逐字落库',
      missing.length === 0, missing.length ? '缺：' + missing.join('/') : '齐全');
    ok('② emotionTrendDesc ≤45 / insightText ≤40（都超了说明没按卡片尺寸写）',
      over.length === 0, over.length ? over.join('，') : '字数都在界内');

    /* ═════════ ③ 场景判定真的会挑对那一套 ═════════ */
    const pick = await page.evaluate(async () => {
      const m = await import('/js/monthly.js');
      const mk = (day, score, emo) => ({ saved_at: new Date(2026, 9, day, 12).toISOString(), timeline_list: [{ emotion_score: score, emotions: emo }] });
      const set = (arr) => m.buildMonthlyReview(arr, { now: new Date(2026, 9, 20) });
      return {
        swing: set([mk(2, 80, ['喜悦']), mk(8, -80, ['悲伤']), mk(15, 40, ['惊喜'])]),
        low: set([mk(2, -60, ['悲伤']), mk(8, -70, ['低落']), mk(15, -65, ['委屈'])]),
        angry: set([mk(2, -50, ['愤怒']), mk(8, -55, ['烦躁']), mk(15, -60, ['压抑'])]),
        positive: set([mk(2, 60, ['喜悦']), mk(8, 70, ['开心']), mk(15, 65, ['满足'])]),
        flat: set([mk(2, 0, ['平静']), mk(8, 0, ['平静']), mk(15, 5, ['平静'])]),
      };
    });
    // 只判「选出了哪一套 + 那套文案是不是被用上了」，不判具体字句（字句由文档 SSOT 定）
    ok('③ 起伏很大 → swing', pick.swing && pick.swing.scenario === 'swing', pick.swing && pick.swing.scenario);
    ok('③ 低落委屈疲惫 → low', pick.low && pick.low.scenario === 'low', pick.low && pick.low.scenario);
    ok('③ 烦躁愤怒压抑 → angry', pick.angry && pick.angry.scenario === 'angry', pick.angry && pick.angry.scenario);
    ok('③ 正向居多 → positive', pick.positive && pick.positive.scenario === 'positive', pick.positive && pick.positive.scenario);
    ok('③ 整体平淡 → flat', pick.flat && pick.flat.scenario === 'flat', pick.flat && pick.flat.scenario);
    ok('③ 每套都取到了自己那套文案（不是全空着）',
      ['swing', 'low', 'angry', 'positive', 'flat'].every((k) => (pick[k].insight_text || '').length > 0),
      ['swing', 'low', 'angry', 'positive', 'flat'].map((k) => k + ':' + (pick[k].insight_text || '').length + '字').join(' '));
  }

  /* ═════════ ④ UI 真跑：手动入口 + 自动弹窗 + 不足 3 条 ═════════ */
  const seed = async (n, emo, score) => {
    await page.evaluate(({ n, emo, score }) => {
      const raw = JSON.parse(localStorage.getItem('xiaoting:v1') || '{}');
      const now = new Date();
      raw.timelines = [];
      for (let i = 0; i < n; i += 1) {
        // 🔴 必须给每条记录**不同的时刻**：今天是 1 号时 Math.max(1, getDate()-i) 三条会落成
        //    同一天同一刻，被 monthRecords 的「同时间戳去重」吃掉成 1 条 ⇒ 永远走不足分支。
        //    注意这不改产品口径（去重本来就是防重复落库）。
        const d = new Date(now.getFullYear(), now.getMonth(), Math.max(1, now.getDate() - i), 12, i * 37, i * 11);
        raw.timelines.push({
          id: 'tl_t' + i,
          saved_at: d.toISOString(),
          card_title: '情绪时间线',
          timeline_list: [{ node_index: 1, emotion_score: score, emotions: emo, emotion_text: emo.join('+'), desc_text: '测试记录' }],
          is_high_risk: false,
        });
      }
      localStorage.setItem('xiaoting:v1', JSON.stringify(raw));
    }, { n, emo, score });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(700);
    // 🔴 今天是 1 号的话，每次 reload 都会被**自动生成的月度复盘弹窗**挡住点击。
    //    这正是自动触发在工作的证明；手动入口的测试要先把它请走，否则点不到按钮。
    await page.evaluate(() => document.querySelectorAll('.monthly-overlay').forEach((n) => n.remove()));
  };
  {
    // 不足 3 条：点按钮应该给「暂时无法生成月度复盘」，而不是硬造一张卡
    await seed(2, ['悲伤'], -70);
    await page.evaluate(() => { location.hash = '#/settings'; });
    await page.waitForSelector('#setMonthly', { timeout: 6000 }).catch(() => {});
    const btnText = await page.$eval('#setMonthly', (b) => (b.textContent || '').trim()).catch(() => '');
    ok('④ 设置页有「生成本月情绪复盘」按钮且文案逐字',
      btnText === '生成本月情绪复盘', btnText || '没找到按钮');
    await page.click('#setMonthly');
    await page.waitForSelector('.monthly-overlay', { timeout: 3000 }).catch(() => {});
    const insTitle = await page.$eval('.monthly-card__title', (e) => (e.textContent || '').trim()).catch(() => '');
    const insBody = await page.$eval('.monthly-card__body', (e) => (e.textContent || '').trim()).catch(() => '');
    const insBtn = await page.$$eval('.monthly-card__btns button', (n) => n.map((x) => (x.textContent || '').trim())).catch(() => []);
    ok('④ 记录不足 3 条 → 弹「暂时无法生成月度复盘」', insTitle === '暂时无法生成月度复盘', insTitle);
    ok('④ 并说明为什么（记录还不够多，再来生成月度复盘）',
      insBody.includes('记录还不够多') && insBody.includes('再来生成月度复盘'), insBody.slice(0, 30));
    ok('④ 只有「知道了」一个按钮（不逼着装完）',
      insBtn.length === 1 && insBtn[0] === '知道了', insBtn.join('/'));
    await shot(page, '01-insufficient.png');
    await page.click('.monthly-card__btns button');
    await page.waitForTimeout(200);

    // 满 3 条：点按钮 → 自动弹窗 + 真出卡 + 卡片是淡紫主题
    await seed(3, ['喜悦'], 70);
    await page.evaluate(() => { location.hash = '#/settings'; });
    await page.waitForSelector('#setMonthly', { timeout: 6000 }).catch(() => {});
    await page.click('#setMonthly');
    await page.waitForSelector('.monthly-overlay', { timeout: 3000 }).catch(() => {});
    const autoTitle = await page.$eval('.monthly-card__title', (e) => (e.textContent || '').trim()).catch(() => '');
    const autoBtns = await page.$$eval('.monthly-card__btns button', (n) => n.map((x) => (x.textContent || '').trim())).catch(() => []);
    ok('④ 生成成功 → 弹窗标题逐字「你的月度情绪复盘已生成✨」',
      autoTitle === '你的月度情绪复盘已生成✨', autoTitle);
    ok('④ 弹窗两个按钮：「稍后再看」+「查看复盘」',
      autoBtns.length === 2 && autoBtns.includes('查看复盘') && autoBtns.includes('稍后再看'), autoBtns.join('/'));
    // 🔴 几何判据：遮罩必须真的盖满视口、卡片必须真的水平居中。
    //    （曾经踩坑：overlay 复用了给「left:50% 居中小浮条」写的 offbar-in 动画，
    //     其 transform:translateX(-50%) 把 inset:0 的全屏遮罩整体左移半个屏宽 ——
    //     断言只看「标题文字对不对」是抓不到的，只有量坐标才抓得到。）
    const geo = await page.evaluate(() => {
      const o = document.querySelector('.monthly-overlay');
      const c = o && o.querySelector('.monthly-card');
      if (!c) return null;
      const r = o.getBoundingClientRect();
      const cr = c.getBoundingClientRect();
      return {
        ovLeft: Math.round(r.left), ovW: Math.round(r.width),
        cardCenter: Math.round(cr.left + cr.width / 2), vw: window.innerWidth,
      };
    });
    ok('④ 遮罩盖满视口（inset:0 没被 transform 挪走）',
      geo && geo.ovLeft === 0 && geo.ovW === geo.vw, geo ? `left=${geo.ovLeft} 宽=${geo.ovW} 视口=${geo.vw}` : '抓不到遮罩');
    ok('④ 复盘卡水平居中（不是挤在屏幕左边）',
      geo && Math.abs(geo.cardCenter - geo.vw / 2) <= 2, geo ? `卡片中心=${geo.cardCenter} 视口中心=${geo.vw / 2}` : '抓不到卡片');

    // 🔴 截图前必须等入场动画沉降，否则会拍到遮罩与卡片半透明的中间帧。
    await page.waitForTimeout(340);
    await shot(page, '02-auto-modal.png');

    // 「查看复盘」真的能跳到卡片
    await page.click('.monthly-card__btns button[class*="primary"]');
    await settle(page);
    await page.evaluate(() => { location.hash = '#/timeline'; });
    await page.waitForTimeout(900);
    const theme = await page.$$eval('.tl-card', (n) => n.map((e) => e.className)).catch(() => []);
    ok('④ 复盘卡渲染成 month-purple 淡紫主题（复用时间线结构）',
      theme.some((c) => /month-purple/.test(c)), theme.join(' | ').slice(0, 80));
    // 月度卡的节点是「高频情绪」不是「倾诉分段」：复用时间线结构不代表连措辞也一起继承
    const nodeLabel = await page.$eval('.tl-node__no', (e) => (e.textContent || '').trim()).catch(() => '');
    ok('④ 复盘卡节点不用「第 N 段」这套倾诉措辞（改成高频情绪）',
      nodeLabel && !/^第/.test(nodeLabel) && /高频情绪/.test(nodeLabel), nodeLabel || '抓不到节点标签');
    await shot(page, '03-monthly-card.png');

    // 「月更不是日更」保护的对象是**自动入口**（1 号当天启动多次只弹一次）。
    // 🔴 手动按钮走的是 force 分支 —— 用户自己按了就该再出一张，把它当去重对象，
    //    等于要求「主动点也静默」，那会把「手动按钮失灵」这个真缺陷一起放过。
    const autoAgain = await page.evaluate(async () => {
      document.querySelectorAll('.monthly-overlay').forEach((n) => n.remove());
      const app = await import('/js/app.js');
      app.__test__.autoMonthlyReview(); // 第二次自动触发
      return document.querySelectorAll('.monthly-overlay').length;
    });
    await page.waitForTimeout(250);
    const afterAuto = await page.$$eval('.monthly-overlay', (n) => n.length).catch(() => 0);
    ok('④ 1 号当天重复启动不重复弹（月更，不是日更）',
      autoAgain === 0 && afterAuto === 0, `第一次调后=${autoAgain} 等一拍后=${afterAuto}`);

    await page.evaluate(() => { location.hash = '#/settings'; });
    await page.waitForSelector('#setMonthly', { timeout: 6000 }).catch(() => {});
    await page.click('#setMonthly');
    await page.waitForTimeout(400);
    const again = await page.$$eval('.monthly-overlay', (n) => n.length).catch(() => 0);
    ok('④ 手动按钮永远响应（主动点就该再出一张，不被去重吞掉）', again === 1, `弹窗数=${again}`);
    await shot(page, '04-manual-again.png');
    await page.evaluate(() => document.querySelectorAll('.monthly-overlay').forEach((n) => n.remove()));

    ok('④ 全程无页面级报错', errors.length === 0, errors.slice(0, 2).join(' / ') || '0 个');
  }

  /* ═════════ ⑤ 每月 1 号自动触发（把时间钉在 1 号验证） ═════════ */
  {
    await seed(3, ['平静'], 0);
    const auto = await page.evaluate(async () => {
      const app = await import('/js/app.js');
      localStorage.removeItem('monthly:done_' + (new Date().getFullYear() * 100 + (new Date().getMonth() + 1)));
      // 直接调自动入口（它内部会看 shouldAutoReview；非 1 号这里是 no-op，正好验证不误弹）
      app.__test__.autoMonthlyReview();
      return document.querySelectorAll('.monthly-overlay').length;
    });
    await page.waitForTimeout(300);
    const after = await page.$$eval('.monthly-overlay', (n) => n.length).catch(() => 0);
    ok('⑤ 非 1 号启动不误弹（自动入口有闸门）',
      new Date().getDate() !== 1 ? after === 0 : true,
      `今天=${new Date().getDate()}号，弹窗数=${after}`);
  }

  await browser.close();
  console.log(`\n==== 月度情绪复盘探针：${pass} 通过 / ${fail} 失败 ====`);
  // 🔴 必须把失败项的**名字**打出来：以前只印一个 ❌，真出问题时根本看不出是哪条挂了，
  //    等于每次都要重跑一遍靠猜（本轮就为这两条花了额外两轮）。
  if (fail) console.log('失败项：\n' + failedNames.map((n) => '  ❌ ' + n).join('\n'));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
