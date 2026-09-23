/* ===========================================================
   IndexedDB 存储层
   stores:
     bank     题库缓存      key: 科目 id
     progress 每题学习状态  key: 题 id
     logs     答题流水      autoIncrement（统计的唯一数据源，便于多设备合并）
     meta     杂项 kv
   =========================================================== */

const DB_NAME = 'kaoyan408';
const DB_VERSION = 2;   // v2：新增 ai 仓库（AI 生成的题目）

/** 这些 meta 键只留本机，不参与云同步（凭据/缓存） */
const LOCAL_ONLY_META = new Set([
  'settings', 'gistId', 'bankManifest', 'lastUpdateCheck', 'deviceId', 'aiAutoState',
]);

let _dbp = null;

function openDB() {
  if (_dbp) return _dbp;
  _dbp = new Promise((resolve, reject) => {
    if (!self.indexedDB) return reject(new Error('当前浏览器不支持 IndexedDB'));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('bank')) db.createObjectStore('bank', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('progress')) {
        const s = db.createObjectStore('progress', { keyPath: 'id' });
        s.createIndex('due', 'due');
      }
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      // v2 新增：AI 生成的题目（keyPath: id）
      if (!db.objectStoreNames.contains('ai')) db.createObjectStore('ai', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('logs')) {
        const s = db.createObjectStore('logs', { keyPath: 'id', autoIncrement: true });
        s.createIndex('qid', 'qid');
        s.createIndex('ts', 'ts');
        s.createIndex('k', 'k');   // 去重键 = qid|ts，用于多设备合并
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
    req.onblocked = () => reject(new Error('数据库被其它标签页占用，请关闭其它页面'));
  });
  return _dbp;
}

function run(storeNames, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    const stores = names.length === 1 ? tx.objectStore(names[0]) : names.map(n => tx.objectStore(n));
    let out;
    try {
      out = fn(stores, tx);
    } catch (e) {
      try { tx.abort(); } catch (_) {}
      return reject(e);
    }
    tx.oncomplete = () => resolve(out && out.__val !== undefined ? out.__val : out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.abort_error || tx.error || new Error('事务被中止'));
  }));
}

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/* ------------ 基础操作 ------------ */
export const get = (store, key) => run(store, 'readonly', s => req(s.get(key)));
export const getAll = (store) => run(store, 'readonly', s => req(s.getAll()));
export const allKeys = (store) => run(store, 'readonly', s => req(s.getAllKeys()));
export const put = (store, val, key) => run(store, 'readwrite', s => req(key === undefined ? s.put(val) : s.put(val, key)));
export const del = (store, key) => run(store, 'readwrite', s => req(s.delete(key)));
export const clear = (store) => run(store, 'readwrite', s => req(s.clear()));
export const count = (store) => run(store, 'readonly', s => req(s.count()));

/** 批量写入：array of values（keyPath 模式） */
export function bulkPut(store, values) {
  if (!values || !values.length) return Promise.resolve(0);
  return run(store, 'readwrite', s => {
    for (const v of values) s.put(v);
    return { __val: values.length };
  });
}

/** 批量删除 */
export function bulkDelete(store, keys) {
  if (!keys || !keys.length) return Promise.resolve(0);
  return run(store, 'readwrite', s => {
    for (const k of keys) s.delete(k);
    return { __val: keys.length };
  });
}

/* ------------ 元数据 ------------ */
export const metaGet = (key, dflt = null) => get('meta', key).then(v => (v === undefined || v === null ? dflt : v));
export const metaSet = (key, val) => put('meta', val, key);

/* ------------ 流水（带索引查询） ------------ */
export function logsSince(ts) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const out = [];
    const tx = db.transaction('logs', 'readonly');
    const idx = tx.objectStore('logs').index('ts');
    const r = idx.openCursor(IDBKeyRange.lowerBound(ts));
    r.onsuccess = () => {
      const c = r.result;
      if (c) { out.push(c.value); c.continue(); } else resolve(out);
    };
    r.onerror = () => reject(r.error);
  }));
}

/** 删除某题的全部流水（重置该题时用） */
export function deleteLogsByQid(qid) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction('logs', 'readwrite');
    const r = tx.objectStore('logs').index('qid').openCursor(IDBKeyRange.only(qid));
    let n = 0;
    r.onsuccess = () => { const c = r.result; if (c) { c.delete(); n++; c.continue(); } else resolve(n); };
    r.onerror = () => reject(r.error);
  }));
}

/** 只保留最近 n 条流水，防止无限增长 */
export async function trimLogs(keep = 30000) {
  const n = await count('logs');
  if (n <= keep) return 0;
  return openDB().then(db => new Promise((resolve, reject) => {
    const drop = n - keep;
    let removed = 0;
    const tx = db.transaction('logs', 'readwrite');
    const r = tx.objectStore('logs').openCursor();
    r.onsuccess = () => {
      const c = r.result;
      if (!c || removed >= drop) { resolve(removed); return; }
      c.delete();
      removed++;
      c.continue();
    };
    r.onerror = () => reject(r.error);
  }));
}

/* ------------ AI 题库 ------------ */
export const aiAll = () => getAll('ai');
export const aiPut = (q) => put('ai', q);
export const aiDelete = (id) => del('ai', id);
export const aiClear = () => clear('ai');
export const aiCount = () => count('ai');

/* ------------ 备份 / 恢复 ------------ */
/** 完整导出；withSecrets=false 时剔除凭据类字段 */
export async function exportAll({ withSecrets = true, maxLogs = 30000 } = {}) {
  const [progress, meta, logs, ai] = await Promise.all([
    getAll('progress'), readAllMeta(), getAll('logs'), getAll('ai'),
  ]);
  if (!withSecrets) for (const k of LOCAL_ONLY_META) delete meta[k];
  const kept = logs.length > maxLogs ? logs.slice(logs.length - maxLogs) : logs;
  return {
    format: 'kaoyan408',
    version: 1,
    exportedAt: Date.now(),
    progress,
    meta,
    ai,
    logs: kept.map(compactLog),
  };
}

/** 压缩流水字段，减小同步体积 */
export function compactLog(l) {
  return { k: l.k, q: l.qid, t: l.ts, c: l.correct ? 1 : 0, m: l.ms | 0, s: l.subject, ch: l.chapter, md: l.mode };
}

export function expandLog(c) {
  return { k: c.k, qid: c.q, ts: c.t, correct: !!c.c, ms: c.m, subject: c.s, chapter: c.ch, mode: c.md };
}

async function readAllMeta() {
  const keys = await allKeys('meta');
  const out = {};
  for (const k of keys) out[k] = await get('meta', k);
  return out;
}

export async function importAll(payload, { merge = true } = {}) {
  const stats = { progress: 0, logs: 0, meta: 0, ai: 0 };
  if (!payload) return stats;

  if (Array.isArray(payload.progress)) {
    const existing = merge ? new Map((await getAll('progress')).map(r => [r.id, r])) : new Map();
    const rows = [];
    for (const inc of payload.progress) {
      if (!inc || !inc.id) continue;
      const cur = existing.get(inc.id);
      if (!cur || (inc.updated || 0) > (cur.updated || 0)) rows.push(inc);
    }
    await bulkPut('progress', rows);
    stats.progress = rows.length;
  }

  if (Array.isArray(payload.logs)) {
    const known = new Set(merge ? (await getAll('logs')).map(l => l.k) : []);
    const rows = [];
    for (const raw of payload.logs) {
      if (!raw) continue;
      const l = raw.k ? expandLog(raw) : (raw.qid ? { ...raw } : null);
      if (!l || !l.qid) continue;
      if (!l.k) l.k = `${l.qid}|${l.ts}`;
      if (known.has(l.k)) continue;   // 同一设备同一秒只算一次，跨设备也不重复
      known.add(l.k);
      delete l.id;
      rows.push(l);
    }
    await bulkPut('logs', rows);
    stats.logs = rows.length;
  }

  if (payload.meta && merge) {
    for (const [k, v] of Object.entries(payload.meta)) {
      if (LOCAL_ONLY_META.has(k)) continue;
      await metaSet(k, v); stats.meta++;
    }
  }

  if (Array.isArray(payload.ai)) {
    const known = new Set(merge ? await allKeys('ai') : []);
    const rows = payload.ai.filter(q => q && q.id && !known.has(q.id));
    await bulkPut('ai', rows);
    stats.ai = rows.length;
  }

  return stats;
}

/** 清空所有学习数据（保留题库缓存与设置） */
export async function resetProgress() {
  await Promise.all([clear('progress'), clear('logs')]);
}

export default {
  get, getAll, allKeys, put, del, clear, count, bulkPut, bulkDelete,
  metaGet, metaSet, logsSince, deleteLogsByQid, trimLogs,
  aiAll, aiPut, aiDelete, aiClear, aiCount,
  exportAll, importAll, resetProgress, compactLog, expandLog,
};
