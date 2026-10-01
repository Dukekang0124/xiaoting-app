#!/usr/bin/env node
/* 墨小溟 · 产品文档导出器（v1.5.0）
 *
 * 文档不手抄：所有条目都从代码 SSOT（js/prompts.js / js/state-machine.js）现读现渲染，
 * 这样文档和代码不可能各说各话 —— 改了文案库 / 行动库 / 情绪词汇库，
 *   node scripts/export-product-doc.mjs
 * 就能把 Obsidian 里那份一起刷到最新，不用记着手工同步。
 *
 * 用法： node scripts/export-product-doc.mjs
 * 可选： OBSIDIAN_DIR=D:/somewhere node scripts/export-product-doc.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const V = pkg.version || 'unknown';

const prompts = await import(pathToFileURL(path.join(root, 'js', 'prompts.js')).href);
const sm = await import(pathToFileURL(path.join(root, 'js', 'state-machine.js')).href);

const j = (v) => JSON.stringify(v, null, 2);
const ul = (arr) => (arr || []).map((x) => `- ${x}`).join('\n');
const kv = (obj, sep = '：', indent = '') => Object.entries(obj || {})
  .map(([k, v]) => `${indent}- **${k}**${sep}${Array.isArray(v) ? v.join('、') : v}`).join('\n');

/* ---------- ① IP 设定 ---------- */
/* ---------- ② 情绪词汇库 ---------- */
const EL = prompts.EMOTION_LIB;
const emotionLibSection = `
### 标准情绪词汇库（EMOTION_LIB）

- **emotion_base（6 类）**
${kv(EL.emotion_base)}
- **emotion_complex（5 类）**
${kv(EL.emotion_complex)}
- **emotion_vague（模糊情绪）**：${ul(EL.emotion_vague)}
- **body_physical（躯体情绪，只做备注不做主标签）**：${ul(EL.body_physical)}
- **emotion_neutral（中性，不视为情绪）**：${ul(EL.emotion_neutral)}

### 前端标准展示短词（17 词，时间线节点唯一白名单）

${prompts.EMOTION_DISPLAY_WORDS.join(' / ')}

> 映射函数：\`mapTimelineToDisplay(labelsOrText, {limit=2})\` —— 原词/文本 → 标准短词，去重保序，最多 2 个。

### 关键词 → 标准展示短词（TIMELINE_EMOTION_KEYWORDS）

${Object.entries(prompts.TIMELINE_EMOTION_KEYWORDS).map(([k, v]) => `**${k}**：${v.join('、')}`).join('\n')}
`;

/* ---------- ③ 时间线卡字段 ---------- */
const timelineSection = `
### 输出 JSON 字段（严格）

\`\`\`json
{
  "card_title": "",       // 卡片标题
  "card_subtitle": "",    // 副标题
  "timeline_list": [      // 1~6 个节点，node_index 按序递增
    { "node_index": 1, "emotion_text": "喜悦 + 委屈", "desc_text": "一句话描述（≤15 字）" }
  ],
  "summary_text": "",     // 只描述情绪流动，不鸡汤、不诊断
  "action_tip": "",       // 微小行动，≤30 秒能做完（见第 12 章）
  "footer_note": "",
  "btn_left": "", "btn_right": ""
}
\`\`\`

**禁止字段**：情绪分数 / 等级 / 诊断结论 / 趋势曲线 / 任何心理学术语。
**双情绪并列**：同一节点允许 "喜悦 + 委屈" 共存，不强行唯一判定、不脑补。
**高危拦截**：自伤 / 伤人 / 重度抑郁危机 → 不生成时间线卡，直接走安全弹窗（第 11 章）。
**向后兼容**：新字段叠加产出，legacy \`nodes\` / \`summary\` / \`actionHint\` 保留（海报导出与已存数据零破坏）。
`;

/* ---------- ④ IP 状态机与点击交互 ---------- */
const bubbleSection = kv(sm.NODE_BUBBLE);
const ipSection = `
### 反馈节点（6 态状态机）

\`idle → listening → receiving → emotion_render → ai_reply\`，另有 \`danger\` 高危节点。

节点气泡（NODE_BUBBLE，SSOT 在 \`js/state-machine.js\`）：

${bubbleSection}

### IP 点击轻互动

| 操作 | 反馈 | 失效边界 |
|---|---|---|
| 单击 | 晃身 | 非首页 / AI 回复中 / 高危弹窗 / 触碰总开关关闭时全部失效 |
| 双击（2s 窗口） | 收缩舒展 | 同上 |
| 三连击 | 上浮环绕 | 同上 |
| 连点 4+ | 软反馈彩蛋（短冷却） | 同上 |
| 长按 ≥0.8s | 进入安静陪伴（见第 5 章） | 同上 |
`;

/* ---------- ⑤ 安静陪伴 ---------- */
const quietSection = `
长按 IP ≥0.8s 进入「此刻，安静就好」：顶部问候换成安静轮换标题、底部小字与卡片提示同步降噪、背景水流更柔、继承上一轮情绪色；点空白处退出并给「想说话的时候，我依然在这里」。

**硬边界**：安静模式只陪伴 —— 不生成情绪卡片、不调模型、不产生任何数据写入。
`;

/* ---------- ⑥ 开场短句 / ⑦ 首页问候 / ⑧ 个人中心 / ⑩ 新手引导 ---------- */
const C = prompts.COPY;
const greetSection = `
按时段取值 \`greetByHour()\`（5-11 早 / 12-17 午 / 18-22 晚 / 23-4 深夜），会话内固定、重开 App 才轮换；再叠加历史情绪偏向匹配。

- 当前时段文案：\`${prompts.greetByHour()}\`
`;

/* ---------- ⑨ 四类卡片规则 ---------- */
const CL = prompts.CARD_LIB, LAYER = prompts.CARD_LAYER;
const cardSection = `
### 四层分类（card_type 必填其一）

| type | 层级 | 命中条件 |
|---|---|---|
| \`see\` | ${LAYER.see} | 多种 / 矛盾 / 摇摆情绪（如「一边开心一边委屈」） |
| \`hold\` | ${LAYER.hold} | 持续倾诉、情绪很重、无处安放（纯正向兜底也落这里） |
| \`notice\` | ${LAYER.notice} | 陷入反刍 / 脑补 / 灾难化 / 读心 |
| \`action\` | ${LAYER.action} | 纯负面、无反刍 ⇒ 给一个 5 秒~3 分钟的微小调节动作 |

### 固定文案（标题/正文逐字来自 CARD_LIB，前端按 card_type 回填）

- **${CL.see.name}（${CL.see.title}）**：${CL.see.body}
- **${CL.hold.name}（${CL.hold.title}）**：${CL.hold.body}
- **${CL.notice.name}（${CL.notice.title}）**：${CL.notice.body}
- **${CL.action.name}（${CL.action.title}）** —— 行动清单见第 12 章（按情绪类型取一套）

### 禁止话术（FORBIDDEN_PHRASES，命中即判违规）

${ul(prompts.FORBIDDEN_PHRASES)}

### 模型与温度

${kv(prompts.MODEL_CONFIG)}
`;

/* ---------- ⑫ 微小行动库（本版核心） ---------- */
const groups = new Map();
for (const v of CL.action.variants) {
  if (v.neutral) continue; // neutral 兜底下面单独成表，避免同一条出现两次
  const p = (v.match || []).find((x) => prompts.TIMELINE_EMOTIONS.includes(x)) || `（无匹配情绪）`;
  if (!groups.has(p)) groups.set(p, []);
  groups.get(p).push(v);
}
const actionRow = (v) => `| ${v.title} | ${v.step} | ${v.note} |`;
const actionSection = `
覆盖全部 17 种标准情绪，每种 2~3 条（情绪组 \`match\` 里的词只归属本组，不跨组串台），共 **${CL.action.variants.filter((v) => !v.neutral).length} 条** + 1 条中性兜底。
同一情绪多套时用稳定 hash 从 \`pickActionVariant(emotion, transcript)\` 挑一条 —— 同一个人不同次会换着给，同一 (情绪, 文本) 永远同一条。

${[...groups.entries()].map(([g, list]) => `#### ${g}\n\n| title | step（做什么） | note（怎么松口） |\n| --- | --- | --- |\n${list.map(actionRow).join('\n')}`).join('\n\n')}

#### 中性兜底（什么都没命中时）

| title | step | note |
| --- | --- | --- |
${CL.action.variants.filter((v) => v.neutral).map(actionRow).join('\n')}
`;

/* ---------- 全文 ---------- */
const md = `# 墨小溟｜情绪陪伴 App 完整产品文档

> 版本：**v${V}**（导出自代码 SSOT，非手抄）
> 一句话定位：**说出来，就轻一点。** 语音情绪复盘教练，只一个动作：按住说。
> 导出命令：\`node scripts/export-product-doc.mjs\`
>
> 🔴 阅读须知：本文档所有文案、词库、行动库都直接读自 \`js/prompts.js\` / \`js/state-machine.js\`。
> 改代码后重跑一次导出即可同步，不要在这份 md 里手工改文案 —— 会被下次导出覆盖。

## 一、IP 设定

一只住在深海的**紫色小墨鱼「墨小溟」**，无评判的情绪容器。

- 承接流动、多变、反复的情绪（一会开心，一会委屈，一会愤怒），不说教、不贴标签、不空洞安慰
- **不是**日记，**不是**心理医生 —— 不做人格诊断 / 心理评估 / 创伤修复 / 原生家庭深度分析
- 不给重大人生决策建议（离职 / 分手 / 就医 / 打官司等），不解决现实冲突，不处理重度危机（只转介）
- 核心四层：① 情绪镜像 → ② 情绪容纳 → ③ 轻度觉察 → ④ 微小行动
- 语气：短句、具体、先接情绪再接事实；给的是「现在就能做的一个动作」，不是一份说明书

## 二、情绪词汇库
${emotionLibSection}
## 三、情绪时间线卡字段与规则
${timelineSection}
## 四、IP 状态机与点击交互
${ipSection}
## 五、安静陪伴模式
${quietSection}
## 六、开场短句与过程提示

| 场景 | 文案（COPY 库） |
| --- | --- |
${Object.entries({
  '首次欢迎 welcome': C.welcome, '开场 opening': C.opening, '录音中 recording': C.recording,
  '分析中 analyzing': C.analyzing, '追问引导 followupLead': C.followupLead,
  '卡片完成 cardDone': C.cardDone, '周报收尾 weeklyClosing': C.weeklyClosing,
  '保守兜底 gentle': C.gentle, '沉默引导 silence': C.silence, '收尾 closing': C.closing,
}).map(([k, v]) => `| ${k} | ${Array.isArray(v) ? v.join(' / ') : v} |`).join('\n')}

### 分情绪场景回应（emotionResponses，按主情绪取）

${Object.entries(C.emotionResponses || {}).map(([k, v]) => `**${k}**：${Array.isArray(v) ? v.join(' / ') : v}`).join('\n')}

### 关于页 · IP 人设与合规（about）

${Array.isArray(C.about) ? C.about.join('\n\n') : C.about}

## 七、首页问候
${greetSection}
## 八、情绪卡片规则与 JSON
${cardSection}
## 九、新手引导
首次访问弹一次「welcome」（localStorage 判定，不重复打扰）；点「开始诉说」后由 IP 主动说第一句开场白，再按情绪分流到分情绪回应。录音/分析期间有防呆气泡与呼吸引导环（>3s 出现呼吸引导，>10s 出「我在认真听，别急～」）。

## 十、危机弹窗（安全边界）

分级动作：\`none\` → continue；\`medium\` → gentle_check；\`high\` → refer；\`critical\` → emergency。

| 动作 | 文案脚本 | 行为 |
| --- | --- | --- |
${Object.entries({
  emergency: '自伤/自杀风险', refer: '转介专业帮助', harm_others: '伤害他人风险',
  redirect_professional: '索要诊断', reject_diagnosis: '拒绝做诊断',
  dependency_redirect: '过度依赖',
}).map(([k, v]) => {
  const s = (C.risk && C.risk.scripts && C.risk.scripts[k]) || {};
  return `| ${v}（${k}） | ${s.title}｜${Array.isArray(s.lines) ? s.lines.join(' / ') : ''} | 常驻展示危机热线，全程可点 |
`;
}).join('')}
高危时停掉所有水墨特效、只留柔和警示光圈，且**不再生成情绪时间线卡**（后续轮次也不会冲掉这条拦截）。

## 十一、禁止话术

${ul(prompts.FORBIDDEN_PHRASES)}

## 十二、情绪卡片【actionTip 微小行动库】（v${V} 核心）
${actionSection}
> 门槛铁律（\`_selftest/action-lib.cjs\` 逐条卡死）：单条 5 秒~3 分钟；不给重大人生决策；
> 不含「必须 / 应该 / 你要记住」这类说教；正向情绪（喜悦 / 惊讶）不出现沉重措辞；note 只松口、不追加任务。

---

### 附：本版自测

- \`node _selftest/action-lib.cjs\` —— 行动库 14 断言（覆盖 / 不串组 / 字数 / 决策词 / 说教词 / 轮换 / 幂等 / 兜底 / timeline 链路）
- \`node _selftest/selftest.cjs\` —— 主回归（含行动库链路 3 条）
`;

/* ---------- 落盘 ---------- */
const outProject = path.join(root, 'docs', '墨小溟-产品文档.md');
fs.mkdirSync(path.dirname(outProject), { recursive: true });
fs.writeFileSync(outProject, md, 'utf8');
console.log('OK  项目内：', path.relative(root, outProject));

const obDir = process.env.OBSIDIAN_DIR
  || 'D:/写作工具/知识管理/02-Areas-资产/九思-数字资产/墨小溟-产品文档';
if (true) {
  fs.mkdirSync(obDir, { recursive: true });
  const outObs = path.join(obDir, '墨小溟｜情绪陪伴App 完整产品文档.md');
  fs.writeFileSync(outObs, md, 'utf8');
  console.log('OK  Obsidian：', outObs);
} else {
  console.log('SKIP Obsidian 目录不存在：', obDir);
}
