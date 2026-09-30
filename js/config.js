// 墨小溟 · 运行期配置
// publicConfig 由 WorkBuddy 云服务在开通时下发，只有 resourceId / endpoint / publishableKey
// 三个值可以进前端源码（publishableKey 本身不带任何权限，服务端按 Origin 精确匹配放行）。
// 底层环境 id 与厂商密钥全部留在服务端，前端永远拿不到，也不需要。

export const CLOUD = {
  endpoint: 'https://xiaoting.app.workbuddy.host',
  publishableKey: 'wbpk_UIbhopeTjkEWVQhMQ0Q0Ia_qOJRuVD4iBCKnctk4ks1e7G1YT9H3NWS',
  resourceId: 'wbcs_CrnorO7a0CaC4xefBz6Rrp',
};

/**
 * 云服务 SDK：本项目是无构建的多模块 PWA，按官方约定走 CDN IIFE（暴露全局 WorkBuddyCloud）。
 *
 * 🔴 v1.1.3：首选取**随包发布的本地副本**，失败才回退 CDN。
 * 为什么要改：APK 里网页跑在 WebView 上，一旦用户网络访问不到 jsdelivr（国内网络下这是常态），
 * SDK 加载失败 → `sdk_unavailable` → 整条 AI 链路降级到本地规则引擎。
 * 表现就是「App 看起来在转圈，其实一个模型都没调」—— 这类失败最难自查，因为它不报错。
 * 本地副本随 index.html 一起进包，离线也能建客户端，把这条失败路径彻底消掉。
 */
export const SDK_URL = './vendor/workbuddy-cloud-sdk.js';
export const SDK_URL_FALLBACK =
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
 * 服务端可达基址（v1.1.2 真机修复的关键）。
 *
 * 🔴 为什么必须有这个：APK 里网页跑在 WebView 的 `https://localhost` 上（Capacitor androidScheme=https），
 * 而 `/api/asr`、`/api/health` 是**相对路径** ⇒ 请求打的是 WebView 本地资产服务，永远 404。
 * 表现是：`probeCloud()` 拿到 'unavailable' ⇒ 云端识别**一次都不尝试** ⇒ 直接弹「没听清」。
 * 真机上「按住说完全没反应」就是这么来的，跟录音权限、音频格式都没关系。
 * 所以：原生容器里一律走绝对基址；Web 上保持同源（本地起 server.cjs 联调时不受影响）。
 */
export const HOSTED_ORIGIN = 'https://xiaoting.app.workbuddy.host';

export function isNativeApp() {
  try {
    return !!(typeof window !== 'undefined' && window.Capacitor
      && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  } catch (e) { return false; }
}

/** 惰性求值：Capacitor 的 bridge 可能在页面脚本之后才就绪，不能在模块加载时算死。 */
export function apiBase() {
  try { return isNativeApp() ? HOSTED_ORIGIN : ''; } catch (e) { return ''; }
}

/**
 * 语音识别（v0.5.0）。
 * 说明：浏览器内置 Web Speech 在 iOS Safari / 微信内置浏览器里不可用，而这两处是国内真机流量的大头，
 * 所以「按住说」改走同源服务端的专业云端 ASR（密钥在服务端，前端拿不到）。
 * 三个端点都由 server.cjs 提供；拿不到时 asr.js 会自动降级到原生识别 / 打字，不会白屏。
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

/**
 * 云端语音识别后端（v1.4.1 · A' 方案）。
 *
 * 【为什么必须换后端】上面 ASR.endpoint 是同源 /api/asr，由 server.cjs 提供。
 * 但线上是**纯静态托管**（没有 Node 进程）⇒ APK 里这个地址恒 404。
 * 也就是说：代码里「云端 ASR 优先」这条链路，从上线第一天起就从来没跑通过一次。
 *
 * 【为什么是 pages.dev 不是 workers.dev】2026-09-30 实测 DNS：
 *   · *.workers.dev —— 三个公共 DNS 全部返回 face:b00c（Facebook 段）且三个 IP 互不相同 ⇒ GFW 污染
 *   · *.pages.dev   —— 返回真实 Cloudflare anycast，且多个 DNS 完全一致 ⇒ 干净
 * 域名不一样，可达性就是两个世界。
 *
 * 【稳定性】实测该后端有两类**瞬态**失败，重试即可成功，绝不能当成"后端坏了"：
 *   · 403 + error code: 1010 —— Cloudflare 风控，高频请求触发，退避后自愈
 *   · 3030 Failed to decode audio file —— 同一份输入原封不动重试就成功
 * 所以接入必须带重试（见 asr.js 的 isTransient）。
 *
 * 【成本】Workers AI 免费档约 10k neurons/天（≈45 分钟音频），零成本。
 */
export const CLOUD_ASR = {
  origin: 'https://xiaoting-asr.pages.dev',
  endpoint: '/api/asr',
  health: '/api/health',
  lang: 'zh',
  timeoutMs: 25000,          // 单次超时。实测 6.7s 音频约 1.8~3.4s，留足一倍余量
  maxAttempts: 3,            // 含首次，共 3 次（应对上面两类瞬态失败）
  backoffMs: 700,            // 退避基值，按 700/1400ms 递增
};

