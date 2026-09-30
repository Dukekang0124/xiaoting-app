/**
 * 诊断：线上 /version.json 到底能不能被「真实客户端」取到？
 *
 * 背景：通牒文档称「点检查更新提示深海信号微弱 ⇒ /api/version/latest 请求彻底失败」。
 *  实测 curl 的两个候选：
 *    /api/version/latest → 404（符合已知事实：静态托管无 Node 后端）
 *    /version.json       → HTTP 200 但 **size=0**
 *  ⚠️ 但 size=0 可能是**我的测量工具问题**：我手写了
 *     `Accept-Encoding: gzip, deflate, br, zstd`，若本机 curl 不带 brotli 解码能力，
 *     服务端选了 br ⇒ curl 无法解压 ⇒ body 被丢弃 ⇒ 看起来"空响应"。
 *     🔴 纪律：判「外部依赖是否失效」必须走真实客户端，不许手改请求头推断
 *        （协议写错的探针会造出比真缺陷更吓人的假警报 —— 本仓踩过）。
 *
 * 所以本脚本用三种独立通道交叉验证：
 *   ① Node undici fetch（默认协议栈，自动协商 br/zstd）
 *   ② 三种显式 Accept-Encoding（gzip / identity / br），逐个看 size
 *   ③ 真实 Chrome（Playwright）里跑 update 模块，拿到它自己认为的结果
 */
const BASE = process.env.BASE || 'https://xiaoting.app.workbuddy.host';

async function tryFetch(label, url, headers) {
  try {
    const r = await fetch(url, { redirect: 'follow', headers, cache: 'no-store' });
    const txt = await r.text();
    let parsed = null, parseErr = '';
    try { parsed = JSON.parse(txt); } catch (e) { parseErr = e.message; }
    console.log(`  ${label}`);
    console.log(`    status=${r.status} bytes=${txt.length} enc=${r.headers.get('content-encoding') || '-'} ct=${r.headers.get('content-type') || '-'}`);
    if (parsed) console.log(`    ✓ JSON 合法，latest_version=${parsed.latest_version} versionCode=${parsed.apk && parsed.apk.versionCode}`);
    else console.log(`    ✗ JSON 解析失败：${parseErr}  前 80 字："${txt.slice(0, 80)}"`);
    return { ok: r.ok, bytes: txt.length, parsed, body: txt };
  } catch (e) {
    console.log(`  ${label}\n    通道异常：${e.message}`);
    return { ok: false, bytes: 0, error: e.message };
  }
}

(async () => {
  console.log(`目标：${BASE}`);
  console.log('='.repeat(70));
  console.log('① Node undici fetch（默认协商，等价于一个正常 HTTP 客户端）');
  const a = await tryFetch('GET /version.json', `${BASE}/version.json`);
  await tryFetch('GET /api/version/latest', `${BASE}/api/version/latest`);

  console.log('\n② 显式指定 Accept-Encoding，逐个验证是否为压缩解码问题');
  for (const ae of ['identity', 'gzip', 'br']) {
    await tryFetch(`AE=${ae}`, `${BASE}/version.json`, { 'accept-encoding': ae });
  }

  console.log('\n③ 真实 Chrome 里跑 update 模块（最接近用户的一条路）');
  let browser;
  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const net = [];
    page.on('response', async (r) => {
      if (/version/.test(r.url())) {
        let len = -1;
        try { len = (await r.body()).length; } catch (e) {}
        net.push({ url: r.url().replace(BASE, ''), status: r.status(), len });
      }
    });
    await page.goto(`${BASE}/#/say`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3500);
    const res = await page.evaluate(async () => {
      try {
        const u = await import('/js/update.js');
        const r = await u.checkUpdate({ manual: true });
        const d = await u.fetchLatest();
        return { reason: r.reason, shown: r.shown, latest: d && d.latest_version, err: u.lastFetchError() };
      } catch (e) { return { err: String(e).slice(0, 200) }; }
    });
    console.log('  checkUpdate() 返回：', JSON.stringify(res));
    console.log('  实际网络：', JSON.stringify(net));
  } catch (e) {
    console.log('  真浏览器通道异常：', e.message);
  } finally {
    try { if (browser) await browser.close(); } catch (e) {}
  }

  console.log('='.repeat(70));
  console.log(a.parsed
    ? '结论：真实客户端能正常取到版本清单 ⇒ 「检查更新」的失败不是接口本身，需从别处找原因'
    : '结论：真实客户端也取不到 ⇒ /version.json 这条链路确实断了，是真缺陷');
})();
