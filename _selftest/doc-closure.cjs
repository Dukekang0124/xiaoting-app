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
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '..');

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

  /* ── 5. 隐私说明七段（文档 §追加模块2 骨架） ── */
  const P = prompts.COPY.privacyFull || {};
  const SEC = P.sections || [];
  const secOf = (k) => (SEC.find((s) => s && s.k === k) || {});
  ok('㉒ 隐私说明七段齐全且每段非零长',
    ['own', 'collect', 'use', 'rights', 'protect', 'notice', 'contact']
      .every((k) => secOf(k).t && secOf(k).t.length > 30),
    SEC.map((s) => s.k).join(','));
  // 🔴 v1.6.2：这条判据**之前是错的**——它用朴素子串否定去禁「完全不出本机」，
  //    结果把「这一步做不到「完全不出本机」，不想拿好听话糊过去」这句**主动认丑的诚实声明**
  //    也判成假承诺 ⇒ 假红。正确判法：禁的是「把完全不出本机当正面承诺」，
  //    即总出现次数里只要有一处**不是**否定式的，就是真假承诺。
  {
    const t = secOf('own').t || '';
    const total = (t.match(/完全不出本机/g) || []).length;
    const negated = (t.match(/(做不到|做不到|不是|并不|并非|谈不上|没那么|不等于)[^。；\n]{0,12}完全不出本机/g) || []).length;
    ok('㉓ 第 1 段说清本地优先 + 语音/文字什么时候会出本机，且「完全不出本机」只作为否定声明出现（不许当正面承诺）',
      /本地优先|本地/.test(t) && /云端|服务端/.test(t) && (total - negated) === 0 && !/不经(过)?云端|不会自动上传/.test(t),
      `完全不出本机 出现 ${total} 次 / 其中否定式 ${negated} 次`);
    // 🔴 承诺里点名的开关必须在代码里**真实存在且真接线**：写个不存在的开关 =
    //    假承诺 + 死开关（「死开关比没开关更糟」）。这里直接读源码，不靠人记。
    const appSrc = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
    const hasEl = /id="setCloudAsr"/.test(appSrc);
    const hasHandler = /getElementById\('setCloudAsr'\)\s*[\s\S]{0,80}addEventListener\(/.test(appSrc);
    const hasGate = /settings\.cloudAsr\s*!==\s*false/.test(appSrc);
    ok('㉓b 隐私文案点名的开关在代码里真实存在 + 真接线 + 真生效（不是空头承诺）',
      /允许把录音发给云端转写/.test(t) && hasEl && hasHandler && hasGate,
      `渲染=${hasEl} 绑事件=${hasHandler} 上传闸门=${hasGate}`);
  }
  // 🔴 判据落在**代码事实**上：全库搜不到「云备份/加密上传」的实现，写了就是空头承诺。
  //    同理「开发团队也无法读取」做不到，"IndexedDB" 与真实存储（localStorage）也不符。
  const all = SEC.map((s) => (s.t || '')).join(' ');
  ok('㉔ 不承诺不存在的云备份 / 不写「开发团队也读不到」/ 不写 IndexedDB',
    !/云备份|开发团队|IndexedDB/.test(all),
    (all.match(/云备份|开发团队|IndexedDB/) || [''])[0] || '干净');
  // 判据要落在**承诺点上**，不能箍死某几个字：隐私文案每版都会为了严谨重写
  // （v1.6.0 就把 audio/memory 两段扩写成更完整的说法），照字面断言只会变成改文案就红。
  ok('㉕ 收集段说清存在本机什么 / 临时过云端什么 / 不收什么',
    /设备/.test(secOf('collect').t) && /云端/.test(secOf('collect').t) && /剪贴板/.test(secOf('collect').t),
    secOf('collect').t);
  ok('㉖ 用途段说清不做广告推送 / 不出售第三方',
    /广告推送/.test(secOf('use').t) && /(第三方|卖给)/.test(secOf('use').t), secOf('use').t);
  ok('㉗ 权利段说清单条删除 / 一键清空 / 关开关都能自己说了算',
    /单条删除/.test(secOf('rights').t) && /清空/.test(secOf('rights').t) && /你/.test(secOf('rights').t),
    secOf('rights').t);
  ok('㉘ 安全段说清真实保护（带鉴权通道 + 不训练 + 不画画像）',
    /鉴权/.test(secOf('protect').t) && /训练/.test(secOf('protect').t) && /画像/.test(secOf('protect').t),
    secOf('protect').t);
  ok('㉙ 声明段给心理援助热线 400-161-9995 / 120',
    /400-161-9995/.test(secOf('notice').t) && !(secOf('notice').t || '').includes('IndexedDB'),
    secOf('notice').t);
  ok('㉚ 「联系我们」指向真实可达的外链（不是 App 里不存在的帮助通道）',
    /^https?:\/\//.test((P.link || {}).href || ''), (P.link || {}).href || '无链接');

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

  /* ── 6b. 文档 §追加模块1 · 逐字 24 条（v1.6.2 新增，优先级高于上面 49 条） ──
     判据：一条都不能改字。改了就是「文档说一套、产品说另一套」，用户会照着文档对不上。 */
  const DOC24 = [
    '做3次缓慢深呼吸，吸气4秒，呼气6秒。',
    '找一个舒服的姿势，安静坐1分钟。',
    '写下一句此刻心里最直接的感受。',
    '喝一杯温水，感受水流过喉咙。',
    '看看窗外，留意眼前任意一件小东西。',
    '允许自己哭一会儿，不用强行忍住。',
    '握紧拳头5秒，再慢慢松开，重复3次。',
    '起身走动一小会儿，离开当下的环境。',
    '在心里默默数10个数，慢慢平复。',
    '把想吐槽的话全部写下来，写完可以删掉。',
    '吹一口气，把心里紧绷的感觉释放一点。',
    '闭眼休息30秒，什么都不用想。',
    '放下手头事情，短暂放空。',
    '拉伸肩膀，释放身体紧绷感。',
    '不用逼自己振作，允许短暂摆烂。',
    '调低环境光线，安静待一会。',
    '记住此刻这种舒服的感觉，好好留存。',
    '简单记下这件让你快乐的小事。',
    '深呼吸，感受这份喜悦留在身体里。',
    '给自己一句肯定，你值得这份美好。',
    '不用立刻做出决定，先把两种感受分开写下来。',
    '只关注当下这一刻，不去想以后的结果。',
    '问问自己：现在我最需要的是什么？',
    '先暂停思考，休息片刻再梳理。',
  ];
  const docSteps = (prompts.CARD_LIB.action.docSet || []).map((v) => v.step || '');
  const miss24 = DOC24.filter((s) => !docSteps.includes(s));
  ok('㉛ 文档点名的 24 条微小行动逐字入库（低落6/愤怒5/疲惫5/开心4/矛盾4）',
    docSteps.length === 24 && miss24.length === 0,
    miss24.length ? `缺 ${miss24.length} 条：${miss24.join(' | ')}` : '24/24 逐字一致');
  const docOver = (prompts.CARD_LIB.action.docSet || []).filter((v) => (v.step || '').length > 30);
  ok('㉜ 24 条每条 ≤30 字（适配卡片 UI）', docOver.length === 0,
    docOver.length ? docOver.map((v) => `${v.step}(${v.step.length})`).join('，')
      : `最长 ${Math.max(...docSteps.map((s) => s.length))} 字`);
  const docPreachy = (prompts.CARD_LIB.action.docSet || []).filter((v) => /应该|必须|你要/.test(`${v.step}${v.title}${v.note}`));
  ok('㉝ 24 条都不说教（无「应该/必须/你要」）', docPreachy.length === 0,
    docPreachy.map((v) => v.title).join('，') || '干净');
  const docOverlap = docSteps.filter((s) => acts.includes(s));
  ok('㉞ 24 条与既有 49 条不重字（两套库各自独立可查）', docOverlap.length === 0,
    docOverlap.join(' | ') || '两套无重叠');

  console.log(`\n==== 文档收口探针：${pass} 通过 / ${fail} 失败 ====`);
  if (fail) { console.log('失败项：' + failures.join(' / ')); process.exit(1); }
  console.log('✅ 全绿');
})().catch((e) => { console.error('探针异常：', e); process.exit(1); });
