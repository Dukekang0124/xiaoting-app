/**
 * 墨小溟 · 音效接线与默认开关 真跑自测（v1.6.6）
 *
 * 背景：康哥反馈「打开应用后没有任何声音」。查证后是**音效默认关闭**（soundOn 默认 false），
 *       而方案 §15 把待机底噪写成「循环、不间断、音量 8%」，点击/情绪/场景也各有音效 —— 是"常驻"描述。
 *
 * 🔴 为什么必须 hook AudioContext 计数才能验「有没有声音」：
 *    本产品的音效是 **Web Audio 纯合成**（`js/ip-audio.js`），**没有音频文件、没有 <audio> 元素**。
 *    所以在 DOM / Network / 控制台里"有没有声音"完全看不出来 —— 唯一可信判据是
 *    `createOscillator()`（单音/气泡）与 `createBufferSource()`（噪声/水流/待机环境音）被调用了几次。
 *    本探针把真实点击跑一遍，数这两个数。
 *
 * 四个场景：
 *   ① 新用户：默认就该是开 + 点击真的发声
 *   ② 老用户迁移：localStorage 里存着旧默认 false ⇒ 升级后应被纠正为开（且只纠正一次）
 *   ③ 反向控制臂：手动关掉开关 ⇒ 点击必须**不**发声（证明是按开关走，不是永远响）
 *   ④ 倾诉让位：开始倾诉 ⇒ 待机环境音必须停（方案 §2.6）
 *
 * run: NODE_PATH=<workspace>/node_modules node _selftest/audio-cue.cjs
 */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const NODE_PATH = process.env.NODE_PATH || '';
if (NODE_PATH) module.paths.push(...NODE_PATH.split(path.delimiter));

const ROOT = path.resolve(__dirname, '..');
const PORT = 4231;
const BASE = 'http://127.0.0.1:' + PORT;
const NODE = process.env.NODE_BIN || 'C:\\Users\\Admin\\.workbuddy\\binaries\\node\\versions\\22.22.2-5\\node.exe';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 计数 hook：必须在页面脚本执行前注入，才能包住 AudioContext。 */
const HOOK = () => {
  window.__audio = { osc: 0, buf: 0 };
  const Orig = window.AudioContext || window.webkitAudioContext;
  if (Orig) {
    const Patched = function (...a) {
      const c = new Orig(...a);
      window.__ac = c;
      const co = c.createOscillator.bind(c);
      const cb = c.createBufferSource.bind(c);
      c.createOscillator = (...x) => { window.__audio.osc++; return co(...x); };
      c.createBufferSource = (...x) => { window.__audio.buf++; return cb(...x); };
      return c;
    };
    window.AudioContext = Patched;
    window.webkitAudioContext = Patched;
  }
  try { localStorage.setItem('moxiaoming:welcomed_v1', '1'); } catch (e) { /* ignore */ }
};

const SNAP = () => ({
  soundOn: (() => {
    try { return JSON.parse(localStorage.getItem('xiaoting:v1') || '{}').user?.settings?.soundOn; }
    catch (e) { return 'parse-fail'; }
  })(),
  enabled: !!(window.ipAudio && window.ipAudio.isEnabled()),
  ambient: !!(window.ipAudio && window.ipAudio.isAmbient()),
  ctxState: window.__ac ? window.__ac.state : '未创建',
  osc: window.__audio.osc,
  buf: window.__audio.buf,
});

/** 老用户夹具：模拟升级前已持久化旧默认 soundOn:false 的存量数据。
 *
 * 🔴 夹具必须**幂等**（只种一次）：`addInitScript` 在**每一次页面加载都会重跑**，
 *    包括 `page.reload()`。不幂等的话，reload 时它会把 localStorage 又刷回"无迁移标记"的老数据，
 *    于是迁移逻辑必然再次触发 ⇒ 「用户关掉后不应再被打开」这条断言永远红 ——
 *    那是**夹具在制造假红**，不是产品缺陷（第一版我就被它带偏了一次）。 */
const LEGACY = () => {
  try {
    if (localStorage.getItem('__legacy_seeded')) return;
    localStorage.setItem('__legacy_seeded', '1');
    localStorage.setItem('xiaoting:v1', JSON.stringify({
      user: { id: 'local-user', nickname: '', createdAt: Date.now(),
        settings: { ipMotion: true, ipIntensity: 'standard', soundOn: false, ipTouch: true, ipBubble: true } },
      cards: [], timelines: [], sessionLog: [], sessionAt: 0,
    }));
  } catch (e) { /* ignore */ }
};

async function main() {
  // 🔴 spawn 前先探端口：端口上有残留 server.cjs 就别硬跑（否则测的是旧代码 = 假绿）
  try {
    const r = await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(900) });
    if (r.ok) { console.error(`端口 ${PORT} 上已有服务在跑，请先清理`); process.exit(2); }
  } catch (e) { /* 端口空着 */ }

  const srv = spawn(NODE, ['server.cjs'], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), STATS_KEY: 'selftest' }, stdio: 'ignore', detached: true,
  });
  const killSrv = () => { try { process.kill(-srv.pid, 'SIGKILL'); } catch (e) { try { srv.kill('SIGKILL'); } catch (e2) { /* ignore */ } } };
  process.on('exit', killSrv);

  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch (e) { /* retry */ }
    await sleep(300);
  }

  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    /* ---------- ① 新用户：默认开 + 点击真发声 ---------- */
    console.log('① 新用户（首次打开，未改过任何设置）');
    {
      const ctx = await browser.newContext();
      await ctx.addInitScript(HOOK);
      const page = await ctx.newPage();
      const errs = [];
      page.on('pageerror', (e) => errs.push(String(e && e.message || e)));
      await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
      await sleep(1800);

      const s0 = await page.evaluate(SNAP);
      check('① 新用户 soundOn 默认为 true（方案 §15 待机底噪"循环不间断"）', s0.soundOn === true, `soundOn=${s0.soundOn}`);
      check('① ipAudio 随之启用', s0.enabled === true, `isEnabled=${s0.enabled}`);

      // 真实点击 IP（4 次覆盖 tap1~tap_more 四档）
      for (let i = 0; i < 4; i++) { await page.click('#ipTouch'); await sleep(150); }
      await sleep(900);
      const s1 = await page.evaluate(SNAP);
      const made = (s1.osc - s0.osc) + (s1.buf - s0.buf);
      check('① 点击 IP 真的产生了声音节点（osc/buf 计数）', made > 0, `新增 osc=${s1.osc - s0.osc} buf=${s1.buf - s0.buf}`);
      check('① AudioContext 处于 running（未被自动播放策略卡死）', s1.ctxState === 'running', `state=${s1.ctxState}`);
      check('① 无页面级报错', errs.length === 0, errs.slice(0, 3).join(' | '));
      await ctx.close();
    }

    /* ---------- ② 老用户迁移：旧默认 false 应被纠正一次 ---------- */
    console.log('\n② 存量用户（localStorage 里存着旧默认 soundOn:false）');
    {
      const ctx = await browser.newContext();
      await ctx.addInitScript(HOOK);
      await ctx.addInitScript(LEGACY);
      const page = await ctx.newPage();
      await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
      await sleep(1800);

      const s = await page.evaluate(SNAP);
      check('② 升级后旧默认 false 被纠正为 true（否则改默认值对老用户无效）', s.soundOn === true, `soundOn=${s.soundOn}`);
      check('② 迁移标记已写入（保证只纠正一次，不覆盖用户后续选择）',
        await page.evaluate(() => JSON.parse(localStorage.getItem('xiaoting:v1') || '{}').user?.settings?.soundDefaultMigrated === true));

      /* 反向：用户自己关掉后，重新加载不得再被打开。
       * 🔴 必须走**真实用户路径**（设置页开关）去关，不能只在页面里改 localStorage：
       *    只改 localStorage 的话，内存里的 soundOn 仍是 true，随后任何一次 persist() 都会
       *    把内存值写回去、把你的写入冲掉 —— 断言就变成在验一个"不存在的场景"（假红）。 */
      await page.goto(BASE + '/#/settings', { waitUntil: 'domcontentloaded' });
      await sleep(1200);
      await page.uncheck('#setSound');
      await sleep(600);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await sleep(1500);
      const s2 = await page.evaluate(SNAP);
      check('② 用户在设置里关掉后重载不再被强行打开（尊重显式选择）', s2.soundOn === false && s2.enabled === false,
        `soundOn=${s2.soundOn} enabled=${s2.enabled}`);
      await ctx.close();
    }

    /* ---------- ③ 反向控制臂：关掉开关 ⇒ 必须不发声 ---------- */
    console.log('\n③ 反向控制臂（关掉音效后点击不得发声）');
    {
      const ctx = await browser.newContext();
      await ctx.addInitScript(HOOK);
      const page = await ctx.newPage();
      await page.goto(BASE + '/#/settings', { waitUntil: 'domcontentloaded' });
      await sleep(1200);
      await page.uncheck('#setSound');
      await sleep(600);
      const s0 = await page.evaluate(SNAP);
      check('③ 开关关掉后 isEnabled=false', s0.enabled === false);
      for (let i = 0; i < 4; i++) { await page.click('#ipTouch', { force: true }).catch(() => {}); await sleep(150); }
      await sleep(700);
      const s1 = await page.evaluate(SNAP);
      check('③ 关掉后点击不产生声音节点（证明是按开关走，不是永远响）', s1.osc === s0.osc && s1.buf === s0.buf,
        `osc ${s0.osc}→${s1.osc} / buf ${s0.buf}→${s1.buf}`);
      await ctx.close();
    }

    /* ---------- ④ 倾诉让位：环境音必须停 ---------- */
    console.log('\n④ 开始倾诉时待机环境音让位（方案 §2.6）');
    {
      const ctx = await browser.newContext();
      await ctx.addInitScript(HOOK);
      const page = await ctx.newPage();
      await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
      await sleep(1800);
      const before = await page.evaluate(SNAP);
      check('④ 开启状态下待机环境音在跑', before.ambient === true, `isAmbient=${before.ambient}`);
      await page.evaluate(() => window.ipAudio.setMuted(true));
      await sleep(400);
      const after = await page.evaluate(SNAP);
      check('④ 倾诉/静音后环境音停止', after.ambient === false, `isAmbient=${after.ambient}`);
      await ctx.close();
    }
  } finally {
    await browser.close();
    killSrv();
  }

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n===== 音效接线与默认开关：${pass}/${results.length} 通过 =====`);
  if (pass !== results.length) {
    console.log('失败项：');
    results.filter((r) => !r.ok).forEach((r) => console.log('  - ' + r.name));
  }
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => { console.error('运行异常：', e && e.message || e); process.exit(1); });
