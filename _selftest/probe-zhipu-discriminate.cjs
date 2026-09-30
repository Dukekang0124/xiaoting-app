// 对照实验：把「模型不存在」与「账号没余额」两种情况分开 —— 不做这一步就无法判断
// 「glm-5.2 调不通」到底是名字写错了，还是这个账号没给高阶模型付费。两者处置完全不同。
//
// 鉴别力校验：如果编造的名字和用户点名的名字返回同一个错误码，那这个探针就没有鉴别力，结论作废。
//
// 运行：node _selftest/probe-zhipu-discriminate.cjs
const fs = require('fs');
const path = require('path');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'model.keys.json'), 'utf8'));
const EP = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const KEY = cfg.keys['glm-4.7-flash'];   // 实测有效的那把

const CASES = [
  { model: 'glm-4-flash', label: '已证实可用（对照组）' },
  { model: 'glm-5.2', label: '用户点名·档位1' },
  { model: 'glm-4.7-flash', label: '用户点名·档位2' },
  { model: 'glm-4.7-flash', label: '用户点名·档位2（重试2）' },
  { model: 'glm-4.7-flash', label: '用户点名·档位2（重试3）' },
  { model: 'zzz-not-a-real-model-9.9', label: '编造名（鉴别力对照）' },
];

async function call(model, extra = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(EP, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: '你是助手。' }, { role: 'user', content: '只回复两个字：收到' }],
        stream: false, max_tokens: 32, temperature: 0.1, ...extra,
      }),
    });
    const txt = await res.text();
    let j = null; try { j = JSON.parse(txt); } catch (e) {}
    return {
      http: res.status, ms: Date.now() - t0,
      code: (j && j.error && j.error.code) || '',
      msg: (j && j.error && j.error.message) || (j && j.choices ? 'OK' : txt.slice(0, 80)),
      content: j && j.choices && j.choices[0] ? String(j.choices[0].message.content || '') : '',
    };
  } catch (e) {
    return { http: 0, ms: Date.now() - t0, code: 'network', msg: String(e && e.message || e), content: '' };
  }
}

(async () => {
  console.log('对照实验：模型不存在 vs 账号无余额\n');
  for (const c of CASES) {
    const r = await call(c.model);
    console.log(`  ${c.label.padEnd(24)} ${c.model.padEnd(26)} http=${String(r.http).padEnd(4)} code=${String(r.code).padEnd(6)} ${r.ms}ms  ${r.msg}${r.content ? ' 「' + r.content + '」' : ''}`);
  }

  console.log('\n=== JSON 模式（response_format）在免费档上能不能用 ===');
  const j1 = await call('glm-4-flash', { response_format: { type: 'json_object' }, messages: [{ role: 'system', content: '只输出 JSON。' }, { role: 'user', content: '{"ok":true} 这个格式回给我' }] });
  console.log(`  glm-4-flash + json_object → http=${j1.http} code=${j1.code || '-'} ${j1.ms}ms ${j1.msg} 「${j1.content.slice(0, 60)}」`);

  console.log('\n=== 流式（stream:true）在免费档上能不能用 ===');
  const sup = await (async () => {
    const t0 = Date.now();
    const res = await fetch(EP, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
      body: JSON.stringify({ model: 'glm-4-flash', messages: [{ role: 'user', content: '数到三' }], stream: true, max_tokens: 32 }),
    });
    const txt = await res.text();
    const hasSse = txt.includes('data:');
    return { http: res.status, ms: Date.now() - t0, hasSse, head: txt.slice(0, 120).replace(/\n/g, '⏎') };
  })();
  console.log(`  glm-4-flash + stream:true → http=${sup.http} ${sup.ms}ms SSE=${sup.hasSse}`);
  console.log(`  原文头: ${sup.head}`);
})().catch((e) => { console.error('异常：', e); process.exit(2); });
