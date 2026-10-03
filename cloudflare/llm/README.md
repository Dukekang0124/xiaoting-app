# 墨小溟 · Cloudflare 模型调度网关（xiaoting-llm）

把 `server/llm-router.cjs` 的「选模型 + 重试 + 降级 + 逃生」逻辑搬到 Cloudflare Pages Functions，
让线上真正打通 **4 档模型**（GLM-5.3-Flash → deepseek-v4-flash → agnes-2.5-flash → GLM-4-Flash），
且 **密钥只在服务端（Cloudflare Secrets）存在，前端完全不暴露任何 Key**。

> 这是 v1.7.6 任务文档的 **P0（最高优先级）**。前端零改动：只需把 selfChannel 的地址指过来（见文末「前端开关」）。

---

## 一、架构与文件布局

```
cloudflare/llm/
├── wrangler.toml              # Pages 项目配置（名称、public 目录、非密钥 vars）
├── package.json               # type:module（让函数文件以 ESM 运行，本地 Node 也能测）
├── .dev.vars.example          # 本地开发环境变量模板（复制为 .dev.vars，勿提交）
├── public/
│   └── index.html             # 占位页（Pages 必须有 public 目录）
├── functions/api/
│   ├── [[path]].js            # 网关主函数（catch-all，按 pathname 路由全部 /api/*）
│   └── llm.config.js          # 模型配置（移植自 server/llm.config.json，密钥改走 env 名）
└── _selftest.mjs              # 无密钥本地逻辑验证（node _selftest.mjs，不发真请求）
```

线上对外域名：`https://xiaoting-llm.pages.dev`（部署后由 Cloudflare 分配）。

### 与本地 `server.cjs /api/llm` 的契约一致性

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/llm` | POST | 主入口，请求体 `{module, system, user, json?, temperature?, maxTokens?, timeoutMs?}`，响应 `{ok, text, model, channel, degraded, attempts, ms, code, tried[]}` —— **与本地完全一致** |
| `/api/llm/config` | GET | 脱敏配置快照（**一个字符的 key 都不带**），回带 `build` 标记 |
| `/api/llm/stats` | GET | 内存统计 + 最近调用（`?recent=N`） |
| `/api/llm/ping` | POST | 探活（需 `?key=LLM_PING_KEY`），会真打模型 |
| `/api/health` | GET | 健康检查，回带 `build` 标记 |

---

## 二、密钥与配置（真花钱的口子，务必走 Secret）

只需 **3 把密钥**（与本地一致，OpenRouter 一把 key 同时覆盖 glm-5.3-flash 与 deepseek-v4-flash）：

| 变量名 | 用途 | 来自 |
|--------|------|------|
| `OPENROUTER_KEY` | OpenRouter 聚合网关（档位 1/2） | OpenRouter 后台 |
| `AGNES_KEY` | Agnes AI（档位 3） | Agnes 后台 |
| `ZHIPU_KEY` | 智谱直连（档位 4 兜底） | 智谱开放平台 |

`workbuddy` 网关免密钥（用 publishableKey，已内置于配置，**可公开**，不是密钥）。

注入 Secrets（首次部署前，**必须**先 `wrangler login` 或设 `CLOUDFLARE_API_TOKEN`）：

```bash
cd cloudflare/llm
wrangler login                         # 浏览器授权（康哥操作）
# 或：export CLOUDFLARE_API_TOKEN=<token>

# 三把真密钥（值与本地 server/model.keys.json 一致）
wrangler pages secret put OPENROUTER_KEY --project-name xiaoting-llm
wrangler pages secret put AGNES_KEY      --project-name xiaoting-llm
wrangler pages secret put ZHIPU_KEY       --project-name xiaoting-llm

# 探活钥匙（务必改成随机串）
wrangler pages secret put LLM_PING_KEY --project-name xiaoting-llm
```

非密钥类开关可在 `wrangler.toml` 的 `[vars]` 里写（已写 `ALLOWED_ORIGINS` 默认线上域名）。
也可通过环境变量运行时调参（同本地）：`LLM_ENABLE_PROVIDERS` / `LLM_DISABLE_PROVIDERS` /
`LLM_TIER_<MODULE>`（如 `LLM_TIER_analysis=zhipu:glm-4-flash,workbuddy:glm-5.3-flash`）/ `LLM_DISABLE_MODULES`。

---

## 三、部署步骤

```bash
cd cloudflare/llm

# 0. 前置：确认 wrangler 已登录（见上）。未登录本地构建可跑，但部署会失败。
wrangler whoami

# 1. 本地校验逻辑（不发真请求）：
node _selftest.mjs

# 2.（可选）本地起服务手动联调：复制 .dev.vars.example → .dev.vars 填入真值，然后：
wrangler pages dev public

# 3. 部署到 Pages（首次会创建项目 xiaoting-llm）：
wrangler pages deploy public --project-name xiaoting-llm
```

部署后 Cloudflare 给出 `https://xiaoting-llm.pages.dev`。**立刻核对线上版本**：

```bash
curl https://xiaoting-llm.pages.dev/api/health
# 应回：{"ok":true,"service":"xiaoting-llm","build":"llm-2026-10-03-v1",...}
```

`build` 字段对得上 `functions/api/[[path]].js` 里的 `BUILD` 常量，即证明线上跑的是这一版。

---

## 四、前端开关（默认关闭，零行为变化）

前端已落地的真实实现（与文档草稿不同，以代码为准）：

- `js/config.js` 第 77 行：`export const LLM_SELF_ENDPOINT = '';`（顶层常量，默认空 = 走旧逻辑）
- `js/llm.js` 第 69 行：`function selfEndpoint() { return LLM_SELF_ENDPOINT || apiBase(); }`
- `js/llm.js` 第 76 行：`callSelf()` 用 `selfEndpoint() + '/api/llm'` 作为基地址
- `js/llm.js` 第 83 行：把 `403` 也纳入「通道不可用」静默回落（网关 Origin 门禁拒绝时也不白屏）

部署并拿到 `xiaoting-llm.pages.dev` 后，**只需翻转一个常量**：

```js
// js/config.js 第 77 行
export const LLM_SELF_ENDPOINT = 'https://xiaoting-llm.pages.dev';  // 填域名即全量切到 CF 网关；留空 '' 即回旧逻辑
```

**本版发版 `LLM_SELF_ENDPOINT` 保持 `''`**，前端零行为变化，网关可独立灰度；待康哥确认线上网关稳定后再翻转该常量发一版即可，无需改其他代码。

---

## 五、回滚与止血

- 网关自身故障：把前端 `selfEndpoint` 翻回 `''`，流量立即回到旧的「同源/免密钥网关」链路（前端不变，无需重出 APK）。
- 单模型失效：用 `LLM_DISABLE_PROVIDERS=openrouter` 等环境变量热关，无需重新部署代码。
- 全部模型失效：`LLM_DISABLE_PROVIDERS=openrouter,agnes,zhipu` 关掉三档，仅留免密钥 workbuddy 网关。

---

## 六、交接清单（上线前康哥必须完成的两件事）

1. **`wrangler login`**（或提供 `CLOUDFLARE_API_TOKEN`）—— 当前环境未登录，无法部署。
2. **重贴 3 把未被改写的真密钥** 到 Secrets：`OPENROUTER_KEY` / `AGNES_KEY` / `ZHIPU_KEY`
   （注意：之前文档里出现过被传输改写的 key，务必用原始未改写的真值；值与本地 `server/model.keys.json` 一致）。

完成以上两步后，按「三、部署步骤」第 3 步部署即可。本仓已交付：代码 + 本地逻辑验证（36/36 通过）+ 本手册。
