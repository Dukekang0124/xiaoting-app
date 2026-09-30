// 墨小溟 · 跨会话记忆存储层（V1.1 地基 / app v1.3.0）
// 本地优先：全部数据在设备 IndexedDB，无账号、无云端同步（除非用户未来主动开启）。
// 与既有 localStorage 共存：本模块只负责「记忆地基」（sessions / memory / settings），
// 不替换 store.js 的 localStorage 持久化，避免一次性大改把已存时间线卡弄丢。
//
// 三张表：
//   sessions  —— 短期/中期记忆：每次倾诉一次会话（transcript + timeline + emotions + date）
//   memory    —— 中期+长期记忆：从每次会话结构化提取的「记忆单元」（人物/事件/心结/模式）
//   settings  —— 记忆开关与偏好（memory_on / silence / migrated 标记）
//
// 所有方法在 IndexedDB 不可用时（隐私模式 / 老浏览器）静默降级为 no-op，绝不抛错中断主流程。

const DB_NAME = 'xiaoting-memory';
const DB_VERSION = 1;

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('no-indexeddb')); return; }
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); }
    catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) {
        const s = db.createObjectStore('sessions', { keyPath: 'id' });
        s.createIndex('date', 'date', { unique: false });
      }
      if (!db.objectStoreNames.contains('memory')) {
        const m = db.createObjectStore('memory', { keyPath: 'id' });
        m.createIndex('type', 'type', { unique: false });
        m.createIndex('important', 'important', { unique: false });
        m.createIndex('last_recalled_at', 'last_recalled_at', { unique: false });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  // 失败时缓存一个永远 reject 的 promise 也没关系：调用方 catch 后降级。
  return _dbPromise;
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 通用写：put 一条。失败静默吞掉（记忆是增强项，绝不能因为写不进 IndexedDB 而崩主流程）。 */
export async function dbPut(store, value) {
  try {
    const db = await openDB();
    await reqToPromise(tx(db, store, 'readwrite').put(value));
    return true;
  } catch (e) { return false; }
}

export async function dbGet(store, key) {
  try {
    const db = await openDB();
    return await reqToPromise(tx(db, store, 'readonly').get(key));
  } catch (e) { return undefined; }
}

export async function dbGetAll(store) {
  try {
    const db = await openDB();
    return await reqToPromise(tx(db, store, 'readonly').getAll()) || [];
  } catch (e) { return []; }
}

export async function dbDelete(store, key) {
  try {
    const db = await openDB();
    await reqToPromise(tx(db, store, 'readwrite').delete(key));
    return true;
  } catch (e) { return false; }
}

export async function dbClear(store) {
  try {
    const db = await openDB();
    await reqToPromise(tx(db, store, 'readwrite').clear());
    return true;
  } catch (e) { return false; }
}

export async function dbCount(store) {
  try {
    const db = await openDB();
    return await reqToPromise(tx(db, store, 'readonly').count());
  } catch (e) { return 0; }
}

/** settings：key/value（value 任意 JSON 可序列化对象） */
export async function setSetting(key, value) { return dbPut('settings', { key, value }); }
export async function getSetting(key) {
  const row = await dbGet('settings', key);
  return row ? row.value : undefined;
}

/** 清空全部记忆（用户主动「清空全部记忆」）：sessions + memory，并保留 settings.migrated。 */
export async function clearAllMemory() {
  await dbClear('sessions');
  await dbClear('memory');
}

export { openDB };
