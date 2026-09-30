// 墨小溟 · 链路诊断日志（v1.1.3）
//
// 为什么要有这个模块：
//   之前排查「AI 到底有没有真的跑」只能靠猜 —— 前端转圈是真的在等模型，还是只是在演？
//   没有任何一处留下「麦克风拿到多少字节 / ASR 用了多久 / 安全识别用的哪个模型 / 主分析返回了什么 JSON」
//   的客观证据，于是真机一次失败就得靠猜根因。
//   这个模块把整条链路的每一步都写成带时间戳的日志，可在「设置 → 链路诊断」页看到，
//   可一键复制/导出，也会打到 console（前缀 [墨小溟·diag]），用 adb logcat 或远程调试能直接抓。
//
// 三条纪律：
//   1. 永不抛错、永不阻塞业务 —— 日志写失败最多就是没日志，绝不能让「记日志」把主流程搞挂。
//   2. 只记事实，不记推断 —— 字段里是什么就写什么，不做任何美化。
//   3. 隐私优先 —— 用户说的话默认只记前 N 字（可关），且只存在本机 localStorage，不上传。

const KEY = 'xiaoting:diag';
const MAX = 400;          // 环形上限：再长也没人看，还占 localStorage
const MAX_TEXT = 160;     // 单条 detail 里的文本截断长度
const MAX_RAW = 600;      // 模型原始返回截断长度

let seq = 0;
let t0 = Date.now();
let buf = [];
let env = {};

function now() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function clip(v, n) {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    if (s == null) return '';
    return s.length > n ? s.slice(0, n) + `…(+${s.length - n})` : s;
  } catch (e) { return ''; }
}

/** 记录一条。返回自增序号，供 end() 补记收尾。 */
export function mark(stage, event, patch = {}) {
  try {
    const e = {
      seq: ++seq,
      ts: now(),
      dt: Date.now() - t0,          // 距本次会话开始的毫秒数
      t: Date.now(),
      stage: String(stage || ''),
      event: String(event || ''),
      ok: patch && typeof patch.ok === 'boolean' ? patch.ok : null,
      ms: typeof patch.ms === 'number' ? Math.round(patch.ms) : null,
      model: patch.model || '',
      code: patch.code || '',
      detail: clip(patch.detail != null ? patch.detail : '', MAX_TEXT),
      raw: patch.raw != null ? clip(patch.raw, MAX_RAW) : '',
    };
    buf.push(e);
    if (buf.length > MAX) buf.splice(0, buf.length - MAX);
    persist();
    // 控制台同步输出一份：真机上没有 UI 时用 adb logcat 也能抓到完整链路
    try {
      const tag = e.ok === true ? 'OK  ' : e.ok === false ? 'FAIL' : '    ';
      console.info(`[墨小溟·diag] ${e.ts} +${String(e.dt).padStart(6)}ms ${tag} ${e.stage}/${e.event}` +
        `${e.ms != null ? ` ${e.ms}ms` : ''}${e.model ? ` model=${e.model}` : ''}${e.code ? ` code=${e.code}` : ''}` +
        `${e.detail ? ` | ${e.detail}` : ''}`);
    } catch (err) { /* 控制台也别出事 */ }
    return e.seq;
  } catch (err) {
    return 0;
  }
}

/** 阶段开始：返回 seq，交给 end() 结算耗时 */
export function begin(stage, event, patch = {}) {
  return mark(stage, event, patch);
}

/**
 * 阶段结束：把耗时、成败、模型、原始返回补记到 begin() 那一条上。
 * 为什么不新起一条：一条 = 一个阶段的完整生命周期，读日志时不用上下配对。
 */
export function end(seqId, patch = {}) {
  try {
    const e = buf.find((x) => x.seq === seqId);
    if (!e) return mark(patch.stage || 'diag', patch.event || 'end', patch);
    e.ms = typeof patch.ms === 'number' ? Math.round(patch.ms) : Math.round(Date.now() - e.t);
    if (typeof patch.ok === 'boolean') e.ok = patch.ok;
    if (patch.model) e.model = patch.model;
    if (patch.code) e.code = patch.code;
    if (patch.detail != null) e.detail = clip(patch.detail, MAX_TEXT);
    if (patch.raw != null) e.raw = clip(patch.raw, MAX_RAW);
    e.event = patch.event || e.event;
    persist();
    try {
      const tag = e.ok === true ? 'OK  ' : e.ok === false ? 'FAIL' : '    ';
      console.info(`[墨小溟·diag] ${e.ts} +${String(e.dt).padStart(6)}ms ${tag} ${e.stage}/${e.event} ` +
        `${e.ms}ms${e.model ? ` model=${e.model}` : ''}${e.code ? ` code=${e.code}` : ''}${e.detail ? ` | ${e.detail}` : ''}`);
    } catch (err) { /* ignore */ }
    return e;
  } catch (err) {
    return null;
  }
}

/** 一次性事件（没有开始/结束配对的），等价于 mark */
export function note(stage, event, patch = {}) { return mark(stage, event, patch); }

/** 环境快照：跑链路前先把「我是谁、什么环境」记下来，否则日志离开本机就没有上下文 */
export function snapshot(info = {}) {
  try {
    env = {
      ...env,
      ...info,
      appVersion: (typeof window !== 'undefined' && window.APP_VERSION) || '',
      ua: (typeof navigator !== 'undefined' && navigator.userAgent) || '',
      origin: (typeof location !== 'undefined' && location.origin) || '',
      online: typeof navigator !== 'undefined' ? navigator.onLine : null,
      lang: (typeof navigator !== 'undefined' && navigator.language) || '',
      at: now(),
    };
    persist();
  } catch (e) { /* ignore */ }
  return env;
}

export function environment() { return { ...env }; }

/* ---------------- 读取与导出 ---------------- */

export function entries() { return buf.slice(); }

export function clear() {
  buf = [];
  seq = 0;
  t0 = Date.now();
  persist();
  return true;
}

/** 人类可读的多行文本（UI 展示 / 复制 / 导出都用它） */
export function text() {
  const lines = [];
  lines.push('墨小溟 · 链路诊断日志');
  lines.push(`生成时间：${now()}`);
  if (env && env.at) {
    lines.push(`应用版本：${env.appVersion || '-'}    平台：${env.platform || '-'}    网络：${env.online === false ? '离线' : '在线'}`);
    lines.push(`页面源：${env.origin || '-'}`);
  }
  lines.push('');
  for (const e of buf) {
    const tag = e.ok === true ? '[OK]  ' : e.ok === false ? '[FAIL]' : '[ -- ]';
    const head = `${tag} ${e.ts}  +${String(e.dt).padStart(6)}ms  ${e.stage}/${e.event}`;
    const mid = `      ${e.ms != null ? e.ms + 'ms' : '-'}${e.model ? `  model=${e.model}` : ''}${e.code ? `  code=${e.code}` : ''}`;
    lines.push(head);
    lines.push(mid);
    if (e.detail) lines.push(`      ${e.detail}`);
    if (e.raw) lines.push(`      raw: ${e.raw}`);
  }
  return lines.join('\n');
}

export function json() {
  return JSON.stringify({ generatedAt: now(), env, entries: buf }, null, 2);
}

/** 一次会话的汇总：各阶段耗时与成败，一眼看出链路通没通 */
export function summary() {
  const byStage = {};
  for (const e of buf) {
    if (e.ms == null) continue;
    const k = e.stage;
    byStage[k] = byStage[k] || { stage: k, calls: 0, ok: 0, fail: 0, ms: 0, maxMs: 0, models: {} };
    const s = byStage[k];
    s.calls++;
    if (e.ok === true) s.ok++;
    if (e.ok === false) s.fail++;
    s.ms += e.ms;
    if (e.ms > s.maxMs) s.maxMs = e.ms;
    if (e.model) s.models[e.model] = (s.models[e.model] || 0) + 1;
  }
  return Object.values(byStage);
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify({ seq, t0, env, buf: buf.slice(-120) }));
  } catch (e) { /* 配额满 / 隐私模式：忽略 */ }
}

/** 页面启动时恢复上一次会话的日志，方便「复现完了再看」 */
export function restore() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return false;
    const j = JSON.parse(raw);
    if (!j || !Array.isArray(j.buf)) return false;
    buf = j.buf;
    seq = j.seq || buf.length;
    // 🔴 t0（本次会话起点）**故意不恢复**：沿用旧会话的起点会让新日志的 dt 变成"跨了多少小时"。
    //   每条日志自带绝对时间戳 t，历史时间并没有丢。恢复 buf，但计时重新开始。
    env = j.env || {};
    return buf.length > 0;
  } catch (e) {
    return false;
  }
}

export default { mark, begin, end, note, snapshot, environment, entries, clear, text, json, summary, restore };
