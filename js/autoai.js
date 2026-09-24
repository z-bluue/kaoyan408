/* ===========================================================
   AI 自动出题 —— 在后台盯着错题本，自动补充针对性的新题

   设计要点（都是为了让"自动"这件事不出问题）：
   1. 默认关闭。自动调用会产生 API 费用，必须由用户主动打开。
   2. 每日额度 + 每日请求次数双上限，防止意外刷爆。
   3. 每个知识点最多补 PER_TOPIC_MAX 道，避免反复出同一个点。
   4. 遇到鉴权 / 余额 / 参数错误（fatal）就自动停用，不再反复失败。
   5. 每次 tick 只补少量几道，不阻塞界面。
   =========================================================== */
import * as store from './store.js';
import * as ai from './ai.js';
import * as rec from './recommend.js';
import { dayKey } from './ui.js';

const STATE_KEY = 'aiAutoState';
const PER_TOPIC_MAX = 2;     // 每个知识点最多生成几道 AI 题
const MAX_SOURCES = 3;       // 一次最多参考几道错题
const GAP_MS = 1500;         // 两次请求之间的间隔，避免触发限流

export const DEFAULT_STATE = {
  date: '',
  requestsToday: 0,
  madeToday: 0,
  lastRun: 0,
  lastError: '',
  lastTopic: '',
  disabled: false,
  topics: {},        // 知识点 -> 已生成数量
};

export async function loadState() {
  const raw = await store.metaGet(STATE_KEY, null);
  const st = {
    ...DEFAULT_STATE,
    ...(raw || {}),
    topics: { ...((raw && raw.topics) || {}) },
  };
  const today = dayKey();
  if (st.date !== today) {     // 跨天，额度重置
    st.date = today;
    st.requestsToday = 0;
    st.madeToday = 0;
  }
  return st;
}

export const saveState = (st) => store.metaSet(STATE_KEY, st);

/** 用户手动重新开启时清掉暂停标记 */
export function reenable(st) {
  st.disabled = false;
  st.lastError = '';
  return st;
}

export function remaining(st, settings) {
  const limit = Math.max(0, Number(settings.aiDailyLimit) || 0);
  return Math.max(0, limit - (st.madeToday || 0));
}

/** 现在能不能跑；不能就跑出原因，方便显示给用户 */
export function canRun(st, settings) {
  if (!settings.aiAuto) return { ok: false, why: '自动出题未开启' };
  if (!settings.aiKey) return { ok: false, why: '还没填 API Key' };
  if (st.disabled) return { ok: false, why: '已自动暂停：' + (st.lastError || '未知错误') };
  if (remaining(st, settings) <= 0) return { ok: false, why: '今日额度已用完' };
  const reqCap = Math.max(6, (Number(settings.aiDailyLimit) || 0) * 3);
  if ((st.requestsToday || 0) >= reqCap) return { ok: false, why: '今日请求次数已达上限' };
  return { ok: true };
}

/**
 * 挑一个"最该补题"的知识点。
 * 打分 = 该知识点的薄弱分 + 错题数量 × 0.3
 * 同时避开：已经有足够 AI 题的知识点、本次已生成过的知识点。
 */
export function pickTarget({ questions, progress, aiQuestions, state }) {
  const wrongs = rec.wrongQuestions(questions, progress, { onlyUnmastered: true });
  if (!wrongs.length) return null;

  const stats = rec.topicStats(questions, progress);

  // 每个知识点下现有的 AI 题数量
  const aiPerTopic = new Map();
  for (const q of aiQuestions) {
    for (const t of q.topics || []) aiPerTopic.set(t, (aiPerTopic.get(t) || 0) + 1);
  }

  // 按知识点把错题分组
  const byTopic = new Map();
  for (const { q, p } of wrongs) {
    for (const t of q.topics || []) {
      if (!byTopic.has(t)) byTopic.set(t, []);
      byTopic.get(t).push({ q, p });
    }
  }

  const cands = [];
  for (const [topic, list] of byTopic) {
    if ((aiPerTopic.get(topic) || 0) >= PER_TOPIC_MAX) continue;
    if ((state.topics[topic] || 0) >= PER_TOPIC_MAX) continue;

    const score = (stats.get(topic) ? stats.get(topic).score : 0) + list.length * 0.3;
    if (score <= 0) continue;

    // 取该知识点下错得最多、最近错的几道作为参考
    const sources = list
      .slice()
      .sort((a, b) => (b.p.wrongCount || 0) - (a.p.wrongCount || 0)
        || (b.p.lastSeen || 0) - (a.p.lastSeen || 0))
      .slice(0, MAX_SOURCES)
      .map(x => x.q);

    cands.push({ topic, score, sources, wrongCount: list.length });
  }

  if (!cands.length) return null;
  cands.sort((a, b) => b.score - a.score || b.wrongCount - a.wrongCount);
  return cands[0];
}

/**
 * 跑一轮自动出题。
 * @param {object} input { questions, progress, settings }
 * @param {object} opts  { max, onGenerated, onStatus }
 */
export async function tick(input, { max = 99, onGenerated, onStatus } = {}) {
  const { questions, progress, settings, fixes = [] } = input;
  const st = await loadState();

  const gate = canRun(st, settings);
  if (!gate.ok) {
    if (onStatus) onStatus({ state: st, ran: 0, reason: gate.why });
    return { ran: 0, reason: gate.why };
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    if (onStatus) onStatus({ state: st, ran: 0, reason: '当前处于离线状态' });
    return { ran: 0, reason: '当前处于离线状态' };
  }

  const budget = Math.min(max, remaining(st, settings));
  let ran = 0;

  for (let i = 0; i < budget; i++) {
    // 注意：onGenerated 会往 questions 里 push 新题，
    // 所以这里每轮都要重新取，避免同一个知识点被连续出两次。
    const aiQuestions = questions.filter(q => q.ai);
    const target = pickTarget({ questions, progress, aiQuestions, state: st });

    if (!target) {
      await saveState(st);
      if (onStatus) onStatus({ state: st, ran, reason: '没有需要补题的知识点了' });
      return { ran, reason: '没有需要补题的知识点了' };
    }

    st.requestsToday = (st.requestsToday || 0) + 1;
    try {
      const { question } = await ai.generateSimilar(target.sources, settings, {
        onStage: onStatus ? (stage) => onStatus({ state: st, ran, stage }) : undefined,
        fixes,
      });

      question.aiTopic = target.topic;
      question.aiSources = target.sources.map(q => q.id);
      if (!question.topics || !question.topics.length) question.topics = [target.topic];

      st.madeToday = (st.madeToday || 0) + 1;
      st.topics[target.topic] = (st.topics[target.topic] || 0) + 1;
      st.lastTopic = target.topic;
      st.lastRun = Date.now();
      st.lastError = '';
      await saveState(st);

      if (onGenerated) await onGenerated(question, target);
      ran++;
    } catch (e) {
      st.lastError = e.message;
      st.lastRun = Date.now();
      // 鉴权 / 余额 / 参数错误：自动停用，免得反复失败白烧额度
      if (e.fatal) st.disabled = true;
      await saveState(st);
      if (onStatus) onStatus({ state: st, ran, reason: e.message, error: true });
      return { ran, reason: e.message, error: true };
    }

    if (i < budget - 1) await new Promise(r => setTimeout(r, GAP_MS));
  }

  await saveState(st);
  if (onStatus) onStatus({ state: st, ran, reason: '' });
  return { ran, reason: '' };
}

export default {
  DEFAULT_STATE, loadState, saveState, reenable, remaining, canRun, pickTarget, tick,
};
