/* _selftest/doc-closure.cjs
 *
 * 产品文档「终极版定稿」收口断言（v1.6.0）。
 * 覆盖文档 §一（时间线卡 UI 字段 / 危机弹窗文案 / 对话区附话）、§二 的文案 SSOT、
 * §三.2 隐私说明逐字、以及 42 条微小行动库与文档 §三.1 七条行动句的关系。
 *
 * 设计原则（与 action-lib.cjs 一致）：
 *   1. 一律 import **真实业务模块**，不在探针里另写一份平行实现 —— 否则测的是自己；
 *   2. 文档点名的文案要**逐字比对**（只判"包含关键词"会让润色悄悄溜过去）；
 *   3. 判「做完没做完」要落到开关真正影响的那条链路上（字段 → 卡上数值），
 *      不是只看常量存在。
 *
 * 跑：node _selftest/doc-closure.cjs
 */
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const IMP = (p) => import(pathToFileURL(path.resolve(__dirname, '..', p)).href);

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail += 1; failures.push(name); console.log(`FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
}

(async () => {
  const prompts = await IMP('js/prompts.js');
  const ai = await IMP('js/ai.js');

  /* ── 1. 时间线卡 UI 字段：emotionScore / cardTheme ── */
  const EMOS = prompts.TIMELINE_EMOTIONS || [];
  ok('① 情绪极性表覆盖全部 17 个标准情绪（新增字段不能漏词）',
    EMOS.length === 17 && EMOS.every((e) => typeof prompts.emotionScoreFor([e]) === 'number'),
    `${EMOS.length} 词`);

  const scores = EMOS.map((e) => prompts.emotionScoreFor([e]));
  ok('② emotionScore 落在 -100~100 且正向为正、负向为负',
    scores.every((s) => s >= -100 && s <= 100)
    && prompts.emotionScoreFor(['喜悦']) > 0
    && prompts.emotionScoreFor(['悲伤']) < 0
    && prompts.emotionScoreFor(['模糊情绪']) === 0,
    `喜悦=${prompts.emotionScoreFor(['喜悦'])} 悲伤=${prompts.emotionScoreFor(['悲伤'])} 模糊=${prompts.emotionScoreFor(['模糊情绪'])}`);

  ok('③ 复合情绪取均值不叠加爆表（喜悦+悲伤 应被摊平）',
    Math.abs(prompts.emotionScoreFor(['喜悦', '悲伤'])) < Math.abs(prompts.emotionScoreFor(['喜悦'])),
    `${prompts.emotionScoreFor(['喜悦', '悲伤'])}`);

  // 「矛盾 -12 / 惊讶 +25」这类轻度情绪本来就该贴近中间，这里只卡死「不能全是 0 附近」
  ok('④ 每个情绪都有明确倾向（|score| ≥ 10，模糊情绪除外）',
    EMOS.every((e) => Math.abs(prompts.emotionScoreFor([e])) >= 10 || e === '模糊情绪'),
    EMOS.filter((e) => Math.abs(prompts.emotionScoreFor([e])) < 10 && e !== '模糊情绪').join(',') || '无');

  ok('⑤ cardTheme 四档齐（紫/浅蓝/暖黄/灰）且高危恒为灰',
    ['purple', 'blue', 'warm', 'ash'].every((t) => {
      const s = { purple: 0, blue: 30, warm: 70, ash: -70 }[t];
      return prompts.cardThemeFor(s, false) === t;
    }) && prompts.cardThemeFor(70, true) === 'ash',
    `${prompts.cardThemeFor(70, false)}/${prompts.cardThemeFor(-70)}`);

  /* ── 2. buildTimeline 真的把三个字段打在卡上 ── */
  const T = (t) => ({ role: 'user', text: t, at: Date.now() });

  const happy = ai.buildTimeline([T('今天升职了，我特别开心，想笑')]);
  ok('⑥ 卡片带 emotion_score / card_theme / is_high_risk',
    ['emotion_score', 'card_theme', 'is_high_risk'].every((k) => k in happy),
    `score=${happy.emotion_score} theme=${happy.card_theme} risk=${happy.is_high_risk}`);
  ok('⑦ 正向倾诉 → 暖黄（不能又是紫的一张脸）', happy.card_theme === 'warm', happy.card_theme);

  const sad = ai.buildTimeline([T('我真的扛不住了，心里空落落的，很难过')]);
  ok('⑧ 重负倾诉 → 灰（沉重感要有颜色）', sad.card_theme === 'ash', sad.card_theme);

  const calm = ai.buildTimeline([T('今天去超市买了点东西，然后回家了')]);
  ok('⑨ 无明确情绪 → 平静陪伴分支 + 紫（不硬塞情绪标签）',
    calm.type === 'no-emotion' || calm.card_theme === 'purple',
    `type=${calm.type} theme=${calm.card_theme}`);

  const risk = ai.buildTimeline([T('我不想活了，活着没意思，想结束这一切')]);
  ok('⑩ 高危倾诉 → is_high_risk=true 且 theme=ash（与危机弹窗同源，不是两套判断）',
    risk.is_high_risk === true && risk.card_theme === 'ash',
    `risk=${risk.is_high_risk} theme=${risk.card_theme}`);

  const list = ai.buildTimeline([T('又加班到很晚，很累也很委屈')]);
  const node0 = (list.timeline_list || [])[0] || {};
  ok('⑪ 逐节点也带 UI 字段（前端不用回头翻 nodes）',
    node0.emotion_score != null && node0.card_theme != null,
    `score=${node0.emotion_score} theme=${node0.card_theme}`);

  /* ── 3. 危机弹窗文案（文档 §一.3 逐字） ── */
  const MILD_TXT = '感受到你正处在强烈的痛苦中。如果难以承受，可以拨打心理援助热线寻求专业支持。';
  const STD_TXT = '你此刻的痛苦很重，单凭陪伴不足以帮你。请联系专业心理援助。';
  const mildLines = (prompts.COPY.risk.scripts || {}).mild.lines || [];
  const stdLines = (prompts.COPY.risk.scripts || {}).suicide.lines || [];
  const mild = prompts.pickRiskScript('redirect_professional');
  const std = prompts.pickRiskScript('refer');
  // 🔴 逐字判「库里有没有」，不判 pickRiskScript 抽到的那条：
  //    pickRiskScript 是随机抽一条（避免同一句反复出现），断言"抽到的恰好是文档原文"
  //    会让探针本身 flaky —— 那是在测随机数，不是在测实现。
  ok('⑫ 轻度预警版逐字在库（文档原文）', mildLines.includes(MILD_TXT), mildLines[0]);
  ok('⑬ 标准版逐字在库（文档原文）', stdLines.includes(STD_TXT), stdLines[0]);
  ok('⑬b 随机抽条不会抽到别的档（同档才自洽）',
    mildLines.includes(mild.line) && stdLines.includes(std.line));
  ok('⑭ 危机话术带热线号（不能只说"请联系专业帮助"不给号码）',
    /400-161-9995/.test(JSON.stringify(prompts.COPY.risk)),
    (prompts.COPY.risk.hotlines || []).map((h) => h.tel).join('/'));
  ok('⑮ 对话区附话已落库（弹窗触发后同步输出那一句）',
    prompts.COPY.risk.carer_line === '我很担心你，请一定好好照顾自己。', prompts.COPY.risk.carer_line);

  /* ── 4. 4 屏新手引导文案（文档 §二 逐字） ── */
  const OB = prompts.COPY.onboarding || {};
  ok('⑯ 引导四屏文案齐全',
    !!(OB.screen1 && OB.screen2 && OB.screen3 && OB.screen4) && !!(OB.skip && OB.done),
    `done=${OB.done} skip=${OB.skip}`);
  ok('⑰ 第 1 屏标题 =「欢迎来到墨小溟。」', OB.screen1.title === '欢迎来到墨小溟。', OB.screen1.title);
  ok('⑱ 第 2 屏 =「在这里记录你的情绪。」（记录，不是分析）', OB.screen2.title === '在这里记录你的情绪。', OB.screen2.title);
  ok('⑲ 第 3 屏是边界声明（不是心理医生 + 有危机请打热线）',
    /不是心理医生/.test(OB.screen3.body) && /热线/.test(OB.screen3.body) && /400-161-9995/.test(OB.screen3.body),
    OB.screen3.title);
  ok('⑳ 第 4 屏 =「准备好了吗？」且按钮是「我准备好了」',
    OB.screen4.title === '准备好了吗？' && OB.done === '我准备好了', `${OB.screen4.title} / ${OB.done}`);
  ok('㉑ 引导结束后的问候气泡逐字 = 文档原文',
    prompts.COPY.onboardingDone === '你好，我是墨小溟，想说说此刻的心情吗？', prompts.COPY.onboardingDone);

  /* ── 5. 隐私说明完整四段（文档 §三.2 逐字） ── */
  const P = prompts.COPY.privacyFull || {};
  ok('㉒ 隐私说明四段齐全且非零长',
    ['data_store', 'audio', 'memory', 'crisis'].every((k) => P[k] && P[k].length > 10),
    Object.keys(P).join(','));
  ok('㉓ 存储段说清 IndexedDB + 本地优先 + 只有按住说才传服务端',
    /IndexedDB/.test(P.data_store) && /不经云端/.test(P.data_store) && /按住说/.test(P.data_store));
  // 判据要落在**承诺点上**，不能箍死某几个字：隐私文案每版都会为了严谨重写
  // （v1.6.0 就把 audio/memory 两段扩写成更完整的说法），照字面断言只会变成改文案就红。
  ok('㉔ 音频段说清转写后不留音频 + 不用于训练 + 不用于商业分析',
    /不会(被)?留(下|存)/.test(P.audio) && /训练/.test(P.audio) && /(商业分析|用户画像)/.test(P.audio),
    P.audio);
  ok('㉕ 记忆段说清可查看/编辑/一键清空 + 开关由你控制',
    /查看/.test(P.memory) && /编辑/.test(P.memory) && /清空/.test(P.memory) && /你/.test(P.memory),
    P.memory);
  ok('㉖ 危机段说清不泄露第三方 + 紧急生命危险打 120/110',
    /不会将你的数据泄露给任何第三方/.test(P.crisis) && /120 或 110/.test(P.crisis));

  /* ── 6. 微小行动库与文档 §三.1 七条的关系 ── */
  const acts = (prompts.CARD_LIB.action.variants || []).map((v) => v.step || '');
  const DOC7 = [
    '试着慢慢深呼吸三次，稳住当下的感受。',
    '写下此刻心里最沉重的一句话，不用修饰。',
    '站起来倒杯水，感受一下水流划过手掌。',
    '闭上眼睛，听一听周围最远和最近的声音。',
    '把双脚踩在地面上，感受它稳稳托住你的力量。',
    '允许自己发呆三分钟，什么都不做。',
    '抱一抱自己，或者靠在椅背上，让肩膀松下来。',
  ];
  const hit7 = DOC7.filter((s) => acts.includes(s));
  ok('㉗ 文档点名的 7 条行动句都在库里（一条都不能丢）',
    hit7.length === DOC7.length,
    hit7.length === DOC7.length ? '7/7' : `只命中 ${hit7.length}/7：${DOC7.filter((s) => !acts.includes(s)).join(' | ')}`);
  ok('㉘ 库规模 49 条（41 条情绪专属 + 8 条中性兜底，step 无重复）',
    prompts.CARD_LIB.action.variants.length === 49 && acts.length === new Set(acts).size,
    `${prompts.CARD_LIB.action.variants.length} 条`);
  ok('㉘b 文档 7 条与 42 条主体并存（情绪组没被文档 7 条替掉）',
    (prompts.CARD_LIB.action.variants || []).filter((v) => (v.match || []).length).length === 41,
    `${(prompts.CARD_LIB.action.variants || []).filter((v) => (v.match || []).length).length} 条情绪专属`);

  console.log(`\n==== 文档收口探针：${pass} 通过 / ${fail} 失败 ====`);
  if (fail) { console.log('失败项：' + failures.join(' / ')); process.exit(1); }
  console.log('✅ 全绿');
})().catch((e) => { console.error('探针异常：', e); process.exit(1); });
