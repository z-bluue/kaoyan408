/* ===========================================================
   多设备同步 —— 基于 GitHub Gist
   进度记录按 updated 时间戳取新；流水按 qid|ts 去重合并。
   =========================================================== */
import * as store from './store.js';

const API = 'https://api.github.com';
export const FILE_NAME = 'kaoyan408-progress.json';
export const GIST_DESC = '408 刷题进度（自动生成，勿手动编辑）';

async function gh(path, { method = 'GET', token, body } = {}) {
  let res;
  try {
    res = await fetch(API + path, {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error('网络请求失败，请检查手机网络是否能访问 GitHub');
  }

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j && j.message) msg += '：' + j.message; } catch (_) {}
    if (res.status === 401) msg += '（Token 无效或已过期）';
    if (res.status === 403) msg += '（权限不足，Token 需要 gist 权限；也可能是触发了限流）';
    if (res.status === 404) msg += '（找不到该 Gist，检查 ID 或换一个 Token）';
    throw new Error(msg);
  }
  return res.json();
}

/** 没有 gistId 时自动创建一个私有 Gist */
export async function ensureGist({ token, gistId }) {
  if (gistId) return gistId;
  const payload = await store.exportAll({ withSecrets: false });
  payload.updatedAt = Date.now();
  const j = await gh('/gists', {
    method: 'POST',
    token,
    body: {
      description: GIST_DESC,
      public: false,
      files: { [FILE_NAME]: { content: JSON.stringify(payload) } },
    },
  });
  return j.id;
}

async function readGist({ token, gistId }) {
  const j = await gh(`/gists/${gistId}`, { token });
  const f = j.files && (j.files[FILE_NAME] || Object.values(j.files)[0]);
  if (!f) return null;
  let content = f.content;
  if (f.truncated && f.raw_url) {
    const r = await fetch(f.raw_url, { headers: { 'Authorization': `Bearer ${token}` } });
    if (r.ok) content = await r.text();
  }
  if (!content) return null;
  try { return JSON.parse(content); }
  catch (_) { throw new Error('云端数据格式损坏，无法解析'); }
}

/** 从云端拉取并合并到本地 */
export async function pull({ token, gistId }) {
  const remote = await readGist({ token, gistId });
  if (!remote) return { empty: true, progress: 0, logs: 0 };
  const s = await store.importAll(remote, { merge: true });
  return { empty: false, ...s, remoteUpdatedAt: remote.exportedAt || null };
}

/** 把本地（合并后的）数据整体写回云端 */
export async function push({ token, gistId }) {
  const payload = await store.exportAll({ withSecrets: false });
  payload.updatedAt = Date.now();
  await gh(`/gists/${gistId}`, {
    method: 'PATCH',
    token,
    body: { files: { [FILE_NAME]: { content: JSON.stringify(payload) } } },
  });
  return { progress: payload.progress.length, logs: payload.logs.length };
}

/**
 * 双向同步：先拉取合并，再整体推回。
 * 这样任何一端都不会丢数据。
 */
export async function sync({ token, gistId, onStep }) {
  if (!token) throw new Error('请先填写 GitHub Token');
  if (onStep) onStep('检查 Gist…');
  const id = await ensureGist({ token, gistId });

  if (onStep) onStep('下载云端进度…');
  const p = await pull({ token, gistId: id });

  if (onStep) onStep('合并并上传…');
  const u = await push({ token, gistId: id });

  return { gistId: id, pulled: p, pushed: u };
}

/** 只上传 */
export async function pushOnly({ token, gistId, onStep }) {
  if (!token) throw new Error('请先填写 GitHub Token');
  const id = await ensureGist({ token, gistId });
  if (onStep) onStep('上传中…');
  const u = await push({ token, gistId: id });
  return { gistId: id, pushed: u };
}

/** 只下载 */
export async function pullOnly({ token, gistId, onStep }) {
  if (!token) throw new Error('请先填写 GitHub Token');
  if (!gistId) throw new Error('请先填写 Gist ID，或直接点"立即同步"自动创建');
  if (onStep) onStep('下载中…');
  const p = await pull({ token, gistId });
  return { gistId, pulled: p };
}

export default { ensureGist, pull, push, sync, pushOnly, pullOnly, FILE_NAME };
