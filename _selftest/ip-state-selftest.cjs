// 墨小溟 v1.3.0 · IP 情绪状态机与视觉联动 真跑自测 + 屏幕录制（本机 Chrome）
// 运行：NODE_PATH=<受管 node_modules> node _selftest/ip-state-selftest.cjs
// 覆盖：① 真实文本提交→本地分析→情绪渲染链路（愤怒/悲伤） ② 全调色板 studio 渲染（11 态）
//      ③ receiving 接收节点（气泡+墨汁波纹） ④ danger 高危截断（柔光环+停特效）
//      ⑤ 总开关一键关全部动画 ⑥ IP 点击轻互动/安静陪伴/问候/开场回应/我页
//      ⑦ §三 色彩过渡是真插值而非硬切（A/B 双臂） ⑧ §三.4 3 分钟无交互自动回归 idle（含对照臂）
//      ⑨ 无运行时报错 ⑩ 屏幕录制 webm 作为验收证据
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const PORT = 4188; // 避开主自测 4173 / 手势 4175 / 不良端口 4190
const BASE = 'http://127.0.0.1:' + PORT;
const NODE = 'C:\\Users\\Admin\\.workbuddy\\binaries\\node\\versions\\22.22.2-3\\node.exe';
const OUT = path.join(__dirname, 'ip-shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
const VIDEO_DIR = path.join(__dirname, 'ip-video');
if (!fs.existsSync(VIDEO_DIR)) fs.mkdirSync(VIDEO_DIR, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail: String(detail || '') });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

async function waitServer() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return true; } catch (e) { /* retry */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('server not up on ' + BASE);
}

const goto = (page, h) => page.goto(BASE + h, { waitUntil: 'domcontentloaded' });
const settle = async (page) => {
  await page.waitForFunction(() => !document.querySelector('.toast.toast--on'), null, { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(620); // 让 @property 颜色过渡与入场动画稳定
};
const waitRoute = async (page, name) => {
  await page.waitForFunction((n) => { try { return (window.location.hash || '').replace('#/', '').split('?')[0] === n || (window.__t && window.__t.store.getState().route === n); } catch (e) { return false; } }, name, { timeout: 12000 }).catch(() => {});
};

(async () => {
  const srv = spawn(NODE, ['server.cjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), STATS_KEY: 'selftest' },
    stdio: 'ignore',
  });
  let browser;
  try {
    await waitServer();
    browser = await chromium.launch({
      channel: 'chrome', headless: true,
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
    });
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'zh-CN', isMobile: true, hasTouch: true,
      recordVideo: { dir: VIDEO_DIR, size: { width: 390, height: 844 } },
    });
    const page = await ctx.newPage();
    // 暴露 app.__test__ 到 window.__t（页面已 boot，动态 import 复用同一实例），并强制 mock 本地规则引擎 + 跳过欢迎
    await ctx.addInitScript(() => {
       try { localStorage.setItem('monthly:done_' + (new Date().getFullYear() * 100 + (new Date().getMonth() + 1)), '1'); } catch (e) {}
      try { localStorage.setItem('xiaoting:ai', 'mock'); localStorage.setItem('moxiaoming:welcomed_v1', '1'); } catch (e) {}
      const tick = setInterval(() => { if (!window.__t) { import('/js/app.js').then((m) => { window.__t = m.__test__; }).catch(() => {}); } else clearInterval(tick); }, 50);
      setTimeout(() => clearInterval(tick), 4000);
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

    await goto(page, '/#/say'); await settle(page);
    await page.waitForFunction(() => !!window.__t, null, { timeout: 6000 }).catch(() => {});

    // ===== ⓪ v1.3.5 settings 默认值与 state-machine 同源（在 store 被任何用例改动之前读）=====
    // 🔴 这条防的是「常量提出来了但没人用」——IP_SETTINGS_DEFAULT 曾经是个纯死导出：
    //   store.js 里另抄了一份硬编码默认值，改默认值改一处不生效，且任何静态检查都发现不了。
    const sameSrc = await page.evaluate(async () => {
      const sm = await import('/js/state-machine.js');
      const st = await import('/js/store.js');
      const s = st.getState().user.settings;
      const want = Object.assign({}, sm.BASE_SETTINGS_DEFAULT, sm.IP_SETTINGS_DEFAULT);
      const missing = Object.keys(want).filter((k) => !(k in s));
      const mismatch = Object.keys(want).filter((k) => (k in s) && s[k] !== want[k]);
      return { n: Object.keys(want).length, missing, mismatch, ipMotion: s.ipMotion };
    });
    check('v1.3.5·settings 覆盖 BASE/IP 两组默认值（无缺键）', sameSrc.missing.length === 0, JSON.stringify(sameSrc.missing));
    check('v1.3.5·settings 默认值逐键等于 state-machine 的定义（同源，不是两处硬编码）',
      sameSrc.mismatch.length === 0 && sameSrc.ipMotion === true, JSON.stringify(sameSrc.mismatch));

    // 断言辅助：等到 receiving 窗口过去、进入情绪渲染态
    const pastReceiving = () => page.waitForFunction(() => { const s = window.__t.store.getState(); return Date.now() > (s.receivingUntil || 0) + 150; }, null, { timeout: 9000 }).catch(() => {});

    // ===== ① 真实链路：文本提交 → 本地分析 → 情绪渲染（含怒文本，本地引擎可能判为复合情绪） =====
    await goto(page, '/#/record?mode=text'); await settle(page);
    await page.fill('#recInput', '我真的好生气，他根本不在乎我的感受，每次都这样。');
    await page.click('#recDone');
    await waitRoute(page, 'followup'); await pastReceiving(); await settle(page);
    const angryKey = await page.evaluate(() => window.__t.store.getState().emotionKey);
    check('真实链路·愤怒文本→检测到有效情绪', !!angryKey && ['angry', 'mixed', 'sad', 'anxious'].includes(angryKey), 'emotionKey=' + angryKey);
    const angryDesc = await page.evaluate(() => { const d = window.__t.currentIpDesc(); const st = window.__t.ipSM.EMOTION_RENDER_STATE; return { node: d.node, state: d.state, bg: document.getElementById('ipBg').className, expect: st[window.__t.store.getState().emotionKey] }; });
    check('真实链路·情绪→emotion_render 节点且姿态匹配', /^(emotion_render|ai_reply)$/.test(angryDesc.node) && angryDesc.state === angryDesc.expect, JSON.stringify(angryDesc));
    await page.screenshot({ path: path.join(OUT, '01-angry-real.png'), fullPage: true });

    // ===== ② 真实链路：悲伤文本 → 情绪渲染 =====
    await goto(page, '/#/record?mode=text'); await settle(page);
    await page.fill('#recInput', '今天一个人待着，突然觉得好难过，好像没有人真的懂我。');
    await page.click('#recDone');
    await waitRoute(page, 'followup'); await pastReceiving(); await settle(page);
    const sadKey = await page.evaluate(() => window.__t.store.getState().emotionKey);
    check('真实链路·悲伤文本→检测到有效情绪', !!sadKey && ['sad', 'mixed', 'lonely', 'tired', 'vague'].includes(sadKey), 'emotionKey=' + sadKey);
    const sadDesc = await page.evaluate(() => { const d = window.__t.currentIpDesc(); const st = window.__t.ipSM.EMOTION_RENDER_STATE; return { node: d.node, state: d.state, bg: document.getElementById('ipBg').className, expect: st[window.__t.store.getState().emotionKey] }; });
    check('真实链路·情绪→emotion_render 节点且姿态匹配', /^(emotion_render|ai_reply)$/.test(sadDesc.node) && sadDesc.state === sadDesc.expect, JSON.stringify(sadDesc));
    await page.screenshot({ path: path.join(OUT, '02-sad-real.png'), fullPage: true });

    // ===== ③ 全调色板 studio 渲染（joy/sad/angry/anxious/tired/lonely/mixed/vague/danger + idle），逐一截图 + 断言 =====
    const PALETTE_KEYS = await page.evaluate(() => Object.keys(window.__t.ipSM.PALETTE));
    const expectedState = { default: 'idle', joy: 'joy', sad: 'sad', angry: 'angry', anxious: 'anxious', tired: 'tired', lonely: 'lonely', mixed: 'mixed', vague: 'vague', danger: 'danger' };
    const intensityByKey = { default: 5, joy: 6, sad: 8, angry: 9, anxious: 5, tired: 4, lonely: 3, mixed: 5, vague: 2, danger: 5 };
    let studioOk = 0;
    for (const key of PALETTE_KEYS) {
      await page.evaluate(async (p) => {
        const s = await import('/js/store.js');
        s.setState({
          draft: { analysis: { emotion_primary: p.k, emotion_secondary: '', intensity: p.it }, asked: [], empathy: '', currentQuestion: '' },
          emotionKey: p.k, emotionIntensity: p.it, receivingUntil: 0, risk: { level: 'none', action: 'continue', hit: false, evidence: '' },
        });
        window.location.hash = '#/followup?t=' + Date.now();
      }, { k: key, it: intensityByKey[key] });
      await page.waitForTimeout(700); // 等 @property 颜色过渡稳定
      const got = await page.evaluate(() => { const d = window.__t.currentIpDesc(); return { node: d.node, state: d.state, bg: document.getElementById('ipBg').className }; });
      const ok = got.state === (expectedState[key] || 'idle') && /ip-bg--/.test(got.bg);
      if (ok) studioOk++;
      check('studio·' + key + ' 渲染姿态=' + (expectedState[key] || 'idle'), ok, JSON.stringify(got));
      await page.screenshot({ path: path.join(OUT, '03-studio-' + key + '.png'), fullPage: true });
    }
    check('studio·全部调色板态渲染成功', studioOk === PALETTE_KEYS.length, studioOk + '/' + PALETTE_KEYS.length);

    // ===== ④ receiving 接收节点：提交后 0.8s 气泡 + 墨汁波纹 =====
    await page.evaluate(async () => {
      const s = await import('/js/store.js');
      s.setState({ receivingUntil: Date.now() + 800, emotionKey: 'angry', emotionIntensity: 9, risk: { level: 'none', action: 'continue', hit: false, evidence: '' } });
      window.location.hash = '#/analyzing';
    });
    await page.waitForTimeout(300);
    const recv = await page.evaluate(() => {
      const d = window.__t.currentIpDesc();
      const bub = document.getElementById('recvBubble');
      const rip = document.getElementById('recvRipple');
      return { node: d.node, bubbleShown: bub ? !bub.hidden : false, bubbleText: bub ? bub.textContent : '', rippleOn: rip ? rip.classList.contains('is-on') : false };
    });
    check('receiving·节点=receiving', recv.node === 'receiving', 'node=' + recv.node);
    check('receiving·气泡「正在接住你的情绪」可见', recv.bubbleShown && /接住/.test(recv.bubbleText || ''), JSON.stringify(recv));
    check('receiving·墨汁波纹触发', recv.rippleOn, 'rippleOn=' + recv.rippleOn);
    await page.screenshot({ path: path.join(OUT, '04-receiving.png'), fullPage: true });

    // ===== ⑤ danger 高危截断：柔光环 + 停特效 + bg soft_warning_ring =====
    await page.evaluate(async () => {
      const s = await import('/js/store.js');
      s.setState({ risk: { level: 'high', action: 'refer', hit: true, evidence: '模拟高危' }, emotionKey: 'angry', emotionIntensity: 9 });
      window.location.hash = '#/followup';
    });
    await page.waitForTimeout(700);
    const danger = await page.evaluate(() => {
      const d = window.__t.currentIpDesc();
      const m = document.querySelector('.mascot');
      const halo = document.querySelector('.mascot__halo');
      return { node: d.node, state: d.state, bg: document.getElementById('ipBg').className, bodyAnim: m ? getComputedStyle(m.querySelector('.mascot__body') || m).animationName : '', haloOpacity: halo ? getComputedStyle(halo).opacity : '' };
    });
    check('danger·节点=danger 且姿态=danger', danger.node === 'danger' && danger.state === 'danger', JSON.stringify(danger));
    check('danger·背景柔光环 soft_warning_ring', /soft_warning_ring/.test(danger.bg), danger.bg);
    await page.screenshot({ path: path.join(OUT, '05-danger.png'), fullPage: true });

    // ===== ⑥ 总开关一键关全部动画 =====
    await page.evaluate(async () => {
      const s = await import('/js/store.js');
      s.setSetting('ipMotion', false);
      s.setState({ risk: { level: 'none', action: 'continue', hit: false, evidence: '' }, emotionKey: 'joy', emotionIntensity: 6, receivingUntil: 0 });
      window.location.hash = '#/followup?t=' + Date.now();
    });
    await page.waitForTimeout(500);
    const off = await page.evaluate(() => {
      const m = document.querySelector('.mascot');
      return { bodyOff: document.body.classList.contains('ip-motion-off'), anim: m ? getComputedStyle(m).animationName : '', bgHidden: getComputedStyle(document.getElementById('ipBg')).display };
    });
    check('总开关·body.ip-motion-off 已挂', off.bodyOff, 'ip-motion-off=' + off.bodyOff);
    check('总开关·mascot 动画被禁用(none)', off.anim === 'none', 'anim=' + off.anim);
    await page.screenshot({ path: path.join(OUT, '06-motion-off.png'), fullPage: true });
    // 恢复
    await page.evaluate(async () => { const s = await import('/js/store.js'); s.setSetting('ipMotion', true); window.location.hash = '#/say'; });

    // ===== ⑦ v1.3.1 IP 点击轻互动：单击/双击/三连击/连点4+ 与动画类、气泡 =====
    const SETS = await page.evaluate(async () => {
      const cw = await import('/js/copywriting.js');
      const flat = (o) => Object.values(o).flat();
      return {
        tap1: cw.TAP_BUBBLES.tap1, tap2: cw.TAP_BUBBLES.tap2, tap3: cw.TAP_BUBBLES.tap3, over: cw.TAP_BUBBLES.over,
        emoBubbles: flat(cw.TAP_BUBBLES_BY_EMOTION),
        quiet: cw.QUIET_COPY,
        greet: [].concat(...Object.values(cw.GREETING_LIBRARY.time_based), ...Object.values(cw.GREETING_LIBRARY.history_based), cw.GREETING_LIBRARY.neutral),
        opening: flat(cw.OPENING_RESPONSES),
      };
    });
    const resetSay = async () => {
      await page.evaluate(async () => { const s = await import('/js/store.js'); s.setState({ emotionKey: null, quietMode: false, aiReplying: false, risk: { level: 'none', action: 'continue', hit: false, evidence: '' } }); window.location.hash = '#/say?t=' + Date.now(); });
      await page.waitForTimeout(450);
    };
    const ipCenter = async () => { const b = await page.locator('#ipTouch').boundingBox(); return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : { x: 195, y: 230 }; };
    const tapTimes = async (n) => { const c = await ipCenter(); for (let i = 0; i < n; i++) { await page.mouse.click(c.x, c.y); await page.waitForTimeout(110); } };
    const ipState = () => page.evaluate(() => ({ bubbleShown: !document.getElementById('ipBubble').hidden, text: document.getElementById('ipBubble').textContent, cls: document.getElementById('ipTouch').className }));

    await resetSay(); await page.waitForTimeout(2100);
    await tapTimes(1); await page.waitForTimeout(150);
    let S1 = await ipState();
    check('v1.3.1·单击→气泡在 tap1 库', S1.bubbleShown && SETS.tap1.includes(S1.text), JSON.stringify(S1));
    check('v1.3.1·单击→ip-tap1 动画类', /ip-tap1/.test(S1.cls), S1.cls);

    await resetSay(); await page.waitForTimeout(2100);
    await tapTimes(2); await page.waitForTimeout(150);
    let S2 = await ipState();
    check('v1.3.1·双击→气泡在 tap2 库', S2.bubbleShown && SETS.tap2.includes(S2.text), JSON.stringify(S2));
    check('v1.3.1·双击→ip-tap2 动画类', /ip-tap2/.test(S2.cls), S2.cls);

    await resetSay(); await page.waitForTimeout(2100);
    await tapTimes(3); await page.waitForTimeout(150);
    let S3 = await ipState();
    check('v1.3.1·三连击→气泡在 tap3 库', S3.bubbleShown && SETS.tap3.includes(S3.text), JSON.stringify(S3));
    check('v1.3.1·三连击→ip-tap3 动画类', /ip-tap3/.test(S3.cls), S3.cls);

    await resetSay(); await page.waitForTimeout(2100);
    await tapTimes(4); await page.waitForTimeout(150);
    let S4 = await ipState();
    check('v1.3.1·连点4+→软反馈气泡', S4.bubbleShown && SETS.over.includes(S4.text), JSON.stringify(S4));
    check('v1.3.1·连点4+→ip-tap-over 动画类', /ip-tap-over/.test(S4.cls), S4.cls);

    // ===== ⑧ v1.3.2 长按进入安静陪伴模式 =====
    await resetSay(); await page.waitForTimeout(2100);
    const c0 = await ipCenter();
    await page.mouse.move(c0.x, c0.y); await page.mouse.down(); await page.waitForTimeout(1000); await page.mouse.up();
    await page.waitForTimeout(450);
    const Q1 = await page.evaluate(() => ({ quiet: document.body.classList.contains('quiet-mode'), quietMode: window.__t.store.getState().quietMode, greet: document.querySelector('.say__greet').textContent, cards: window.__t.store.getState().cards.length }));
    check('v1.3.2·长按进入安静陪伴模式', Q1.quiet && Q1.quietMode, JSON.stringify(Q1));
    check('v1.3.2·顶部文案为安静专属标题', SETS.quiet.titles.includes(Q1.greet), Q1.greet);
    await page.screenshot({ path: path.join(OUT, '07-quiet-mode.png'), fullPage: true });
    // 安静模式点 IP → 专属气泡
    await tapTimes(1); await page.waitForTimeout(150);
    const Q2 = await ipState();
    check('v1.3.2·安静模式单击→专属气泡', Q2.bubbleShown && SETS.quiet.tap1.includes(Q2.text), JSON.stringify(Q2));
    // 回归护栏：长按触发时页面重渲染，长按的 pointerup 会落到新控制器上，
    // 若不过滤「无配对 pointerdown 的抬起」，安静模式首击会被误算成第 2 次（ip-tap2）。
    check('v1.3.2·长按松手不额外计一次点击（安静模式首击=第1次）', /ip-tap1/.test(Q2.cls), Q2.cls);
    // 点空白退出安静模式
    await page.mouse.click(345, 250); await page.waitForTimeout(450);
    const Q3 = await page.evaluate(() => ({ quiet: document.body.classList.contains('quiet-mode'), cards: window.__t.store.getState().cards.length }));
    check('v1.3.2·点空白退出安静模式', !Q3.quiet, 'quiet=' + Q3.quiet);
    check('v1.3.2·安静模式全程未产生卡片', Q3.cards === 0, 'cards=' + Q3.cards);

    // ===== ⑧b v1.3.2 规格硬要求：安静模式继承上一轮情绪色（不是回到默认紫）=====
    // 走真实链路：让 store 带上一个情绪键（等价于刚倾诉完），再进安静模式看 IP 是否沿用该情绪。
    await goto(page, '/#/say'); await settle(page);
    await page.evaluate(() => window.__t.store.setEmotion('sad', 6));
    await goto(page, '/#/followup?t=' + Date.now()); await settle(page);   // 换个路由触发一次 render
    await goto(page, '/#/say'); await settle(page);
    const inheritBefore = await page.evaluate(async () => {
      const sm = await import('/js/state-machine.js');
      const svg = document.querySelector('.say__mascot .mascot');
      return { state: svg.getAttribute('data-state'), bodyIn: getComputedStyle(svg).getPropertyValue('--ip-body-in').trim(), want: sm.selectColors('sad', 6)['--ip-body-in'] };
    });
    check('v1.3.2·首页继承上一轮情绪（sad 姿态 + 调色板色）', inheritBefore.state === 'sad', JSON.stringify(inheritBefore));
    const c1 = await ipCenter();
    await page.mouse.move(c1.x, c1.y); await page.mouse.down(); await page.waitForTimeout(1000); await page.mouse.up();
    await page.waitForTimeout(450);
    const inheritAfter = await page.evaluate(() => {
      const svg = document.querySelector('.say__mascot .mascot');
      return { quiet: document.body.classList.contains('quiet-mode'), state: svg.getAttribute('data-state'), bodyIn: getComputedStyle(svg).getPropertyValue('--ip-body-in').trim(), emoKey: window.__t.store.getState().emotionKey };
    });
    check('v1.3.2·安静模式仍继承该情绪色（未回退默认紫）', inheritAfter.quiet && inheritAfter.state === 'sad' && inheritAfter.emoKey === 'sad', JSON.stringify(inheritAfter));
    await page.mouse.click(345, 250); await page.waitForTimeout(300);   // 退出安静模式，恢复后续用例的干净态

    // ===== ⑨ v1.3.3 首页问候语来自问候库 =====
    const G = await page.evaluate(() => document.querySelector('.say__greet').textContent);
    check('v1.3.3·首页问候来自问候库', SETS.greet.includes(G), G);

    // ===== ⑩ v1.3.4 开场回应 + 我页文案 =====
    await goto(page, '/#/record?mode=text'); await settle(page);

    // ⑩-0 v1.3.5 倾听节点气泡（§一.1）：复用本次录音页跳转，不额外导航（录音态离开会被守卫拦下）
    // 🔴 这条防的是「规格写了节点气泡、NODE_BUBBLE 却没人消费」——
    //   receiving 的气泡有人用，listening 的曾经只定义不接线（静默缺功能，静态检查全绿）。
    const listen = await page.evaluate(async () => {
      const sm = await import('/js/state-machine.js');
      const el = document.querySelector('.record__mascot .ip-bubble');
      const svg = document.querySelector('.record__mascot .mascot');
      const hint = document.getElementById('recHint');
      return {
        text: el ? el.textContent.trim() : '',
        want: sm.NODE_BUBBLE.listening,
        opacity: el ? getComputedStyle(el).opacity : '0',
        state: svg ? svg.getAttribute('data-state') : null,
        hint: hint ? hint.textContent.trim() : '',
      };
    });
    check('v1.3.5·倾听节点 IP 姿态=listening', listen.state === 'listening', String(listen.state));
    check('v1.3.5·倾听气泡「我在听」且取自 NODE_BUBBLE（非硬编码）',
      listen.text === '我在听' && listen.text === listen.want, JSON.stringify(listen));
    check('v1.3.5·倾听气泡常显（静态气泡，不依赖 hover/计时器）', Number(listen.opacity) > 0.9, String(listen.opacity));
    // 气泡与轮播提示不能撞同一句，否则 IP 下方会出现两层同样的字（截图里抓到过「我在听」+「我在听……」）
    check('v1.3.5·轮播提示不与节点气泡重复（不出现两层同义字）',
      !!listen.hint && !listen.hint.startsWith(listen.text), `hint=「${listen.hint}」 bubble=「${listen.text}」`);
    await page.screenshot({ path: path.join(OUT, '04b-listening.png'), fullPage: true });

    await page.fill('#recInput', '我很生气，他根本不尊重我。');
    await page.click('#recDone');
    await waitRoute(page, 'followup'); await pastReceiving(); await settle(page);
    const OP = await page.evaluate(() => { const d = window.__t.store.getState().draft || {}; return d.opening || ''; });
    check('v1.3.4·开场回应来自 OPENING_RESPONSES', SETS.opening.includes(OP), OP);
    await goto(page, '/#/me'); await settle(page);
    const ME = await page.evaluate(() => ({
      title: document.body.textContent.includes('你的深海空间'),
      faq: document.querySelectorAll('.faq').length,
      exp: !!document.getElementById('meExport'),
      clrCards: !!document.getElementById('meClearCards'),
      clrMem: !!document.getElementById('meClearMemory'),
      boundary: document.body.textContent.includes('不能替代心理咨询师'),
    }));
    check('v1.3.4·我页含「你的深海空间」标题', ME.title, JSON.stringify(ME));
    check('v1.3.4·我页 FAQ ≥ 3 条', ME.faq >= 3, 'faq=' + ME.faq);
    check('v1.3.4·我页记忆/导出/清除卡片按钮齐全', ME.exp && ME.clrCards && ME.clrMem, JSON.stringify(ME));
    check('v1.3.4·我页含陪伴边界提示', ME.boundary, 'boundary=' + ME.boundary);
    await page.screenshot({ path: path.join(OUT, '08-me-page.png'), fullPage: true });

    // ===== ⑪ 边界：AI 回复中点击互动失效 =====
    await resetSay();
    await page.evaluate(async () => { const s = await import('/js/store.js'); s.setState({ aiReplying: true }); });
    await page.evaluate(() => { const el = document.getElementById('ipTouch'); if (el) el.className = el.className.replace(/ip-tap\S*/g, ''); });
    await tapTimes(1); await page.waitForTimeout(150);
    const B1 = await page.evaluate(() => ({ cls: document.getElementById('ipTouch').className, hidden: document.getElementById('ipBubble').hidden }));
    check('v1.3.1边界·AI回复中点击互动失效', !/ip-tap/.test(B1.cls), JSON.stringify(B1));
    // 触碰总开关关闭 → 点击失效
    await page.evaluate(async () => { const s = await import('/js/store.js'); s.setState({ aiReplying: false }); s.setSetting('ipTouch', false); window.location.hash = '#/say?t=' + Date.now(); });
    await page.waitForTimeout(400);
    await page.evaluate(() => { const el = document.getElementById('ipTouch'); if (el) el.className = el.className.replace(/ip-tap\S*/g, ''); });
    await tapTimes(1); await page.waitForTimeout(150);
    const B2 = await page.evaluate(() => document.getElementById('ipTouch').className);
    check('v1.3.1边界·触碰总开关关闭后点击失效', !/ip-tap/.test(B2), B2);
    await page.evaluate(async () => { const s = await import('/js/store.js'); s.setSetting('ipTouch', true); });

    // ===== ⑪b v1.3.5 规格 §三：情绪色切换必须是 0.6~1.2s 柔和晕染，不是硬切 =====
    // 🔴 为什么单独立段：render() 是整块 innerHTML 重写 ⇒ IP 节点每次都是新的、出生即目标色，
    //   @property 过渡天生**不会**触发。发布说明曾写着「平滑晕染、绝不硬切」，实测却是硬切
    //   （8 次采样全部等于目标值）。这条断言就是那次的护栏，A/B 双臂保证它有鉴别力。
    // A 臂（动效开）：切到 sad 后 ~140ms 采样应是**中间色**；判据用「三段距离可加」——
    //   真插值：|起点→中间| + |中间→终点| == |起点→终点|；硬切：中间==终点 ⇒ 左式是右式的两倍。
    // B 臂（动效关）：同一步操作应立即就是目标色（零过渡）——若 B 臂也「像过渡」，说明 A 臂是恒真的假断言。
    await goto(page, '/#/say'); await settle(page);
    await page.evaluate(async () => {
      const st = await import('/js/store.js');
      st.setSetting('ipMotion', true);
      st.setState({ emotionKey: 'default', emotionIntensity: 5, risk: { level: 'none', action: 'continue', hit: false, evidence: '' } });
      window.__t.render();
    });
    await page.waitForTimeout(950); // 先稳定在起点色（default 平静）
    const rgbOf = (s) => (String(s || '').match(/\d+/g) || []).map(Number).slice(0, 3);
    const dist = (a, b) => { const x = rgbOf(a); const y = rgbOf(b); return x.length === 3 && y.length === 3 ? Math.abs(x[0] - y[0]) + Math.abs(x[1] - y[1]) + Math.abs(x[2] - y[2]) : -1; };

    const trA = await page.evaluate(async () => {
      const st = await import('/js/store.js');
      const node = () => document.querySelector('.say__mascot .mascot');
      const read = () => getComputedStyle(node()).getPropertyValue('--ip-body-in').trim();
      const before = read();
      st.setEmotion('sad', 8);   // L3 → #747494，与平静紫差距足够大
      window.__t.render();
      await new Promise((r) => setTimeout(r, 140)); // 过渡进行中
      const mid = read();
      await new Promise((r) => setTimeout(r, 950)); // 过渡结束
      return { before, mid, end: read() };
    });
    const trB = await page.evaluate(async () => {
      const st = await import('/js/store.js');
      st.setSetting('ipMotion', false); // 关掉动效总开关
      const node = () => document.querySelector('.say__mascot .mascot');
      const read = () => getComputedStyle(node()).getPropertyValue('--ip-body-in').trim();
      st.setEmotion('angry', 9);
      window.__t.render();
      await new Promise((r) => setTimeout(r, 140));
      const mid = read();
      const st2 = await import('/js/store.js');
      st2.setSetting('ipMotion', true); // 立刻还原，别影响后面用例
      return { mid };
    });

    const dBM = dist(trA.before, trA.mid), dME = dist(trA.mid, trA.end), dBE = dist(trA.before, trA.end);
    check('v1.3.5·情绪切换是过渡不是硬切（中间色落在起终点之间）',
      dBE > 60 && dBM > 8 && dME > 8 && Math.abs(dBM + dME - dBE) <= 3,
      `before=${trA.before} mid=${trA.mid} end=${trA.end} | ${dBM}+${dME} vs ${dBE}`);
    check('v1.3.5·过渡结束后收敛到目标色（sad L3 #747494）',
      dist(trA.end, 'rgb(116,116,148)') <= 2, trA.end);
    check('v1.3.5·A/B 对照：关掉动效后立即即目标色（证明上一条有鉴别力）',
      dist(trA.end, trB.mid) > 30, `过渡终点=${trA.end} / 关闭动效 140ms=${trB.mid}`);

    // ===== ⑪c v1.3.5 规格 §三.4：3 分钟无交互 → 情绪色自动回归 idle =====
    // 🔴 这条必须验「计时器真的存在」：原实现只在 render() 那一刻求值一次 isIdleTimeout，
    //   用户不动页面就永远停在情绪色 ⇒ 规格等于没实现，而 node --check / 静态检查全绿看不出任何异常。
    // 真等 3 分钟不现实 ⇒ 把 TRANSITION.idleTimeoutMs 临时缩到 800ms（对象成员可写），跑完立刻还原。
    const idleRevert = await page.evaluate(async () => {
      const st = await import('/js/store.js');
      const sm = await import('/js/state-machine.js');
      const cur = () => document.querySelector('.say__mascot .mascot');
      const read = () => ({ emo: st.getState().emotionKey, state: cur() ? cur().getAttribute('data-state') : null });
      const orig = sm.TRANSITION.idleTimeoutMs;
      // 阈值 800ms：scheduleIdleRevert 的下限是 1000ms，所以计时器在 1000ms 触发时
      // elapsed(≈1000~1015) > 800 一定成立，不会出现「刚好卡在阈值上不触发」的抖动。
      sm.TRANSITION.idleTimeoutMs = 800;

      // A 臂：无交互 → 1.8s 后（> 触发点 1.0s）应已回归 idle
      st.setEmotion('sad', 8);
      window.__t.render();
      await new Promise((r) => setTimeout(r, 250));
      const armed = read();
      await new Promise((r) => setTimeout(r, 1550));
      const afterA = read();
      await new Promise((r) => setTimeout(r, 950)); // 等颜色过渡回退完成
      const colorA = getComputedStyle(cur()).getPropertyValue('--ip-body-in').trim();

      // B 臂（对照）：同样设情绪，但中途 touchInteraction() 模拟用户动作 → 不应回归
      st.setEmotion('tired', 8);
      window.__t.render();
      await new Promise((r) => setTimeout(r, 300));
      st.touchInteraction();               // 计时器在 1.0s 触发时 elapsed≈700 < 800 → 判为「有交互」
      await new Promise((r) => setTimeout(r, 900)); // 累计 1.2s（仍早于重新排的下一次 2.0s）
      const afterB = read();

      sm.TRANSITION.idleTimeoutMs = orig;
      st.setEmotion(null, 0);
      return { armed, afterA, colorA, afterB, orig };
    });
    check('v1.3.5·无交互超时后情绪键自动清空', idleRevert.armed.emo === 'sad' && idleRevert.afterA.emo === null,
      `armed=${idleRevert.armed.emo} → after=${idleRevert.afterA.emo}`);
    check('v1.3.5·超时后 IP 姿态回到 idle', idleRevert.afterA.state === 'idle', String(idleRevert.afterA.state));
    check('v1.3.5·超时后颜色平滑回退到默认紫 #F3EEFF', dist(idleRevert.colorA, 'rgb(243, 238, 255)') <= 3, idleRevert.colorA);
    check('v1.3.5·对照臂：期间有交互则不回归（超时是「无交互」而非「看了很久」）',
      idleRevert.afterB.emo === 'tired', `afterB=${idleRevert.afterB.emo}`);

    // ===== ⑫ 屏幕录制：点击/长按/安静 + 情绪过渡 montage（作为验收证据）=====
    const seq = [
      { key: 'default', it: 5, route: 'say', ms: 1500 },
      { key: 'joy', it: 6, route: 'followup', ms: 1600 },
      { key: 'sad', it: 8, route: 'followup', ms: 1600 },
      { key: 'angry', it: 9, route: 'followup', ms: 1600 },
      { key: 'mixed', it: 5, route: 'followup', ms: 1600 },
      { key: 'default', it: 5, route: 'say', ms: 1600 },
      { key: 'danger', it: 5, route: 'followup', risk: 'high', ms: 1800 },
    ];
    for (const step of seq) {
      await page.evaluate(async (s) => {
        const st = await import('/js/store.js');
        st.setState({
          draft: { analysis: { emotion_primary: s.key, intensity: s.it }, asked: [], empathy: '', currentQuestion: '' },
          emotionKey: s.key, emotionIntensity: s.it, receivingUntil: 0,
          risk: s.risk ? { level: 'high', action: 'refer', hit: true, evidence: '' } : { level: 'none', action: 'continue', hit: false, evidence: '' },
        });
        window.location.hash = '#/' + s.route + '?t=' + Date.now();
      }, step);
      await page.waitForTimeout(step.ms);
    }

    // 运行时报错（排除故意的版本探测/离线降级类）
    const realErrors = errors.filter((e) => !/version\/history|version\.json|ERR_FAILED|更新检测|api\/health|favicon/i.test(e));
    check('无意外运行时报错', realErrors.length === 0, realErrors.slice(0, 5).join(' | '));

    // 屏幕录制（Playwright recordVideo 原生 webm，浏览器可直接播放）。
    // 🔴 两个坑都在 `page.video()` 上：
    //   ① 不要 saveAs() 再复制一份 —— 本上下文录十来分钟、390x844，自动 webm 上百 MB，
    //      saveAs 会长时间不返回，把整套自测挂死（实测卡 24 分钟、日志停在最后一条断言）。
    //   ② video.path() 返回的是 **Promise<string>**，直接当字符串用会 ERR_INVALID_ARG_TYPE。
    // 所以：先 close（此时才会 flush 落盘），再扫目录取最新那份。
    await browser.close();

    let recFile = '', recSize = 0;
    try {
      const cands = fs.readdirSync(VIDEO_DIR).filter((n) => n.endsWith('.webm'))
        .map((n) => ({ n, m: fs.statSync(path.join(VIDEO_DIR, n)).mtimeMs }))
        .sort((a, b) => b.m - a.m);
      if (cands.length) { recFile = cands[0].n; recSize = fs.statSync(path.join(VIDEO_DIR, cands[0].n)).size; }
    } catch (e) { /* ignore */ }
    check('屏幕录制已生成（Web/Playwright 真跑录像，非真机）', recSize > 0,
      recFile ? `${recFile}（${(recSize / 1048576).toFixed(1)} MB）` : 'no video');
  } finally {
    try { if (srv) srv.kill('SIGTERM'); } catch (e) {}
  }

  // 断言总数基线自检（同源 _selftest/expected-counts.json）：数量对不上就是有人增删了断言，宁可红一条
  let EXPECTED = null;
  try { EXPECTED = JSON.parse(fs.readFileSync(path.join(__dirname, 'expected-counts.json'), 'utf8')).ipState; } catch (e) { /* ignore */ }
  if (EXPECTED && results.length !== EXPECTED) {
    check('v1.3.5·断言总数与 expected-counts.json 基线一致', false, `实际 ${results.length} / 期望 ${EXPECTED}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== 汇总：${results.length - failed.length}/${results.length} 通过 ====`);
  if (failed.length) { failed.forEach((f) => console.log('  ✗ ' + f.name + '   ' + f.detail)); process.exit(1); }
})().catch((e) => { console.error('运行异常：', e); process.exit(2); });
