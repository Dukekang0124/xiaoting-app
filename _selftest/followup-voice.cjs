#!/usr/bin/env node
/* 墨小溟 · 追问页「按住说」探针（v1.4.5）
 *
 * 覆盖：① UI 接线 ② 按住录音态 + IP listening + 「回答」禁用 ③ 松手识别成功 → 填入输入框（可改）
 * ④ 滑出取消 → 不提交 ⑤ 识别失败 → 温柔提示文字兜底 ⑥ 录音中点跳过 → 先停录音再跳过
 *
 * ENV=1 BASE=http://127.0.0.1:4174 node _selftest/followup-voice.cjs
 */
const path = require('path');
module.paths.push(process.env.NODE_PATH || 'C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules');
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:4174';
const FU_DEMO = '我当时一直盯着手机屏幕，越等越心慌，觉得他根本不在乎我。';

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  —  ' + detail : ''}`);
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'zh-CN', isMobile: true, hasTouch: true, permissions: ['microphone'] });
  await ctx.addInitScript(() => {
     try { localStorage.setItem('monthly:done_' + (new Date().getFullYear() * 100 + (new Date().getMonth() + 1)), '1'); } catch (e) {}
    try { localStorage.setItem('moxiaoming:welcomed_v1', '1'); localStorage.setItem('xiaoting:ai', 'mock'); } catch (e) {}
  });
  let asrCalls = 0, asrShouldFail = false;
  await ctx.route('**/api/asr', (r) => {
    asrCalls++;
    if (asrShouldFail) return r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false }) });
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, text: FU_DEMO, engine: 'mock', ms: 1 }) });
  });
  await ctx.route('https://xiaoting-asr.pages.dev/api/health', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, ai_binding: true }) }));

  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  await page.goto(BASE + '/#/say', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#talkbtn', { timeout: 10000 });

  // 注入 draft 直达追问页（绕过长闭环，聚焦追问页自身的语音交互）
  await page.evaluate(async (T) => {
    const m = await import('/js/app.js');
    const t = m.__test__;
    t.store.setState({
      draft: {
        transcript: '今天又和男朋友吵架了，他很晚才回我消息。',
        analysis: { needs_followup: true, event: '被忽视', risk_level: 'none', action: 'continue' },
        asked: [], currentQuestion: '你当时最难受的是什么？', empathy: '这种感觉，真的挺委屈的。',
      },
    });
    location.hash = '#/followup';
  }, FU_DEMO);
  await page.waitForSelector('#fuTalk', { timeout: 8000 });

  // ① UI 接线
  const ui = await page.evaluate(() => ({
    talk: !!document.getElementById('fuTalk'),
    label: (document.getElementById('fuTalkLabel') || {}).textContent,
    input: !!document.getElementById('fuInput'),
    next: !!document.getElementById('fuNext'),
  }));
  check('①·追问页有「按住说」按钮（语音优先）', ui.talk && ui.label === '按住说', JSON.stringify(ui));
  check('①·文字输入框仍在（文字兜底双通道）', ui.input && ui.next, '');

  // ② 按住 → 录音态 + IP listening + 回答禁用
  const box = await page.locator('#fuTalk').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  const rec = await page.evaluate(() => ({
    label: document.getElementById('fuTalkLabel').textContent,
    timer: document.getElementById('fuTalkTimer').textContent,
    nextDisabled: document.getElementById('fuNext').disabled,
    ipState: (document.querySelector('#fuMascot svg') || { getAttribute: () => '' }).getAttribute('data-state'),
  }));
  check('②·按住进入录音态（松手结束 + 计时）', rec.label === '松手结束' && parseFloat(rec.timer) > 0, JSON.stringify(rec));
  check('②·IP 切换为倾听态（listening）', rec.ipState === 'listening', `data-state=${rec.ipState}`);
  check('②·录音期间「回答」按钮禁用（防重复提交）', rec.nextDisabled === true, `disabled=${rec.nextDisabled}`);

  // ③ 松手 → 识别成功 → 填入输入框（不自动提交）
  await page.mouse.up();
  await page.waitForTimeout(1400);
  const done = await page.evaluate(() => ({
    value: document.getElementById('fuInput').value,
    nextDisabled: document.getElementById('fuNext').disabled,
    ipState: (document.querySelector('#fuMascot svg') || { getAttribute: () => '' }).getAttribute('data-state'),
    hint: document.getElementById('fuTalkHint').textContent,
    label: document.getElementById('fuTalkLabel').textContent,
  }));
  check('③·识别文本自动填入输入框（可修改再回答）', done.value === FU_DEMO, done.value.slice(0, 24) + '…');
  check('③·识别结束后「回答」恢复可用', done.nextDisabled === false, `disabled=${done.nextDisabled}`);
  check('③·IP 回归本页派生态（empathy）', done.ipState === 'empathy', `data-state=${done.ipState}`);
  check('③·结果可见且有引导文案', /写进输入框/.test(done.hint) && done.label === '按住说', done.hint);

  // ④ 滑出取消 → 不提交
  const before = asrCalls;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(500);
  await page.mouse.move(box.x + box.width + 60, box.y + box.height / 2); // 滑出
  await page.waitForTimeout(700);
  const cancelled = await page.evaluate(() => ({
    value: document.getElementById('fuInput').value,
    label: document.getElementById('fuTalkLabel').textContent,
    nextDisabled: document.getElementById('fuNext').disabled,
    hint: document.getElementById('fuTalkHint').textContent,
  }));
  check('④·滑出按钮区取消：输入框内容不被覆盖', cancelled.value === FU_DEMO, cancelled.value.slice(0, 18) + '…');
  check('④·取消后按钮复位 + 明确反馈', cancelled.label === '按住说' && /取消/.test(cancelled.hint), cancelled.hint);
  check('④·取消不触发识别', asrCalls === before, `asrCalls=${asrCalls}/${before}`);

  // ⑤ 识别失败 → 温柔提示文字兜底（mock 500 会触发 3 次重试 + 退避，等待窗口要给足）
  asrShouldFail = true;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(600);
  await page.mouse.up();
  await page.waitForFunction(() => (document.getElementById('fuTalkHint') || {}).textContent !== '', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(400);
  const failed = await page.evaluate(() => ({
    hint: document.getElementById('fuTalkHint').textContent,
    value: document.getElementById('fuInput').value,
    ipState: (document.querySelector('#fuMascot svg') || { getAttribute: () => '' }).getAttribute('data-state'),
  }));
  check('⑤·识别失败温柔提示（文字兜底）', /水里有点吵/.test(failed.hint), failed.hint);
  check('⑤·失败后 IP 回归 + 输入框不被污染', failed.ipState === 'empathy' && failed.value === FU_DEMO, failed.ipState);
  asrShouldFail = false;

  // ⑥ 录音中点「跳过」→ 先停录音再跳过
  const before6 = asrCalls;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(500);
  await page.click('#fuSkip');
  await page.waitForTimeout(1500);
  const skipped = await page.evaluate(() => ({
    // mock AI 下跳过可能直接收敛出卡（ready_for_card）⇒ 页面推进 ⇒ 追问页元素不存在 = 合法推进
    left: !document.getElementById('fuTalkLabel'),
    label: document.getElementById('fuTalkLabel') ? document.getElementById('fuTalkLabel').textContent : '(已推进到下一环节)',
    nextDisabled: document.getElementById('fuNext') ? document.getElementById('fuNext').disabled : false,
  }));
  check('⑥·录音中跳过：流程推进且无残留录音 UI（录音被先停掉）',
    skipped.left || (skipped.label === '按住说' && skipped.nextDisabled === false), JSON.stringify(skipped));
  check('⑥·中止不触发识别（fuAbort 是同步停，不发音频）', asrCalls === before6, `asrCalls=${asrCalls}/${before6}`);
  check('全程无未捕获异常', errors.length === 0, errors.slice(0, 2).join(' | '));

  await browser.close();
  console.log(`\n==== 追问页语音探针：PASS ${pass} / FAIL ${fail} ====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('运行异常：', e && e.message); process.exit(2); });
