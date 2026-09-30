/**
 * 云端 ASR（Cloudflare Pages Functions + Workers AI Whisper）真跑验收
 *
 * 判据全部是「行为」而不是「看起来对」：
 *   - 真音频打真接口，要求回真正的中文文本（不是断言"没抛错"）
 *   - 错误路径也要有断言（空音频 / 错误路径 / 未配置），否则只测 happy path 等于没测
 *   - 与本地 server.cjs 的 /api/asr 契约逐字段对齐，保证前端切换后端零改动
 *
 * 跑法：
 *   NODE_OPTIONS="--use-system-ca" node _selftest/probe-cf-asr.cjs
 *   或指定端点：CF_ASR_ENDPOINT=https://xxx.pages.dev/api/asr node _selftest/probe-cf-asr.cjs
 *
 * 为什么端点要能指定：本地 wrangler pages dev 与线上是两套运行环境
 * （本地没有 AI 绑定），只测其中一套都可能给出"全绿但实际上线不可用"的错觉。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(ROOT, '_selftest', 'fixtures', 'asr-zh-16k.wav');
const ENDPOINT = process.env.CF_ASR_ENDPOINT || 'https://xiaoting-asr.pages.dev/api/asr';
const HEALTH = process.env.CF_ASR_HEALTH || 'https://xiaoting-asr.pages.dev/api/health';

let pass = 0;
let fail = 0;
const failures = [];

function check(label, cond, extra) {
  if (cond) {
    pass++;
    console.log('PASS  ' + label + (extra ? '  — ' + extra : ''));
  } else {
    fail++;
    failures.push(label);
    console.log('FAIL  ' + label + (extra ? '  — ' + extra : ''));
  }
}

async function postJson(url, obj) {
  const t0 = Date.now();
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  });
  const raw = await r.text();
  let j = null;
  try { j = JSON.parse(raw); } catch (_) {}
  return { status: r.status, json: j, raw, ms: Date.now() - t0 };
}

(async () => {
  console.log('端点：' + ENDPOINT);
  console.log('');

  /* ---------- 一、健康检查（证明 Pages 与 AI 绑定都活着） ---------- */
  console.log('== 一、健康检查 ==');
  try {
    const r = await fetch(HEALTH);
    const j = await r.json();
    check('health 返回 200', r.status === 200, 'HTTP ' + r.status);
    check('health.ok === true', j.ok === true);
    check('AI 绑定已生效（否则整条链路必然 503）', j.ai_binding === true, JSON.stringify(j.ai_binding));
    check('模型名正确', j.model === '@cf/openai/whisper-large-v3-turbo', j.model);
  } catch (e) {
    check('health 可达', false, String(e.message || e));
  }
  console.log('');

  /* ---------- 二、真音频识别（核心） ---------- */
  console.log('== 二、真音频识别 ==');
  if (!fs.existsSync(FIXTURE)) {
    check('测试夹具存在', false, FIXTURE);
  } else {
    const wav = fs.readFileSync(FIXTURE);
    const speech = wav.toString('base64');
    console.log('夹具：' + (wav.length / 1024).toFixed(1) + ' KB，base64 ' + (speech.length / 1024).toFixed(1) + ' KB');

    const r = await postJson(ENDPOINT, { speech, lang: 'zh' });
    console.log('HTTP ' + r.status + ' · 端到端 ' + r.ms + 'ms');
    if (r.json) console.log('返回：' + JSON.stringify(r.json).slice(0, 300));

    check('识别请求 200', r.status === 200, 'HTTP ' + r.status);
    check('ok === true', !!(r.json && r.json.ok === true));
    check('返回了非空文本', !!(r.json && typeof r.json.text === 'string' && r.json.text.trim().length > 0),
      r.json && r.json.text ? JSON.stringify(r.json.text) : '');
    check('文本是中文（证明不是空转/回声）', !!(r.json && r.json.text && /[\u4e00-\u9fa5]/.test(r.json.text)));
    check('engine 标记为 cf-whisper', !!(r.json && r.json.engine === 'cf-whisper'), r.json && r.json.engine);
    check('带服务端耗时 ms', !!(r.json && typeof r.json.ms === 'number' && r.json.ms >= 0), r.json && String(r.json.ms) + 'ms');
    check('带音频字节数（可与请求对账）', !!(r.json && r.json.bytes === wav.length),
      r.json ? r.json.bytes + ' vs ' + wav.length : '');
    check('端到端在可接受范围（<30s）', r.ms < 30000, r.ms + 'ms');

    /* ---------- 三、错误路径（只测 happy path 等于没测） ---------- */
    console.log('');
    console.log('== 三、错误路径 ==');

    const empty = await postJson(ENDPOINT, { speech: '', lang: 'zh' });
    check('空音频 → 400 empty_audio（不是 200 假成功）',
      empty.status === 400 && empty.json && empty.json.error === 'empty_audio',
      'HTTP ' + empty.status + ' ' + (empty.json && empty.json.error));

    // 实测脚坑：Pages 对未匹配路径会回落 index.html 并返回 **200**（不是 404）。
    // 所以「未知路径返回 404」这条断言是错的 —— 真正要防的是
    // 「客户端把 HTML 当 JSON 解析」和「把 HTML 200 误判成识别成功」。
    const nope = await fetch(ENDPOINT.replace(/\/api\/asr$/, '/api/nope'));
    const nopeCtype = nope.headers.get('content-type') || '';
    const nopeBody = await nope.text();
    check('未知路径不会被误判成成功的识别结果（Pages 回落 index.html 且返回 200）',
      !nopeCtype.includes('application/json') && !/"ok"\s*:\s*true/.test(nopeBody),
      'HTTP ' + nope.status + ' ctype=' + nopeCtype);
    check('该回落确为 HTML ⇒ 客户端解析前必须校验 Content-Type（防 JSON.parse 炸）',
      nopeCtype.includes('text/html'), nopeCtype);

    const r404 = await fetch(ENDPOINT, { method: 'GET' });
    check('GET /api/asr → 405 use_post', r404.status === 405, 'HTTP ' + r404.status);

    const cors = await fetch(ENDPOINT, { method: 'OPTIONS' });
    const acao = cors.headers.get('access-control-allow-origin');
    check('CORS 预检放行（APK 的 https://localhost 源要能打）', cors.status === 204 && acao === '*',
      'HTTP ' + cors.status + ' ACAO=' + acao);
  }

  console.log('');
  console.log('==== 汇总：' + pass + '/' + (pass + fail) + ' 通过 ====');
  if (fail) {
    console.log('未通过：');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
})().catch((e) => {
  console.error('探针自身异常：', e && e.stack ? e.stack : e);
  process.exit(2);
});
