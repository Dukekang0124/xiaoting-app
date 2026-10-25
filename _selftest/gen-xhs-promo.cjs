// 小红书推广图生成器：6 张 1080x1440（3:4），嵌入真机截图 + 手绘感标注。
// 设计基调：紫色系（产品 IP 色）、奶油底、圆角卡片、大字标题（仿热门封面手法）。
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const SHOTS = path.join(ROOT, '_selftest', 'shots-xhs');
const OUT = path.join(ROOT, 'docs', '小红书-推广素材');
fs.mkdirSync(OUT, { recursive: true });

const ipSvg = fs.readFileSync(path.join(ROOT, 'site', 'assets', 'moxiaoming.svg'), 'utf8');
const IP = ipSvg.replace('<svg ', '<svg width="100%" height="100%" style="display:block" ');
const shot = (n) => {
  const buf = fs.readFileSync(path.join(SHOTS, n));
  return 'data:image/png;base64,' + buf.toString('base64');
};

/* 手机样机：黑壳 + 刘海 + 真截图（宽度固定，高度自适应比例） */
const phone = (img, crop = 0) => `
  <div class="phone">
    <div class="phone__notch"></div>
    <img class="phone__scr" src="${img}" ${crop ? `style="height:${crop}px; object-fit:cover; object-position:top;"` : ''}>
  </div>`;

/* 手绘感标注气泡（可带小尾巴方向） */
const note = (text, cls = '') => `<div class="note ${cls}">${text}</div>`;

const baseCss = `
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:1080px; height:1440px; font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif;
         background:linear-gradient(165deg,#FBF8FF 0%,#F3ECFE 55%,#EDE3FD 100%); color:#43346B;
         position:relative; overflow:hidden; }
  /* 背景装饰泡泡 */
  .bubble { position:absolute; border-radius:50%; background:rgba(167,139,250,.10); }
  .bubble.b1 { width:340px; height:340px; top:-90px; right:-70px; }
  .bubble.b2 { width:180px; height:180px; bottom:180px; left:-50px; background:rgba(167,139,250,.14); }
  .bubble.b3 { width:90px; height:90px; top:420px; left:70px; background:rgba(196,181,253,.20); }
  .head { padding:64px 80px 0; position:relative; z-index:3; }
  .kicker { display:inline-block; background:#4C3D78; color:#fff; font-size:29px; font-weight:600;
            padding:11px 28px; border-radius:100px; letter-spacing:2px; }
  .kicker--soft { background:rgba(76,61,120,.10); color:#5B4A8F; }
  h1 { font-size:74px; line-height:1.22; font-weight:800; margin-top:26px; letter-spacing:1px; color:#3A2C61; }
  h1 em { font-style:normal; color:#7C5CE0; }
  .sub { font-size:37px; line-height:1.5; color:#7A6B9E; margin-top:20px; font-weight:500; }
  .stage { position:relative; display:flex; justify-content:center; margin-top:30px; }
  .phone { width:372px; background:#1C1530; border-radius:52px; padding:15px; position:relative;
           box-shadow:0 40px 80px rgba(76,61,120,.28), 0 12px 28px rgba(76,61,120,.18); }
  .phone__notch { position:absolute; top:28px; left:50%; transform:translateX(-50%); width:112px; height:22px;
                  background:#1C1530; border-radius:18px; z-index:5; }
  .phone__scr { width:100%; height:auto; border-radius:42px; display:block; }
  .note { position:absolute; z-index:6; background:#fff; border:3px solid #7C5CE0; color:#4C3D78;
          font-size:27px; font-weight:700; line-height:1.45; padding:20px 28px; border-radius:28px 28px 28px 8px;
          box-shadow:0 14px 30px rgba(124,92,224,.22); max-width:300px; }
  .note--r { border-radius:28px 28px 8px 28px; }
  .note small { display:block; font-size:23px; font-weight:500; color:#8A7BB0; margin-top:6px; }
  .foot { position:absolute; bottom:0; left:0; right:0; z-index:3; display:flex; align-items:center;
          justify-content:center; gap:20px; padding:0 80px 56px; }
  .foot__ip { width:120px; height:120px; flex:none; }
  .foot__txt { font-size:32px; font-weight:700; color:#5B4A8F; line-height:1.5; }
  .foot__txt small { display:block; font-size:25px; font-weight:500; color:#8A7BB0; }
  .doodle { position:absolute; z-index:2; }
  .stamp { position:absolute; top:64px; right:64px; z-index:4; background:rgba(255,255,255,.85);
           border:2px dashed #A78BFA; color:#7C5CE0; font-size:26px; font-weight:700;
           padding:14px 24px; border-radius:18px; letter-spacing:2px; }
`;

/* 通用页骨架 */
const pageHtml = ({ head, stage, foot }) => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${baseCss}</style></head>
<body>
  <div class="bubble b1"></div><div class="bubble b2"></div><div class="bubble b3"></div>
  <div class="head">${head}</div>
  <div class="stage">${stage}</div>
  <div class="foot">${foot}</div>
</body></html>`;

const FOOT_DEFAULT = `<div class="foot__ip">${IP}</div>
  <div class="foot__txt">墨小溟 · 语音情绪复盘<small>说出来，就轻一点 ｜ 免费使用</small></div>`;

const pages = [
  /* 1 封面：一个动作 */
  {
    name: 'xhs-01-封面-说出来就轻一点',
    html: pageHtml({
      head: `<span class="kicker">情绪没地方放的时候</span>
             <h1>说出来，<br>就<em>轻一点</em>。</h1>
             <div class="sub">不用打字、不用写日记——<br>按住这一个键，想到哪说到哪。</div>`,
      stage: phone(shot('02-say.png')) +
             note(`就这一个键<br>不用学、不用想<small>按住 ▸ 说 ▸ 松手</small>`, `left:-46px; top:430px; transform:rotate(-4deg);`),
      foot: FOOT_DEFAULT,
    }),
  },
  /* 2 痛点场景 */
  {
    name: 'xhs-02-痛点-被当众怼了',
    html: pageHtml({
      head: `<span class="kicker">真实瞬间 ①</span>
             <h1>被当众怼了一句，<br>我笑着说<em>「没事」</em>。</h1>
             <div class="sub">回家路上才反应过来：<br>那一瞬间的不舒服，是真实的。</div>`,
      stage: phone(shot('06-record-text.png')) +
             note(`不用组织语言<br>想到哪说到哪<small>「不方便说？打字也行」</small>`, `right:-42px; top:120px;`),
      foot: FOOT_DEFAULT,
    }),
  },
  /* 3 解决方案：卡片 */
  {
    name: 'xhs-03-方案-心事收成一张卡',
    html: pageHtml({
      head: `<span class="kicker">说完之后</span>
             <h1>3 分钟，心事被<br>温柔地收成<em>一张卡</em>。</h1>
             <div class="sub">你经历了什么、心里是什么感受，<br>牠替你整理好，不打扰任何人。</div>`,
      stage: phone(shot('04-cards.png')) +
             note(`情绪被说出来的那一刻<br>就被放下一半<small>委屈 · 疲惫 · 烦闷…都有名字</small>`, `left:-46px; top:400px; transform:rotate(-3deg);`),
      foot: FOOT_DEFAULT,
    }),
  },
  /* 4 时间线：有迹可循 */
  {
    name: 'xhs-04-时间线-情绪有迹可循',
    html: pageHtml({
      head: `<span class="kicker">回看的时候</span>
             <h1>原来我的情绪，<br>一直<em>有迹可循</em>。</h1>
             <div class="sub">每一次倾诉的起伏都被留住，<br>像一条安静的情绪轨迹。</div>`,
      stage: phone(shot('05-timelines.png')) +
             note(`委屈 → 委屈+自责 → 平静<small>看见变化的那一刻，真的会松一口气</small>`, `right:-42px; top:330px;`),
      foot: FOOT_DEFAULT,
    }),
  },
  /* 5 隐私 */
  {
    name: 'xhs-05-隐私-只存在本机',
    html: pageHtml({
      head: `<span class="kicker">最关心的事</span>
             <h1>没有账号，<br>心事<em>没有观众</em>。</h1>
             <div class="sub">心事只存在你自己的手机里，<br>不发给任何人，也不会被围观。</div>`,
      stage: phone(shot('07-me.png'), 700) +
             note(`全部存在这台设备上<small>删不删、给不给别人看，都由你</small>`, `left:-46px; top:260px; transform:rotate(-3deg);`),
      foot: FOOT_DEFAULT,
    }),
  },
  /* 6 步骤 CTA */
  {
    name: 'xhs-06-步骤-三步放下',
    html: pageHtml({
      head: `<span class="kicker">今天就试试</span>
             <h1>三步，把心事<em>放下</em>。</h1>`,
      stage: `
        <div style="display:flex; flex-direction:column; gap:34px; width:920px; margin-top:10px;">
          ${[
            ['1', '按住说', '不想措辞、不用打草稿，按住就讲'],
            ['2', '说出来就好', '牠会接住你，不评价、不建议、不催'],
            ['3', '收下情绪卡片', '心事被整理成一张卡，存在你手机里'],
          ].map(([n, t, d]) => `
            <div style="display:flex; align-items:center; gap:36px; background:#fff; border-radius:36px;
                        padding:44px 48px; box-shadow:0 16px 40px rgba(124,92,224,.14);">
              <div style="width:96px; height:96px; flex:none; border-radius:50%; background:linear-gradient(145deg,#A78BFA,#7C5CE0);
                          color:#fff; font-size:52px; font-weight:800; display:flex; align-items:center; justify-content:center;">${n}</div>
              <div><div style="font-size:46px; font-weight:800; color:#3A2C61;">${t}</div>
                   <div style="font-size:31px; color:#7A6B9E; margin-top:10px; line-height:1.4;">${d}</div></div>
            </div>`).join('')}
          <div style="display:flex; align-items:center; justify-content:center; gap:20px; margin-top:6px;">
            <div style="width:96px; height:96px;">${IP}</div>
            <div style="font-size:34px; font-weight:700; color:#5B4A8F;">墨小溟 · 免费使用<small style="display:block; font-size:27px; font-weight:500; color:#8A7BB0;">网页 / 安卓 App 都能直接用</small></div>
          </div>
        </div>`,
      foot: ``,
    }),
  },
];

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1080, height: 1440 }, deviceScaleFactor: 1 });
  for (const p of pages) {
    await page.setContent(p.html, { waitUntil: 'networkidle' });
    await page.waitForTimeout(350); // 字体/图片沉降
    await page.screenshot({ path: path.join(OUT, p.name + '.png') });
    console.log('saved', p.name);
  }
  await browser.close();
})().catch((e) => { console.error('gen failed:', e); process.exit(1); });
