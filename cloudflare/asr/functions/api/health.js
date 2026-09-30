/**
 * 健康检查路由。
 *
 * 为什么要单独一个文件：Pages Functions 是「文件即路由」——
 * functions/api/asr.js 只绑定 /api/asr，函数体内再判断 pathname 是无效的
 * （落到 /api/health 会直接走静态资源兜底，返回 index.html，看起来像 200 其实跑错了东西）。
 * 这是本次部署实测踩到的坑，记在这里免得下次再犯。
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-lang',
};

export async function onRequestGet({ env }) {
  return new Response(
    JSON.stringify({
      ok: true,
      service: 'xiaoting-asr',
      build: 'asr-2026-09-30-audiob64',
      model: '@cf/openai/whisper-large-v3-turbo',
      ai_binding: !!env.AI,
      msg: env.AI ? 'Whisper ASR ready' : '缺少 AI 绑定：[ai] binding = "AI"',
      ts: new Date().toISOString(),
    }),
    { headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS } }
  );
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}
