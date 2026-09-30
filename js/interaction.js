// 墨小溟 · IP 点击轻互动控制器（v1.3.1）
// 职责：把「IP 本体」上的指针事件翻译成 单击/双击/三连击/连点4+ 与 长按 语义。
// 纯逻辑 + 事件绑定，不直接操作业务 store；通过回调交由 app.js 决定动画与气泡。
// 防误触：仅绑定在 IP 本身上；拖动/滚动会取消；2s 无点击清零；连点 4+ 后短时间冷却。

export const TAP_CONF = {
  windowMs: 2000,     // 连击窗口：超过则计数清零
  longPressMs: 800,   // 长按阈值
  overCooldownMs: 5000, // 连点 4+ 软反馈后的冷却
  moveTolPx: 12,      // 指针位移容差，超过视为拖动（不触发点击/长按）
};

/**
 * 绑定 IP 轻互动。
 * @param {object} p
 *   el           触发元素（IP 本体容器）
 *   isDisabled   () => boolean，返回 true 时本次交互整体失效（对话中/回复中/高危弹窗/总开关关）
 *   onTap        (count:1|2|3|4) => void  count>=4 表示连点4+
 *   onLongPress  () => void
 *   onTapAway    (event) => void  可选：点击「IP 之外」的空白处（用于退出安静模式）
 *   awayEl       可选：判定「空白处」的更大范围元素（默认 document）
 * @returns {{ destroy():void, reset():void, count():number }}
 */
export function createIpInteraction({ el, isDisabled, onTap, onLongPress, onTapAway, awayEl }) {
  let count = 0;
  let lastTapAt = 0;
  let resetTimer = null;
  let longTimer = null;
  let longFired = false;
  let cooldownUntil = 0;
  let downX = 0, downY = 0, downAt = 0;
  // v1.3.1 修补：长按触发后会重渲染（换掉 DOM），原元素的 pointerdown 目标已消失，
  // 而随后的 pointerup 会落到新元素上 —— 若不过滤，就会凭空多算一次「单击」，
  // 表现为「安静模式首击被识别成第 2 次点击」。故只认「有成对 pointerdown」的抬起。
  let downSeen = false;

  const clearReset = () => { if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; } };
  const clearLong = () => { if (longTimer) { clearTimeout(longTimer); longTimer = null; } };
  const disabled = () => (typeof isDisabled === 'function' ? !!isDisabled() : false);

  function onDown(e) {
    downSeen = true;
    if (disabled()) return;
    longFired = false;
    downAt = Date.now();
    downX = e.clientX || 0; downY = e.clientY || 0;
    clearLong();
    longTimer = setTimeout(() => {
      longFired = true;
      if (typeof onLongPress === 'function') onLongPress();
    }, TAP_CONF.longPressMs);
  }

  function onMove(e) {
    if (longFired || !longTimer) return;
    const dx = Math.abs((e.clientX || 0) - downX);
    const dy = Math.abs((e.clientY || 0) - downY);
    if (dx > TAP_CONF.moveTolPx || dy > TAP_CONF.moveTolPx) { clearLong(); }
  }

  function onUp() {
    if (!downSeen) return;      // 没有配对的 pointerdown ⇒ 不是一次真实点击（如在别处按下的抬起）
    downSeen = false;
    if (disabled()) { clearLong(); return; }
    clearLong();
    if (longFired) { longFired = false; return; } // 长按已触发，不再算点击
    const now = Date.now();
    if (now < cooldownUntil) return;              // 软反馈冷却期内不再触发
    if (now - lastTapAt > TAP_CONF.windowMs) count = 0;
    count += 1;
    lastTapAt = now;
    if (count >= 4) {
      if (typeof onTap === 'function') onTap(4);
      cooldownUntil = now + TAP_CONF.overCooldownMs;
      count = 0;
      clearReset();
      return;
    }
    if (typeof onTap === 'function') onTap(count);
    clearReset();
    resetTimer = setTimeout(() => { count = 0; }, TAP_CONF.windowMs);
  }

  function onCancel() { downSeen = false; clearLong(); longFired = false; }

  // 空白处点击（退出安静模式用）：不在 IP 元素内才触发
  function onDocDown(e) {
    if (typeof onTapAway !== 'function') return;
    if (el && el.contains(e.target)) return;
    onTapAway(e);
  }

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onCancel);
  el.addEventListener('pointerleave', onCancel);
  const awayTarget = awayEl || (typeof document !== 'undefined' ? document : null);
  if (awayTarget && typeof onTapAway === 'function') awayTarget.addEventListener('pointerdown', onDocDown, true);

  return {
    destroy() {
      clearReset(); clearLong();
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onCancel);
      el.removeEventListener('pointerleave', onCancel);
      if (awayTarget && typeof onTapAway === 'function') awayTarget.removeEventListener('pointerdown', onDocDown, true);
    },
    reset() { count = 0; clearReset(); clearLong(); longFired = false; cooldownUntil = 0; },
    count() { return count; },
  };
}

/** 点击次数 → 动画类名（普通模式与安静模式共用） */
export function tapAnimClass(count) {
  if (count <= 1) return 'ip-tap1';
  if (count === 2) return 'ip-tap2';
  if (count === 3) return 'ip-tap3';
  return 'ip-tap-over';
}

export const __test__ = { TAP_CONF, createIpInteraction, tapAnimClass };
