#!/usr/bin/env node
/* 墨小溟 · 【微小行动库】契约探针（v1.5.0）
 *
 * 为什么要有这个探针（v1.5.0 前的真实缺陷）：
 *   CARD_LIB.action.variants 原来只有 4 套（愤怒/委屈/迷茫/疲惫），而标准情绪短词有 17 个。
 *   剩下 13 种情绪在 pickActionVariant 里一律落进兜底 variants[1] —— 等于
 *   「用户高高兴兴说了件好事（喜悦），App 推他把心里最沉重的一句话写下来」。
 *   而且同一情绪永远只推同一条（命中即 return，顺序即优先级）。
 *
 * 本探针逐条卡死四件事：
 *   ① 覆盖：17 种标准情绪各自命中**自己那一组**（返回的 variant.match 必须含该情绪词，不允许串组）；
 *   ② 门槛：每条 5 秒~3 分钟（字数上限）、不带「必须/应该」的说教味；
 *   ③ 红线：全库不含重大人生决策（离职/分手/就医/打官司…），不给诊断和保证；
 *   ④ 手感：同情绪多套会轮换（不总推同一句）、同输入可复现、无情绪时给中性兜底。
 *
 * 用法： node _selftest/action-lib.cjs
 */
const path = require('path');
const { pathToFileURL } = require('node:url');
const EMO = ['喜悦', '悲伤', '愤怒', '焦虑', '惊讶', '厌恶', '愧疚', '疲惫', '孤单', '矛盾',
  '期待落空', '模糊情绪', '委屈', '迷茫', '麻木', '心酸', '不甘'];

// 重大人生决策（红线：MAIN_PROMPT 第五层绝不碰）
const BIG_DECISION = ['离职', '辞职', '跳槽', '分手', '离婚', '就医', '看病', '手术',
  '打官司', '报警', '起诉', '仲裁', '买房', '买车', '考研', '停药', '搬家', '辞职信', '休学'];
// 说教味（≥1 命中即不合格）
const PREACHY = ['必须', '应该', '不应该', '你要', '你得', '记住', '永远', '从不', '一定'];
// 正向情绪禁词：喜悦/惊讶只配「存住/慢一点」，不配沉重措辞
const HEAVY = ['沉重', '难过', '委屈', '哭', '心酸', '难受', '痛苦', '崩溃'];

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  — ' + detail : ''}`);
};

(async () => {
  const ai = await import(pathToFileURL(path.join(__dirname, '..', 'js', 'ai.js')).href);
  const prompts = await import(pathToFileURL(path.join(__dirname, '..', 'js', 'prompts.js')).href);
  const { pickActionVariant } = ai;
  const { CARD_LIB, TIMELINE_EMOTIONS } = prompts;

  if (!CARD_LIB || !CARD_LIB.action || !Array.isArray(CARD_LIB.action.variants)) {
    check('微小行动库存在且 variants 是数组', false, 'CARD_LIB.action.variants 缺失');
    process.exitCode = 1;
    return;
  }
  const lib = CARD_LIB.action.variants;
  const live = lib.filter((v) => !v.neutral);
  const neutral = lib.filter((v) => v.neutral);

  /* ---------- ① 覆盖 + 不串组 ---------- */
  const wrong = [];
  const miss = [];
  for (const e of EMO) {
    const v = pickActionVariant([e], '');
    if (!v) { miss.push(e); continue; }
    if (!(v.match || []).includes(e)) wrong.push(`${e}→${v.title}`);
  }
  check(`① 17 种标准情绪全部命中自己那一组（库共 ${live.length} 条）`,
    EMO.length === TIMELINE_EMOTIONS.length && miss.length === 0 && wrong.length === 0,
    miss.length ? `未命中：${miss.join('/')}` : wrong.length ? `串组：${wrong.join('，')}` : `${EMO.length}/${EMO.length}`);
  // 情绪组判定 = 该条 match 里第一个属于标准情绪短词的词；同组内多条共享词是允许的，
  // 跨组共享同一个词才是缺陷（典型症状：焦虑的人被推去做「方向题」）。
  const primaryOf = (v) => (v.match || []).find((x) => EMO.includes(x)) || '';
  const cross = [];
  for (const v of live) {
    for (const w of v.match) {
      for (const o of live) {
        if (o === v) continue;
        if ((o.match || []).includes(w) && primaryOf(o) && primaryOf(o) !== primaryOf(v)) {
          cross.push(`${w}:${v.title}(${primaryOf(v)})↔${o.title}(${primaryOf(o)})`);
        }
      }
    }
  }
  check('① 每个情绪词的匹配词不跨组（避免焦虑的人被推去做方向题）', cross.length === 0,
    cross.length ? cross.slice(0, 4).join('，') : '同词只出现在同一情绪组内');

  /* ---------- ② 低门槛 + 不说教 ---------- */
  const tooLong = live.filter((v) => (v.step || '').length > 46);
  const noteLong = live.filter((v) => (v.note || '').length > 24);
  const empty = live.filter((v) => !v.title || !v.step || !v.note);
  check('② 每条 step ≤ 46 字（5 秒~3 分钟能做完）', tooLong.length === 0,
    tooLong.length ? tooLong.map((v) => `${v.title}(${v.step.length})`).join('，') : `${live.length}/${live.length} 条`);
  check('② 每条 note ≤ 24 字（只松口，不追加任务）', noteLong.length === 0,
    noteLong.length ? noteLong.map((v) => `${v.title}(${v.note.length})`).join('，') : `最长 ${Math.max(...live.map((v) => (v.note || '').length))} 字`);
  check('② 每条 title/step/note 字段齐全', empty.length === 0, empty.map((v) => v.title).join('，') || '齐全');
  const preach = live.filter((v) => PREACHY.some((w) => (v.step + v.note).includes(w)));
  check('② 全库不含「必须/应该/你要记住」这类说教词', preach.length === 0,
    preach.length ? preach.map((v) => v.title).join('，') : '干净');

  /* ---------- ③ 红线：不给重大人生决策 ---------- */
  const bigHit = live.filter((v) => BIG_DECISION.some((w) => (v.step + v.note).includes(w)));
  check('③ 全库不含重大人生决策词（离职/分手/就医/打官司…）', bigHit.length === 0,
    bigHit.length ? bigHit.map((v) => `${v.title}:${BIG_DECISION.find((w) => (v.step + v.note).includes(w))}`).join('，') : `${BIG_DECISION.length} 词全扫过`);

  /* ---------- ④ 手感：轮换 / 幂等 / 兜底 ---------- */
  const rounds = new Map();
  for (const e of EMO) {
    const set = new Set();
    for (let i = 0; i < 8; i += 1) set.add(pickActionVariant([e], `第 ${i} 次倾诉`).title);
    rounds.set(e, set.size);
  }
  const notRound = [...rounds.entries()].filter(([, n]) => n < 2).map(([e]) => e);
  check('④ 多情绪在 8 次不同倾诉里会轮换到 ≥2 种（不总推同一句）', notRound.length === 0,
    notRound.length ? `未轮换：${notRound.join('/')}` : `最多 ${Math.max(...rounds.values())} 种`);

  const rep = live.every((v) => {
    const a = pickActionVariant(['焦虑'], '明天要开会我睡不着');
    const b = pickActionVariant(['焦虑'], '明天要开会我睡不着');
    return a.title === b.title && a.step === b.step;
  });
  check('④ 同一 (情绪, 文本) 结果可复现（同一个人重复点不会乱跳）', rep, '幂等');
  check('④ 同一种情绪多套并存（≥18 条行动 + 1 条中性兜底）', live.length >= 18 && neutral.length === 1,
    `live=${live.length} neutral=${neutral.length}`);

  const fb = pickActionVariant([], '');
  check('④ 无情绪输入 → 中性兜底（不再是「把最沉重的一句话写下来」）',
    fb && fb.title === '就待一会儿' && !HEAVY.some((w) => (fb.step + fb.note).includes(w)), (fb && fb.title) || 'null');
  check('④ 正向情绪（喜悦/惊讶）不出现沉重措辞', (() => {
    const bad = [];
    for (const e of ['喜悦', '惊讶']) {
      const v = pickActionVariant([e], '今天发生了一件让我很高兴的事');
      if (HEAVY.some((w) => (v.step + v.note).includes(w))) bad.push(`${e}→${v.title}`);
    }
    return bad.length === 0 ? true : (bad.length && bad.join('，'));
  })(true) === true, '喜悦/惊讶 干净');

  /* ---------- ⑤ 链路：时间线卡 action_tip 真的来自命中那条 ---------- */
  const TXT = '今天和同事吵架了，我憋了一肚子火，现在还在生气。';
  const tl = ai.buildTimeline([{ role: 'user', text: TXT, at: Date.now() }]);
  const tip = tl.actionHint || null;
  const nodeEmo = (tl.nodes && tl.nodes[tl.nodes.length - 1] && tl.nodes[tl.nodes.length - 1].emotions) || [];
  const expect = pickActionVariant(nodeEmo, TXT);
  check('⑤ 时间线卡 action_tip 与命中行动逐字一致',
    !!tip && !!expect && tip.step === expect.step && tip.title === expect.title,
    tip ? `${tip.title}｜${tip.step}` : 'actionHint 为空');

  const dupe = new Set();
  const dupHit = live.filter((v) => {
    if (dupe.has(v.step)) return true;
    dupe.add(v.step);
    return false;
  });
  check('⑤ 库内无重复 step（42 条各自不同）', dupHit.length === 0, dupHit.map((v) => v.title).join('，') || `${live.length} 条全不同`);

  console.log(`\n通过 ${pass} / ${pass + fail}${fail ? `　❌ 失败 ${fail}` : '　✅ 全绿'}`);
  process.exitCode = fail ? 1 : 0;
})();
