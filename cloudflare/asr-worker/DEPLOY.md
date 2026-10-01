# 墨小溟 · 云端 ASR（Cloudflare Worker）部署指引

一句话结论先给：**现在线上跑的是 Pages 版（`xiaoting-asr.pages.dev`），它通了，别为了"用 Worker"去换。**
只有你要把 ASR 挪出 pages.dev（比如 pages.dev 被限流、或你要统一域名）时才需要按本文件部署 Worker。

---

## 0. 先读这三条实测结论（别照着网上教程走）

| # | 结论 | 依据 |
|---|---|---|
| 1 | **`*.workers.dev` 在国内被 DNS 污染**：三个公共 DNS 都回 `face:b00c` 段，且三个 IP 互不相同；`*.pages.dev` 回真实 Cloudflare anycast、多 DNS 一致 | 2026-09-30 在墨小溟账号实测 |
| 2 | **Workers AI 不需要任何 API Key**（走账号额度 + bindings）。教程里让你填 `OPENAI_API_KEY` 的是调 OpenAI 的 Whisper，跟这个方案无关 | 本仓 `cloudflare/asr/*` 全程零密钥 |
| 3 | **`audio` 必须传 base64 字符串**。传数组 / `Uint8Array` / `ArrayBuffer` 全被拒，且**报错信息是反的**（`"string not in 'array','binary'"`） | 四种形态逐个真实打过，见 `probe-cf-asr.cjs` |

> 结论 1 的反面：**如果你有自定义域名，Worker 完全可以打**；没有自定义域名，就继续用 Pages 版。
> 换句话说——"给我一份 Worker 代码"这条路能交付，但要不要换，取决于你有没有自己的域名。

---

## 1. 部署前准备

需要三样（都在 Cloudflare 控制台里，本仓库账号：`Kang7108558@163.com`，账号 ID `d24caa86`）：

- `CF_ACCOUNT_ID` —— Dashboard 右侧「Cloudflare 账户 ID」
- `CF_API_TOKEN` —— 我的个人令牌，**勿把 token 贴进仓库或对话**（本仓已经明文暴露过两次，强烈建议轮换）
- 可选：`CF_ZONE_ID` + 你的自定义域名（走自定义域名才需要）

需要的 token 权限（范围最小够用）：`Account → Cloudflare Workers → Edit`。

---

## 2. 部署（两条路，Windows 本机优先走 A）

### A. REST API 上传（推荐：本机 `wrangler` 缺平台二进制）

本机 `npx wrangler` 会报 `@cloudflare/workerd-windows-64` 找不到，`wrangler dev` 根本起不来，
所以**不要用本地 wrangler**。改用 Cloudflare REST API 直接传脚本：

```bash
# 1) 先给脚本起个名字（Workers 平台上脚本名即服务名）
curl -s -X PUT "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/scripts/xiaoting-asr" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -F "index.js=@src/index.js" \
  -F "metadata=@metadata.json;type=application/json" \
  -o put.json
```

`metadata.json`（跟 `src/index.js` 放一起）必须是这个形状——漏 `bindings` 就是后面一直
`asr_not_configured`：

```json
{
  "main_module": "index.js",
  "compatibility_date": "2026-09-01",
  "bindings": [{ "type": "ai", "name": "AI" }]
}
```

```bash
# 2) 启用 workers.dev 子域（可选，国内不稳定，见第 0 节）
curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/scripts/xiaoting-asr/deployments" ...
# 简单起见也可直接在控制台 Workers → Create Application → 上传 main=index.js + AI binding
```

### B. 控制台可视化（最不容易出错）

Dashboard → **Workers 和 Worker（Workers & Workers Builds）** → 创建服务 `xiaoting-asr`
→ 设置 → **变量** → 添加 **AI 绑定**（变量名填 `AI`）→ 把 `src/index.js` 粘进编辑器 → 部署。

---

## 3. 定域名（关键一步）

- **有自定义域名**：Dashboard → `xiaoting-asr` → **设置 → 域和路由 → 添加自定义域**，
  填你的域名（如 `asr.你的域名.com`）。然后把 `wrangler.toml` 里的路由段打开：

  ```toml
  routes = [{ pattern = "asr.你的域名.com", custom_domain = true }]
  ```

- **没有自定义域名**：只能 `https://xiaoting-asr.<子域>.workers.dev`。**国内大概率连不上**（第 0 节结论 1），
  这种情况请回来用 Pages 版（见下节）。

---

## 4. 前端换域名（只有确认 Worker 域名可达后才做）

改 `js/config.js` 的 `CLOUD_ASR.origin`：

```js
export const CLOUD_ASR = {
  origin: 'https://asr.你的域名.com',   // ← 只改这一行
  endpoint: '/api/asr',
  health: '/api/health',
  lang: 'zh',
  timeoutMs: 25000,
  maxAttempts: 3,
  backoffMs: 700,
};
```

前端 `js/asr.js` 的**三层降级完全不用动**：设备原生识别 → 云端（Worker/Pages）→ 打字。
所以换后端这件事的最大风险不在前端，而在"换过去的域名国内根本连不上"。

---

## 5. 验收（不看"部署成功"，看"真的出字"）

```bash
# 健康检查：必须 ai_binding: true、build 对得上
curl -s "https://<你的域名>/api/health"
# 期望：{"ok":true,"service":"xiaoting-asr-worker","ai_binding":true,"build":"asr-worker-2026-10-01",...}

# 真识别：拿一段中文 wav 转 base64 后
curl -s -X POST "https://<你的域名>/api/asr" \
  -H "Content-Type: application/json" \
  -d '{"speech":"<base64>","lang":"zh"}'
```

判据（按重要性排）：

1. `ok:true` 且 `text` 是**中文原文**（不是空、不是乱码）。这是唯一能证明"通了"的指标。
2. `build` 字段 = 你部署的那条（排障用：**部署时间/md5/文件名都不能证明线上是哪一版**）。
3. `audioShape` 记的是实际生效的 base64 形态（raw / reencoded）——两条实测结论里那条
   "请求里的 base64 和运行时自己 btoa 出来的可能不同"，靠这个字段能直接看出来。
4. `ms` 在合理区间（实测 6.7s 音频约 1.8~3.4s）。

真机侧再跑一遍：`_selftest/followup-voice.cjs`（17 断言）+ `_selftest/asr-e2e.cjs`。

---

## 6. 现在线上用的是哪个

`js/config.js` 当前指向 `origin: 'https://xiaoting-asr.pages.dev'`（Pages 版，已通）。
想确认线上真在跑的那个，看 `CLOUD_ASR.origin` 一行就够了 —— **不要凭"我部署过 Worker"来判断**。
