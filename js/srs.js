/* ===========================================================
   间隔重复调度（SM-2 改良版，Anki 风格阶梯）
   评分 grade: 0=重来  1=困难  2=一般  3=简单
   =========================================================== */

export const GRADE = { AGAIN: 0, HARD: 1, GOOD: 2, EASY: 3 };

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

/** 学习阶梯（分钟） */
const LADDER_LEARN = [1, 10];
/** 重学阶梯（分钟） */
const LADDER_RELEARN = [10];
/** 毕业间隔（天） */
const GRADUATING_IVL = 1;
/** 直接点"简单"的毕业间隔（天） */
const EASY_IVL = 4;
/** 复习阶段间隔上限（天） */
const MAX_IVL = 365 * 3;

export const STATE = { NEW: 'new', LEARNING: 'learning', REVIEW: 'review', RELEARN: 'relearning' };

export function newRecord(id) {
  return {
    id,
    state: STATE.NEW,
    step: 0,
    ef: 2.5,
    interval: 0,          // 天
    due: 0,
    reps: 0,
    lapses: 0,
    lastGrade: null,
    lastCorrect: null,
    rightCount: 0,
    wrongCount: 0,
    firstSeen: 0,
    lastSeen: 0,
    updated: 0,
  };
}

function ladderOf(state) {
  return state === STATE.RELEARN ? LADDER_RELEARN : LADDER_LEARN;
}

/** 根据 4 档评分计算下一次安排；返回新的 progress 记录 */
export function schedule(prev, grade, now = Date.now()) {
  const r = prev ? { ...prev } : newRecord(null);
  r.reps = (r.reps || 0) + 1;
  r.updated = now;
  r.lastSeen = now;
  if (!r.firstSeen) r.firstSeen = now;
  r.lastGrade = grade;

  if (grade === GRADE.AGAIN) {
    r.lapses = (r.lapses || 0) + 1;
    r.wrongCount = (r.wrongCount || 0) + 1;
    r.lastCorrect = false;
    r.state = (r.state === STATE.REVIEW) ? STATE.RELEARN : STATE.LEARNING;
    r.step = 0;
    r.ef = Math.max(1.3, round2((r.ef || 2.5) - 0.2));
    const m = ladderOf(r.state)[0];
    r.interval = 0;
    r.due = now + m * MIN;
    return r;
  }

  r.rightCount = (r.rightCount || 0) + 1;
  r.lastCorrect = true;

  if (r.state === STATE.NEW || r.state === STATE.LEARNING || r.state === STATE.RELEARN) {
    if (grade === GRADE.EASY) {
      return graduate(r, EASY_IVL, now);
    }
    if (grade === GRADE.HARD) {
      // 原地踏步：给一个较短的重现时间
      const m = ladderOf(r.state)[Math.min(r.step || 0, ladderOf(r.state).length - 1)];
      r.due = now + Math.max(1, m) * MIN;
      r.interval = 0;
      return r;
    }
    const ladder = ladderOf(r.state);
    const nextStep = (r.step || 0) + 1;
    if (nextStep >= ladder.length) {
      return graduate(r, GRADUATING_IVL, now);
    }
    r.step = nextStep;
    r.interval = 0;
    r.due = now + ladder[nextStep] * MIN;
    return r;
  }

  // ---- 复习阶段 ----
  const ivl = r.interval || 1;
  let next;
  if (grade === GRADE.HARD) {
    next = ivl * 1.2;
    r.ef = Math.max(1.3, round2(r.ef - 0.05));
  } else if (grade === GRADE.GOOD) {
    next = ivl * r.ef;
  } else {
    next = ivl * r.ef * 1.3;
    r.ef = Math.max(1.3, round2(r.ef + 0.05));
  }
  next = clamp(Math.round(next * 10) / 10, 1, MAX_IVL);
  r.state = STATE.REVIEW;
  r.interval = next;
  r.due = now + next * DAY;
  return r;
}

function graduate(r, days, now) {
  r.state = STATE.REVIEW;
  r.step = 0;
  r.interval = days;
  r.due = now + days * DAY;
  return r;
}

/** 预览四个按钮对应的下次间隔文本（不落库） */
export function previewIntervals(prev, now = Date.now()) {
  return [0, 1, 2, 3].map(g => humanInterval(schedule(prev, g, now).due - now));
}

export function humanInterval(ms) {
  if (ms <= 0) return '现在';
  const m = ms / MIN;
  if (m < 1) return '<1分';
  if (m < 60) return Math.round(m) + '分';
  const h = m / 60;
  if (h < 24) return Math.round(h) + '小时';
  const d = h / 24;
  if (d < 30) return Math.round(d) + '天';
  const mo = d / 30;
  if (mo < 12) return (Math.round(mo * 10) / 10) + '月';
  return (Math.round(d / 36.5 * 10) / 10) + '年';
}

/**
 * 由作答情况自动推断评分：
 *   答错 → 重来；答对 → 一般；又快又对 → 简单
 */
export function autoGrade({ correct, ms, state }) {
  if (!correct) return GRADE.AGAIN;
  if (state === STATE.NEW || state === STATE.LEARNING) {
    return ms != null && ms < 12000 ? GRADE.EASY : GRADE.GOOD;
  }
  return ms != null && ms < 12000 ? GRADE.EASY : GRADE.GOOD;
}

/** 是否已"掌握"（不再进错题本） */
export function isMastered(p) {
  if (!p) return false;
  return p.lastCorrect === true && (p.interval || 0) >= 21;
}

function round2(n) { return Math.round(n * 100) / 100; }
function clamp(n, a, b) { return Math.min(b, Math.max(a, n)); }

export default { GRADE, STATE, newRecord, schedule, previewIntervals, humanInterval, autoGrade, isMastered };
