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

不是偏好问题，是**实测结论**：

- 三个公共 DNS 查 `*.workers.dev`，全部返回 `face:b00c` 段（Facebook 保留地址），且**三个 IP 互不相同**
  ⇒ 典型 GFW DNS 污染，国内网络基本访问不到。
- 同样的查询对 `*.pages.dev` 返回真实 Cloudflare anycast IP，多个 DNS 结果一致 ⇒ 干净。

所以国内要能用，只能走 Pages。换回 Workers 等于这条链路又变死路。

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
