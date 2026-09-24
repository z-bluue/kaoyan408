/* ===========================================================
   间隔重复调度（SM-2 改良版，Anki 风格阶梯）
   评分 grade: 0=重来  1=困难  2=一般  3=简单
   =========================================================== */

export const GRADE = { AGAIN: 0, HARD: 1, GOOD: 2, EASY: 3 };

/* ---------------- 复习节奏 ---------------- */
export const PACING = {
  /** 按遗忘曲线：答错的题当天不再安排，隔天再见，之后 1→3→7→17… 逐级拉长 */
  CURVE: 'curve',
  /** 当天巩固：分钟级阶梯，当天反复练几遍再进入天级（Anki 风格） */
  CRAM: 'cram',
};

const MIN = 60 * 1000;
export const DAY_MS = 24 * 60 * MIN;
const DAY = DAY_MS;

/** cram 模式的学习阶梯（分钟） */
const LADDER_LEARN = [1, 10];
/** cram 模式的重学阶梯（分钟） */
const LADDER_RELEARN = [10];
/** curve 模式的间隔阶梯（天）：答对逐级前进，答错回到第一级 */
const CURVE_STEPS = [1, 3, 7];
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

/**
 * 根据 4 档评分计算下一次安排。
 * @param {object|null} prev 之前的 progress 记录
 * @param {number} grade 0=重来 1=困难 2=一般 3=简单
 * @param {number} now 时间戳
 * @param {{pacing?: string}} opts 复习节奏，默认按遗忘曲线
 */
export function schedule(prev, grade, now = Date.now(), opts = {}) {
  const pacing = opts.pacing === PACING.CRAM ? PACING.CRAM : PACING.CURVE;
  const r = prev ? { ...prev } : newRecord(null);
  r.reps = (r.reps || 0) + 1;
  r.updated = now;
  r.lastSeen = now;
  if (!r.firstSeen) r.firstSeen = now;
  r.lastGrade = grade;

  /* ---------------- 答错 ---------------- */
  if (grade === GRADE.AGAIN) {
    r.lapses = (r.lapses || 0) + 1;
    r.wrongCount = (r.wrongCount || 0) + 1;
    r.lastCorrect = false;
    r.state = (r.state === STATE.REVIEW) ? STATE.RELEARN : STATE.LEARNING;
    r.step = 0;
    r.ef = Math.max(1.3, round2((r.ef || 2.5) - 0.2));

    if (pacing === PACING.CURVE) {
      // 遗忘曲线模式：当天不再安排，退回阶梯第一级（次日再见）
      r.interval = CURVE_STEPS[0];
      r.due = now + CURVE_STEPS[0] * DAY;
    } else {
      const m = ladderOf(r.state)[0];
      r.interval = 0;
      r.due = now + m * MIN;
    }
    return r;
  }

  /* ---------------- 答对 ---------------- */
  r.rightCount = (r.rightCount || 0) + 1;
  r.lastCorrect = true;

  const isLearning = r.state === STATE.NEW || r.state === STATE.LEARNING || r.state === STATE.RELEARN;

  if (isLearning) {
    if (grade === GRADE.EASY) return graduate(r, EASY_IVL, now);

    if (pacing === PACING.CURVE) {
      // 新题第一次答对 → 落到阶梯第一级
      if (r.state === STATE.NEW) {
        r.state = STATE.LEARNING;
        r.step = 0;
        r.interval = CURVE_STEPS[0];
        r.due = now + r.interval * DAY;
        return r;
      }
      const idx = Math.min(r.step || 0, CURVE_STEPS.length - 1);
      if (grade === GRADE.HARD) {
        // 困难：原地踏步，不前进到下一级，下一轮还是同一间隔
        r.interval = CURVE_STEPS[idx];
        r.due = now + r.interval * DAY;
        return r;
      }
      if (idx >= CURVE_STEPS.length - 1) {
        // 阶梯走完 → 毕业，之后按 EF 逐级拉长
        r.state = STATE.REVIEW;
        r.step = 0;
        r.interval = clamp(round1(CURVE_STEPS[idx] * r.ef), 1, MAX_IVL);
        r.due = now + r.interval * DAY;
        return r;
      }
      r.step = idx + 1;
      r.state = STATE.LEARNING;
      r.interval = CURVE_STEPS[r.step];
      r.due = now + r.interval * DAY;
      return r;
    }

    // ---- cram 模式：分钟级阶梯 ----
    const ladder = ladderOf(r.state);
    if (grade === GRADE.HARD) {
      // 原地踏步：给一个较短的重现时间
      const m = ladder[Math.min(r.step || 0, ladder.length - 1)];
      r.due = now + Math.max(1, m) * MIN;
      r.interval = 0;
      return r;
    }
    const nextStep = (r.step || 0) + 1;
    if (nextStep >= ladder.length) {
      return graduate(r, GRADUATING_IVL, now);
    }
    r.step = nextStep;
    r.interval = 0;
    r.due = now + ladder[nextStep] * MIN;
    return r;
  }

  // ---- 复习阶段：两种节奏一致 ----
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
  next = clamp(round1(next), 1, MAX_IVL);
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
export function previewIntervals(prev, now = Date.now(), opts = {}) {
  return [0, 1, 2, 3].map(g => humanInterval(schedule(prev, g, now, opts).due - now));
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

function round1(n) { return Math.round(n * 10) / 10; }
function round2(n) { return Math.round(n * 100) / 100; }
function clamp(n, a, b) { return Math.min(b, Math.max(a, n)); }

export default { GRADE, STATE, PACING, DAY_MS, newRecord, schedule, previewIntervals, humanInterval, autoGrade, isMastered };
