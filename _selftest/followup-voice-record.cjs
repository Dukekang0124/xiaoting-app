#!/usr/bin/env node
/* 墨小溟 · 追问页「按住说」完整流程录屏（v1.4.5 验收材料）
 * 录制：进入追问页 → 按住说 → 识别填入输入框 → 点「回答」→ 下一问出现。
 * 输出 _selftest/shots/followup-voice-demo.webm（Web 端 mock ASR 演示；真机链路同代码）。
 */
const path = require('path');
module.paths.push(process.env.NODE_PATH || 'C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:4174';
const FU_DEMO = '我当时一直盯着手机屏幕，越等越心慌，觉得他根本不在乎我。';

(async () => {
  const fs = require('fs');
  const outDir = path.join(__dirname, 'shots');
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'zh-CN', isMobile: true, hasTouch: true, permissions: ['microphone'],
    recordVideo: { dir: outDir, size: { width: 390, height: 844 } },
  });
  await ctx.addInitScript(() => {
    try { localStorage.setItem('moxiaoming:welcomed_v1', '1'); localStorage.setItem('xiaoting:ai', 'mock'); } catch (e) {}
  });
  await ctx.route('**/api/asr', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, text: FU_DEMO, engine: 'cloud', ms: 900 }) }));
  await ctx.route('https://xiaoting-asr.pages.dev/api/health', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, ai_binding: true }) }));

  const page = await ctx.newPage();
  await page.goto(BASE + '/#/say', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1600);
  await page.evaluate(async () => {
    const m = await import('/js/app.js');
    m.__test__.store.setState({
      draft: {
        transcript: '今天又和男朋友吵架了，他很晚才回我消息。',
        analysis: { needs_followup: true, event: '被忽视', risk_level: 'none', action: 'continue' },
        asked: [], currentQuestion: '你当时最难受的是什么？', empathy: '这种感觉，真的挺委屈的。',
      },
    });
    location.hash = '#/followup';
  });
  await page.waitForSelector('#fuTalk', { timeout: 8000 });
  await page.waitForTimeout(1200);

  // 按住说（1.8 秒，够看到 listening 态 + 计时器走动）
  const box = await page.locator('#fuTalk').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(1800);
  await page.mouse.up();
  // 等识别填入（mock 900ms + 管线）
  await page.waitForFunction(() => document.getElementById('fuInput') && document.getElementById('fuInput').value.length > 10, { timeout: 10000 });
  await page.waitForTimeout(1500);
  // 点「回答」→ 下一问
  await page.click('#fuNext');
  await page.waitForTimeout(2200);

  const video = page.video();
  await page.close();
  const file = await video.path();
  await ctx.close();
  const target = path.join(outDir, 'followup-voice-demo.webm');
  fs.renameSync(file, target);
  console.log('录屏完成: ' + target + ' (' + fs.statSync(target).size + 'B)');
  await browser.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(2); });
