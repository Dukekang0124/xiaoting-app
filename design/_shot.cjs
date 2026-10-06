const { chromium } = require('C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules/playwright');
const path = require('path');
const file = 'file://' + path.resolve(__dirname, '组件预览.html');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1120, height: 1000, deviceScaleFactor: 2 } });
  await page.goto(file, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  // 触发 toast 与开关反馈无关，直接截全页
  await page.screenshot({ path: path.resolve(__dirname, '_preview_full.png'), fullPage: true });
  // 手机预览局部
  const phone = await page.$('#phone');
  if (phone) await phone.screenshot({ path: path.resolve(__dirname, '_preview_phone.png') });
  await browser.close();
  console.log('shot done');
})().catch(e => { console.error(e); process.exit(1); });
