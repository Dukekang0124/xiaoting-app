/**
 * 墨小溟 · 「下载更新完成后弹窗重复出现两次」真跑复现/回归探针
 *
 * 康哥真机反馈：每次更新流程，下载完成后更新弹窗会出现两次而非一次。
 * 本探针回答三句话：
 *   ① DownloadManager 下载完成的瞬间，系统安装器是不是只被唤起**一次**？
 *      （完成时刻有两条通道都会喊"下完了"：downloadCompleted 事件 + checkStatus 轮询兜底，
 *        此前 finalize() 无重入保护 ⇒ FileOpener.open 可能被调两次 ⇒ 安装弹窗弹两次）
 *   ② 点「立即更新」进入安装指引后，更新弹窗是不是已经关掉、不再以僵尸形态压在底下？
 *      （此前 doUpdate() 的 APK 分支不 closeModal() ⇒ 新卡盖旧卡，用户关掉新卡旧卡又露出来
 *        ⇒ "更新弹窗又出现了一次"）
 *   ③ 「已下好但没装上」时重开 App，是不是只弹**一张**"立即安装"卡，而不是
 *      通用更新弹窗 + 待装卡两张叠罗汉？（此前 initUpdate() 两条链各自弹）
 *
 * 🔴 为什么这个探针是新的：_selftest/in-app-install.cjs 的假桥里**没有 CapacitorDownloader**，
 *    它测的是 Filesystem 回落链路；而 v1.6.12 起真机默认走 DownloadManager 链路 ——
 *    完成时刻的行为此前零断言覆盖，缺陷正藏在这里。
 *
 * 场景：
 *   A. DM 链路完整走一遍（modal → 立即更新 → 指引 → 开始下载 → 完成事件 + 轮询兜底同时到达）
 *      → 断言 FileOpener.open === 1
 *   B. 弹窗互斥：进入安装指引时更新弹窗必须已关闭；关掉指引后屏幕上零弹窗
 *   C. 启动单弹窗：预置「已下好」标记 → 启动只有待装卡；对照臂：无标记 → 启动照常弹更新弹窗
 *
 * run: NODE_PATH=<workspace>/node_modules node _selftest/update-popup-once.cjs
 *      PW_CHANNEL=chromium   # CI 里用 Playwright 自带 chromium
 */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const PORT = 4193; // 安全区端口（4173=门禁 / 4191=in-app-install）
const BASE = 'http://127.0.0.1:' + PORT;
const NODE = process.execPath;

/* 🔴 版本号从产物 www/index.html 现读（探针测的就是这份产物），绝不写死。
   PENDING = 当前版 +1：既是清单里的"线上最新"，也是预置的"已下好"版本。 */
const CUR = (fs.readFileSync(path.join(ROOT, 'www', 'index.html'), 'utf8').match(/APP_VERSION\s*=\s*'([\d.]+)/) || [])[1];
if (!CUR) { console.error('✗ www/index.html 读不到 APP_VERSION（先跑 node scripts/build-web.mjs）'); process.exit(1); }
const CUR_CODE = CUR.split('.').map(Number).reduce((a, b) => a * 100 + b, 0);
const PENDING = CUR.split('.').slice(0, 2).join('.') + '.' + (Number(CUR.split('.')[2] || 0) + 1);
const SIZE = 4352332; // 与 v1.7.9 真包同体量，让 expectSize 校验走真分支

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitServer() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return true; } catch (e) { /* retry */ }
    await sleep(500);
  }
  throw new Error('server not up on ' + BASE);
}

/**
 * 带 DownloadManager 的假 Capacitor 桥。
 *
 * 🔴 FileOpener.open 故意拖 1800ms 才 resolve：真机上"唤起安装器"期间 JS 侧不会立刻 settle
 *    （桥往返 + Activity 启动都是几十到几百 ms 级）。轮询兜底 1500ms 一跳——拖过 1500ms，
 *    「完成事件先到、轮询兜底在窗口内也喊一次下完了」就从概率事件变成**确定性复现**。
 *    修好重入保护后，同样的最坏时序也必须恰好 open 1 次 —— 判据因此有鉴别力。
 */
const FAKE_DM_BRIDGE = `
window.__cap = { opens: 0, openArgs: [], enq: 0, statusCalls: 0, fsDl: 0, completed: false };
window.Capacitor = {
  isNativePlatform: () => true,
  getPlatform: () => 'android',
  Plugins: {
    CapacitorDownloader: {
      addListener: async (ev, cb) => { window['__cb_' + ev] = cb; return { remove: async () => {} }; },
      download: async (o) => { window.__cap.enq++; window.__dlOpts = o; },
      checkStatus: async () => {
        window.__cap.statusCalls++;
        return window.__cap.completed
          ? { status: 8, bytesDownloaded: ${SIZE}, bytesTotal: ${SIZE} }
          : { status: 2, bytesDownloaded: Math.min(${SIZE}, window.__cap.statusCalls * 600000), bytesTotal: ${SIZE} };
      },
      stop: async () => {},
    },
    Filesystem: {
      stat: async () => { await new Promise((r) => setTimeout(r, 40)); return { size: ${SIZE} }; },
      getUri: async () => { await new Promise((r) => setTimeout(r, 40)); return { uri: 'content://org.moxiaoming/external/downloads/xiaoting-v${PENDING}.apk' }; },
      deleteFile: async () => {},
      addListener: async () => ({ remove: async () => {} }),
      downloadFile: async () => { window.__cap.fsDl++; return { path: 'downloads/xiaoting-v${PENDING}.apk' }; },
    },
    FileOpener: {
      open: async (o) => {
        await new Promise((r) => setTimeout(r, 1800)); // 见上：故意制造"轮询必然撞进完成窗口"的最坏时序
        window.__cap.opens++; window.__cap.openArgs.push(o);
      },
    },
  },
};
`;

const FAKE_MANIFEST = JSON.stringify({
  latest_version: PENDING,
  force_update: false,
  download_url: `/apk/Xiaoting-v${PENDING}-release.apk`,
  web_url: '/#/say',
  release_notes: ['修复：下载更新完成后弹窗只出现一次'],
  apk: { versionCode: CUR_CODE + 1, version: PENDING, url: `/apk/Xiaoting-v${PENDING}-release.apk`, md5: 'deadbeef', size: SIZE, force: false },
});

const INIT_FLAG = () => `
try { localStorage.setItem('xiaoting:ai', 'mock'); } catch (e) {}
try { localStorage.setItem('moxiaoming:welcomed_v1', '1'); } catch (e) {}
try { localStorage.setItem('monthly:done_' + (new Date().getFullYear() * 100 + (new Date().getMonth() + 1)), '1'); } catch (e) {}
`;

(async () => {
  // 端口有残留 server 就别硬跑（防"跑在旧服务上"的假绿）
  try {
    const occupied = await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(900) });
    if (occupied.ok) {
      console.error(`端口 ${PORT} 上已有 server 在跑。先清理：netstat -ano | findstr :${PORT} → taskkill /PID <pid> /F`);
      process.exit(2);
    }
  } catch (e) { /* 端口空着，正常 */ }

  const srv = spawn(NODE, ['server.cjs'], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), STATS_KEY: 'selftest' },
    stdio: 'ignore', detached: true,
  });
  let killed = false;
  const killSrv = () => {
    if (killed) return; killed = true;
    try { process.kill(-srv.pid, 'SIGKILL'); } catch (e) { try { srv.kill('SIGKILL'); } catch (e2) { /* ignore */ } }
  };
  process.on('exit', killSrv);

  let browser;
  let code = 0;
  try {
    await waitServer();
    browser = await chromium.launch({ channel: process.env.PW_CHANNEL || 'chrome', headless: true });

    const newPage = async ({ withPendingMarker = false } = {}) => {
      const c = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN', isMobile: true, hasTouch: true });
      // 🔴 每个场景新 context：localStorage 是 context 级的，复用会互相污染（「已下好」标记串场）
      await c.addInitScript(FAKE_DM_BRIDGE);
      await c.addInitScript(INIT_FLAG());
      if (withPendingMarker) {
        await c.addInitScript(`try { localStorage.setItem('xiaoting:apk_downloaded_${PENDING}', String(Date.now())); } catch (e) {}`);
      }
      const page = await c.newPage();
      const navs = [];
      page.on('framenavigated', (f) => { if (f === page.mainFrame()) navs.push(f.url()); });
      await page.route('**/api/version/latest*', (r) => r.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: FAKE_MANIFEST }));
      await page.route('**/version.json*', (r) => r.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: FAKE_MANIFEST }));
      await page.route('**/version-latest.js*', (r) => r.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: 'window.__VERSION_MANIFEST__ = ' + FAKE_MANIFEST }));
      return { page, navs };
    };

    const overlayCounts = (page) => page.evaluate(() => ({
      update: document.querySelectorAll('.update-overlay').length,
      install: document.querySelectorAll('.install-overlay').length,
    }));

    /* ---------- 场景 A：DM 完成时刻，安装器只唤起一次 ---------- */
    console.log('场景 A：DownloadManager 下载完成（完成事件 + 轮询兜底同时到达）');
    {
      const { page, navs } = await newPage();
      await page.goto(BASE + '/?app=android#/settings', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#updateNow', { timeout: 12000 });
      await page.click('#updateNow'); // 产品真实链路：更新弹窗 → 立即更新 → 安装指引
      await page.waitForSelector('.install-overlay .install-card', { timeout: 12000 });
      await page.waitForSelector('#installStart', { timeout: 12000 });
      await page.click('#installStart');
      await page.waitForSelector('#dlFill', { timeout: 8000 });

      // 下载完成：事件通道喊一声（真机插件行为），同时 checkStatus 也开始报 SUCCESSFUL（轮询兜底通道）
      await page.evaluate(() => { window.__cap.completed = true; });
      await page.evaluate(() => { if (window.__cb_downloadCompleted) window.__cb_downloadCompleted({ id: 'probe' }); });

      await page.waitForFunction(() => {
        const t = document.querySelector('.install-overlay .install-card');
        return t && /安装界面已经打开了/.test(t.innerText);
      }, null, { timeout: 15000 }).catch(() => {});
      // 第二次 open（若缺陷在）要再拖 1800ms 才落账 —— 等它落地再数，别冤枉也别放过
      await sleep(2600);

      const cap = await page.evaluate(() => window.__cap);
      const armed = await page.evaluate((v) => localStorage.getItem('xiaoting:update_armed_' + v), PENDING);
      const counts = await overlayCounts(page);

      check('A·下载走的是 DownloadManager 链路（探针测的是真机默认通道）', cap.enq === 1 && cap.statusCalls > 0,
        `enq=${cap.enq} statusCalls=${cap.statusCalls}`);
      check('A·没有回落到 Filesystem 旧链路', cap.fsDl === 0, `downloadFile=${cap.fsDl}`);
      check('A·完成时刻 FileOpener.open 恰好 1 次（事件+轮询双通道不重复唤起安装器）',
        cap.opens === 1, `open=${cap.opens} 次 — 大于 1 就是"安装弹窗弹两次"`);
      check('A·成功卡照常提示「安装界面已经打开了」（功能保持）',
        (await page.evaluate(() => (document.querySelector('.install-overlay .install-card') || { innerText: '' }).innerText)).includes('安装界面已经打开了'));
      check('A·"已装"凭据照常写入（armInstalled 功能保持）', !!armed, armed ? `armed=${armed}` : '无');
      check('A·全程没有导航离开当前页', navs.length <= 1, `framenavigated=${navs.length}`);
      check('A·成功后屏幕上只剩一张弹窗卡', counts.update + counts.install === 1, JSON.stringify(counts));
      await page.close();
    }

    /* ---------- 场景 B：弹窗互斥（不留僵尸更新弹窗） ---------- */
    console.log('场景 B：进入安装指引时，更新弹窗必须已关闭');
    {
      const { page } = await newPage();
      await page.goto(BASE + '/?app=android#/settings', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#updateNow', { timeout: 12000 });
      await page.click('#updateNow');
      await page.waitForSelector('.install-overlay .install-card', { timeout: 12000 });
      await sleep(250); // 等 closeModal 类同步 DOM 操作落定

      let counts = await overlayCounts(page);
      check('B·安装指引出现时，更新弹窗已被关闭（不留僵尸弹窗压在底下）',
        counts.update === 0 && counts.install === 1, JSON.stringify(counts) + ' — update>0 就是"关掉指引后更新弹窗又冒出来"');

      // 指引内容保持原样：修的是"弹几次"，不是"弹什么"
      const g = await page.evaluate(() => ({
        sign: (document.querySelector('.install-overlay .update-sign') || {}).textContent || '',
        steps: document.querySelectorAll('.install-steps li').length,
        start: !!document.getElementById('installStart'),
        later: !!document.getElementById('installLater'),
      }));
      check('B·指引内容原样（标题=安装指引 / 3 步 / 开始下载 / 稍后再说）',
        /安装指引/.test(g.sign) && g.steps === 3 && g.start && g.later, JSON.stringify(g));

      await page.click('#installLater'); // 稍后再说 → 关卡
      await sleep(250);
      counts = await overlayCounts(page);
      check('B·关闭安装指引后，屏幕上零更新类弹窗（不会又露出一张）',
        counts.update === 0 && counts.install === 0, JSON.stringify(counts));
      await page.close();
    }

    /* ---------- 场景 C：启动单弹窗（待装卡不与更新弹窗叠罗汉） ---------- */
    console.log('场景 C：已下好未安装 → 重开 App 只弹一张"立即安装"卡');
    {
      const { page } = await newPage({ withPendingMarker: true });
      await page.goto(BASE + '/#/settings', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.install-overlay', { timeout: 12000 });
      await sleep(800); // 修复前更新弹窗会晚一点点叠上来 —— 等它到齐了再数，抓的是"叠罗汉"不是时序抖动

      const counts = await overlayCounts(page);
      const t = await page.evaluate(() => (document.querySelector('.install-overlay .update-title') || { textContent: '' }).textContent || '');
      check('C·启动只有一张弹窗（待装卡），不叠加通用更新弹窗',
        counts.install === 1 && counts.update === 0, JSON.stringify(counts) + ' — update>0 就是"弹窗重复出现"');
      check('C·那张卡是「安装包已下好·立即安装」', /安装包已经下好了/.test(t), t.slice(0, 40));
      await page.close();

      // 对照臂：没有待装包时，启动自动检测必须照常弹更新弹窗（证明没把自动检测误杀）
      const { page: p2 } = await newPage();
      await p2.goto(BASE + '/#/settings', { waitUntil: 'domcontentloaded' });
      await p2.waitForSelector('.update-overlay', { timeout: 12000 });
      const c2 = await overlayCounts(p2);
      check('C·对照臂：无待装包时启动照常弹更新弹窗（自动检测没被误杀）',
        c2.update === 1 && c2.install === 0, JSON.stringify(c2));
      await p2.close();
    }
  } catch (e) {
    console.error('✗ 运行异常：' + (e && e.stack || e));
    code = 1;
  } finally {
    try { if (browser) await browser.close(); } catch (e) { /* ignore */ }
    killSrv();
  }

  const fails = results.filter((r) => !r.ok).length;
  console.log(`\n汇总：${results.length - fails}/${results.length} 通过`);
  if (fails || code) process.exit(1);
})();
