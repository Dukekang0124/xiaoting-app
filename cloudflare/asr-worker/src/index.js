/**
 * 墨小溟 · 云端语音识别 —— Cloudflare **Worker** 版
 *
 * 与 Pages 版（`cloudflare/asr/functions/api/asr.js`）逻辑完全一致，只有入口不同：
 *   · Pages Functions：`export async function onRequest(context)`
 *   · Worker         ：`export default { async fetch(request, env, ctx) }`
 * 之所以两个都留：Pages 用 `*.pages.dev`、Worker 用 `*.workers.dev`，
 * 国内网络对这两类域名的可达性**不一样**，由真机实测决定用哪个，不靠猜。
 *
 * 契约（与本地 server.cjs 的 /api/asr 完全一致，前端零改动即可切换）：
 *   请求  POST /api/asr
 *         { "speech": "<base64 音频>", "lang": "zh" }      ← JSON
 *         或 原始二进制音频体（Content-Type: audio/*）
 *   成功  { ok: true, text, engine: 'cf-whisper', ms }
 *   失败  { ok: false, error, detail?, ms }
 *   错误码沿用本地语义：asr_not_configured / empty_audio / audio_too_long /
 *                      asr_empty / bad_body / use_post / asr_failed
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-lang',
  'Access-Control-Max-Age': '86400',
};

// 单次请求音频上限（base64 长度）。与本地 server.cjs 的 MAX_B64_LEN 同数量级，防烧额度。
const MAX_B64_LEN = 8 * 1024 * 1024;

const MODEL = '@cf/openai/whisper-large-v3-turbo';

// 构建标记：唯一能证明「线上跑的到底是哪一版」的东西。
// 文件名、md5、部署时间都不可靠（本项目用这条实证过一次：「本地改了、线上没生效」）。
const BUILD = 'asr-worker-2026-10-01';

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

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);

    // Worker 没有「文件即路由」，路径全在函数里判 —— 这也是它比 Pages 灵活的地方。
    if (url.pathname === '/' || url.pathname === '/api/health') {
      return json({
        ok: true,
        service: 'xiaoting-asr-worker',
        build: BUILD,
        model: MODEL,
        ai_binding: !!env.AI,
        msg: env.AI ? 'Whisper ASR ready' : '缺少 AI 绑定：wrangler.toml 里要有 [ai] binding = "AI"',
      });
    }

    if (url.pathname !== '/api/asr') return json({ ok: false, error: 'not_found' }, 404);
    if (request.method !== 'POST') return json({ ok: false, error: 'use_post' }, 405);

    // 没绑 AI 必须明确报「未配置」，不能伪装成网络失败 ——
    // 否则前端会反复重试一条永远不可能成功的通道，用户只会觉得「一直转圈」。
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

    // 语种提示白名单，避免把任意字符串透传给上游
    const hint = ['zh', 'en'].includes(lang) ? lang : 'zh';

    try {
      // 🔴 audio 必须传 base64 字符串（实测，且与报错信息相反）：
      //    传 Array.from(Uint8Array) / Uint8Array / ArrayBuffer 全被拒，
      //    报错写作 "string not in 'array','binary'" —— 是反的，别信它。
      //
      // 🔴 更反直觉的一条：请求里带进来的 base64 与运行时自己 btoa 出来的
      //    可能不同（前者偶发 3030 解码失败，后者正常）。这里两个都试，谁先用谁。
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
        // 「没识别到」是空结果不是错误：前端据此提示重录，不该走失败降级。
        return json({ ok: false, error: 'asr_empty', engine: 'cf-whisper', audioShape: usedShape, tried, ms: Date.now() - t0 });
      }
      return json({
        ok: true, text, engine: 'cf-whisper', model: MODEL, lang: hint,
        bytes: bytes.byteLength, audioShape: usedShape, ms: Date.now() - t0,
      });
    } catch (e) {
      return json({
        ok: false,
        error: 'asr_failed',
        detail: String((e && e.message) || e),
        build: BUILD,
        debug: { audioType: typeof audioB64, audioLen: audioB64.length, bytes: bytes.byteLength, lang: hint },
        ms: Date.now() - t0,
      }, 502);
    }
  },
};
