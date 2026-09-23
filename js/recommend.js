/* ===========================================================
   薄弱知识点分析 + 根据错题推新题
   =========================================================== */
import { isMastered } from './srs.js';

/**
 * 统计每个知识点的情况。
 * weak  = max(0, 错次 - 0.5 × 对次)   直观理解：错得比对得多才叫薄弱
 * score = weak / √出现题数           做过的题越少，分数越"不可信"，所以除以 √n 收敛
 */
export function topicStats(questions, progressMap) {
  const m = new Map();
  for (const q of questions) {
    const p = progressMap.get(q.id);
    if (!p || !p.reps) continue;
    const wrong = p.wrongCount || 0;
    const right = p.rightCount || 0;
    for (const t of q.topics || []) {
      let e = m.get(t);
      if (!e) { e = { topic: t, seen: 0, wrong: 0, right: 0, weak: 0, score: 0 }; m.set(t, e); }
      e.seen++;
      e.wrong += wrong;
      e.right += right;
    }
  }
  for (const e of m.values()) {
    e.weak = Math.max(0, e.wrong - 0.5 * e.right);
    e.score = e.seen > 0 ? e.weak / Math.sqrt(e.seen) : 0;
  }
  return m;
}

/** 最薄弱的知识点列表 */
export function weakTopics(questions, progressMap, { limit = 12, minWeak = 0.5 } = {}) {
  const stats = topicStats(questions, progressMap);
  return [...stats.values()]
    .filter(e => e.weak >= minWeak)
    .sort((a, b) => b.score - a.score || b.wrong - a.wrong)
    .slice(0, limit);
}

/** 错题本条目 */
export function wrongQuestions(questions, progressMap, { onlyUnmastered = true, subjects = null, chapters = null } = {}) {
  const out = [];
  for (const q of questions) {
    const p = progressMap.get(q.id);
    if (!p || !p.wrongCount) continue;
    if (onlyUnmastered && isMastered(p)) continue;
    if (subjects && subjects.size && !subjects.has(q.subject)) continue;
    if (chapters && chapters.size && !chapters.has(q.chapter)) continue;
    out.push({ q, p });
  }
  out.sort((a, b) => (b.p.wrongCount || 0) - (a.p.wrongCount || 0) || (b.p.lastSeen || 0) - (a.p.lastSeen || 0));
  return out;
}

/**
 * 推荐新题：
 *   - 默认只推"没做过"的题
 *   - 按所涉知识点的薄弱分排序
 *   - topics 给定时，只推命中这些知识点的题（这就是"根据错题推新题"）
 */
export function recommendNew(questions, progressMap, {
  topics = null, subjects = null, limit = 40, allowSeen = false,
} = {}) {
  const stats = topicStats(questions, progressMap);
  const topicSet = topics && topics.length ? new Set(topics) : null;
  const scored = [];

  for (const q of questions) {
    if (subjects && subjects.size && !subjects.has(q.subject)) continue;
    const p = progressMap.get(q.id);
    if (!allowSeen && p && p.reps) continue;
    if (allowSeen && p && isMastered(p)) continue;

    const ts = q.topics || [];
    if (topicSet && !ts.some(t => topicSet.has(t))) continue;

    let sc = 0;
    for (const t of ts) {
      const e = stats.get(t);
      if (e) sc += e.score;
    }
    if (!topicSet && sc <= 0) continue;                 // 没有薄弱点时无法排序
    sc += (4 - (q.difficulty || 2)) * 0.08;             // 同分时优先简单题
    sc += Math.random() * 0.02;                          // 打散，避免每次顺序相同
    scored.push({ q, sc });
  }

  scored.sort((a, b) => b.sc - a.sc);
  return scored.slice(0, limit).map(x => x.q);
}

/** 找出命中给定知识点的所有题（含已做过），用于错题重做 */
export function byTopics(questions, topics, { subjects = null } = {}) {
  const set = new Set(topics || []);
  return questions.filter(q => {
    if (subjects && subjects.size && !subjects.has(q.subject)) return false;
    return (q.topics || []).some(t => set.has(t));
  });
}

export default { topicStats, weakTopics, wrongQuestions, recommendNew, byTopics };
