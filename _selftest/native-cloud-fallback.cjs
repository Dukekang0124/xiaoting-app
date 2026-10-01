#!/usr/bin/env node
/* 墨小溟 · 原生识别失败 ⇒ 云端回落 A/B 鉴别力探针（v1.4.4）
 *
 * 复现的真机缺陷（康哥 2026-10-01 截图：按住说 →「水里有点吵，我没听清」）：
 *   设备识别（SpeechRecognizer）的可用性检查会说谎 —— 不少国产 ROM 返回 available=true，
 *   实际识别服务残缺：说完话 partialResults 一直空，松手结算 {ok:false, code:'empty'}。
 *   旧代码（≤v1.4.3）此时直接判死，且 native 模式不录音频（blob=null）⇒ 想回落云端也没有原料
 *   ⇒ 这类设备上语音识别**永久不可用**。
 *
 * 本探针用假 Capacitor 桥精确模拟这种设备（插件在、检查通过、start 后永远不给字），
 * ENV=1 断言新行为（native empty → 云端回落 → 进分析页），ENV=0 断言旧行为（不回落，停在原地）。
 * 用法：
 *   ENV=1 BASE=http://127.0.0.1:4174 node _selftest/native-cloud-fallback.cjs   # 新代码应全绿
 *   ENV=0 …                                                                    # 旧代码应恰好红
 */
const path = require('path');
const fs = require('fs');
module.paths.push(process.env.NODE_PATH || 'C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules');
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:4174';
const EXPECT_FALLBACK = String(process.env.ENV || '1') === '1';
const DEMO = '今天又和男朋友吵架了，他很晚才回我消息，我觉得他根本不在乎我。';

let pass = 0, fail = 0;
function check(name, ok, detail) {
  const mark = ok ? 'PASS' : 'FAIL';
  if (ok) pass++; else fail++;
  console.log(`${mark}  ${name}${detail !== undefined ? '  —  ' + detail : ''}`);
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'zh-CN', isMobile: true, hasTouch: true,
    permissions: ['microphone'],
  });

  // 假 Capacitor 桥：模拟「检查说可用、实际吐不出字」的真机设备（康哥手机那类国产 ROM）
  await ctx.addInitScript(() => {
    try { localStorage.setItem('moxiaoming:welcomed_v1', '1'); localStorage.setItem('xiaoting:ai', 'mock'); } catch (e) {}
    window.__native = { startCalls: 0, partials: 0 };
    const fakePlugin = {
      available: async () => ({ available: true }),           // 🔴 检查通过 = 说谎的那一环
      requestPermissions: async () => ({ speechRecognition: 'granted' }),
      addListener: async () => ({ remove: async () => {} }),
      start: async () => { window.__native.startCalls++; return {}; },  // 启动了，但永远不给 partialResults
      stop: async () => ({}),
      isAvailable: async () => ({ available: true }),
    };
    window.Capacitor = { isNativePlatform: () => true, Plugins: { SpeechRecognition: fakePlugin } };
  });

  let asrCalls = 0;
  await ctx.route('**/api/asr', (r) => { asrCalls++; r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, text: DEMO, engine: 'mock', ms: 1 }) }); });
  // 云端健康探针必须替身化（主回归同款教训：探针打真网 = 随机假红）
  await ctx.route('https://xiaoting-asr.pages.dev/api/health', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, ai_binding: true, service: 'mock' }) }));
  // APK 判定成立后 apiBase() 是绝对域名，把站点请求拦掉，保证全程无真实外网
  await ctx.route('https://xiaoting.app.workbuddy.host/**', (r) => r.abort());

  const page = await ctx.newPage();
  await page.goto(BASE + '/#/say', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#talkbtn', { timeout: 10000 });

  // 确认真的选中了 native 模式（否则整条探针测的是别人）
  await page.evaluate(() => { window.__modeSeen = null; });
  const box = await page.locator('#talkbtn').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(1400);
  const mid = await page.evaluate(() => ({
    nativeStarts: window.__native.startCalls,
    recording: document.body.classList.contains('recording'),
  }));
  await page.mouse.up();
  await page.waitForTimeout(900);
  const after = await page.evaluate(async () => {
    const t = await import('/js/app.js').then((m) => m.__test__);
    return { hash: location.hash, draft: (t.store.getState().draft || {}).transcript || '' };
  });

  check('守卫·假桥的设备识别真的被调用（不是走错 web 模式）', mid.nativeStarts >= 1, `startCalls=${mid.nativeStarts}`);
  check('守卫·录音态生效', mid.recording, `rec=${mid.recording}`);

  if (EXPECT_FALLBACK) {
    check('回落·云端识别端点真的被调用（native empty 不再判死）', asrCalls >= 1, `asrCalls=${asrCalls}`);
    // 流程走得快时会越过 #/analyzing 进入 #/followup —— 两者都算"带着转写离开了说话页"
    check('回落·松手后带着转写离开说话页（进入分析/追问）', after.hash === '#/analyzing' || after.hash === '#/followup', after.hash);
    check('回落·云端识别文本完整带进草稿', after.draft === DEMO, after.draft.slice(0, 24) + '…');
  } else {
    check('旧码·云端不被调用（缺陷复现：native 失败即判死）', asrCalls === 0, `asrCalls=${asrCalls}`);
    check('旧码·停在说话页不进分析（用户只看到「水里有点吵」）', after.hash !== '#/analyzing', after.hash);
  }

  await browser.close();
  console.log(`\n==== 原生回落 A/B（EXPECT_FALLBACK=${EXPECT_FALLBACK ? '新码' : '旧码'}）：PASS ${pass} / FAIL ${fail} ====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('运行异常：', e && e.message); process.exit(2); });
