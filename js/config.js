// 墨小溟 · 运行期配置
// publicConfig 由 WorkBuddy 云服务在开通时下发，只有 resourceId / endpoint / publishableKey
// 三个值可以进前端源码（publishableKey 本身不带任何权限，服务端按 Origin 精确匹配放行）。
// 底层环境 id 与厂商密钥全部留在服务端，前端永远拿不到，也不需要。

export const CLOUD = {
  endpoint: 'https://xiaoting.app.workbuddy.host',
  publishableKey: 'wbpk_UIbhopeTjkEWVQhMQ0Q0Ia_qOJRuVD4iBCKnctk4ks1e7G1YT9H3NWS',
  resourceId: 'wbcs_CrnorO7a0CaC4xefBz6Rrp',
};

/** 云服务 SDK：本项目是无构建的多模块 PWA，按官方约定走 CDN IIFE（暴露全局 WorkBuddyCloud）。 */
export const SDK_URL =
  'https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js';

/**
 * AI 运行参数。
 * 说明：MVP 阶段「后端」= WorkBuddy 云服务的免密钥 LLM 网关（服务端发起真实模型调用）。
 * 任一环节不可用时，api.js 会降级到 js/ai.js 的本地规则引擎，保证流程永远能走完。
 */
export const AI = {
  enabled: true,          // 总开关
  sdkTimeoutMs: 4500,     // 等 SDK 加载的上限（超时即降级，不卡住页面）
  callTimeoutMs: 15000,   // 单次模型调用超时（含流式收集）；实测正常模型 1.3-3s，故留 5-10 倍余量
  modelAttempts: 2,       // 单次请求最多换几个模型（目录里思考型模型很慢，换模型比死等划算）
  retry: 1,               // 同一模型上的瞬时故障重试次数
  minThinkingMs: 600,     // 「分析中」页最短停留，避免一闪而过
  maxInputChars: 2000,    // 用户输入截断上限（防超长输入把 Prompt 顶爆）
};

/** 调试/离线自测可用：URL 加 ?ai=mock，或 localStorage 置 xiaoting:ai=mock */
export const AI_OVERRIDE_KEY = 'xiaoting:ai';

/**
 * 语音识别（v0.5.0）。
 * 说明：浏览器内置 Web Speech 在 iOS Safari / 微信内置浏览器里不可用，而这两处是国内真机流量的大头，
 * 所以「按住说」改走同源服务端的专业云端 ASR（密钥在服务端，前端拿不到）。
 * 三个端点都由 server.cjs 提供；纯静态托管时它们会 404，asr.js 会自动降级，不会白屏。
 */
export const ASR = {
  endpoint: '/api/asr',      // POST { speech: base64, lang } → { ok, text }
  health: '/api/health',     // GET 探测服务端是否配好密钥（顺带在服务端预热 token）
  events: '/api/events',     // POST 内测埋点批量上报
  lang: 'zh',                // 墨小溟是中文产品；服务端映射 dev_pid 1537
  timeoutMs: 15000,          // 单次识别超时（含上传）；实测云端 1-3s，留足余量
  minB64Len: 2000,           // 约 0.05 秒以下的音频视为没录到内容
  maxB64Len: 2_900_000,      // 约 55 秒上限，与百度 60 秒硬限制留出余量
  maxSeconds: 55,            // 录音时长上限，到点自动停（避免录太久被服务端拒）
};

