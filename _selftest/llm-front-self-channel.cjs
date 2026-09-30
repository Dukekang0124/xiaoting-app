#!/usr/bin/env node
/**
 * 内部模型调度 · 前端接入真跑（浏览器内 import 真实模块）
 *
 * 为什么不能只做静态检查：
 *   js/llm.js 的改动全是「运行时分支」——通道优先级、404 回落、结构不符停用、冷却跳过。
 *   grep 只能证明代码写在那儿，证不了「挂了的后端不会把用户卡住」。
 *
 * 三条路径必须各自造桩（少一条就是漏一条降级分支）：
 *   A 后端在      → 走自建通道，channel='self'，providerName()='self'
 *   B 后端 404    → 优雅回落，state='down'，且失败原因说得清（self_channel_absent）
 *   C 结构不符    → 视为停用，不让脏数据穿过去
 *   D 冷却生效    → 停用后 60s 内不再重复打这个端点（不为坏后端每轮付一次往返）
 *
 * 用法（先起服务）：PORT=4173 STATS_KEY=selftest node server.cjs
 *   BASE=http://127.0.0.1:4173 node _selftest/llm-front-self-channel.cjs
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://127.0.0.1:4173';
let pass = 0, fail = 0;
const lines = [];
const ok = (c, n, e) => { if (c) { pass++; lines.push(`  ✅ ${n}`); } else { fail++; lines.push(`  ❌ ${n}${e ? '  ← ' + e : ''}`); } };

const KEY_FRAGS = ['c7de7465', 'sk-H6rL', '4vfH5GEJ', 'lcid_'];

(async () => {
  lines.push('==============================================');
  lines.push(' 内部模型调度 · 前端自通道真跑（真 Chrome）');
  lines.push(' BASE = ' + BASE);
  lines.push('==============================================');

  const browser = await chromium.launch({ channel: 'chrome' });

  /* ============ A 后端在：走自建通道 ============ */
  lines.push('');
  lines.push('A 后端已部署 —— 自建通道应当接管');
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message || e)));
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });

    const r = await page.evaluate(async () => {
      const m = await import('/js/llm.js');
      m.resetSelfChannel();
      const out = await m.call({ stage: 'main', system: '只回两个字。', user: '只回复两个字：收到' });
      return {
        out,
        provider: m.providerName(),
        real: m.isReal(),
        self: m.selfChannelState(),
        dbg: m.debug(),
      };
    });

    ok(errors.length === 0, '页面无 JS 异常', errors.join(' | '));
    ok(r.out && r.out.ok === true, 'call() 成功', 'got ok=' + (r.out && r.out.ok) + ' code=' + (r.out && r.out.code));
    ok(r.out.channel === 'self', "channel === 'self'（真正走的是自建通道）", 'got ' + r.out.channel);
    ok(!!r.out.model, '回包带 model', 'got ' + r.out.model);
    ok(r.provider === 'self', "providerName() === 'self'", 'got ' + r.provider);
    ok(r.real === true, 'isReal() === true', 'got ' + r.real);
    ok(r.self.state === 'up', "selfChannelState().state === 'up'", 'got ' + r.self.state);
    ok(r.self.model === r.out.model, '通道状态里的 model 与回包一致', r.self.model + ' vs ' + r.out.model);
    ok(r.dbg.selfChannel && r.dbg.selfChannel.state === 'up', 'debug() 能观测到自通道状态');

    const raw = JSON.stringify(r);
    ok(!KEY_FRAGS.some((f) => raw.includes(f)), '前端侧拿到的数据里不含任何密钥片段');

    lines.push(`     model=${r.out.model} provider=${r.provider} real=${r.real} degraded=${r.out.degraded}`);
    await ctx.close();
  }

  /* ============ B 后端 404：优雅回落 ============ */
  lines.push('');
  lines.push('B 后端不存在（/api/llm → 404）—— 必须优雅回落，不能卡住');
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    let hit = 0;
    await page.route('**/api/llm', (route) => {
      // 注意：路径精确匹配要放在通用规则之后注册（后注册优先），这里只有这一条，够用
      if (new URL(route.request().url()).pathname === '/api/llm') {
        hit++;
        return route.fulfill({ status: 404, body: 'not found', contentType: 'text/plain' });
      }
      return route.continue();
    });
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });

    const r = await page.evaluate(async () => {
      const m = await import('/js/llm.js');
      m.resetSelfChannel();
      const t0 = Date.now();
      const out = await m.call({ stage: 'main', system: '只回两个字。', user: '只回复两个字：收到' });
      const dt = Date.now() - t0;
      const self1 = m.selfChannelState();
      // 冷却验证：立刻再调一次，不应该再打一次 /api/llm
      const out2 = await m.call({ stage: 'main', system: '只回两个字。', user: '只回复两个字：收到' });
      return { out, dt, self1, out2, provider: m.providerName() };
    });

    ok(r.self1.state === 'down', "自通道标记为 'down'", 'got ' + r.self1.state);
    ok(r.self1.lastError && r.self1.lastError.code === 'self_channel_absent',
      "失败原因明确：self_channel_absent（不是含糊的 unknown）", 'got ' + JSON.stringify(r.self1.lastError));
    ok(r.out.channel !== 'self', "回包 channel 不是 'self'（已回落）", 'got ' + r.out.channel);
    ok(r.dt < 30000, `回落耗时可接受（${r.dt}ms）`, 'got ' + r.dt);
    lines.push(`     第一次调用 channel=${r.out.channel} code=${r.out.code} 耗时=${r.dt}ms`);
    lines.push(`     端点被访问次数=${hit}（冷却生效则第二次不该再加 1）`);
    ok(hit === 1, '冷却生效：停用后不再重复打这个端点', 'got hit=' + hit);
    await ctx.close();
  }

  /* ============ C 结构不符：视为停用 ============ */
  lines.push('');
  lines.push('C 后端返回结构不符契约（200 但没有 ok 布尔）—— 视为停用');
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.route('**/api/llm', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hello: 'not the contract' }) }));
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });

    const r = await page.evaluate(async () => {
      const m = await import('/js/llm.js');
      m.resetSelfChannel();
      const out = await m.call({ stage: 'main', system: '只回两个字。', user: '只回复两个字：收到' });
      return { out, self: m.selfChannelState() };
    });
    ok(r.self.state === 'down', "脏结构 → 通道停用", 'got ' + r.self.state);
    ok(r.self.lastError && r.self.lastError.code === 'self_channel_bad_response',
      "失败原因与「未部署」区分开：self_channel_bad_response", 'got ' + JSON.stringify(r.self.lastError));
    ok(r.out.channel !== 'self', "回包 channel 不是 'self'", 'got ' + r.out.channel);
    lines.push(`     state=${r.self.state} code=${r.self.lastError && r.self.lastError.code} channel=${r.out.channel}`);
    await ctx.close();
  }

  /* ============ D 真后端 + 真降级：前端能否看见 degraded ============ */
  lines.push('');
  lines.push('D 前端能否观测到「后端发生了降级」');
  {
    // 用 4175（降级配置，第一档必挂）来证：前端拿到的 degraded 应当为 true
    const DB = process.env.DEGRADE_BASE || '';
    if (!DB) {
      lines.push('     ⚠ 未提供 DEGRADE_BASE，跳过（用 DEGRADE_BASE=http://127.0.0.1:4175 可启用）');
    } else {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(DB + '/', { waitUntil: 'domcontentloaded' });
      const r = await page.evaluate(async () => {
        const m = await import('/js/llm.js');
        m.resetSelfChannel();
        const out = await m.call({ stage: 'main', system: '只回两个字。', user: '只回复两个字：收到' });
        return { out, self: m.selfChannelState(), dbg: m.debug() };
      });
      ok(r.out.ok === true, '降级后依然成功（用户无感）', 'ok=' + r.out.ok);
      ok(r.out.degraded === true, '前端能看见 degraded=true（可观测，不静默）', 'got ' + r.out.degraded);
      ok(r.self.degraded === true, 'selfChannelState().degraded === true');
      ok(Array.isArray(r.out.tried) && r.out.tried.length >= 2, '前端拿到完整尝试轨迹 tried[]', 'got ' + (r.out.tried || []).length);
      if (r.out.tried) for (const t of r.out.tried) lines.push(`       - [${t.provider}] ${t.model} ok=${t.ok} code=${t.code || '-'} ${t.ms}ms`);
      await ctx.close();
    }
  }

  await browser.close();

  lines.push('');
  lines.push('==============================================');
  lines.push(` 前端自通道真跑：${pass} 通过 / ${fail} 失败`);
  lines.push('==============================================');

  const out = lines.join('\n');
  console.log(out);
  fs.writeFileSync(path.join(__dirname, 'llm-front-self-channel.out.txt'), out, 'utf8');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('脚本自身崩溃：', e); process.exit(2); });
