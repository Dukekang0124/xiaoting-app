/**
 * 云端 ASR 接入（v1.4.1）真跑验收
 *
 * 判据是「行为」不是「看起来对」：
 *   ① 浏览器内 import() 直接调真实业务模块 —— 测的是真代码，不是复制品
 *   ② 重试判定表逐条断言（含反例：确定性失败不许重试，否则把"马上能改"拖成"一直转圈"）
 *   ③ 真实网络探测 + 真实音频端到端识别
 *
 * 跑法：
 *   PORT=4173 STATS_KEY=selftest node server.cjs
 *   BASE=http://127.0.0.1:4173 NODE_PATH=<workspace>/node_modules node _selftest/probe-cloud-asr-retry.cjs
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:4173';
const FIXTURE = path.join(__dirname, 'fixtures', 'asr-zh-16k.wav');

let pass = 0, fail = 0;
const failures = [];
function check(label, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + label + (extra ? '  — ' + extra : '')); }
  else { fail++; failures.push(label); console.log('FAIL  ' + label + (extra ? '  — ' + extra : '')); }
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));

  // 关掉欢迎浮层，避免拦截
  await page.addInitScript(() => {
     try { localStorage.setItem('monthly:done_' + (new Date().getFullYear() * 100 + (new Date().getMonth() + 1)), '1'); } catch (e) {}
    try { localStorage.setItem('moxiaoming:welcomed_v1', '1'); } catch (e) {}
  });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);

  console.log('== 一、端点与配置（浏览器内读真模块） ==');
  const cfg = await page.evaluate(async () => {
    const m = await import('/js/asr.js');
    const c = await import('/js/config.js');
    return { endpoint: m.cloudEndpoint(), origin: c.CLOUD_ASR.origin, attempts: c.CLOUD_ASR.maxAttempts, timeout: c.CLOUD_ASR.timeoutMs };
  });
  check('云端端点指向 Cloudflare（不是同源 /api/asr）', cfg.endpoint === cfg.origin + '/api/asr', cfg.endpoint);
  check('端点为绝对地址（APK 内 WebView 源是 https://localhost，相对路径必 404）', /^https:\/\//.test(cfg.endpoint));
  check('重试次数已配置（>1）', cfg.attempts > 1, String(cfg.attempts));
  check('超时留有余量（>=20s）', cfg.timeout >= 20000, cfg.timeout + 'ms');

  console.log('');
  console.log('== 二、重试判定表（含反例，否则这条断言是恒真的） ==');
  const table = await page.evaluate(async () => {
    const m = await import('/js/asr.js');
    return {
      cf403:   m.isTransient(403, 'http_403', '', 'error code: 1010'),
      http500: m.isTransient(500, 'http_500', '', ''),
      decode:  m.isTransient(200, 'asr_failed', '3030: Failed to decode audio file', ''),
      timeout: m.isTransient(0, 'timeout', '', ''),
      network: m.isTransient(0, 'network', '', ''),
      // ↓ 反例：这些必须**不**重试
      empty:   m.isTransient(400, 'empty_audio', '', ''),
      toolong: m.isTransient(413, 'audio_too_long', '', ''),
      nosound: m.isTransient(200, 'asr_empty', '', ''),
      usePost: m.isTransient(405, 'use_post', '', ''),
    };
  });
  check('403 风控（1010）→ 重试', table.cf403 === true);
  check('5xx → 重试', table.http500 === true);
  check('3030 解码失败 → 重试（实测同输入重试即成功）', table.decode === true);
  check('超时 → 重试', table.timeout === true);
  check('网络层失败 → 重试', table.network === true);
  check('反例：空音频 400 → 不重试', table.empty === false);
  check('反例：音频过长 413 → 不重试', table.toolong === false);
  check('反例：没识别到语音 → 不重试', table.nosound === false);
  check('反例：405 方法不对 → 不重试', table.usePost === false);

  console.log('');
  console.log('== 三、真实网络：cloud 探测 ==');
  const probe = await page.evaluate(async () => {
    const m = await import('/js/asr.js');
    // 打真实 Cloudflare，不走 mock —— 这一条不真跑就没有任何意义
    const r = await fetch('https://xiaoting-asr.pages.dev/api/health', { cache: 'no-store' });
    const j = await r.json();
    return { http: r.status, health: j, state: await m.probeCloud(true) };
  });
  check('云端 health 200', probe.http === 200, 'HTTP ' + probe.http);
  check('AI 绑定已生效', probe.health && probe.health.ai_binding === true);
  check('probeCloud() 判定为 ready（否则上层根本不会走云端）', probe.state === 'ready', probe.state);

  console.log('');
  console.log('== 四、真实音频端到端识别 ==');
  if (!fs.existsSync(FIXTURE)) {
    check('测试夹具存在', false, FIXTURE);
  } else {
    const b64 = fs.readFileSync(FIXTURE).toString('base64');
    const r = await page.evaluate(async (b64) => {
      const m = await import('/js/asr.js');
      const bin = atob(b64);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const blob = new Blob([u8], { type: 'audio/wav' });
      const t0 = Date.now();
      const out = await m.recognize(blob);
      return { out, wall: Date.now() - t0 };
    }, b64);
    console.log('返回：' + JSON.stringify(r.out).slice(0, 260));
    check('识别成功 ok===true', r.out && r.out.ok === true);
    check('返回非空中文文本', !!(r.out && r.out.text && /[\u4e00-\u9fa5]/.test(r.out.text)), r.out && r.out.text);
    check('engine 标记为 cf-whisper', r.out && String(r.out.engine).indexOf('whisper') >= 0, r.out && r.out.engine);
    check('带回实际尝试次数', r.out && typeof r.out.attempts === 'number' && r.out.attempts >= 1, r.out && String(r.out.attempts));
    check('端到端在可接受范围（<40s）', r.wall < 40000, r.wall + 'ms');
  }

  check('页面零 JS 异常', errors.length === 0, errors.slice(0, 2).join(' | '));

  await browser.close();
  console.log('');
  console.log('==== 汇总：' + pass + '/' + (pass + fail) + ' 通过 ====');
  if (fail) { console.log('未通过：'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.error('探针异常：', e && e.stack ? e.stack : e); process.exit(2); });
