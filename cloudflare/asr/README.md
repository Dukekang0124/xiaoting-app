# 墨小溟 · 云端语音识别（Cloudflare Pages + Workers AI Whisper）

> 为什么需要它：APK 里「按住说」原本走同源 `/api/asr`，而线上是**纯静态托管**（没有 Node 进程）
> ⇒ 那个地址恒 404，云端识别从上线第一天起就没成功过一次。本工程把识别搬到 Cloudflare，
> 手机直接调 `https://xiaoting-asr.pages.dev/api/asr`。

## 已经部署好了（可直接测）

| 用途 | 地址 |
|---|---|
| 手机自测页（推荐，直接用这个测） | `https://xiaoting-asr.pages.dev/` |
| 健康检查 | `https://xiaoting-asr.pages.dev/api/health` |
| 识别接口 | `https://xiaoting-asr.pages.dev/api/asr` |

健康时应返回：
```json
{"ok":true,"service":"xiaoting-asr","build":"asr-2026-09-30-audiob64",
 "model":"@cf/openai/whisper-large-v3-turbo","ai_binding":true,"msg":"Whisper ASR ready"}
```
`ai_binding` 必须是 `true`；是 `false` 说明 AI 绑定没生效，识别会全部失败。

## 为什么是 Pages 而不是 Workers

不是偏好问题，是**实测结论**（2026-10-01 同一份代码、两个入口，当场对比）：

| 入口 | 域名 | 实测结果 |
|---|---|---|
| Pages | `xiaoting-asr.pages.dev` | **HTTP 200，0.79s**，`ai_binding: true` |
| Worker | `xiaoting-asr-worker.kang7108558.workers.dev` | **HTTP 000，10 秒超时，连不上** |

DNS 侧同样的结论：

- `*.workers.dev` → `74.86.17.48`，**不是 Cloudflare 的 IP 段**（CF 是 172.64-172.67 / 104.16-104.31 / 188.114…），
  且首次查询直接超时 ⇒ 劫持。
- `*.pages.dev` → `172.66.47.47` / `172.66.44.209`，真实 anycast。

⇒ 国内要能用，走 Pages。Worker 版本（`../asr-worker/`）已经部署好留作备用与对照，
**你自己用手机流量再验一次**：如果 `.workers.dev` 在你的网络下能通，就换过去，我改一行配置即可。

## Worker 版（备用，已部署）

代码在 `../asr-worker/src/index.js`，与 Pages 版逻辑完全一致，只有入口不同：
- Pages Functions：`export async function onRequest(context)`
- Worker：`export default { async fetch(request, env) }`

```bash
cd cloudflare/asr-worker
npx wrangler deploy          # 常规方式
```

🔴 本机踩到的坑：`npx wrangler` 会报 `@cloudflare/workerd-windows-64 could not be found`
（npx 缓存里缺平台二进制）。绕法是用 **REST API 直接上传**，不依赖本地运行时：

```
PUT https://api.cloudflare.com/client/v4/accounts/<account_id>/workers/scripts/<script_name>
Content-Type: multipart/form-data
  part1: metadata  {"main_module":"src/index.js","bindings":[{"type":"ai","name":"AI"}],"compatibility_date":"2026-09-01"}
  part2: 脚本本体（application/javascript+module，文件名 src/index.js）
```
再用 `POST /workers/scripts/<script_name>/subdomain` body `{"enabled":true}` 开通 `*.workers.dev`。

🔴 **不需要任何 API Key**：Workers AI 走的是账号额度 + binding，不是密钥调用。
你在教程里看到要填 `OPENAI_API_KEY` 的，那是调 OpenAI 的 Whisper，不是这个方案。

## 目录结构（Pages Functions 是「文件即路由」）

```
cloudflare/asr/
  functions/api/asr.js     → 只绑 /api/asr
  functions/api/health.js  → 只绑 /api/health（必须单独一个文件）
  public/index.html        → 手机自测页
  wrangler.toml            → [ai] binding = "AI"
```

🔴 **两个必须记住的坑**：
1. **文件即路由**：`functions/api/asr.js` 只服务 `/api/asr`；在函数体内再判断 `url.pathname` 是无效的。
   想加 `/api/health` 就**必须新建一个 `health.js`**。
2. **未匹配路径会回落 index.html 并返回 200**（不是 404）⇒ 客户端**必须校验 Content-Type**，
   否则会把 HTML 当 JSON 解析。

## 部署（从零）

```bash
cd cloudflare/asr
npx wrangler pages project create xiaoting-asr   # 首次
npx wrangler pages deploy .                       # 之后每次改完就这条
```

首次会让你登录并选账号（本项目在账号 `d24caa86` / Kang7108558@163.com 下；
该账号里还有 Sinoky 的 `kaikou-*` / `sinoky-*` 资产，**别动**）。

部署后必须做一件事：**在 Cloudflare 控制台给这个 Pages 项目绑定 Workers AI**。
路径：Pages 项目 → Settings → Functions → **AI binding**，变量名填 `AI`（与 `wrangler.toml` 一致）。
没绑就是 503 `asr_not_configured`。

## 接口契约（与本地 /api/asr 完全一致，前端不用改代码）

请求 `POST /api/asr`
```json
{ "speech": "<base64 音频>", "lang": "zh" }
```
成功
```json
{ "ok": true, "text": "识别结果", "engine": "cloudflare-whisper", "ms": 1853 }
```
失败沿用本地错误码：`asr_not_configured` / `empty_audio` / `audio_too_long` / `asr_empty` / `asr_failed`。

## 🔴 三个踩过的坑（改代码前先看）

1. **`audio` 必须传 base64 字符串**。
   传 `Array.from(Uint8Array)` / `Uint8Array` / `ArrayBuffer` **全部被拒**，
   而且**报错信息是反的**（写的是 "string not in 'array','binary'"，实际是数组被转成字符串后再判不合格）。
   真要改入参形态，先跑 `_selftest/probe-cf-asr.cjs`，别信报错文案。

2. **不稳定，必须带重试**。实测两类瞬间失败：
   - 403 `error code: 1010`：高频请求触发 CF 风控，退避约 45s 自愈；
   - `3030` 解码失败：同一份输入重发一次就成功。
   前端 `js/asr.js` 已带重试（最多 3 次，700/1400ms 退避）；
   而「空音频」「说太久」「没识别到语音」**不重试** —— 那是用户马上能改的行为，让他白等更糟。

3. **验「线上跑的是哪一版」看 `build` 字段**，别看部署时间或文件名。
   函数里的 `BUILD` 常量就是干这个的（当前 `asr-2026-09-30-audiob64`）。

## 自测

```bash
node _selftest/probe-cf-asr.cjs            # 云端后端 17 条断言
BASE=http://127.0.0.1:4173 node _selftest/probe-cloud-asr-retry.cjs   # 前端接入 22 条（真实音频端到端）
```
