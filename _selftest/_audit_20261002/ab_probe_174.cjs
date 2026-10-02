/* v1.7.4 P1-1 干预式 A/B：同一判据（让 /api/health 永不响应 = 弱网/半开连接），
 * 分别 import HEAD 旧版 asr.js 与修复后新版 asr.js，看 probeCloud 会不会自己收尾。
 *
 * 判据（修复前必失败）：网络挂起时 probeCloud 必须 NOT 永久 pending。
 *   - 旧版预期 __HANG__（挂死）   → 缺陷复现
 *   - 新版预期 unavailable @≈6s   → 修复生效
 *
 * 端口 4192 起 python -m http.server（不缓存静态文件，改文件立刻生效）。
 */
const { chromium } = require('playwright');

const ORIGIN = process.env.AB_ORIGIN || 'http://127.0.0.1:4192';
const HANG_MS = 12000; // 观测窗口：超过它还没返回就判 __HANG__

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 420, height: 820 } });

  // 🔴 干预：探测端点彻底不响应（模拟半开连接 / 弱网挂起）。
  //    不调 continue / fulfill ⇒ 请求永久 pending。这正是 P1-1 的触发条件。
  let blocked = 0;
  await page.route('**/api/health*', () => { blocked += 1; });

  await page.goto(ORIGIN + '/_ab_lab.html', { waitUntil: 'domcontentloaded' });

  const run = async (path) =>
    page
      .evaluate(
        async ([p, hang]) => {
          const m = await import(p);
          const t0 = Date.now();
          const st = await Promise.race([
            m.probeCloud(true).catch((e) => 'error:' + (e && e.name)),
            new Promise((r) => setTimeout(() => r('__HANG__'), hang)),
          ]);
          return { st, ms: Date.now() - t0 };
        },
        [path, HANG_MS]
      )
      .catch((e) => ({ st: 'EVAL_FAIL', ms: -1, err: String(e).slice(0, 160) }));

  const OLD = await run('/_ab_old/js/asr.js');
  const NEW = await run('/_ab_new/js/asr.js');

  console.log('被拦下的 /api/health 请求次数:', blocked);
  console.log('旧版(HEAD asr.js)  :', JSON.stringify(OLD));
  console.log('新版(修复后 asr.js):', JSON.stringify(NEW));
  console.log('---');

  const okOld = OLD.st === '__HANG__';
  const okNew = NEW.st === 'unavailable' && NEW.ms > 0 && NEW.ms < HANG_MS;
  console.log((okOld ? 'PASS' : 'FAIL') + '  A·旧版确实会永久 pending（缺陷可复现 ⇒ 这条判据修复前必失败）');
  console.log((okNew ? 'PASS' : 'FAIL') + '  B·新版在超时上限内自己收尾并判 unavailable（修复真生效）');

  await browser.close();
  process.exit(okOld && okNew ? 0 : 1);
})();
