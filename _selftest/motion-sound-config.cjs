#!/usr/bin/env node
/**
 * 动效/音效配置·反向断言（v1.6.3）
 *
 * 🔴 为什么要有这一层：配置化的最大陷阱是「写了配置、没人去读」——
 *    配置里写 `"anim":"ip-tap1"`，实际 CSS 里叫 `ip-tap9`，页面照样跑得欢，
 *    只是那份配置永远是死的。这类失效不报错、不闪退、不空指针，
 *    属于「看起来闭环、实际没接上」（本仓 update.js 那次就是这个套路）。
 *
 * 判据全部取**真源**，不拿自己的常量自证：
 *   · 动画名 ← 浏览器样式表里真实的 @keyframes / 选择器
 *   · 状态名 ← ip.js 的 mascot(state) 真实产出的 class
 *   · 音效名 ← ip-audio.js 导出的 CUE_NAMES（那个 Set 就是声音表的真源）
 *   · 参数生效 ← 挂上 motion 后 root 上真实存在的 CSS 变量值
 *
 * 用法：NODE_PATH=<受管 node_modules> node _selftest/motion-sound-config.cjs
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const BASE = process.env.BASE || 'http://127.0.0.1:4173';
const ROOT = path.resolve(__dirname, '..');
// 磁盘上的配置作为传入真源：页面只是渲染环境，配置本身才是被验证的对象。
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'moxiaoming_motion_sound_config.json'), 'utf8'));

const results = [];
const failed = [];
function ok(name, cond, detail = '') {
  const pass = !!cond;
  results.push(pass);
  if (!pass) failed.push(name + (detail ? ' — ' + detail : ''));
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e && e.message)));

  await page.goto(BASE + '/#/say', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);

  // 一次性把「配置 + 四处真源」都取回来
  const data = await page.evaluate(async ({ base, cfg }) => {
    const out = {};
    out.cfg = cfg;
    // 🔴 真链路（防假绿）：上面取的都是「自己 import 进来的模块实例」上的东西。
    //    但 app.js 调的是 window.motion —— 如果 app.js 只 import 没挂全局，
    //    这里每一条都会绿，产品里却是静默空转（v1.6.3 真实踩过：window.motion 从未被赋值）。
    //    所以这一组必须问真页面：全局在不在、八个入口齐不齐、配置真读进来没、playTap 真加到 IP 没。
    try {
      const w = window.motion || null;
      out.wire = {
        hasGlobal: !!w && typeof w === 'object',
        missing: w ? ['load','mount','setEnabled','setIntensity','playTap','setState','getConfig']
                     .filter((k) => typeof w[k] !== 'function') : ['全局根本不存在'],
        cfgByApp: !!(w && w.getConfig && w.getConfig()),
      };
      out.wire.tap = w && typeof w.playTap === 'function' ? (w.playTap(2) || null) : null;
      // 判据选择器必须和 playTap 实现里用的是同一个（.say__mascot 才是它加 class 的目标，.mascot 只是外层壳）
      const tapEl = document.querySelector('.say__mascot') || document.querySelector('.mascot');
      out.wire.tapOnMascot = !!(tapEl && out.wire.tap && tapEl.classList.contains(out.wire.tap.cls));
      w && typeof w.setEnabled === 'function' && w.setEnabled(false);
      out.wire.offAfterClose = document.body.classList.contains('ip-motion-off');
      w && typeof w.setEnabled === 'function' && w.setEnabled(true);
      out.wire.onAfterOpen = document.body.classList.contains('ip-motion-off') === false;
      // v1.6.13：情绪态真联动 —— setState 必须真把配置里的 ip_anim 挂到 IP 身上、真写 particle 变量
      try {
        const em = (cfg || {}).emotion_motion_map || {};
        const key = Object.keys(em).find((k) => (em[k] || {}).ip_anim);
        const ret = (w && typeof w.setState === 'function') ? w.setState(key) : null;
        const el = document.querySelector('.say__mascot') || document.querySelector('.mascot');
        out.wire.setState = {
          key, ret,
          onEl: !!(el && ret && ret.ip_anim && el.classList.contains(ret.ip_anim)),
          particle: getComputedStyle(document.documentElement).getPropertyValue('--mm-particle').trim(),
        };
      } catch (e) { out.wire.setState = { err: String(e.message) }; }
    } catch (e) { out.wire = { err: String(e.message) }; }
    try {
      const res = await fetch('/moxiaoming_motion_sound_config.json', { cache: 'no-cache' });
      out.configHttp = res.status;
      out.configHttp = res.ok ? 200 : res.status;
    } catch (e) { out.configHttp = 0; }

    // 真源①：样式表里真实存在的 @keyframes 与选择器
    const kf = new Set(); const sels = new Set();
    for (const sheet of Array.from(document.styleSheets)) {
      let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
      for (const r of Array.from(rules)) {
        if (r.type === CSSRule.KEYFRAMES_RULE) kf.add(r.name);
        if (r.selectorText) sels.add(r.selectorText);
      }
    }
    out.keyframes = Array.from(kf);
    out.selectors = Array.from(sels);

    // 真源②：ip.js 真实产出的状态 class（跑真实的 mascot() 函数，不是抄一份名单）
    try {
      const ip = await import('/js/ip.js');
      const svg = ip.mascot('idle');
      out.tentacleTotal = (String(svg).match(/class="mascot__wisp[^"]*tentacle--\d/g) || []).length;
      // 🔴 分组只认 class 属性里的 tentacle--gX：ip.js 顶部注释也写了 "tentacle--g1 = 1/2 号"，
      //   用裸正则数会连注释一起数（第一版就因此假红：注释 1 + 实际 2 = 3，看着像多了一条）。
      const grp = (g) => (String(svg).match(new RegExp(`class="mascot__wisp[^"]*tentacle--g${g}"`, 'g')) || []).length;
      out.groupCount = { g1: grp('1'), g2: grp('2'), g3: grp('3'), g4: grp('4') };
      // 状态名逐个真跑 mascot(state)，看看这个 class 到底产不产得出来
      // （不能用一份"从 idle SVG 里扫出来的名单"当真源 —— 那样扫出来只有 idle，七个情绪全假红）
      const states = Array.from(new Set(
        Object.values((cfg || {}).emotion_motion_map || {}).map((x) => (x || {}).ip_state).filter(Boolean)
      ));
      out.ipStateCheck = states.map((s) => ({ s, ok: String(ip.mascot(s)).includes('mascot--' + s) }));
    } catch (e) { out.ipStates = []; out.ipErr = String(e && e.message); }

    // 真源③：音效表真源
    try {
      const au = await import('/js/ip-audio.js');
      out.cues = Array.from(au.CUE_NAMES || []);
    } catch (e) { out.cues = []; out.audioErr = String(e && e.message); }

    // 真源④：挂上动效编排层之后，root 上真实落地的 CSS 变量
    try {
      const m = await import('/js/motion.js');
      await m.load();
      const cs = getComputedStyle(document.documentElement);
      out.vars = {
        floatMs: cs.getPropertyValue('--mm-float-ms').trim(),
        floatRange: cs.getPropertyValue('--mm-float-range').trim(),
        wispAmp: cs.getPropertyValue('--mm-wisp-amp').trim(),
        wispTinyAmp: cs.getPropertyValue('--mm-wisp-tiny-amp').trim(),
        wispStillAmp: cs.getPropertyValue('--mm-wisp-still-amp').trim(),
      };
      out.g2Delay = (() => {
        const el = document.querySelector('.tentacle--g2');
        return el ? getComputedStyle(el).animationDelay : null;
      })();
      // 开关真生效：关掉后 body 必须带 ip-motion-off（既有总开关，不另造）
      m.setEnabled(false);
      out.offClass = document.body.classList.contains('ip-motion-off');
      m.setEnabled(true);
      out.onClass = !document.body.classList.contains('ip-motion-off');
    } catch (e) { out.motionErr = String(e && e.message); }
    return out;
  }, { base: BASE, cfg: CFG });

  const cfg = data.cfg || {};
  console.log('===== 动效/音效配置反向断言 =====');

  ok('配置可读（HTTP 200 + 合法 JSON）', data.cfg && data.configHttp === 200,
     `status=${data.configHttp}`);

  if (!cfg.schema) {
    console.log('\n❌ 配置取不到，后续断言无意义（真源仍在，页面会退回 CSS 默认值）');
    console.log(`结果：0 通过 / ${results.length} 断言跳过`);
    await browser.close();
    process.exit(1);
  }

  // ① 触手结构：方案要八条，且必须能分组驱动
  ok('IP 有八条可独立驱动的触手', data.tentacleTotal === 8, `tentacle--N = ${data.tentacleTotal}`);
  ok('触手分四组、每组两条（1-2 / 3-4 / 5-6 / 7-8）',
     data.groupCount.g1 === 2 && data.groupCount.g2 === 2 && data.groupCount.g3 === 2 && data.groupCount.g4 === 2,
     JSON.stringify(data.groupCount));

  // ② 点击互动：配置里的 anim 必须是样式表里真实存在的动画名
  const ci = cfg.click_interact || {};
  for (const [k, v] of Object.entries(ci)) {
    if (!v || !v.anim) continue;
    ok(`点击 ${k}.anim 在样式表里真实存在`, data.keyframes.includes(v.anim), v.anim);
  }
  // ②b v1.6.13：情绪的 ip_anim 也必须是样式表里真实存在的动画名
  //     （补这一条之前，七个 ip_anim 全在配置里"声明"，样式表里 0 命中 —— 死配置，改了不生效）
  Object.entries(cfg.emotion_motion_map || {}).forEach(([k, v]) => {
    if (v && v.ip_anim) ok(`情绪 ${k}.ip_anim 在样式表里真实存在`, data.keyframes.includes(v.ip_anim), v.ip_anim);
  });

  // ③ 情绪状态：ip_state 必须是 mascot() 真能产出的 class
  (data.ipStateCheck || []).forEach((c) => {
    ok(`情绪状态 ${c.s} 是 IP 真实可渲染状态`, c.ok, c.ok ? '' : 'mascot() 产不出 mascot--' + c.s);
  });
  // ④ 音效：每个 sound 引用都必须在声音表里
  const cueRefs = [];
  Object.values(ci).forEach((v) => v && v.sound && cueRefs.push([v.sound, 'click_interact']));
  Object.values(cfg.emotion_motion_map || {}).forEach((v) => v && v.sound && cueRefs.push([v.sound, 'emotion']));
  Object.values(cfg.scene_effect || {}).forEach((v) => v && v.sound && cueRefs.push([v.sound, 'scene_effect']));
  for (const [name, from] of cueRefs) {
    ok(`音效 ${name}（${from}）在声音表里真实存在`, data.cues.includes(name));
  }

  // ⑤ 待机参数是真生效，不是写完就躺在文件里
  const idle = cfg.idle_standby || {};
  const v = data.vars || {};
  ok('待机周期写进了 CSS 变量（6s）', v.floatMs === '6000ms', String(v.floatMs));
  ok('垂直浮动幅度写进了 CSS 变量（6px）', v.floatRange === '6px', String(v.floatRange));
  ok('垂须振幅写进了 CSS 变量（3deg）', v.wispAmp === '3deg', String(v.wispAmp));
  ok('5/6 号组小幅度呼吸（2px）', v.wispTinyAmp === '2px', String(v.wispTinyAmp));
  ok('7/8 号组极稳锚定（1deg）', v.wispStillAmp === '1deg', String(v.wispStillAmp));
  ok('3/4 号组滞后 0.5s 生效', String(data.g2Delay) === '0.5s', String(data.g2Delay));

  // ⑥ 总开关：复用既有 ip-motion-off，关了必须真关
  ok('动效总开关关掉后 body 带 ip-motion-off', data.offClass === true);
  ok('总开关打开后 body 不带 ip-motion-off', data.onClass === true);

  // ⑦ 真链路：落 app.js 实际调用的那条（window.motion），前面全是假绿的话这里必须红
  const w = data.wire || {};
  ok('app.js 真把 motion 挂上了 window（只 import 不挂全局 = 静默空转）', w.hasGlobal === true);
  ok('window.motion 的入口都是真函数', Array.isArray(w.missing) && w.missing.length === 0, (w.missing || []).join(','));
  ok('页面启动真把配置读进来了（getConfig 非空）', w.cfgByApp === true);
  ok('playTap(2) 真跑出结果', !!w.tap, JSON.stringify(w.tap));
  ok('playTap 的 class 真加到了 IP 身上（不是只算出个名字）', w.tapOnMascot === true);
  ok('setEnabled(false) 真让 body 带 ip-motion-off', w.offAfterClose === true);
  ok('setEnabled(true) 后恢复', w.onAfterOpen === true);
  // v1.6.13：情绪态真联动（曾为空壳 + 死配置，这两条在修复前必须失败）
  const ws = w.setState || {};
  ok('setState 对情绪态真跑出结果', !!ws.ret, JSON.stringify(ws.ret));
  ok('setState 的动画类真加到 IP 身上（不是只算出个名字）', ws.onEl === true, JSON.stringify(ws));
  ok('setState 真把 particle 写进 CSS 变量', !!ws.particle && ws.particle !== 'none', String(ws.particle));

  ok('页面无未捕获异常', pageErrors.length === 0, pageErrors.join(' | '));

  const pass = results.filter(Boolean).length;
  console.log(`\n==== 汇总：${pass} 通过 / ${results.length - pass} 失败 ====`);
  if (failed.length) console.log('失败项：\n' + failed.map((n) => '  ❌ ' + n).join('\n'));
  await browser.close();
  process.exit(failed.length ? 1 : 0);
})();
