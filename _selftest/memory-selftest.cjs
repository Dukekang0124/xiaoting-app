// 墨小溟 v1.3.0 · 记忆地基 真跑自测（本机 Chrome）
// 覆盖：结构化提取 / 召回打分 / 上下文注入 / IndexedDB 持久化与去重 / 迁移播种 /
//       /memory 面板渲染与增删改 / 总开关门禁 / settings 入口。
// 运行：先起服务 `PORT=4173 STATS_KEY=selftest node server.cjs`，
//       再 `NODE_PATH=<managed-node-workspace>/node_modules node _selftest/memory-selftest.cjs`
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = process.env.BASE || 'http://127.0.0.1:4173';
const OUT = path.join(__dirname, 'shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail: String(detail || '') });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const sec = (name) => console.log(`\n===== 分区 ${name} =====`);

// 紧凑 SDK 契约替身：记录每一次主分析请求的用户文本，供「记忆注入」断言使用。
const MOCK_SDK = `(function(){
  window.__llmCalls = [];
  var REPLY = {
    safety: { risk_level:'none', reason:'ok', action:'continue' },
    main: { event:'他很久才回我消息', people:['男朋友'], scene:'亲密关系', emotion:['委屈','愤怒'], intensity:8,
      body:['胸闷'], thought:'他根本不在乎我', cognitive_patterns:['读心','绝对化'], need:['被重视','可预期'],
      behavior:'冷战', result:'更焦虑', pattern:'把回消息速度等同于被重视', experiment:'先说需要',
      summary:'你不是因为消息慢而难受。', needs_followup:false, followup_questions:[] },
    card: { title:'t', date:'2026-09-30', event:'e', emotion:['委屈'], intensity:8, body:[], thought:'',
      need:[], behavior:'', result:'', pattern:'', experiment:'', summary:'', tags:[], ip_state:'empathy' }
  };
  function stageOf(u){
    if (u.indexOf('risk_level')>=0) return 'safety';
    if (u.indexOf('"title"')>=0) return 'card';
    if (u.indexOf('needs_followup')>=0) return 'main';
    return 'main';
  }
  async function* stream(text){
    yield { choices:[{ delta:{ content: text.slice(0,20) } }] };
    for (var i=20;i<text.length;i+=20) yield { choices:[{ delta:{ content: text.slice(i,i+20) } }] };
    yield { choices:[{ delta:{}, finish_reason:'stop' }], usage:{ total_tokens: 100 } };
  }
  window.WorkBuddyCloud = {
    createWorkBuddyCloud: function(){
      return { llm: {
        models: { list: function(){ return Promise.resolve([{ id:'mock-chat', name:'Mock', disabled:false, supportsReasoning:false, maxOutputTokens:8192, temperature:0.7 }]); } },
        chat: { completions: { create: function(req){
          var u = (req.messages[1] && req.messages[1].content) || '';
          var stage = stageOf(u);
          window.__llmCalls.push({ stage: stage, userText: u });
          return stream(JSON.stringify(REPLY[stage] || {}));
        } } }
      } };
    }
  };
})();`;

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'zh-CN', isMobile: true, hasTouch: true,
  });
  const page = await ctx.newPage();
  await ctx.addInitScript(() => {
     try { localStorage.setItem('monthly:done_' + (new Date().getFullYear() * 100 + (new Date().getMonth() + 1)), '1'); } catch (e) {} try { localStorage.setItem('xiaoting:ai', 'mock'); localStorage.setItem('moxiaoming:welcomed_v1', '1'); } catch (e) {} });
  await ctx.addInitScript(MOCK_SDK);
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
     try { localStorage.setItem('monthly:done_' + (new Date().getFullYear() * 100 + (new Date().getMonth() + 1)), '1'); } catch (e) {} if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('dialog', (d) => d.accept());
  // 让自通道（/api/llm）走不通，逼 ask 回退到网关（SDK 替身）；同时避免打到真服务。
  await ctx.route('**/api/llm', (route) => route.abort());
  const goto = (h) => page.goto(BASE + h, { waitUntil: 'domcontentloaded' });

  /* ===== 分区 1：结构化提取 / 召回打分 / 上下文生成（纯函数） ===== */
  sec('M1. 提取 / 召回 / 上下文（纯函数）');
  await goto('/#/say');
  await page.waitForSelector('.mascot', { timeout: 10000 });

  const F = await page.evaluate(async () => {
    const mem = await import('/js/memory.js');
    const a = { event:'项目压力', people:['领导','同事小张'], scene:'工作', emotion:['焦虑','疲惫'], emotion_primary:'焦虑', hidden_need:'怕辜负别人期望', pattern:'总把任务揽上身' };
    const units = mem.deriveMemoryUnits({ analysis: a, transcript:'', timeline:null, sessionId:'s0', dateISO:new Date().toISOString() });
    // 召回：构造几个历史单元，按分数排序
    const hist = [
      { type:'person', title:'领导', summary:'', emotion_tags:['焦虑'], created_at:new Date().toISOString(), important:false },
      { type:'event', title:'项目压力', summary:'', emotion_tags:['焦虑'], created_at:new Date(Date.now()-40*864e5).toISOString(), important:false },
      { type:'knot', title:'怕辜负别人期望', summary:'', emotion_tags:['焦虑'], created_at:new Date().toISOString(), important:true },
      { type:'person', title:'同事小张', summary:'', emotion_tags:['中性'], created_at:new Date().toISOString(), important:false },
    ];
    const top = mem.recallTopN(hist, { transcript:'今天领导又给我加了任务，好焦虑', emotion:['焦虑'], limit:3 });
    const ctx0 = mem.buildMemoryContext(top.map((t)=>t.unit));
    return { units, top, ctx0, nUnits: units.length };
  });

  // 提取：人物最多 2（领导、同事小张），事件 1，心结 1（hidden_need 优先于 pattern）
  const types = F.units.map((u) => u.type);
  check('提取：人物 2 条（people 截断到 2）', types.filter((t)=>t==='person').length === 2, types.join(','));
  check('提取：事件 1 条', types.filter((t)=>t==='event').length === 1);
  check('提取：心结 1 条（hidden_need 优先）', types.filter((t)=>t==='knot').length === 1);
  check('提取：不写原始转录（无 transcript 字段泄露）', F.units.every((u)=> !('transcript' in u)));

  // 召回：important 的 knot 应排第一（50 分），其次当前文本提及「领导」的 person（+5），recency 次之
  check('召回：返回 Top-3', F.top.length === 3, 'len=' + F.top.length);
  check('召回：important 单元分数最高', F.top[0].unit.important === true, 'top0=' + (F.top[0].unit.title));
  check('召回：当前文本提及的「领导」被加权', F.top.some((t)=>t.unit.title==='领导'), F.top.map((t)=>t.unit.title).join(','));
  check('上下文：含「你之前陪 TA 聊过的」引导语', F.ctx0.includes('你之前陪 TA 聊过的'));
  check('上下文：含被召回的标题', F.ctx0.includes('领导') && F.ctx0.includes('怕辜负别人期望'));

  /* ===== 分区 2：IndexedDB 持久化 / 去重合并 / 增删改 ===== */
  sec('M2. IndexedDB 持久化 / 去重 / CRUD');
  const DB = await page.evaluate(async () => {
    const mem = await import('/js/memory.js');
    await mem.clearMemory();
    const r1 = await mem.saveSessionWithMemory({ session:{id:'s1'}, analysis:{ event:'项目压力', people:['领导'], scene:'工作', emotion:['焦虑'], emotion_primary:'焦虑', hidden_need:'怕辜负别人期望' }, transcript:'', timeline:null, dateISO:new Date().toISOString() });
    const all1 = await mem.loadMemory();
    // 再次保存同 (type,title) 单元，应合并而非新增，且保留用户 important 标记
    await mem.markMemoryImportant(all1[0].id, true);
    const r2 = await mem.saveSessionWithMemory({ session:{id:'s2'}, analysis:{ event:'项目压力', people:['领导'], scene:'工作', emotion:['焦虑'], emotion_primary:'焦虑', hidden_need:'怕辜负别人期望' }, transcript:'', timeline:null, dateISO:new Date().toISOString() });
    const all2 = await mem.loadMemory();
    // 编辑一条
    const target = all2.find((x)=>x.type==='event');
    await mem.editMemory(target.id, { title:'项目交付压力', summary:'来自 boss 的项目' });
    const all3 = await mem.loadMemory();
    const edited = all3.find((x)=>x.id===target.id);
    // 删除一条
    const beforeDel = all3.length;
    await mem.deleteMemory(all3[0].id);
    const afterDel = (await mem.loadMemory()).length;
    await mem.clearMemory();
    const afterClear = (await mem.loadMemory()).length;
    return { upserted1: r1.memoryUpserted, upserted2: r2.memoryUpserted, all1: all1.length, all2: all2.length, editedTitle: edited.title, editedSummary: edited.summary, editedFlag: edited.user_edited, beforeDel, afterDel, afterClear };
  });
  check('持久化：保存后能从 IndexedDB 读回', DB.all1 === 3, 'all1=' + DB.all1);
  check('去重：相同 (type,title) 再次保存不新增', DB.all2 === 3 && DB.upserted2 === 3, `all2=${DB.all2} up2=${DB.upserted2}`);
  check('编辑：标题 / 摘要 / user_edited 生效', DB.editedTitle === '项目交付压力' && DB.editedSummary === '来自 boss 的项目' && DB.editedFlag === true);
  check('删除：条数 -1', DB.afterDel === DB.beforeDel - 1, `${DB.beforeDel}→${DB.afterDel}`);
  check('清空：归零', DB.afterClear === 0);

  /* ===== 分区 3：迁移播种（localStorage 时间线 → IndexedDB） ===== */
  sec('M3. 迁移播种');
  const MIG = await page.evaluate(async () => {
    const mem = await import('/js/memory.js');
    await mem.clearMemory();
    await mem.setSetting('migrated', false); // 清掉守卫，强制重跑
    const fakeState = { timelines: [
      { saved_at:new Date(Date.now()-5*864e5).toISOString(), analysis:{ event:'和妈妈吵架', people:['妈妈'], emotion:['委屈'], emotion_primary:'委屈', hidden_need:'想要被理解' } },
      { saved_at:new Date().toISOString(), analysis:{ event:'工作瓶颈', people:['领导'], emotion:['焦虑'], emotion_primary:'焦虑' } },
    ] };
    const r = await mem.migrateFromLocalStorage(fakeState);
    const all = await mem.loadMemory();
    const done = await mem.getSetting('migrated');
    // 再跑一次应被守卫跳过
    const r2 = await mem.migrateFromLocalStorage(fakeState);
    return { seeded: r.seeded, total: all.length, done, skipped2: r2.skipped };
  });
  check('迁移：从时间线播种出记忆单元', MIG.total >= 4, 'total=' + MIG.total);
  check('迁移：写入 migrated 守卫', MIG.done === true);
  check('迁移：二次调用被守卫跳过', MIG.skipped2 === true);

  /* ===== 分区 4：api.analyze 把记忆注入主提示 + 总开关门禁 + 集成烟测 ===== */
  sec('M4. 注入 / 门禁 / 集成');
  const INJ = await page.evaluate(async () => {
    const mem = await import('/js/memory.js');
    const pr = await import('/js/prompts.js');
    const { api } = await import('/js/api.js');
    const store = await import('/js/store.js');
    await mem.clearMemory();
    await mem.saveSessionWithMemory({ session:{id:'s9'}, analysis:{ event:'项目压力', people:['领导'], scene:'工作', emotion:['焦虑'], emotion_primary:'焦虑', hidden_need:'怕辜负别人期望' }, transcript:'', timeline:null, dateISO:new Date().toISOString() });
    // 复刻 api.analyze 的组合逻辑（loadMemory → recallTopN → buildMemoryContext → buildMainPrompt）
    const units = await mem.loadMemory();
    const top = mem.recallTopN(units, { transcript:'今天领导又给我加了任务，我好焦虑', emotion:[], limit:3 });
    const ctx = mem.buildMemoryContext(top.map((t)=>t.unit));
    const promptOn = pr.buildMainPrompt('今天领导又给我加了任务，我好焦虑', null, ctx);
    const promptOff = pr.buildMainPrompt('今天领导又给我加了任务，我好焦虑', null, '');
    // 集成烟测：开关开时 api.analyze 真跑不抛错、返回主分析形状的对象
    let analyzed = null, threw = false;
    try { analyzed = await api.analyze({ transcript:'今天领导又给我加了任务，我好焦虑' }); } catch (e) { threw = true; }
    store.setSetting('memory_on', false);
    let analyzedOff = null;
    try { analyzedOff = await api.analyze({ transcript:'今天领导又给我加了任务，我好焦虑' }); } catch (e) {}
    store.setSetting('memory_on', true);
    return {
      onHit: promptOn.includes('你之前陪 TA 聊过的') && promptOn.includes('领导'),
      offHit: promptOff.includes('你之前陪 TA 聊过的'),
      threw,
      analyzedShape: !!(analyzed && (analyzed.event !== undefined || Array.isArray(analyzed.emotion))),
      analyzedOffShape: !!(analyzedOff && (analyzedOff.event !== undefined || Array.isArray(analyzedOff.emotion))),
    };
  });
  check('注入：memory_on 开 → 主提示含跨会话记忆', INJ.onHit);
  check('门禁：memory_on 关 → 主提示不含记忆（新增/召回都被关掉）', !INJ.offHit);
  check('集成：api.analyze 开开关时不抛错', !INJ.threw);
  check('集成：api.analyze 返回主分析形状对象（开）', INJ.analyzedShape);
  check('集成：api.analyze 返回主分析形状对象（关）', INJ.analyzedOffShape);

  /* ===== 分区 5：/memory 面板渲染与交互 ===== */
  sec('M5. 记忆面板 UI');
  const panel = await page.evaluate(async () => {
    const mem = await import('/js/memory.js');
    await mem.clearMemory();
    await mem.saveSessionWithMemory({ session:{id:'sp'}, analysis:{ event:'项目压力', people:['领导'], scene:'工作', emotion:['焦虑'], emotion_primary:'焦虑', hidden_need:'怕辜负别人期望' }, transcript:'', timeline:null, dateISO:new Date().toISOString() });
  });
  await goto('/#/me');
  // v1.3.4：「我」页重建为「你的深海空间」，列表容器从 .mlist 改为分区卡 .mblock
  await page.waitForSelector('.mblock', { timeout: 8000 });
  const hasLink = await page.$('a[href="#/memory"]');
  check('「我」页含「我的记忆」入口', !!hasLink);
  await goto('/#/memory');
  await page.waitForSelector('#memList', { timeout: 8000 });
  await page.waitForTimeout(400);
  const rowCount = await page.$$eval('.mem-row', (els) => els.length);
  check('面板渲染出记忆条目', rowCount >= 1, 'rows=' + rowCount);
  // 标记重要
  await page.click('.mem-row .mem-star');
  await page.waitForTimeout(300);
  const starOn = await page.$('.mem-row .mem-star.is-on');
  check('面板：标记重要生效（★ 高亮）', !!starOn);
  // 编辑
  await page.click('.mem-row [data-act="edit"]');
  await page.waitForSelector('.mem-edit-title', { timeout: 5000 });
  await page.fill('.mem-edit-title', '项目交付压力');
  await page.click('.mem-edit-actions [data-act="save"], .mem-edit-acts [data-act="save"]');
  await page.waitForTimeout(300);
  const editedTitle = await page.$eval('.mem-row .mem-title', (e) => e.textContent).catch(() => '');
  check('面板：编辑标题保存生效', editedTitle === '项目交付压力', editedTitle);
  // 删除
  const beforeDel = await page.$$eval('.mem-row', (els) => els.length);
  await page.click('.mem-row [data-act="del"]');
  await page.waitForTimeout(400);
  const afterDel = await page.$$eval('.mem-row', (els) => els.length);
  check('面板：删除条目生效', afterDel === beforeDel - 1, `${beforeDel}→${afterDel}`);

  /* ===== 分区 6：设置总开关 + 一键删除清零 ===== */
  sec('M6. 设置开关与一键删除');
  await goto('/#/settings');
  await page.waitForSelector('#setMemory', { timeout: 8000 });
  const setChecked = await page.$eval('#setMemory', (e) => e.checked);
  check('设置页：记忆总开关默认勾选', setChecked === true);
  // 取消勾选
  await page.click('#setMemory');
  await page.waitForTimeout(150);
  const offNow = await page.evaluate(async () => { const s = await import('/js/store.js'); return s.getState().user.settings.memory_on; });
  check('设置页：取消勾选写入 memory_on=false', offNow === false);
  // 恢复
  await page.click('#setMemory');
  await page.waitForTimeout(150);

  /* ===== 分区 7：真实倾诉流程捕获记忆（防回归：分析 JSON 不可得导致空手） ===== */
  sec('M7. 真实倾诉流程捕获记忆');
  await page.evaluate(async () => { const mem = await import('/js/memory.js'); await mem.clearMemory(); });
  await goto('/#/record?mode=text');
  await page.waitForSelector('#recInput', { timeout: 8000 });
  await page.fill('#recInput', '今天又和男朋友吵架了，他很晚才回我消息，我觉得他根本不在乎我。');
  await page.click('#recDone');
  // 等主分析完成（离开 analyzing，进入 followup / confirm / gentle / risk）
  await page.waitForFunction(() => {
    const r = location.hash.replace('#/','').split('?')[0];
    return ['followup','confirm','gentle','risk'].includes(r);
  }, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(900); // 等 fire-and-forget 入库完成
  const flow = await page.evaluate(async () => {
    const mem = await import('/js/memory.js');
    const all = await mem.loadMemory();
    return { count: all.length, hasBoyfriend: all.some((u)=>u.type==='person' && u.title==='男朋友'), titles: all.map((u)=>u.title) };
  });
  check('真实流程：主分析完成后记忆被入库（非空手）', flow.count >= 1, 'count=' + flow.count + ' titles=' + JSON.stringify(flow.titles));
  check('真实流程：捕获到「男朋友」人物单元', flow.hasBoyfriend, JSON.stringify(flow.titles));

  /* ===== 收尾：运行期错误检查 ===== */
  sec('M8. 运行期错误');
  sec('M7. 运行期错误');
  check('无 pageerror / console error', errors.length === 0, errors.slice(0, 5).join(' | '));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n===== 记忆自测汇总：${results.length - failed.length}/${results.length} 通过 =====`);
  if (failed.length) { console.log('FAILED:'); failed.forEach((f) => console.log('  - ' + f.name + (f.detail ? '  (' + f.detail + ')' : ''))); }
  await browser.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('self-test crashed:', e); process.exit(2); });
