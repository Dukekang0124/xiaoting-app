/**
 * 墨小溟 · 云端语音识别（Cloudflare Pages Functions + Workers AI Whisper）
 *
 * 为什么是 Pages 而不是 Worker：
 *   实测 *.workers.dev 在国内被 DNS 污染（三个公共 DNS 都返回 face:b00c 段、
 *   且三个 IP 互不相同），而 *.pages.dev 返回真实 Cloudflare anycast 且多 DNS 一致。
 *   所以对外域名走 pages.dev，函数体本身与 Worker 无关。
 *
 * 契约与本地 server.cjs 的 /api/asr 完全一致，便于前端零改动切换：
 *   请求  POST /api/asr
 *         { "speech": "<base64 音频>", "lang": "zh" }      ← JSON（与本地一致）
 *         或 原始二进制音频体（Content-Type: audio/*）
 *   成功  { ok: true, text, engine: 'cf-whisper', ms }
 *   失败  { ok: false, error, detail?, ms }
 *   —— 错误码沿用本地语义（asr_not_configured / empty_audio / audio_too_long /
 *      asr_network / asr_failed），前端的三层降级判定不需要为新后端加分支。
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-lang',
  'Access-Control-Max-Age': '86400',
};

// 单次请求音频上限。Whisper 单文件上限约 25MB，这里按 base64 长度收口，
// 与本地 server.cjs 的 MAX_B64_LEN 同数量级，防止误传超长音频烧额度。
const MAX_B64_LEN = 8 * 1024 * 1024;

const MODEL = '@cf/openai/whisper-large-v3-turbo';

// 构建标记：用来确认「线上跑的到底是哪一版」。
// 这条是从本项目历史里带过来的教训 —— 文件名、md5、体积都不能证明版本，
// 只有代码里真写着的标记能证明。发版后拿它对照，避免又出现「本地改了、线上没生效」。
const BUILD = 'asr-2026-09-30-audiob64';

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(u8) {
  let s = '';
  const CHUNK = 0x8000; // 分块，避免 apply 参数过多爆栈
  for (let i = 0; i < u8.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(request.url);

  if (url.pathname === '/api/health' || url.pathname === '/') {
    return json({
      ok: true,
      service: 'xiaoting-asr',
      model: MODEL,
      ai_binding: !!env.AI,
      msg: env.AI ? 'Whisper ASR ready' : '缺少 AI 绑定：[ai] binding = "AI"',
    });
  }

  if (url.pathname !== '/api/asr') return json({ ok: false, error: 'not_found' }, 404);
  if (request.method !== 'POST') return json({ ok: false, error: 'use_post' }, 405);

  // 没绑 AI：明确返回「未配置」，前端据此判定为结构性不可用并降级，
  // 不要伪装成网络失败，否则用户会反复重试一个永远不会成功的通道。
  if (!env.AI) {
    return json({ ok: false, error: 'asr_not_configured', detail: 'AI binding missing' }, 503);
  }

  const t0 = Date.now();
  const ctype = request.headers.get('content-type') || '';
  let bytes = null;
  let audioB64 = '';
  let lang = request.headers.get('x-lang') || '';

  try {
    if (ctype.includes('application/json')) {
      const body = await request.json();
      const speech = String((body && body.speech) || '');
      lang = lang || String((body && body.lang) || '');
      if (!speech) return json({ ok: false, error: 'empty_audio', ms: Date.now() - t0 }, 400);
      if (speech.length > MAX_B64_LEN) {
        return json({ ok: false, error: 'audio_too_long', max: MAX_B64_LEN, ms: Date.now() - t0 }, 413);
      }
      audioB64 = speech;
      bytes = b64ToBytes(speech);
    } else {
      const buf = await request.arrayBuffer();
      if (buf && buf.byteLength > MAX_B64_LEN) {
        return json({ ok: false, error: 'audio_too_long', max: MAX_B64_LEN, ms: Date.now() - t0 }, 413);
      }
      bytes = new Uint8Array(buf || new ArrayBuffer(0));
      audioB64 = bytesToB64(bytes);
    }
  } catch (e) {
    return json({ ok: false, error: 'bad_body', detail: String((e && e.message) || e) }, 400);
  }

  if (!bytes || bytes.byteLength === 0) {
    return json({ ok: false, error: 'empty_audio', ms: Date.now() - t0 }, 400);
  }

  // 语种提示：墨小溟是中文情绪产品，默认 zh；显式传 en 时按 en。
  // 只接受白名单，避免把任意字符串透传给上游。
  const hint = ['zh', 'en'].includes(lang) ? lang : 'zh';

  try {
    // 🔴 audio 必须传 base64 字符串 —— 这是实测出来的，且与报错信息相反：
    //    传 Array.from(Uint8Array) / Uint8Array / ArrayBuffer 都会被拒
    //    （5006: "Type mismatch of '/audio', 'string' not in 'array','binary'"，
    //      这条报错本身是反的：数组会被转成 string 再被判不合格），
    //    只有 base64 字符串能过（与官方 schema-input.json 一致）。
    //
    // 另一条实测结论（更反直觉）：**请求里带进来的 base64 与运行时自己
    // btoa 出来的 base64，文本可能不同**（前者会 3030「Failed to decode audio file」，
    // 后者能正常识别）。所以这里不赌哪一个对，两个都试，谁先成功用谁，
    // 并把实际生效的形态记进返回体，便于日后追查。
    const candidates = [['raw', audioB64]];
    const reencoded = bytesToB64(bytes);
    if (reencoded !== audioB64) candidates.push(['reencoded', reencoded]);

    const tried = [];
    let out = null;
    let usedShape = '';
    for (const [shape, payload] of candidates) {
      try {
        out = await env.AI.run(MODEL, { audio: payload, language: hint });
        usedShape = shape;
        tried.push({ shape, ok: true });
        break;
      } catch (err) {
        tried.push({ shape, ok: false, err: String((err && err.message) || err).slice(0, 120) });
      }
    }

    const text = (out && out.text ? String(out.text) : '').trim();
    if (!text) {
      // 「没识别到」不是错误，是空结果：前端据此提示重录，不该走失败降级。
      return json({
        ok: false, error: 'asr_empty', engine: 'cf-whisper',
        audioShape: usedShape, tried, ms: Date.now() - t0,
      });
    }
    return json({
      ok: true,
      text,
      engine: 'cf-whisper',
      model: MODEL,
      lang: hint,
      bytes: bytes.byteLength,
      audioShape: usedShape,
      ms: Date.now() - t0,
    });
  } catch (e) {
    return json({
      ok: false,
      error: 'asr_failed',
      detail: String((e && e.message) || e),
      build: BUILD,
      // 排障用：证明到底把什么类型交给了运行时（不许凭猜）
      debug: { audioType: typeof audioB64, audioLen: audioB64.length, bytes: bytes.byteLength, lang: hint },
      ms: Date.now() - t0,
    }, 502);
  }
}
