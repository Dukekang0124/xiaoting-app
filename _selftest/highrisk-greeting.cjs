/**
 * 墨小溟 · 高危时首页停用普通问候（方案 §8 约束 2）真跑自测（v1.6.6）
 *
 * 方案原话：「高危情绪状态，自动切换安全引导文案，停用普通问候」。
 * 此前 `pageSay()` 只区分 quiet 模式，高危用户回到首页看到的仍是一句普通问候。
 *
 * 本探针：在真实浏览器里把 risk 置为 high，看首页那句问候有没有真的换成安全引导文案。
 * 🔴 必须带**反向控制臂**（先 none 后 high）—— 只测"切过去了"证明不了任何事，
 *    因为一段恒定的文案也能"切过去"。
 *
 * run: NODE_PATH=<workspace>/node_modules node _selftest/highrisk-greeting.cjs
 */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const NODE_PATH = process.env.NODE_PATH || '';
if (NODE_PATH) module.paths.push(...NODE_PATH.split(path.delimiter));

const ROOT = path.resolve(__dirname, '..');
const PORT = 4251;
const BASE = 'http://127.0.0.1:' + PORT;
const NODE = 'C:\\Users\\Admin\\.workbuddy\\binaries\\node\\versions\\22.22.2-5\\node.exe';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HOOK = () => {
  try { localStorage.setItem('moxiaoming:welcomed_v1', '1'); } catch (e) { /* ignore */ }
};

(async () => {
  const srv = spawn(NODE, ['server.cjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), STATS_KEY: 'selftest' }, stdio: 'ignore', detached: true });
  const kill = () => { try { process.kill(-srv.pid, 'SIGKILL'); } catch (e) { try { srv.kill('SIGKILL'); } catch (e2) {} } };
  process.on('exit', kill);
  for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch (e) {} await sleep(300); }

  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    console.log('① 正常状态（risk=none）→ 首页应是**普通问候**');
    {
      const ctx = await browser.newContext();
      await ctx.addInitScript(HOOK);
      const page = await ctx.newPage();
      await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
      await sleep(1600);
      const g = await page.locator('.say__greet').innerText();
      check('① 正常状态不显示安全引导文案', !/我很担心你|很担心你/.test(g), `问候="${g}"`);
      await ctx.close();
    }

    console.log('\n② 高危状态（risk=high）→ 首页必须换成**安全引导文案**');
    {
      const ctx = await browser.newContext();
      await ctx.addInitScript(HOOK);
      const page = await ctx.newPage();
      await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
      await sleep(1600);
      const before = await page.locator('.say__greet').innerText();
      // 真实地把 risk 置为 high
      await page.evaluate(async () => {
        const m = await import('/js/store.js');
        m.setState({ risk: { level: 'high', action: 'refer', hit: true, evidence: '测试' } });
      });
      await sleep(800);
      /* 🔴 setState **不会**自动重绘页面 —— store.subscribe 只挂了 renderToast
        （app.js:3625）。真实产品里 risk 变化后必然伴随一次路由动作（go('say')），
        这里用 hash 切换复现它，否则断言验的是"状态变了但屏幕没动"的假象。 */
      await page.goto(BASE + '/#/settings', { waitUntil: 'domcontentloaded' });
      await sleep(700);
      await page.goto(BASE + '/#/say', { waitUntil: 'domcontentloaded' });
      await sleep(1100);
      const after = await page.locator('.say__greet').innerText();
      check('② 高危时首页问候被换成安全引导文案', after !== before && /担心你/.test(after),
        '之前="' + before + '" → 之后="' + after + '"');
      await ctx.close();
    }
  } finally {
    await browser.close();
    kill();
  }

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n===== 高危停用普通问候：${pass}/${results.length} 通过 =====`);
  if (pass !== results.length) {
    console.log('失败项：');
    results.filter((r) => !r.ok).forEach((r) => console.log('  - ' + r.name));
  }
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('运行异常：', e && e.message || e); process.exit(1); });
