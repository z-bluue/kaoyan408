/* ===========================================================
   题库：加载 / 缓存 / 从 GitHub 自动更新
   =========================================================== */
import * as store from './store.js';

const LOCAL_DATA = './data/';
export const BANK_MANIFEST_KEY = 'bankManifest';

/* ---------------- 网络 ---------------- */
export async function fetchJSON(url, { timeout = 15000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('请求超时');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- 版本比较 ---------------- */
export function cmpVersion(a, b) {
  if (a === b) return 0;
  const pa = String(a ?? '0').split(/[.\-_]/);
  const pb = String(b ?? '0').split(/[.\-_]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0', y = pb[i] ?? '0';
    const nx = Number(x), ny = Number(y);
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx > ny ? 1 : -1;
    } else {
      const c = String(x).localeCompare(String(y));
      if (c) return c > 0 ? 1 : -1;
    }
  }
  return 0;
}

/* ---------------- 规范化 ---------------- */
export function buildSubject(raw, sm, warnings = []) {
  const id = raw.id || sm.id;
  const name = sm.name || raw.name || id;
  const seen = new Set();
  const questions = [];
  for (const q of raw.questions || []) {
    const n = normalizeQuestion(q, id, name, warnings);
    if (!n) continue;
    if (seen.has(n.id)) { warnings.push(`重复题号 ${n.id}，已跳过`); continue; }
    seen.add(n.id);
    questions.push(n);
  }
  return { id, name, version: raw.version || raw.generated || '0', questions, fetchedAt: Date.now() };
}

export function normalizeQuestion(q, sid, sname, warnings = []) {
  if (!q || !q.id || !q.stem) { warnings.push(`题号为 ${q && q.id ? q.id : '(空)'} 的题目缺少题干，已跳过`); return null; }

  const type = q.type || 'single';
  let options = q.options;
  if (type === 'judge' && !options) options = [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }];
  if ((type === 'single' || type === 'multi') && (!Array.isArray(options) || options.length < 2)) {
    warnings.push(`${q.id} 选项缺失，已跳过`); return null;
  }

  let answer = q.answer;
  if (answer == null) { warnings.push(`${q.id} 缺少答案，已跳过`); return null; }
  if (!Array.isArray(answer)) answer = [answer];
  answer = answer.map(a => String(a).trim().toUpperCase());

  if (!q.explain) warnings.push(`${q.id} 缺少解析`);

  return {
    id: String(q.id),
    subject: sid,
    subjectName: sname,
    chapter: q.chapter || '未分类',
    topics: Array.isArray(q.topics) ? q.topics : (q.topics ? [q.topics] : []),
    type,
    difficulty: Number(q.difficulty) || 2,
    stem: String(q.stem),
    options: options ? options.map(o => ({ key: String(o.key).toUpperCase(), text: String(o.text) })) : null,
    answer,
    accept: Array.isArray(q.accept) ? q.accept.map(String) : (q.accept ? [String(q.accept)] : []),
    explain: q.explain || '',
    source: q.source || '',
  };
}

/* ---------------- 本地题库 ---------------- */
export async function loadSubjectsMeta() {
  const raw = await fetchJSON(LOCAL_DATA + 'subjects.json');
  return raw.subjects || [];
}

/**
 * 加载全部题库。
 * 优先使用 IndexedDB 缓存，缺失时才回源 ./data，保证离线可用。
 */
export async function loadBank(subjectsMeta, { force = false } = {}) {
  const warnings = [];
  const cached = new Map((await store.getAll('bank')).map(r => [r.id, r]));
  const subjects = [];
  const questions = [];
  const byId = new Map();

  for (const sm of subjectsMeta) {
    let rec = cached.get(sm.id);
    const stale = force || !rec || !Array.isArray(rec.questions) || !rec.questions.length;
    if (stale) {
      try {
        const raw = await fetchJSON(`${LOCAL_DATA}${sm.id}.json`);
        rec = buildSubject(raw, sm, warnings);
        await store.put('bank', rec);
      } catch (e) {
        if (rec) {
          warnings.push(`${sm.name}：更新失败，使用缓存版本（${e.message}）`);
        } else {
          warnings.push(`${sm.name}：加载失败（${e.message}）`);
          rec = { id: sm.id, name: sm.name, version: '0', questions: [] };
        }
      }
    }
    subjects.push(rec);
    for (const q of rec.questions) {
      if (byId.has(q.id)) { warnings.push(`跨科目重复题号 ${q.id}`); continue; }
      byId.set(q.id, q);
      questions.push(q);
    }
  }
  return { subjects, questions, byId, warnings };
}

/** 丢弃缓存，重新从 ./data 抓取 */
export async function reloadLocal(subjectsMeta) {
  await store.clear('bank');
  await store.metaSet(BANK_MANIFEST_KEY, null);
  return loadBank(subjectsMeta, { force: true });
}

/* ---------------- 远程更新 ---------------- */
export function buildBases({ repo, branch = 'main', mirror = 'jsdelivr' } = {}) {
  if (!repo) return [];
  const clean = String(repo)
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');
  if (!/^[^/\s]+\/[^/\s]+$/.test(clean)) return [];
  const branches = [branch, 'main', 'master'].filter((v, i, a) => v && a.indexOf(v) === i);
  const out = [];
  for (const br of branches) {
    const raw = `https://raw.githubusercontent.com/${clean}/${br}/`;
    const cdn = `https://cdn.jsdelivr.net/gh/${clean}@${br}/`;
    if (mirror === 'raw') out.push(raw, cdn); else out.push(cdn, raw);
  }
  return out;
}

/** 探测更新源，返回可用 base 与远程清单 */
export async function checkUpdate(settings) {
  const bases = buildBases(settings);
  if (!bases.length) throw new Error('请先填写 GitHub 仓库，格式 owner/repo');
  let lastErr = null;
  for (const base of bases) {
    try {
      const manifest = await fetchJSON(`${base}data/bank-manifest.json?t=${Date.now()}`);
      if (!manifest || !manifest.subjects) throw new Error('清单格式不正确');
      return { base, manifest };
    } catch (e) { lastErr = e; }
  }
  throw new Error('无法连接更新源：' + (lastErr ? lastErr.message : '网络错误'));
}

/** 应用更新，只下载版本变高的科目 */
export async function applyUpdate(base, manifest, { onProgress } = {}) {
  const local = await store.metaGet(BANK_MANIFEST_KEY, null);
  const changed = [];
  for (const sid of Object.keys(manifest.subjects || {})) {
    const info = manifest.subjects[sid];
    const lv = local && local.subjects && local.subjects[sid] ? local.subjects[sid].version : null;
    const rv = info.version || manifest.version;
    if (!lv || cmpVersion(rv, lv) > 0) changed.push(sid);
  }
  if (!changed.length) return { changed: [], added: 0 };

  let added = 0;
  for (let i = 0; i < changed.length; i++) {
    const sid = changed[i];
    if (onProgress) onProgress(i, changed.length, sid);
    const file = (manifest.subjects[sid] && manifest.subjects[sid].file) || `${sid}.json`;
    const raw = await fetchJSON(`${base}data/${file}?t=${Date.now()}`, { timeout: 45000 });
    const rec = buildSubject(raw, { id: sid, name: raw.name || sid });
    const old = await store.get('bank', sid);
    added += Math.max(0, rec.questions.length - ((old && old.questions && old.questions.length) || 0));
    await store.put('bank', rec);
  }
  await store.metaSet(BANK_MANIFEST_KEY, manifest);
  return { changed, added };
}

export default {
  fetchJSON, cmpVersion, loadSubjectsMeta, loadBank, reloadLocal,
  buildBases, checkUpdate, applyUpdate, buildSubject, normalizeQuestion, BANK_MANIFEST_KEY,
};
