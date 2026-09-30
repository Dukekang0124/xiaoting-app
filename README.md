# 墨小溟 · 语音情绪复盘教练（v1.1.2）

> 说出来，就轻一点。
> 一个会追问、会记住、不评判的语音情绪复盘教练。

单端口 Node 服务（零依赖）托管的 PWA（无构建，原生 ES Module）：**真实 AI 接入**
（WorkBuddy 云服务免密钥 LLM 网关）+ **真实云端 ASR**（百度短语音识别，密钥只在服务端）。

- v0.4.x = 安全识别 / 主分析 / 追问 / 卡片 / 周报**五段 Prompt 全部接到真实模型** + 三层兜底 + 模型选型 + 防注入 + 视觉收尾。
- v0.5.0 = 破 ASR 卡点 + 情绪强度收口 + 内测埋点地基。
  - **破 ASR 卡点**：改用「录音 → 浏览器内 16k 重采样 → 同源服务端代理 → 专业云端识别」，
    解决 iOS Safari / 微信内置浏览器**没有 Web Speech API** 导致「按住说了半天一个字都不出」的问题。
    实测中文识别**字错误率 0.0%**，完整链路往返 **544ms**（7.3 秒语音）。
  - **情绪强度收口**：修掉「同一类倾诉强度在 8/7/0 之间乱跳」，文本有负面情绪时下限 5、卡片锚定主分析。
  - **埋点地基**：ASR 成功率 / 追问完整率 / 卡片保存率 / 风险判定分布四项指标可查。

- v0.8.0 = 全维度情绪共鸣 + 墨小溟 IP 生命感系统：
  - **深度情绪解析**：混合情绪（emotion_primary / emotion_secondary）、情绪转折（emotion_shift / shift_trigger）、隐藏需求（hidden_need），墨小溟更懂你没说出口的话。
  - **语音物理特征辅助**：语速 / 停顿 / 音量 / 语气词由 `voice.js` 提取，作为 `user_voice_features` 送主分析，情绪判断更准。
  - **IP 生命感**：落泪 / 蹙眉 / 星光微动作；实时音量驱动触角发光；>3s 停顿呼吸引导；>10s 等待防呆气泡。
  - **对话更有人味**：先接情绪再接事实，允许沉默与「退行」，卡片「灵魂一击」引用用户原话。
自测 **276/276**（v0.7.0 基线 264 零回归 + 新增 **I·v0.8.0 情绪共鸣与 IP 生命感 12 条**），ASR 端到端 **42/42**，真机（真模型）**20/20**（首段端到端 5832ms）。

## 运行

需要一个能同时托管静态文件和 `/api/**` 的单端口服务（**必须走 http(s)**，直接 `file://` 打开时
ES Module、Service Worker、麦克风都不工作）：

```bash
cd "D:/写作工具/知识管理/08-九思-工作空间/墨小溟App"
node server.cjs                    # 零依赖，默认端口 3000；本地可用 PORT=8791 node server.cjs
# 浏览器打开 http://127.0.0.1:8791
```

### 配置云端 ASR 密钥（不配也能跑，只是「按住说」会退到浏览器内置识别或打字）

密钥**只允许**放在下面两处之一，前端永远拿不到：

1. 环境变量 `ASR_BAIDU_AK` / `ASR_BAIDU_SK`（推荐，尤其线上）
2. 项目内 `server/asr.keys.json`（照抄 `server/asr.keys.example.json` 的结构）

本机开发还有一个便利入口：`ASR_KEYS_FILE=<任意记录着 API Key / Secret Key 的文件>`，
服务端会在启动时读它，不需要把密钥复制进项目。

`asr.keys.json` 与 `server/` 整目录都在静态白名单之外，浏览器取不到（自测里有 4 条断言专门守这个）。

## 自测（改完代码必须真跑，不要只做静态检查）

```bash
# 1) 主自测：364 条断言（契约 / 文案库 / 流程 / 分级安全 / 视觉 / AI 管线 / 兜底 / 最小闭环 / §2§3 护栏 / 版本更新与自动弹窗 / v0.8.0 情绪共鸣与 IP 生命感 / 四类场景卡片 / v1.1.0 情绪时间线卡片 / C4 审计修复回归 / C5 真机修复回归）
#    ⚠️ 跑主自测请起【根目录】server.cjs（不是 _selftest/server.cjs）——套件会请求 /api/version/latest，
#       纯静态小服务器会 404 并中断整套测试。示例：PORT=4174 node server.cjs
NODE_PATH=C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules \
  BASE=http://127.0.0.1:8791 node _selftest/selftest.cjs

# 2) ASR 端到端真跑：42 条断言（把已知标准答案的中文音频当麦克风喂进 Chrome，跑完整链路并算字错误率）
NODE_PATH=... ASR_KEYS_FILE="<密钥文件>" node _selftest/asr-e2e.cjs
#    不传 ASR_KEYS_FILE 时，需要真实识别的用例会 SKIP，降级/安全用例照跑

# 3) 真实模型验证：20 条断言（真 SDK + 真云服务 + 真网络；「本地代码 × 线上域名」法，无需先发布）
NODE_PATH=... node _selftest/verify-local-on-live.cjs

# 4) 视觉断言的 A/B 鉴别力校验（证明断言真的会抓到回归）
NODE_PATH=... node _selftest/probe-ab.cjs

# 5) 只做视觉预览（不断言，迭代视觉时快得多）
node _selftest/preview.cjs                       # 全部页面
node _selftest/preview.cjs 01-home 03-me         # 按名字过滤
```

- 用 `channel:'chrome'` 驱动**本机已装 Chrome**（不下载 playwright 自带浏览器）。
- `NODE_PATH` 指向受管 workspace；**不要** `npm i` 到项目目录（污染项目且沙箱可能拦）。
- 可调环境变量：`BASE`（目标地址）、`SETTLE`（截图前动画沉降毫秒，默认 950）。
- 截图输出在 `_selftest/shots/`。
- **要测「假麦克风」必须同时给两个开关**：`--use-fake-device-for-media-stream`（造设备）与
  `--use-fake-ui-for-media-stream`（自动授权）。只给后者会得到 `NotFoundError`，表现为「录到 0 字节」，
  极易被误判成重采样或接口的 bug。

## 目录

```
package.json            Node 服务端项目的版本出口（含 version，与前端四处同步）
server.cjs              单端口服务：静态白名单托管 + /api/asr 云端识别代理 + /api/events /api/stats 埋点 + /api/version/latest /api/version/history 版本更新接口
server/
  asr.keys.example.json 密钥文件模板（asr.keys.json 在静态白名单之外，浏览器取不到）
  version.json         对外宣告的最新版本与更新历史（latest_version 发版须与五处版本号同步 bump）
index.html              单页外壳（3 Tab + 视图容器 + window.APP_VERSION）
styles.css              UI 令牌 + IP 六状态动效 + 全站精装修样式
manifest.webmanifest    PWA 清单（含 version）
sw.js                   Service Worker 离线缓存（ASSETS 必须覆盖 js/ 下全部文件；不接管 /.cloud/ 与 /api/）
icons/icon.svg          应用图标（几何与 IP 待机态一致）
js/
  store.js              状态管理（单一 store + 订阅 + localStorage + toast TTL）
  voice.js              语音物理特征提取（语速 / 停顿 / 音量 / 语气词）+ createVolumeProbe 实时音量探针（写 --ip-vol 驱动 IP 发光）
  ip.js                 墨小溟 IP（云朵水母）+ 六状态机 + avatar()/miniFace() + v0.8.0 微动作（tears 落泪 / brow 蹙眉 / spark 星光 / breath 呼吸）+ --ip-vol 音量发光
  config.js             运行期配置（publicConfig 三值 + SDK_URL + AI 参数 + ASR 参数）
  llm.js                传输层：SDK 加载 / 模型目录与选型 / 调用重试换模型 / JSON 提取与截断修复 / trace（永不抛错）
  prompts.js            5 段 Prompt 全文 + SYSTEM 角色句 + sanitizeInput 防注入 + COPY 文案库 + 禁止话术校验（MAIN_PROMPT 含 v0.8.0 深度情绪解析 + 语音物理特征第六维度）
  ai.js                 本地规则引擎（确定性兜底，本身就是完整的安全分类器）
  api.js                业务语义层：5 段管线 + 归一化 + 情绪强度收口 + **深度情绪解析（emotion_primary/secondary/shift/hidden_need）+ 语音物理特征接入** + 三层兜底 / 埋点（换真后端只改 llm.js + api.js）
  asr.js                语音识别层：能力探测 + 云端优先/内置兜底/打字三级降级 + 16k WAV 重采样 + 埋点上报
  router.js             hash 路由
  app.js                页面渲染与交互（PAGES 路由表 + 流程编排）
  update.js             版本更新检测 + 自定义弹窗 + 平台分支（APK/微信/Web）+ snooze + 更新历史页数据
_selftest/
  server.cjs            零依赖静态服务（仅静态场景用；带 ASR 时应跑根目录的 server.cjs）
  selftest.cjs          主自测（276 断言，SDK/ASR 双契约替身，可离线；含 H 版本更新与自动弹窗 35 条 + I·v0.8.0 情绪共鸣与 IP 生命感 12 条）
  asr-e2e.cjs           ASR 端到端真跑（42 断言，真音频真链路真识别，算字错误率）
  verify-local-on-live.cjs  真机验证（20 断言，真 SDK + 真云服务，无需发布）
  probe-ab.cjs          视觉断言 A/B 鉴别力校验
  probe-geom.cjs        量首页几何（为排版断言定阈值，不猜数字）
  preview.cjs           视觉快速预览（不做断言）
  shots/                截图与自测输出
```

## 已实现（对应 PRD §12）

1. 工程骨架（前端 + 单端口服务端；DB 仍为第二阶段） ✅
2. 首页：墨小溟待机呼吸 + 质感「按住说」按钮（渐变/脉冲光/按住缩放发光/波形） ✅
3. **录音 + 云端 ASR 转写** ✅（v0.5.0 破局：三级降级「云端 → 内置 → 打字」，
   录音入口的判断依据从「有没有内置识别」改成「能不能录音」；拿不到麦克风时立刻送打字页而不是假装在录）
4. **真实 LLM 分析 → 结构化 JSON** ✅（安全识别 / 主分析 / 追问 / 卡片 / 周报五段全部真模型）
5. AI 追问流程（≤3 轮，每次一个问题，可跳过） ✅
6. 确认卡片页（可编辑并保存，"被接住"入场动效） ✅
7. 卡片列表与详情 ✅
8. 基础周报页（情绪体检报告式） ✅
9. 隐私设置与一键删除 ✅
10. **真实 LLM 接入 ✅ ｜ 真实云端 ASR 接入 ✅**（中文识别字错误率 0.0%，完整链路 544ms）
11. 高风险识别与转介页（四分支：continue / gentle_check / refer / emergency） ✅
12. 测试用例与部署说明 ✅（主自测 **334/334** + ASR 端到端 **42/42** + 真机 **20/20**；
    文档在作品集 `06-测试验证` / `07-验收上线`）
13. 内测基础设施（§4 地基）✅ 部分：`/api/events` 按天落 JSONL + `/api/stats?key=` 出四项指标；
    完整看板与"高风险转介准确率"的人工/模型复核标注留到下一轮
14. **版本更新自动弹窗 + 关于墨小溟/更新历史页** ✅（v0.7.0）：自定义 Modal（暖奶油白 #FFF8F0 + 圆角 20px + 墨小溟举牌 IP + 柔紫 #B8A9E8 主按钮），打开 App 与回前台检测；非强制「稍后再说」snooze 到次日、强制单按钮；平台分支 APK/微信/Web；「我的」页「关于墨小溟」可看完整更新历史。后端 `/api/version/latest` + `/api/version/history` 由 `server/version.json` 驱动。
15. **全维度情绪共鸣 + IP 生命感系统（v0.8.0）** ✅：
  - 深度情绪解析：混合情绪（emotion_primary / emotion_secondary）、情绪转折（emotion_shift / shift_trigger）、隐藏需求（hidden_need）。
  - 语音物理特征辅助：语速 / 停顿 / 音量 / 语气词（`voice.js` 的 `createVolumeProbe` 实时音量探针）作为 `user_voice_features` 送主分析。
  - IP 生命感：落泪 / 蹙眉 / 星光微动作（`ip.js mascot` 新增 tears/brow/spark/breath 四组 SVG 元素）；实时音量驱动触角发光（`--ip-vol` CSS 变量）；>3s 停顿呼吸引导；>10s 等待防呆气泡。
  - 对话调优：先接情绪再接事实，允许沉默与「退行」，卡片「灵魂一击」引用用户原话。
16. **四类场景卡片引擎（v1.0.0-RC）** ✅：`selectCardType` 按场景选 see / hold / notice / action；标题/正文/动作以 `prompts.js CARD_LIB` 为 SSOT 逐字回填；确认页渲染卡片 + 收下 / 继续倾诉双按钮；对话区同步墨小溟回应（矛盾用「一边…一边…」承接）。
17. **情绪时间线卡片（v1.1.0）** ✅（复盘载体）：
  - 对话结束后（用户主动点首页「结束倾诉」）把本次倾诉的情绪起伏画成一条**柔和曲线时间轴**（`pageTimeline` 的 SVG 三次贝塞尔 `C` 曲线 + 圆点），让用户看见「情绪本来就会流动、矛盾、来回摇摆」。
  - **只记录与呈现**：不打分、不评估、不贴标签、不解读深层原因；每节点最多 2 种并存情绪（支持 A+B，如喜悦+委屈）；只用 8 个普通词（开心/委屈/愤怒/疲惫/迷茫/不甘/心酸/麻木），禁止脑补。
  - 数据源 `store.sessionLog`（本次会话累积用户原话，只保留本次会话、不跨会话合并）；最多 6 节点（超出合并）；全程无情绪 → 简化卡。
  - 边界：命中高危阻断（`isBlockingAction`）**不生成时间线卡**，只保留危机提示与热线；对话过程中绝不弹出。
  - 卡片底部静态免责小字 + 【保存卡片】（本机保存，不自动分享）/【重新倾诉】（`startSession`）。
18. **时间线卡片可回看、可导出（v1.1.1）** ✅：
  - 【保存卡片】支持导出 PNG 图片（零依赖：`timelinePosterSvg` 重绘海报 → canvas → `toBlob` 下载，不上传）。
  - 「我的」页新增「情绪时间线」入口 → 列表页（`#/timelines`）→ 详情（`#/timeline?id=`），可删除单条记录。
  - `sessionLog`/`sessionAt` 持久化：中途刷新不丢会话，超过 6 小时自动算新会话（守住「不跨会话合并」）。
  - 保存防重：已保存后按钮变「已保存 ✓」且不可再点。
  - 安全加固：结束倾诉时对 `sessionLog` 全文做本地高危复检，高危不再被后续轮次冲掉。
  - 自测新增 **C4 审计修复回归 13 条**（含云端路径造桩、真实动作序列高危边界、health 版本一致性）。
19. **墨小溟 App 图标 + 真机语音修复（v1.1.2）** ✅：
  - App 图标：`_selftest/gen-icons.cjs` 按 Capacitor 8 模板实测尺寸表出图（5 密度 × 方形/圆形/自适应前景 + 奶油白背景色），
    CI 步骤覆盖默认 `ic_launcher`；源 SVG 在脚本内，改形象只重跑一次。
  - 真机「按住说」修复：APK 里 WebView 源是 `https://localhost`，相对路径 `/api/*` 打不到服务端 ⇒ 云端识别一次都不尝试。
    修法：① `config.js` 增加 `apiBase()`（原生容器拼 `HOSTED_ORIGIN` 绝对基址）；② 原生容器优先走
    **设备自带语音识别**（`@capacitor-community/speech-recognition`，`js/native-asr.js`，无需服务端与密钥，永不抛错），
    拿不到再降级回 Web 录音 + 云端 ASR → 打字。
  - 麦克风权限原生申请，拒绝时给「去设置 + 打字」引导；`usesCleartextTraffic` 兜底注入。
  - 识别失败不再弹黑色警告条：柔和奶油白气泡 + 区分「好像没录上（<1 秒）」与「水里有点吵，我没听清」。
  - 自测新增 **C5 真机修复回归 17 条**。

## 核心流程

```
按住说 → ASR 转写 → ①安全识别 ─┬─ continue      → ②主分析 → ③追问 ≤3 轮 → ④卡片 → ⑤周报
                              ├─ gentle_check  → 温和确认页
                              ├─ refer         → 转介页（停常规分析）
                              └─ emergency     → 紧急页（停常规分析）
```

## 硬约束（改动前必读）

1. **AI 输出必须过归一化**（缺字段补默认）与**容错解析**（非法/截断 JSON 不抛错），前端永不崩。
2. **安全识别三层兜底不可退化成两层**：①模型答了→归一化（只往更保守纠正）②模型没答好→`gentle_check`，**绝不放行 continue** ③通道结构性不可用→本地规则引擎。**"模型答错"与"没有模型可问"必须分开判断**。
3. **版本号五处同改**：`index.html` 的 `window.APP_VERSION`、`sw.js` 的 `CACHE`、`manifest.webmanifest` 的 `version`、**`js/app.js` 页脚兜底值**、`package.json` 的 `version`。新增 js 文件必须加进 `sw.js` 的 `ASSETS`。另：`server/version.json` 的 `latest_version` 也要同步 bump（它是对外宣告的最新版，不在五处代码戳内，自测不覆盖，需人工核对）。
4. **接入云服务的四条硬约束**：只支持流式（`stream:true`）/ `messages[0]` 必须是应用自带 system / Origin 精确匹配（`127.0.0.1` 被拒）/ SDK 形态随项目形态（无构建 PWA 用 `WorkBuddyCloud.createWorkBuddyCloud`）。
5. **模型选型是必做项**：目录里多数模型 `onlyReasoning:true`，短结构化任务必须先选型（实测 23.9s → 1.3s）。**线上旧版本用 `auto` 实测首段端到端 50.3s 且主分析只回 reasoning 不给正文**，选型不是优化项而是可用性前提。**`max_tokens` 是防跑飞，不是压延迟**。
6. **改代码后必须真跑**：`node --check` 只能当最低门槛 —— 引用不存在的变量在语法上合法，还会被 `try/catch` 静默吞掉（这个坑本项目踩过两次：AI 通道完全不通、内置识别永不启动，两次静态检查都是全绿）。
7. **密钥只准待在服务端**：前端源码里出现 `apiKey` / `secretKey` / `access_token` 一律视为缺陷（自测有断言守）。`server/` 整目录与 `server.cjs`、`package.json` 都在静态白名单之外。
8. **情绪强度只上不下**：文本证据推出的下限（有负面情绪 5、带强化词 6）只用来抬高模型给的分数，上限钳在 8 —— 9-10 带临床意味，那是模型和安全策略的领域。**"模型没给 intensity" ≠ "模型给了 0"**（`validateShape` 会把缺字段补成 0，必须用 `hasOwnProperty` 分开判断）。
9. **录音入口的判断依据是「能不能录音」，不是「有没有内置识别」**：iOS Safari / 微信里 `getUserMedia` 与 `MediaRecorder` 都可用，只有 `SpeechRecognition` 不可用 —— 用后者做判断会把整个语音入口误判成"不可用"。
10. **拿不到麦克风时必须立刻说清楚并送打字页**，绝不让用户对着一个假按钮说半分钟然后只得到一句"没听清"。
11. **IP 状态只换 CSS 变量 + 挂动画，不改 SVG 结构**；元素类名必须与 CSS 选择器严格一致（曾因 `.wet` vs `.mascot__wet` 导致"共情态眼睛变湿润"永不生效）。
12. **入场动画凡以 `opacity:0` 起始**，必须在 `prefers-reduced-motion` 下强制 opacity 为 1，否则关动画 = 内容消失。
13. 数据仅存 `localStorage['xiaoting:v1']`；无账号；**录音会上传到墨小溟自建服务端做云端转写，转写完成后不留存音频**（v0.5.0 起如此，旧文案"音频不出本机"已与代码事实不符，禁止再写）；转写文本再经加密通道发给大模型用于本次分析。用户可在设置里关掉「允许把录音发给云端转写」，关掉后一个字都不上传（自测有断言守）。埋点只上报计数与错误码，不上报用户正文（自测有断言守）。

## APK 构建（CI 出包，参考 Sinoky）

墨小溟的 APK **不在本机造**，沿用同作品集 Sinoky 的 **Capacitor + GitHub Actions CI + Cloudflare Pages** 方法：本地只做配置，APK 由 CI 用 Android SDK 编译、固定 keystore 签名、发布到 `https://xiaoting.app.workbuddy.host/apk/` 并回写 `version.json`。

- 本地配置已就绪：`capacitor.config.json`、`scripts/build-web.mjs`（前端静态资产进 `www/`，带归类断言）、`.github/workflows/apk.yml`（完整出包链）、`package.json`（`@capacitor/*` + `build:web` 脚本）、`server/version.json` 的 `apk` 段。
- 前端资产构建已本地真跑验证（`node scripts/build-web.mjs`）。
- **发布动作在 GitHub 侧完成**：建仓 → 配 Secrets（keystore / Cloudflare / GH_PAT）→ 生成固定 keystore → 后端上线 → `git tag v0.8.0 && git push --tags` → CI 自动出包。
- ⚠️ **硬前置**：后端（`server.cjs` 的 `/api/asr` + `/api/version/*`）须先部署到可达地址，否则 APK 装了也录不了音、检测不了更新（完整流程见作品集 `墨小溟/07-验收上线/2026-09-29-APK发布SOP-参考Sinoky.md`）。

## 重要声明

墨小溟不是心理医生，不提供诊断与治疗建议。MVP 数据仅保存在本机浏览器；录音会发到墨小溟自己的服务端做云端转写、转写完成后不留存，转写出的文字再经加密通道发给大模型用于本次分析。
如果你正处于强烈的痛苦中，请寻求专业帮助（产品内「设置与隐私」与转介页均提供热线）。
