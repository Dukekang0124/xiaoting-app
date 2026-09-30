// 一次性探针：这两把 key + 这三个模型名，在智谱开放平台上到底通不通？
// 不猜、不推断 —— 直接把每个「模型 × key」组合真打一次，把 HTTP 状态与错误码原样打出来。
//
// 运行：node _selftest/probe-zhipu.cjs
const fs = require('fs');
const path = require('path');

const KEYS_FILE = path.join(__dirname, '..', 'server', 'model.keys.json');
const cfg = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
const EP = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

// 探测矩阵：用户点名的三个 + 目录里真实存在的同类（用于确认「是不是名字写错了」）
const MODELS = ['glm-5.2', 'glm-4.7-flash', 'glm-4-flash', 'glm-4.6', 'glm-4.5-flash', 'glm-4.7', 'glm-5'];
const KEYNAMES = ['glm-5.2', 'glm-4.7-flash'];

async function ping(model, key) {
  const t0 = Date.now();
  try {
    const res = await fetch(EP, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: '只回复两个字：收到' }],
        stream: false,
        max_tokens: 32,
        temperature: 0.1,
      }),
    });
    const ms = Date.now() - t0;
    const txt = await res.text();
    let j = null;
    try { j = JSON.parse(txt); } catch (e) { /* 保留原文 */ }
    const ok = res.ok && j && j.choices && j.choices[0];
    const content = ok ? String(j.choices[0].message.content || '').slice(0, 30) : '';
    const err = j && j.error ? `${j.error.code || ''} ${j.error.message || ''}`.trim() : (ok ? '' : txt.slice(0, 120));
    return { ok, status: res.status, ms, content, err: err.slice(0, 160) };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, content: '', err: '网络异常：' + String(e && e.message || e).slice(0, 100) };
  }
}

(async () => {
  console.log('智谱开放平台直连探测 @ ' + EP + '\n');
  const rows = [];
  for (const kn of KEYNAMES) {
    const key = cfg.keys[kn];
    console.log(`=== 用「${kn}」这把 key（${key.slice(0, 12)}… 长度 ${key.length}）===`);
    for (const m of MODELS) {
      const r = await ping(m, key);
      rows.push({ key: kn, model: m, ...r });
      console.log(`  ${m.padEnd(16)} ${r.ok ? 'OK  ' : 'FAIL'} http=${String(r.status).padEnd(4)} ${String(r.ms).padStart(5)}ms ${r.ok ? '「' + r.content + '」' : r.err}`);
    }
    console.log('');
  }

  console.log('=== 结论矩阵 ===');
  const byModel = {};
  rows.forEach((r) => { byModel[r.model] = byModel[r.model] || {}; byModel[r.model][r.key] = r.ok ? '通' : '不通'; });
  console.log('模型'.padEnd(18) + KEYNAMES.map((k) => k.padEnd(14)).join(''));
  MODELS.forEach((m) => console.log(m.padEnd(18) + KEYNAMES.map((k) => String(byModel[m][k]).padEnd(14)).join('')));
})().catch((e) => { console.error('探针异常：', e); process.exit(2); });
