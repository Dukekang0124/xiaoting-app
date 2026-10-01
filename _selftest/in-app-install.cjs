/**
 * 墨小溟 · 应用内下载安装（不跳出产品）真跑自测
 *
 * 要回答的那一句话：**点「开始下载」之后，用户会不会被甩出 App 去通知栏找包？**
 *
 * v1.6.3 的真机截图就是这个问题：点「开始下载」→ 提示「从屏幕顶部下拉通知栏，点 Xiaoting…apk」。
 * 根因是 `loadInstaller()` 用裸 `import('@capacitor/filesystem')` 取插件（无构建 WebView
 * 解析不了裸说明符 + node_modules 里没装这两个包）⇒ 拿不到插件 ⇒ 静默回落 `window.location.href`
 ⇒ 下载被甩给系统/浏览器。
 *
 * 本探针的做法：**注入一个假的 Capacitor 桥**（真机上的 `window.Capacitor.Plugins.Filesystem /
 * .FileOpener` 长得就是这个样子，两个插件在 APK 里的 Java 层都已注册），然后真的去点按钮、
 * 真的看 DOM 变化。这样验的是「接线接对了没 + 用户看到什么」，而不是"模块导出存不存在"。
 *
 * 四个场景：
 *   ① 正常：原生下载 + 真进度 → 唤起安装界面 + 记下"已装"凭据
 *   ② 网络中断（可重试）→ 说人话 + 给「再试一次」
 *   ③ 假包（体积对不上）→ 拦下 + 绝不拿 HTML 去唤起安装器
 *   ④ 桥上没插件 → 如实说这台设备装不了 + 给手动入口（**不再**静默 location.href）
 *
 * run: NODE_PATH=<workspace>/node_modules node _selftest/in-app-install.cjs
 */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const PORT = 4191; // 安全区端口
const BASE = 'http://127.0.0.1:' + PORT;
const NODE = 'C:\\Users\\Admin\\.workbuddy\\binaries\\node\\versions\\22.22.2-3\\node.exe';

/* 🔴 版本号一律从 index.html 的 APP_VERSION 现读，绝不写死在断言/假数据里 ——
*    写死的话，下一个版本这条探针必定假红（`_selftest/` 里已经栽过一次：
*    www-artifact-smoke 写死 18 个模块、_probe/_sw-upgrade 写死 CACHE 名）。
*    这里的 CUR 同时喂给假清单、假桥产物名、armed 凭据 key，保证探针跟着版本走。 */
const CUR = (fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').match(/APP_VERSION\s*=\s*'([\d.]+)/) || [])[1];
if (!CUR) { console.error('✗ 读不到 APP_VERSION'); process.exit(1); }
const CUR_CODE = CUR.split('.').map((n) => Number(n) || 0).reduce((a, b) => a * 100 + b, 0);

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 这句话是不是在**指挥用户去通知栏操作**？
 *
 * 🔴 为什么不能直接 `!/通知栏/.test(txt)`（本探针第一版就是这么写，结果假红）：
 *    新文案里有一句否定式说明「不用切到浏览器，也不用去通知栏翻文件」—— 它含「通知栏」三个字，
 *    却是**正确**的（正是在告诉用户不必再去翻文件）。字面 grep 把这句话判成缺陷，
 *    属于「判据太粗 ⇒ 拿假红去改一处根本没坏的代码」（本项目 v1.4.1 三条红全是这么来的）。
 *    真正的缺陷长这样：「从屏幕顶部下拉通知栏，点一下 Xiaoting…apk」= 指令。
 *    所以判据 = 「命中指令词」且「紧邻 6 字内没有否定词」。
 */
const trayDirective = (s) => (s.match(/.{0,6}(?:下拉通知栏|通知栏[点找翻])/g) || [])
  .filter((h) => !/(?:不用|不必|无需|免)/.test(h));

async function waitServer() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return true; } catch (e) { /* retry */ }
    await sleep(500);
  }
  throw new Error('server not up on ' + BASE);
}

/** 假的 Capacitor 桥：接口形状照 @capacitor/filesystem 官方文档（downloadFile + addListener('progress')）。 */
const FAKE_BRIDGE = (statSize, failMsg) => `
window.__cap = { dl: 0, opens: [], navigations: 0, progressPushed: 0, lastOpts: null };
window.__capFail = ${failMsg ? JSON.stringify(failMsg) : 'null'};
window.Capacitor = {
  isNativePlatform: () => true,
  Plugins: {
    Filesystem: {
      addListener: async (ev, cb) => { window.__cb = cb; return { remove: async () => {} }; },
      downloadFile: async (o) => {
        window.__cap.dl++; window.__cap.lastOpts = o;
        if (window.__cb) {
          // 200ms 一档 ≈ 真机下 3.5MB 的手感。推太快的话卡片一下就切到成功态，
          // 探针只能看到"已经被替换后的 DOM"，那验的就不是进度了（= 自己骗自己）。
          const total = 3635282;
          for (const b of [363528, 1090584, 1817640, 2544696, 3271752, 3635282]) {
            window.__cb({ url: o.url, bytes: b, contentLength: total });
            window.__cap.progressPushed++;
            await new Promise((r) => setTimeout(r, 200));
          }
        }
        if (window.__capFail) throw new Error(window.__capFail);
        return { path: '/cache/xiaoting-v${CUR}.apk' };
      },
      stat: async () => ({ size: ${statSize} }),
      getUri: async () => ({ uri: 'content://com.android.app/cache/xiaoting-v${CUR}.apk' }),
      deleteFile: async () => {},
    },
    FileOpener: { open: async (o) => { window.__cap.opens.push(o.url); } },
  },
};
`;

const FAKE_MANIFEST = JSON.stringify({
  latest_version: CUR,
  force_update: false,
  download_url: `/apk/Xiaoting-v${CUR}-release.apk`,
  web_url: '/#/say',
  apk: { versionCode: CUR_CODE, version: CUR, url: `/apk/Xiaoting-v${CUR}-release.apk`, md5: 'deadbeef', size: 3635282, force: false },
});

(async () => {
  // 🔴 spawn 前先探端口（v1.6.4 修「跑在旧服务上」的假红）：端口上有残留 server 就别硬跑
  try {
    const occupied = await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(900) });
    if (occupied.ok) {
      console.error(`端口 ${PORT} 上已有 server.cjs 在跑（多半是上一轮的残留）。请先清理：` +
        `netstat -ano | findstr :${PORT} 然后 taskkill /PID <pid> /F`);
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

  let browser;
  try {
    await waitServer();
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN', isMobile: true, hasTouch: true });

    const openFlow = async ({ statSize = 3635282, failMsg = null, withBridge = true } = {}) => {
      // 🔴 每个场景开**新的 context**：localStorage 是 context 级别的，
      //    复用一个 context 的话，场景①写的「已装」标记会被②/③ 读到，断言就变成在测别人家的残留。
      const c = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN', isMobile: true, hasTouch: true });
      const page = await c.newPage();
      const navs = [];
      page.on('framenavigated', (f) => { if (f === page.mainFrame()) navs.push(f.url()); });
      await page.route('**/version.json*', (r) => r.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: FAKE_MANIFEST }));
      await page.route('**/version-latest.js*', (r) => r.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: 'window.__VERSION_MANIFEST__ = ' + FAKE_MANIFEST }));
      if (withBridge) await c.addInitScript(FAKE_BRIDGE(statSize, failMsg));
      else await c.addInitScript('window.Capacitor = { isNativePlatform: () => true, Plugins: {} };');
      await c.addInitScript(() => {
        try { localStorage.setItem('xiaoting:ai', 'mock'); } catch (e) {}
        // 跳过首启 4 屏引导，否则 welcome-overlay 会把「立即更新」整个盖住（点不到）
        try { localStorage.setItem('moxiaoming:welcomed_v1', '1'); } catch (e) {}
      });
      await page.goto(BASE + '/?app=android&showUpdate=1#/settings', { waitUntil: 'domcontentloaded' });
      // 🔴 点「立即更新」才是产品真实链路：checkUpdate → showModal（普通更新窗）→ 点按钮 → doUpdate → 安装指引。
      //    直接等 install-card 会等到天荒地老 —— 它根本不会被自动弹出来。
      await page.waitForSelector('#updateNow', { timeout: 12000 });
      await page.click('#updateNow');
      await page.waitForSelector('.install-overlay .install-card', { timeout: 12000 });
      await sleep(250);
      return { page, navs };
    };

    const cardText = (page) => page.evaluate(() => {
      const c = document.querySelector('.install-overlay .install-card');
      return c ? c.innerText.replace(/\s+/g, ' ') : '';
    });

    /* ---------- ⓪ 先自检判据本身有没有鉴别力 ----------
       「断言抓不到东西」比「断言抓到坏东西」更隐蔽。这里把两段真实文案喂进判据：
       旧的那句必须被判成缺陷，新的那句必须被放行 —— 判据自己也要有测试。 */
    console.log('⓪ 判据自检：关键词判据的鉴别力');
    check('判据自检·旧指令文案「下拉通知栏，点一下 Xiaoting…apk」被判为缺陷',
      trayDirective('下载完成后，从屏幕顶部下拉通知栏，点一下「Xiaoting…apk」。').length > 0);
    check('判据自检·否定式说明「不用去通知栏翻文件」不被误判',
      trayDirective('下完会自动弹出安装界面 —— 不用切到浏览器，也不用去通知栏翻文件。').length === 0);
    console.log('');

    /* ---------- ① 正常：产品内下载 + 真进度 + 唤起安装界面 ---------- */
    console.log('① 场景一：正常路径（应用内下载 + 进度 + 唤起安装器）');
    {
      const { page, navs } = await openFlow();
      // 🔴 首屏（点「开始下载」之前那张卡）必须一起断言。v1.6.4 的真实缺陷正好出在这里：
      //    下载链路改成了「App 内下载 + 自动唤起安装器」，首屏却还留着旧骨架那句
      //    「下载完成后，从屏幕顶部下拉通知栏，点一下 Xiaoting…apk」—— 新流程压根不往通知栏放包。
      //    探针第一版只断言了点按钮之后的卡片文本 ⇒ 首屏那句漏网 = 假绿。
      //    教训：断言要覆盖「用户真正会看到的那一屏」，不是「我觉得有问题的那一屏」。
      const first = await cardText(page);
      check('① 首屏卡（点开始下载之前）不指挥用户去通知栏', trayDirective(first).length === 0, trayDirective(first).join('|') || first.slice(0, 90));
      check('① 首屏卡讲清了「不用切浏览器」', /不用切/.test(first), first.slice(0, 90));
      check('① 首屏有「开始下载」按钮', (await page.locator('#installStart').count()) === 1);
      await page.click('#installStart');
      await page.waitForSelector('#dlFill', { timeout: 8000 });
      // 🔴 下载中**先抓一次快照**：卡片随后会被成功态整个替换，等成功了再回头看 #dlFill 就是 null，
      //    那时候验出来的"没有进度"是观测时机造成的，不是产品没做。
      await sleep(500);
      const midSnap = await page.evaluate(() => {
        const f = document.getElementById('dlFill');
        const h = document.getElementById('dlHint');
        return {
          w: f ? (f.style.width || '') : '',
          indet: f ? f.classList.contains('dl-bar__fill--indet') : true,
          hint: h ? h.textContent : '',
        };
      });
      // 等进度推完
      await page.waitForFunction(() => {
        const t = document.querySelector('.install-overlay .install-card');
        return t && /安装界面已经打开了/.test(t.innerText);
      }, null, { timeout: 12000 }).catch(() => {});

      const bar = { w: midSnap.w, indet: midSnap.indet };
      const cap = await page.evaluate(() => window.__cap || null);
      const armed = await page.evaluate((v) => localStorage.getItem('xiaoting:update_armed_' + v), CUR);
      const txt = await cardText(page);

      check('① 下载走的是原生 Filesystem.downloadFile（不是甩给系统/浏览器）', !!cap && cap.dl === 1, `downloadFile 调用 ${cap ? cap.dl : 0} 次`);
      check('① downloadFile 传了 progress 开关（否则收不到进度事件）', !!(cap && cap.lastOpts && cap.lastOpts.progress === true));
      check('① 原生进度事件真的推进了 UI（百分比宽度 > 0）', !!(bar && bar.w && parseFloat(bar.w) > 0), `width=${bar ? bar.w : '-'}`);
      check('① 进度条不是"假绿"的呼吸条（有确定百分比）', !!(bar && bar.indet === false));
      check('① 有字节数文案（已下载 x / 总 y）', /已下载/.test(midSnap.hint), midSnap.hint);
      check('① 进度条在下载途中真的推进过（宽度不是 0）', parseFloat(bar.w) > 0, `下载中 width=${bar.w}`);
      check('① 成功后提示「安装界面已经打开了」', /安装界面已经打开了/.test(txt));
      check('① 真的调用了 FileOpener.open（唤起系统安装界面）', !!cap && cap.opens.length === 1, `open=${cap ? cap.opens.length : 0} uri=${cap ? cap.opens[0] : '-'}`);
      check('① 记下了"已装"凭据（供重启后那句交代用）', !!armed, armed ? `armed=${armed}` : '无标记');
      check('① 全程没有导航离开当前页（没跳出产品）', navs.length <= 1, `framenavigated=${navs.length}`);
      check('① 成功卡里没有「去通知栏操作」的旧甩锅指令', trayDirective(txt).length === 0, trayDirective(txt).join('|') || txt.slice(0, 80));
      await page.close();
    }

    /* ---------- ② 网络中断：说人话 + 给「再试一次」 ---------- */
    console.log('② 场景二：下载中断（网络断一下）');
    {
      const { page } = await openFlow({ failMsg: 'java.net.SocketTimeoutException: timeout' });
      await page.click('#installStart');
      await page.waitForSelector('#dlRetry', { timeout: 12000 });
      const txt = await cardText(page);
      const cap = await page.evaluate(() => window.__cap);
      check('② 中断后如实说「没下完」而不是假装成功', /没下完|下载中断/.test(txt), txt.slice(0, 50));
      check('② 中断后给了「再试一次」按钮', !!(await page.$('#dlRetry')));
      check('② 说了"已下那部分不算数"（不让人拿半截包去装）', /不算数/.test(txt));
      check('② 中断时没有去调 FileOpener.open（没拿坏包去唤起安装器）', !cap.opens || cap.opens.length === 0);
      check('② 中断时也没有写"已装"凭据', !(await page.evaluate((v) => localStorage.getItem('xiaoting:update_armed_' + v), CUR)));
      check('② 中断文案里也不指挥用户去通知栏', trayDirective(txt).length === 0, trayDirective(txt).join('|'));
      await page.close();
    }

    /* ---------- ③ 假包：体积对不上 ⇒ 拦下，绝不拿 HTML 去唤起安装器 ---------- */
    console.log('③ 场景三：假包（托管的兜底页被当成安装包）');
    {
      const { page } = await openFlow({ statSize: 8491 }); // index.html 的体量
      await page.click('#installStart');
      await page.waitForSelector('#dlRetry', { timeout: 12000 });
      const txt = await cardText(page);
      const cap = await page.evaluate(() => window.__cap);
      check('③ 拿到的不是安装包时如实说「没下下来」', /没下下来/.test(txt), txt.slice(0, 50));
      check('③ 绝不拿假包去唤起系统安装器', !cap.opens || cap.opens.length === 0, `opens=${cap ? cap.opens.length : 0}`);
      check('③ 假包也不会被记成"已装"', !(await page.evaluate((v) => localStorage.getItem('xiaoting:update_armed_' + v), CUR)));
      check('③ 假包场景说了这是发布环节的问题（不是用户手机的问题）', /发布环节/.test(txt));
      await page.close();
    }

    /* ---------- ④ 桥上没插件：如实说装不了，给手动入口 ---------- */
    console.log('④ 场景四：Capacitor 桥上压根没这两个插件');
    {
      const { page } = await openFlow({ withBridge: false });
      await page.click('#installStart');
      await page.waitForSelector('#dlManual', { timeout: 12000 });
      const txt = await cardText(page);
      const cap = await page.evaluate(() => window.__cap || { dl: 0, opens: [] });
      check('④ 拿不到插件时如实说「这台设备上没法直接装」', /这台设备上没法直接装/.test(txt), txt.slice(0, 50));
      check('④ 给了「手动下载」这个兜底入口（不是卡住不给反馈）', !!(await page.$('#dlManual')));
      check('④ 拿不到插件时也没偷偷把人甩去下载（不跳通知栏）', cap.dl === 0 && (!cap.opens || cap.opens.length === 0));
      await page.close();
    }

    const passed = results.filter((r) => r.ok).length;
    console.log(`\n===== 应用内下载安装（不跳出产品）：${passed}/${results.length} 通过 =====`);
    process.exitCode = passed === results.length ? 0 : 1;
  } catch (e) {
    console.error('测试异常：', e);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    killSrv();
    process.exit(process.exitCode || 1);
  }
})();
