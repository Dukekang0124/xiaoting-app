// 墨小溟 v0.8.0 · 真实演示视频录制（仅 Web，Playwright 录屏）
// 说明：本环境无法构建 APK，也无法真机录屏；按既定方案用本机 Chrome 走真实 Web 流程录屏，
// 并注入 v0.8.0 新增的微动作（实时音量驱动触角 / 呼吸引导 / 落泪 / 防呆气泡）做特征展示。
// 运行：NODE_PATH=<node-workspace>/node_modules node _selftest/demo-record.cjs
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = process.env.BASE || 'http://127.0.0.1:4173';
const DEMO = '今天又和男朋友吵架了，他很晚才回我消息，我觉得他根本不在乎我。';

// 契约替身（与自测同源的卡片/分析/周报结构，stageOf 已修正 weekly 段）
const MOCK_SDK = `(function(){
  window.__llmConfig = null; window.__llmCalls = [];
  var FOLLOWUPS = ['当时你脑子里冒出的第一句话是什么？','你最难受的是消息慢本身，还是那种不被看见的感觉？','类似的感觉，以前什么时候也出现过？'];
  var REPLY = {
    safety: { risk_level:'none', reason:'无自伤自杀意念，主要是关系冲突', action:'continue' },
    main: { event:'他很久才回我消息', people:['男朋友'], scene:'亲密关系', emotion:['委屈','愤怒'], intensity:8, body:['胸闷'], thought:'他根本不在乎我', cognitive_patterns:['读心'], need:['被重视','可预期'], behavior:'冷战', result:'更焦虑，关系更紧张', pattern:'把回复速度等同于重视程度', experiment:'先说「我需要确认」', summary:'你不是因为消息慢而难受，是那一刻感觉自己不重要。', needs_followup:true, followup_questions:FOLLOWUPS.slice() },
    card: { title:'回消息慢让我觉得不被重视', date:'2026-09-29', event:'他很久才回我消息', emotion:['委屈','愤怒'], intensity:8, body:['胸闷'], thought:'他根本不在乎我', need:['被重视','可预期'], behavior:'冷战', result:'更焦虑，关系更紧张', pattern:'把回复速度等同于重视程度', experiment:'先说「我需要确认」', summary:'你不是因为消息慢而难受，是那一刻感觉自己不重要。', tags:['亲密关系','被忽视'], ip_state:'empathy' },
    weekly: { headline:'这周你留下了 1 次记录', top_triggers:[{trigger:'他很久才回我消息',count:1,emotion:'委屈'}], top_people:[{person:'男朋友',count:1,avg_intensity:8}], correlations:[], effective_coping:[], experiment:'下周先说感受，再说需要。', summary:'你不是情绪太多，你只是感受得很清楚。', cards_count:1 }
  };
  function stageOf(u){
    if (u.indexOf('risk_level') >= 0) return 'safety';
    if (u.indexOf('cards_count') >= 0) return 'weekly';
    if (u.indexOf('"title"') >= 0) return 'card';
    if (u.indexOf('ready_for_card') >= 0) return 'followup';
    if (u.indexOf('needs_followup') >= 0) return 'main';
    if (u.indexOf('ip_state') >= 0) return 'card';
    return 'unknown';
  }
  function payloadFor(stage){
    var i = window.__llmCalls.filter(function(c){return c.stage===stage;}).length - 1;
    if (stage==='followup') return { empathy:'这种感觉，真的挺委屈的。', question:FOLLOWUPS[i%3], round:i+1, can_skip:true, ready_for_card:false };
    return REPLY[stage] || {};
  }
  async function* stream(text){
    yield { choices:[{ delta:{ role:'assistant', content:'' }}]};
    for (var i=0;i<text.length;i+=20) yield { choices:[{ delta:{ content:text.slice(i,i+20)} }]};
    yield { choices:[{ delta:{}, finish_reason:'stop'}], usage:{ total_tokens:120 } };
  }
  window.WorkBuddyCloud = { createWorkBuddyCloud:function(cfg){ window.__llmConfig=cfg; return { llm:{ models:{ list:function(){ return Promise.resolve([{id:'mock-chat',name:'Mock Chat',disabled:false,supportsReasoning:false,maxOutputTokens:8192,temperature:0.7}]);}}, chat:{ completions:{ create:function(req){ var u=(req.messages[1]&&req.messages[1].content)||''; var stage=stageOf(u); window.__llmCalls.push({stage:stage}); var text=JSON.stringify(payloadFor(stage)); return stream(text); }}}}}; } };
})();`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({
    channel: 'chrome', headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'zh-CN', isMobile: true, hasTouch: true,
    recordVideo: { dir: path.join(__dirname, 'shots'), size: { width: 390, height: 844 } },
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
     try { localStorage.setItem('monthly:done_' + (new Date().getFullYear() * 100 + (new Date().getMonth() + 1)), '1'); } catch (e) {} try { localStorage.setItem('xiaoting:ai', 'mock'); } catch (e) {} });
  await page.route(/index\.global\.js/, (route) => route.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body: MOCK_SDK }));
  await page.route('**/api/asr', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, text: DEMO, engine: 'mock', ms: 1 }) }));

  const log = (m) => console.log('[demo] ' + m);
  const safe = async (label, fn) => { try { await fn(); } catch (e) { log('segment "' + label + '" skipped: ' + e.message); } };

  await page.goto(BASE + '/#/say', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.mascot', { timeout: 10000 });

  // —— ① 首页待机（IP 呼吸浮动）——
  log('① 首页待机'); await sleep(2600);

  // —— ② 真实录音流程：按住说话 → 倾听态（点头）——
  log('② 按住说话·倾听态');
  const box = await page.locator('#talkbtn').boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await sleep(3200);
    await page.mouse.up();
  }
  // —— ③ 分析中（思考态）——
  log('③ 分析中·思考态');
  await page.waitForSelector('#analyzingSummary', { timeout: 15000 }).catch(() => {});
  await sleep(3600);

  // —— ④ 追问（共情态）——
  log('④ 追问·共情态');
  await page.waitForSelector('.fu-question', { timeout: 20000 }).catch(() => {});
  await sleep(2600);
  for (let r = 0; r < 3; r++) {
    const input = await page.$('#fuInput');
    if (input) await input.fill('我当时觉得他根本不在乎我。');
    const next = await page.$('#fuNext');
    if (next) await next.click();
    await sleep(2400);
  }

  // —— ⑤ 卡片确认（共情态）+ 落泪微动作展示 ——
  log('⑤ 卡片确认·落泪微动作');
  await page.waitForSelector('#f_title', { timeout: 20000 }).catch(() => {});
  await safe('empathy_tears showcase', async () => {
    await page.evaluate(() => {
      const m = document.querySelector('.cf-mascot .mascot');
      if (m) { m.setAttribute('data-state', 'empathy_tears'); m.className = 'mascot mascot--empathy_tears'; }
    });
    await sleep(3000);
    await page.evaluate(() => {
      const m = document.querySelector('.cf-mascot .mascot');
      if (m) { m.setAttribute('data-state', 'empathy'); m.className = 'mascot mascot--empathy'; }
    });
  });
  await sleep(1200);

  // —— ⑥ 保存 → 首页（开心态·星光 + 弹跳）——
  log('⑥ 保存·开心态');
  const save = await page.$('#cfSave');
  if (save) await save.click();
  await sleep(3200);

  // —— ⑦ 特征展示：实时音量驱动触角发光（倾听态 + --ip-vol 振荡）——
  log('⑦ 实时音量驱动触角发光');
  await safe('voice glow showcase', async () => {
    const holder = await page.evaluate(() => {
      const { mascot } = window.__ip || {};
      const div = document.createElement('div');
      div.id = '__demoShowcase';
      div.style.cssText = 'position:fixed;inset:0;background:linear-gradient(160deg,#FBF4FF,#FFF4E8);display:flex;align-items:center;justify-content:center;z-index:9999';
      div.innerHTML = '<div style="text-align:center"><div id="__demoMascot"></div><p style="color:#7a6ca8;font:600 15px/1.6 sans-serif;margin-top:10px">实时音量驱动触角发光</p></div>';
      document.body.appendChild(div);
      return true;
    });
    // 动态拉取真实 mascot 渲染函数
    await page.evaluate(async () => {
      const ip = await import('/js/ip.js');
      const host = document.getElementById('__demoMascot');
      if (host) host.innerHTML = ip.mascot('listening', 240);
    });
    for (let i = 0; i < 16; i++) {
      await page.evaluate((v) => document.documentElement.style.setProperty('--ip-vol', String(v)), (Math.sin(i / 1.6) * 0.5 + 0.5).toFixed(2));
      await sleep(200);
    }
    await page.evaluate(() => { document.documentElement.style.setProperty('--ip-vol', '0'); const d = document.getElementById('__demoShowcase'); if (d) d.remove(); });
  });
  await sleep(600);

  // —— ⑧ 特征展示：呼吸引导环（倾听态 + >3s 停顿）——
  log('⑧ 呼吸引导环');
  await safe('breath ring showcase', async () => {
    await page.evaluate(async () => {
      const ip = await import('/js/ip.js');
      const div = document.createElement('div');
      div.id = '__demoShowcase';
      div.style.cssText = 'position:fixed;inset:0;background:linear-gradient(160deg,#FBF4FF,#FFF4E8);display:flex;align-items:center;justify-content:center;z-index:9999';
      div.innerHTML = '<div style="text-align:center"><div id="__demoMascot"></div><p style="color:#7a6ca8;font:600 15px/1.6 sans-serif;margin-top:10px">停顿 >3s · 呼吸引导</p></div>';
      document.body.appendChild(div);
      document.getElementById('__demoMascot').innerHTML = ip.mascot('listening', 240);
      document.body.classList.add('recording--breath');
    });
    await sleep(3200);
    await page.evaluate(() => { document.body.classList.remove('recording--breath'); const d = document.getElementById('__demoShowcase'); if (d) d.remove(); });
  });
  await sleep(500);

  // —— ⑨ 特征展示：防呆气泡（思考态等待 >10s）——
  log('⑨ 防呆气泡');
  await safe('stuck bubble showcase', async () => {
    await page.evaluate(async () => {
      const ip = await import('/js/ip.js');
      const div = document.createElement('div');
      div.id = '__demoShowcase';
      div.style.cssText = 'position:fixed;inset:0;background:linear-gradient(160deg,#EFE9FF,#FFF0E6);display:flex;align-items:center;justify-content:center;z-index:9999';
      div.innerHTML = '<div style="text-align:center"><div id="__demoMascot"></div><p style="color:#7a6ca8;font:600 15px/1.6 sans-serif;margin-top:10px">思考等待 >10s · 防呆气泡</p></div>';
      document.body.appendChild(div);
      document.getElementById('__demoMascot').innerHTML = ip.mascot('thinking', 240);
      let b = document.getElementById('stuckBubble');
      if (!b) { b = document.createElement('div'); b.id = 'stuckBubble'; b.className = 'stuck-bubble'; b.textContent = '我在认真听，别急～'; document.body.appendChild(b); }
      document.body.classList.add('thinking--stuck');
    });
    await sleep(2600);
    await page.evaluate(() => { document.body.classList.remove('thinking--stuck'); const d = document.getElementById('__demoShowcase'); if (d) d.remove(); });
  });

  await browser.close();

  const vpath = await page.video().path();
  log('raw video: ' + vpath);
  const out = path.join(__dirname, 'xiaoting-v0.8.0-demo.mp4');
  // 转码为 mp4 便于通用播放（webm 默认）
  const { execSync } = require('child_process');
  try {
    execSync(`ffmpeg -y -i "${vpath}" -c:v libx264 -pix_fmt yuv420p -movflags +faststart "${out}"`, { stdio: 'ignore' });
    log('mp4 done: ' + out);
  } catch (e) {
    // 没有 libx264 就直接复制容器（webm）
    const webm = path.join(__dirname, 'xiaoting-v0.8.0-demo.webm');
    fs.copyFileSync(vpath, webm);
    log('ffmpeg mp4 失败，已输出 webm: ' + webm);
  }
  log('录制结束');
})().catch((e) => { console.error('运行异常：', e); process.exit(1); });
