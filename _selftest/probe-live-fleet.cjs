/**
 * 探针：线上网关「fleet 一致性」——有多少边缘节点还在发旧版。
 *
 * 为什么需要它：
 *   单次探测会 flaky。实测同一 URL + 同一 Chrome 请求头，8 秒内三次拿到 1.3.5 / 1.2.1 / 1.2.1，
 *   且 `Age` 差值远大于采样间隔 ⇒ 这是 **多边缘节点各自缓存、状态不一致**（Server: CloudStudio Gateway），
 *   不是「没回源」也不是「源上是旧版」。
 *   判「改动是否真的上线」必须看**分布**：只要还有节点发旧版，真实用户就可能命中旧版。
 *
 * 判据：
 *   N 次采样全部返回期望版本 ⇒ PASS（fleet 已收敛）
 *   出现任何旧版 ⇒ FAIL，并打印新旧比例 + 旧快照时间戳
 *
 * 用法：EXPECT=1.3.5 SAMPLES=12 node _selftest/probe-live-fleet.cjs
 */
const BASE = process.env.BASE || 'https://xiaoting.app.workbuddy.host';
const EXPECT = process.env.EXPECT || '1.3.5';
const N = Number(process.env.SAMPLES || 12);

// 与真实 Chrome 完全一致的请求头组合（缓存键 = 路径 + 完整 Accept-Encoding 串）
const HEADERS = {
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-encoding': 'gzip, deflate, br, zstd',
  'accept-language': 'zh-CN,zh;q=0.9',
  'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none',
  'upgrade-insecure-requests': '1',
};

const TARGETS = [
  ['/', (t) => (/APP_VERSION\s*=\s*'([^']+)'/.exec(t) || [])[1] || '?'],
  ['/sw.js', (t) => (/CACHE\s*=\s*'([^']+)'/.exec(t) || [])[1]?.replace('xiaoting-v', '') || '?'],
  ['/js/app.js', (t) => (t.includes('replayIpColors') ? EXPECT : '旧')],
];

async function once(path, extract) {
  try {
    const r = await fetch(BASE + path, { redirect: 'follow', headers: HEADERS, cache: 'no-store' });
    const t = await r.text();
    return { ver: extract(t), lm: r.headers.get('last-modified') || '-', age: r.headers.get('age') || '-', status: r.status };
  } catch (e) {
    return { ver: 'ERR', lm: '-', age: '-', status: 0, err: e.message };
  }
}

(async () => {
  console.log(`fleet 一致性探针   目标：${BASE}   期望：v${EXPECT}   采样：${N} 次/资源`);
  console.log('='.repeat(72));
  let allOk = true;

  for (const [path, extract] of TARGETS) {
    const rows = [];
    for (let i = 0; i < N; i++) {
      rows.push(await once(path, extract));
      await new Promise((r) => setTimeout(r, 120));
    }
    const tally = {};
    rows.forEach((r) => { const k = `v${r.ver}|${r.lm}`; tally[k] = (tally[k] || 0) + 1; });
    const okCount = rows.filter((r) => r.ver === EXPECT).length;
    const ok = okCount === N;
    if (!ok) allOk = false;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${path.padEnd(14)} 新版本 ${okCount}/${N} 次`);
    Object.entries(tally).sort((a, b) => b[1] - a[1]).forEach(([k, c]) => {
      const [v, lm] = k.split('|');
      console.log(`        ${String(c).padStart(3)}x  ${v.padEnd(12)} lm=${lm}`);
    });
  }

  console.log('='.repeat(72));
  if (allOk) {
    console.log(`✓ fleet 已收敛：全部采样均为 v${EXPECT} —— 改动真正上线`);
    process.exit(0);
  }
  console.log('✗ fleet 尚未收敛：仍有边缘节点在发旧快照 ⇒ 真实用户可能命中旧版');
  console.log('  影响范围：仅浏览器直访（Web 首屏）；APK 用户不受影响（资源打包在壳内）。');
  process.exit(1);
})();
