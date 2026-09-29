// 墨小溟 · hash 路由

/**
 * 解析当前 hash → { name, param, q }
 * 例：#/card/c_abc  → { name:'card', param:'c_abc', q:{} }
 *     #/record?mode=text → { name:'record', param:'', q:{mode:'text'} }
 */
export function parseHash(hash) {
  const h = (hash || location.hash || '#/say').replace(/^#\/?/, '');
  const [path, query] = h.split('?');
  const parts = path.split('/').filter(Boolean);
  const name = parts[0] || 'say';
  const param = parts[1] ? decodeURIComponent(parts[1]) : '';
  const q = {};
  if (query) {
    query.split('&').forEach((kv) => {
      const [k, v] = kv.split('=');
      if (k) q[k] = decodeURIComponent(v || '');
    });
  }
  return { name, param, q };
}

/** 跳转 */
export function go(path) {
  const target = path.startsWith('#') ? path : '#/' + path;
  if (location.hash === target) {
    // 相同 hash 不触发 hashchange，手动派发
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    location.hash = target;
  }
}

/** 监听路由变化 */
export function onChange(fn) {
  window.addEventListener('hashchange', () => fn(parseHash()));
}
