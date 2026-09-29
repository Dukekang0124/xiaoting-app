/**
 * 墨小溟 v0.5.0 · 云端 ASR 端到端真跑自测
 * =====================================================================
 * 这个文件只回答一个问题：**在「内置语音识别不可用」的真机环境（iOS Safari / 微信内置浏览器）
 * 里，用户按住说、松手，到底能不能拿到文字？**
 *
 * 做法：把一段已知标准答案的中文音频当作「麦克风输入」喂给本机 Chrome
 * （--use-file-for-fake-audio-capture），然后真的按住按钮、真的松手，
 * 让浏览器跑完 录音 → 解码 → 重采样 16k → WAV → base64 → POST /api/asr → 百度 → 转写
 * 这整条链路，最后拿回来的文字跟标准答案逐字比。
 *
 * 为什么必须这么测：只测「接口返回 200」是没有意义的 —— 真正会坏的从来不是某一段函数，
 * 而是段与段之间的缝（音频格式、采样率、字节长度、时序）。这些缝只有跑完整链路才暴露。
 *
 * 运行：
 *   NODE_PATH="C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules" \
 *   ASR_KEYS_FILE="<密钥文件路径>" node _selftest/asr-e2e.cjs
 *
 * 不传 ASR_KEYS_FILE 时，需要真实识别的用例会标记 SKIP（其余降级/安全用例照跑），
 * 让这个脚本在「没密钥的机器」上也不会红一片 —— 但报告里必须能看出哪些是真跑过的。
 */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const NODE = process.execPath;
const PORT = Number(process.env.ASR_TEST_PORT || 8795);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');
const KEYS_FILE = process.env.ASR_KEYS_FILE || '';
const FIXTURE = process.env.ASR_FIXTURE || 'D:/_tmp/asrfix/zh1.wav';
const GROUND = process.env.ASR_GROUND || '今天又和男朋友吵架了，他很晚才回我消息，我觉得他根本不在乎我。';
const RECORD_MS = Number(process.env.ASR_RECORD_MS || 7600); // 音频 7.3s，录久一点确保整段进去
const OUT = path.join(__dirname, 'shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const results = [];
const sections = [];
const sec = (name) => { sections.push({ name, n: results.length }); console.log(`\n===== 分区 ${name} =====`); };
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail: String(detail || '') });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const skip = (name, why) => {
  results.push({ name, ok: true, skipped: true, detail: why });
  console.log(`SKIP  ${name}  — ${why}`);
};
const sectionCounts = () => sections.map((s, i) => {
  const end = i + 1 < sections.length ? sections[i + 1].n : results.length;
  return { 分区: s.name, 条数: end - s.n };
});

/** 只留汉字，用来做逐字比对（标点与空白不计入错误） */
const han = (s) => String(s || '').replace(/[^\u4e00-\u9fa5]/g, '');
function levenshtein(a, b) {
  const m = a.length; const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[m][n];
}

/* ---------------- 起服务端 ---------------- */

function startServer(extraEnv = {}) {
  const env = { ...process.env, PORT: String(PORT), STATS_KEY: 'e2e-key', ...extraEnv };
  if (KEYS_FILE) env.ASR_KEYS_FILE = KEYS_FILE;
  else delete env.ASR_KEYS_FILE;
  const p = spawn(NODE, [path.join(ROOT, 'server.cjs')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => process.stdout.write('[server] ' + d.toString()));
  p.stderr.on('data', (d) => process.stderr.write('[server:err] ' + d.toString()));
  return p;
}

async function waitHealth(expectAsr) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + '/api/health');
      const j = await r.json();
      if (!expectAsr || j.asr === expectAsr) return j;
    } catch (e) { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/* ---------------- 浏览器场景 ---------------- */

const LAUNCH_ARGS = [
  // 这两个开关必须成对出现，否则会得到一个极具误导性的失败：
  //   --use-fake-ui-for-media-stream     只负责"自动授权"，不伪造设备
  //   --use-fake-device-for-media-stream 负责造出 Fake Default Audio Input
  // 只给前者时 getUserMedia 抛 NotFoundError（Requested device not found），
  // 表现为"录到了 0 字节"，很容易被误判成重采样或接口的 bug —— 本次就踩了这个坑。
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
];

async function newCtx(browser, { noSpeechRecognition = false, fakeSpeechRecognition = null, denyMicrophone = null } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    permissions: ['microphone'],
    serviceWorkers: 'block', // 铁律：不挡 SW 就会拿到线上缓存里的旧 JS，测的其实是旧代码
  });
  if (denyMicrophone) {
    // 把 getUserMedia 确定性地打回失败。
    // 为什么不能靠"不传 --use-fake-device-for-media-stream"来制造这个场景：
    // 那样取决于这台机器到底有没有音频输入设备 —— 同一份代码两次运行结论不同（本机就发生过：
    // 第一次 NotFoundError，第二次 Chrome 找到了真实麦克风，断言直接翻红）。
    // 断言的前提必须由测试自己决定，不能交给环境。
    await ctx.addInitScript((name) => {
      const install = () => {
        const md = navigator.mediaDevices;
        if (!md || !md.getUserMedia) return false;
        md.getUserMedia = () => Promise.reject(Object.assign(new Error('stubbed: ' + name), { name }));
        return true;
      };
      if (!install()) document.addEventListener('DOMContentLoaded', install);
    }, denyMicrophone);
  }
  if (noSpeechRecognition) {
    // 模拟 iOS Safari / 微信内置浏览器：WKWebView 不暴露 SpeechRecognition。
    // 这是本次攻坚的核心场景，旧版代码正是在这里把用户直接踢去打字页。
    await ctx.addInitScript(() => {
      try { delete window.SpeechRecognition; } catch (e) {}
      try { delete window.webkitSpeechRecognition; } catch (e) {}
      Object.defineProperty(window, 'SpeechRecognition', { value: undefined, configurable: true });
      Object.defineProperty(window, 'webkitSpeechRecognition', { value: undefined, configurable: true });
    });
  }
  if (fakeSpeechRecognition) {
    // 内置识别的契约替身：用来验证"云端识别挂了，内置兜底还在"这条分支。
    await ctx.addInitScript((text) => {
      window.__srText = text;
      class FakeSR {
        constructor() { this.lang = ''; this.continuous = false; this.interimResults = false; }
        start() { window.__srStarted = true; setTimeout(() => { this.onresult && this.onresult({ results: [[{ transcript: window.__srText || '' }]] }); }, 150); }
        stop() { window.__srEnded = true; }
      }
      window.SpeechRecognition = FakeSR;
      window.webkitSpeechRecognition = FakeSR;
    }, fakeSpeechRecognition);
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message ? e.message : e)));
  return { ctx, page, errors };
}

/** 真按住、真松手：用真实鼠标事件（isTrusted=true），拿到和用户一致的事件时序 */
async function pressHold(page, ms) {
  const box = await page.locator('#talkbtn').boundingBox();
  if (!box) throw new Error('找不到 #talkbtn');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

const transcriptOf = (page) => page.evaluate(async () => {
  const t = await import('/js/app.js').then((m) => m.__test__);
  const d = t.store.getState().draft;
  return { transcript: (d && d.transcript) || '', route: location.hash, cap: t.CAP };
});

/** 埋点是攒批发送的（8 条或 5 秒），测试里必须显式推一把，否则关页面时还没送出去 */
const flushEvents = async (page) => {
  await page.evaluate(async () => {
    const m = await import('/js/asr.js');
    await m.flushEvents();
  }).catch(() => {});
  await page.waitForTimeout(250);
};

/* ==================== 主流程 ==================== */

(async () => {
  if (!fs.existsSync(FIXTURE)) {
    console.error(`缺少测试音频：${FIXTURE}\n（用 edge-tts 合成中文再 ffmpeg 转 16k 单声道 WAV 即可，见测试报告 §方法）`);
    process.exit(2);
  }

  let server = startServer();
  let health = await waitHealth();
  const asrReady = !!(health && health.asr === 'ready');
  console.log(`服务端 v${health && health.version} asr=${health && health.asr} key_source=${health && health.key_source}`);

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: [...LAUNCH_ARGS, `--use-file-for-fake-audio-capture=${FIXTURE.replace(/\\/g, '/')}`],
  });

  /* ---------- 分区 S1：iOS/微信场景（无内置识别）走通云端 ASR ---------- */
  sec('S1 无内置识别的真机场景（iOS/微信）');
  {
    const { ctx, page, errors } = await newCtx(browser, { noSpeechRecognition: true });
    await page.goto(BASE + '/#/say', { waitUntil: 'load' });
    await page.waitForTimeout(400);

    const cap = await page.evaluate(async () => (await import('/js/app.js').then((m) => m.__test__)).CAP);
    check('S1·能力探测：无内置识别但可录音（旧代码就在这里误判）',
      cap.webSpeech === false && cap.canRecord === true, JSON.stringify(cap));

    const pressBox = await page.locator('#talkbtn').boundingBox();
    check('S1·按钮可见可点', !!pressBox && pressBox.width > 0 && pressBox.height > 0,
      pressBox ? `${Math.round(pressBox.width)}x${Math.round(pressBox.height)}` : 'none');

    // 关键回归：按住之后绝不能跳到打字页
    await page.mouse.move(pressBox.x + pressBox.width / 2, pressBox.y + pressBox.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(700);
    const mid = await page.evaluate(() => ({
      hash: location.hash,
      recording: document.body.classList.contains('recording'),
      liveHidden: document.getElementById('liveWrap') ? document.getElementById('liveWrap').hidden : null,
      liveText: (document.getElementById('liveText') || {}).textContent || '',
      label: (document.getElementById('talkLabel') || {}).textContent || '',
    }));
    check('S1·按住不跳打字页（v1.3 核心回归）', !mid.hash.includes('record?mode=text'), `hash=${mid.hash}`);
    check('S1·进入录音态且显示聆听面板', mid.recording && mid.liveHidden === false, JSON.stringify(mid));
    // 没有实时字幕时，屏幕上是轮播的安抚话术（"我在听……"），而不是 HTML 里那个死的占位"……"
    check('S1·无实时字幕时屏幕有活气（不是一片死寂的占位）',
      mid.liveText.trim() !== '……' && mid.liveText.trim().length >= 3, `「${mid.liveText}」`);

    await page.waitForTimeout(Math.max(0, RECORD_MS - 700));
    await page.mouse.up();

    if (!asrReady) {
      skip('S1·云端识别结果与标准答案一致', '未提供 ASR_KEYS_FILE，服务端没有密钥');
      skip('S1·识别后进入分析流程', '同上');
    } else {
      let got = null;
      try {
        await page.waitForFunction(() => location.hash.includes('analyzing'), null, { timeout: 40000 });
        got = await transcriptOf(page);
      } catch (e) {
        got = await transcriptOf(page).catch(() => null);
      }
      const said = han(got && got.transcript);
      const want = han(GROUND);
      const dist = levenshtein(said, want);
      const cer = want.length ? dist / want.length : 1;
      check('S1·云端识别结果与标准答案一致（字错误率 ≤ 5%）', !!said && cer <= 0.05,
        `识别「${got ? got.transcript : ''}」 CER=${(cer * 100).toFixed(1)}%`);
      check('S1·识别后进入分析流程', !!(got && got.route.includes('analyzing')), got ? got.route : 'n/a');
      await flushEvents(page);
      await page.screenshot({ path: path.join(OUT, 'asr-e2e-01-ios-wechat-cloud-ok.png'), fullPage: true });
    }

    check('S1·全程无 JS 异常', errors.length === 0, errors.slice(0, 2).join(' | '));
    await ctx.close();
  }

  /* ---------- 分区 S2：云端不可用时的降级（不白屏） ---------- */
  sec('S2 云端不可用降级');
  {
    const { ctx, page, errors } = await newCtx(browser, { noSpeechRecognition: true });
    // 把识别端点打回 503：这正是「未配密钥」在生产上的真实响应
    await page.route('**/api/asr', (route) => route.fulfill({
      status: 503, contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: 'asr_not_configured' }),
    }));
    await page.goto(BASE + '/#/say', { waitUntil: 'load' });
    await page.waitForTimeout(300);
    await pressHold(page, 2200);
    await page.waitForTimeout(1200);

    const st = await page.evaluate(() => ({
      hash: location.hash,
      route: document.body.dataset.route,
      viewLen: (document.getElementById('view') || {}).innerHTML ? document.getElementById('view').innerHTML.length : 0,
      toast: (document.querySelector('.toast') || {}).textContent || '',
      recording: document.body.classList.contains('recording'),
    }));
    check('S2·识别失败不白屏（页面仍有内容）', st.viewLen > 200, `view=${st.viewLen} hash=${st.hash}`);
    check('S2·给出人话提示，并指向打字这条路',
      st.toast.includes('打字') && !/undefined|\[object/.test(st.toast), st.toast);
    check('S2·失败后退出录音态（不会卡在录音中）', st.recording === false, `recording=${st.recording}`);
    check('S2·没有跳到别的页面', !st.hash.includes('analyzing'), st.hash);
    check('S2·全程无 JS 异常', errors.length === 0, errors.slice(0, 2).join(' | '));
    await flushEvents(page);
    await page.screenshot({ path: path.join(OUT, 'asr-e2e-02-degrade-no-blank.png'), fullPage: true });
    await ctx.close();
  }

  /* ---------- 分区 S2b：云端挂了，但内置识别有结果 → 不能用兜底把流程一起丢 ---------- */
  sec('S2b 云端失败 + 内置兜底');
  {
    const SR_TEXT = '我就是觉得他不在乎我';
    const { ctx, page, errors } = await newCtx(browser, { fakeSpeechRecognition: SR_TEXT });
    await page.route('**/api/asr', (route) => route.fulfill({
      status: 502, contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: 'asr_failed', err_no: 3301, hint: '音频质量过差（太短/太小/全是噪音）' }),
    }));
    await page.goto(BASE + '/#/say', { waitUntil: 'load' });
    await page.waitForTimeout(300);
    await pressHold(page, 2200);

    let route2 = '';
    try {
      await page.waitForFunction(() => location.hash.includes('analyzing'), null, { timeout: 20000 });
      route2 = await page.evaluate(() => location.hash);
    } catch (e) { route2 = await page.evaluate(() => location.hash); }
    const draft = await transcriptOf(page);
    check('S2b·云端失败时用内置转写继续（不把兜底一起丢）', route2.includes('analyzing'), route2);
    check('S2b·带进草稿的是内置识别的那句', draft.transcript.trim() === SR_TEXT, `「${draft.transcript}」`);
    check('S2b·全程无 JS 异常', errors.length === 0, errors.slice(0, 2).join(' | '));
    await flushEvents(page);
    await ctx.close();
  }

  /* ---------- 分区 S3：接口契约与安全边界 ---------- */
  sec('S3 接口契约与安全边界');
  {
    const { ctx, page } = await newCtx(browser);
    await page.goto(BASE + '/#/say', { waitUntil: 'load' });

    const probe = await page.evaluate(async (base) => {
      const hit = async (p, opt) => {
        try { const r = await fetch(base + p, opt); let j = null; try { j = await r.json(); } catch (e) {} return { s: r.status, j }; }
        catch (e) { return { s: 0, err: String(e) }; }
      };
      return {
        serverCjs: await hit('/server.cjs'),
        pkg: await hit('/package.json'),
        keysExample: await hit('/server/asr.keys.example.json'),
        readme: await hit('/README.md'),
        statsNoKey: await hit('/api/stats'),
        statsBadKey: await hit('/api/stats?key=wrong'),
        statsOk: await hit('/api/stats?key=e2e-key'),
        asrGet: await hit('/api/asr'),
        asrEmpty: await hit('/api/asr', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ speech: '', lang: 'zh' }) }),
        asrHuge: await hit('/api/asr', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ speech: 'A'.repeat(3000001), lang: 'zh' }) }),
        health: await hit('/api/health'),
      };
    }, BASE);

    check('S3·服务端源码不外泄', probe.serverCjs.s === 404, 'HTTP ' + probe.serverCjs.s);
    check('S3·package.json 不外泄', probe.pkg.s === 404, 'HTTP ' + probe.pkg.s);
    check('S3·密钥示例文件不外泄', probe.keysExample.s === 404, 'HTTP ' + probe.keysExample.s);
    check('S3·README 不外泄', probe.readme.s === 404, 'HTTP ' + probe.readme.s);
    check('S3·埋点统计端点需要密钥（无 key → 404，不暴露端点存在性）', probe.statsNoKey.s === 404, 'HTTP ' + probe.statsNoKey.s);
    check('S3·埋点统计端点错 key → 404', probe.statsBadKey.s === 404, 'HTTP ' + probe.statsBadKey.s);
    check('S3·正确 key 可读统计并返回内测四项指标',
      probe.statsOk.s === 200 && probe.statsOk.j && probe.statsOk.j.metrics
      && 'recording_success_rate' in probe.statsOk.j.metrics && 'card_save_rate' in probe.statsOk.j.metrics,
      probe.statsOk.j ? JSON.stringify(probe.statsOk.j.metrics) : 'HTTP ' + probe.statsOk.s);
    check('S3·ASR 端点拒绝非 POST（浏览器直开不会执行识别）', probe.asrGet.s === 405, 'HTTP ' + probe.asrGet.s);
    check('S3·空音频 → 400 empty_audio', probe.asrEmpty.s === 400 && probe.asrEmpty.j.error === 'empty_audio',
      `HTTP ${probe.asrEmpty.s} ${probe.asrEmpty.j && probe.asrEmpty.j.error}`);
    check('S3·超长音频 → 413 audio_too_long（防额度被刷）', probe.asrHuge.s === 413 && probe.asrHuge.j.error === 'audio_too_long',
      `HTTP ${probe.asrHuge.s} ${probe.asrHuge.j && probe.asrHuge.j.error}`);
    check('S3·health 不回密钥文件名（只给粗粒度来源）',
      probe.health.s === 200 && !/密钥|\.txt|asr\.keys/.test(JSON.stringify(probe.health.j)),
      JSON.stringify(probe.health.j));
    await ctx.close();
  }

  /* ---------- 分区 S3b：拿不到麦克风时不能假装在录 ---------- */
  sec('S3b 拿不到麦克风的情形');
  {
    // 两种失败原因分开覆盖：没有设备（NotFoundError）与用户拒绝授权（NotAllowedError），
    // 用户看到的提示应该不一样 —— 前者是环境问题，后者是"你刚才点了不允许"。
    const CASES = [
      { name: 'NotFoundError', expect: /麦克风/, why: '没有输入设备' },
      { name: 'NotAllowedError', expect: /权限/, why: '用户拒绝授权' },
    ];
    for (const c of CASES) {
      const { ctx, page, errors } = await newCtx(browser, { noSpeechRecognition: true, denyMicrophone: c.name });
      await page.goto(BASE + '/#/say', { waitUntil: 'load' });
      await page.waitForTimeout(300);
      // 前提自证：替身没装上就等于什么都没测，必须响亮地失败而不是静默通过
      const stubbed = await page.evaluate(() => {
        try { return String(navigator.mediaDevices.getUserMedia).includes('stubbed'); } catch (e) { return false; }
      });
      check(`S3b(${c.why}) 测试前提成立：getUserMedia 已被打回失败`, stubbed, stubbed ? 'ok' : '替身未生效');
      const box = await page.locator('#talkbtn').boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(900);
      const afterDown = await page.evaluate(() => ({
        hash: location.hash,
        recording: document.body.classList.contains('recording'),
        toast: (document.querySelector('.toast') || {}).textContent || '',
      }));
      await page.mouse.up();
      await page.waitForTimeout(400);
      const st = await page.evaluate(() => ({
        hash: location.hash,
        viewLen: (document.getElementById('view') || {}).innerHTML ? document.getElementById('view').innerHTML.length : 0,
      }));
      check(`S3b(${c.why}) 不进入"录音中"的假状态`, afterDown.recording === false, JSON.stringify(afterDown));
      check(`S3b(${c.why}) 提示说清是哪一类问题，并指向打字`,
        c.expect.test(afterDown.toast) && /打字/.test(afterDown.toast), afterDown.toast);
      check(`S3b(${c.why}) 直接送到打字页，不浪费用户时间`, st.hash.includes('record?mode=text'), st.hash);
      // 注意：跳转后 #talkLabel 已不在 DOM（那是首页的元素），所以这里只验"页面正常落地且能直接打字"
      const textPage = await page.evaluate(() => !!document.getElementById('recInput'));
      check(`S3b(${c.why}) 不白屏且落在打字页（落地即可输入）`,
        st.viewLen > 200 && textPage, `view=${st.viewLen} recInput=${textPage}`);
      check(`S3b(${c.why}) 全程无 JS 异常`, errors.length === 0, errors.slice(0, 2).join(' | '));
      await flushEvents(page);
      await ctx.close();
    }
  }

  /* ---------- 分区 S4：埋点真的落盘（§4 地基） ---------- */
  sec('S4 埋点落盘');
  {
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(ROOT, 'data', `events-${day}.jsonl`);
    let lines = [];
    try { lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean); } catch (e) { lines = []; }
    const parsed = lines.map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
    const names = [...new Set(parsed.map((e) => e.name))].sort();
    check('S4·埋点文件已生成且是合法 JSONL', parsed.length > 0 && parsed.length === lines.length,
      `${parsed.length} 行 / ${lines.length}`);
    check('S4·含 ASR 结果事件（录音成功率的分母分子）',
      names.includes('asr_ok') || names.includes('asr_fail'), names.join(','));
    check('S4·埋点不含用户正文（只允许计数/枚举/短码）', parsed.every((e) => {
      const hj = JSON.stringify(e.data || {});
      return !/[\u4e00-\u9fa5]{4,}/.test(hj);
    }), names.join(','));
  }

  await browser.close();
  server.kill();

  /* ---------- 汇总 ---------- */
  const failed = results.filter((r) => !r.ok);
  const skipped = results.filter((r) => r.skipped);
  console.log('\n==== 分区条数 ====');
  sectionCounts().forEach((s) => console.log(`${s.分区}: ${s.条数}`));
  console.log(`\n==== 结果 ====`);
  console.log(`通过 ${results.length - failed.length - skipped.length} / 跳过 ${skipped.length} / 失败 ${failed.length} / 共 ${results.length}`);
  if (failed.length) failed.forEach((f) => console.log(`  FAIL ${f.name} — ${f.detail}`));
  const outFile = path.join(OUT, 'asr-e2e-output.txt');
  fs.writeFileSync(outFile, results.map((r) => `${r.skipped ? 'SKIP' : (r.ok ? 'PASS' : 'FAIL')}\t${r.name}\t${r.detail}`).join('\n')
    + '\n\n' + sectionCounts().map((s) => `${s.分区}\t${s.条数}`).join('\n') + '\n');
  console.log(`输出已写入 ${outFile}`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
