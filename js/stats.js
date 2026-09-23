/* ===========================================================
   统计：概览数据 + Canvas 图表（无第三方依赖）
   =========================================================== */
import * as store from './store.js';
import { isMastered } from './srs.js';
import { dayKey, startOfDay } from './ui.js';

const DAY = 86400000;

/* ---------------- 数据 ---------------- */

/** 根据 progress 计算覆盖率 / 掌握度 / 各科目情况 */
export function progressOverview(questions, progressMap) {
  const bySubject = new Map();
  let covered = 0, mastered = 0, wrong = 0;

  for (const q of questions) {
    let s = bySubject.get(q.subject);
    if (!s) {
      s = { subject: q.subject, name: q.subjectName || q.subject, total: 0, covered: 0, mastered: 0, wrong: 0, attempts: 0, correct: 0 };
      bySubject.set(q.subject, s);
    }
    s.total++;
    const p = progressMap.get(q.id);
    if (!p || !p.reps) continue;
    covered++;
    s.covered++;
    s.attempts += (p.rightCount || 0) + (p.wrongCount || 0);
    s.correct += (p.rightCount || 0);
    if ((p.wrongCount || 0) > 0) s.wrong++;
    if (isMastered(p)) { mastered++; s.mastered++; }
  }
  for (const s of bySubject.values()) {
    if ((s.attempts || 0) > 0) {
      s.accuracy = s.correct / s.attempts;
    } else s.accuracy = null;
  }
  wrong = [...bySubject.values()].reduce((a, b) => a + b.wrong, 0);
  return { covered, mastered, wrong, bySubject };
}

/** 汇总某段时间的日粒度数据 */
export async function dailySeries({ days = 30, subject = null, chapter = null } = {}) {
  const from = startOfDay(Date.now() - (days - 1) * DAY);
  const logs = await store.logsSince(from);

  const buckets = new Map();
  for (let i = days - 1; i >= 0; i--) {
    const k = dayKey(Date.now() - i * DAY);
    buckets.set(k, { date: k, total: 0, correct: 0 });
  }
  for (const l of logs) {
    if (subject && l.subject !== subject) continue;
    if (chapter && l.chapter !== chapter) continue;
    const b = buckets.get(dayKey(l.ts));
    if (!b) continue;
    b.total++;
    if (l.correct) b.correct++;
  }
  return [...buckets.values()];
}

/** 某段时间内的总体数据（正确的与总数） */
export async function rangeSummary(days = 30, filter = {}) {
  const rows = await dailySeries({ days, ...filter });
  const total = rows.reduce((a, b) => a + b.total, 0);
  const correct = rows.reduce((a, b) => a + b.correct, 0);
  return { total, correct, accuracy: total ? correct / total : null, rows };
}

/** 全部时间范围的累计值（meta 里增量维护，避免全表扫描） */
export async function lifetime() {
  return store.metaGet('stats', { total: 0, totalCorrect: 0, streak: 0, lastDate: '', todayDate: '', todayCount: 0, todayCorrect: 0, days: {} });
}

/** 记录一次作答后更新累计值 */
export async function bumpLifetime({ correct, ts = Date.now() }) {
  const s = await lifetime();
  const today = dayKey(ts);
  s.total = (s.total || 0) + 1;
  if (correct) s.totalCorrect = (s.totalCorrect || 0) + 1;

  if (s.todayDate !== today) {
    s.todayDate = today;
    s.todayCount = 0;
    s.todayCorrect = 0;
  }
  s.todayCount++;
  if (correct) s.todayCorrect++;

  // 连续打卡：昨天有记录则 +1，否则重新从 1 开始
  if (s.lastDate !== today) {
    const y = dayKey(ts - DAY);
    s.streak = (s.lastDate === y) ? (s.streak || 0) + 1 : 1;
    s.lastDate = today;
  }
  await store.metaSet('stats', s);
  return s;
}

/* ---------------- 图表 ---------------- */
function setupCanvas(cv) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = Math.max(200, cv.clientWidth || cv.parentElement.clientWidth || 320);
  // 注意：给 cv.height 赋值会同时回写到 height 属性上，
  // 所以逻辑高度必须单独存在 dataset 里，否则每次重绘高度都会翻倍。
  const h = Number(cv.dataset.logicalHeight) || Number(cv.getAttribute('height')) || 180;
  cv.dataset.logicalHeight = h;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  cv.style.width = '100%';
  cv.style.height = h + 'px';
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function axisFrame(ctx, w, h, { padL = 30, padR = 8, padT = 12, padB = 22 } = {}) {
  const cw = w - padL - padR;
  const ch = h - padT - padB;
  ctx.font = '10px -apple-system,system-ui,sans-serif';
  return { padL, padR, padT, padB, cw, ch };
}

function grid(ctx, f, max, w, { fmt = v => String(v), lines = 2 } = {}) {
  ctx.strokeStyle = '#2a3240';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#6e7681';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= lines; i++) {
    const y = f.padT + f.ch * i / lines;
    ctx.beginPath();
    ctx.moveTo(f.padL, y + 0.5);
    ctx.lineTo(w - f.padR, y + 0.5);
    ctx.stroke();
    ctx.fillText(fmt(Math.round(max * (1 - i / lines))), f.padL - 5, y);
  }
}

export function drawBars(cv, rows, { color = '#2f81f7', labelEvery = 5, fmt } = {}) {
  if (!cv) return;
  const { ctx, w, h } = setupCanvas(cv);
  const f = axisFrame(ctx, w, h);
  const max = Math.max(1, ...rows.map(r => r.value));
  grid(ctx, f, max, w, { fmt: fmt || (v => String(v)) });

  const bw = f.cw / rows.length;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  rows.forEach((r, i) => {
    const barW = Math.max(2, bw * 0.62);
    const bh = r.value > 0 ? Math.max(3, f.ch * (r.value / max)) : 1;
    const x = f.padL + i * bw + (bw - barW) / 2;
    const y = f.padT + f.ch - bh;
    ctx.fillStyle = r.value > 0 ? color : '#232a35';
    roundRect(ctx, x, y, barW, bh, 2);
    ctx.fill();
    if (i % labelEvery === 0 || i === rows.length - 1) {
      ctx.fillStyle = '#6e7681';
      ctx.fillText(r.label, f.padL + i * bw + bw / 2, h - f.padB + 5);
    }
  });
}

export function drawLine(cv, rows, { color = '#3fb950', fmt = v => Math.round(v * 100) + '%' } = {}) {
  if (!cv) return;
  const { ctx, w, h } = setupCanvas(cv);
  const f = axisFrame(ctx, w, h);
  const max = 1;
  grid(ctx, f, max, w, { fmt: v => fmt(v) });

  const pts = [];
  rows.forEach((r, i) => {
    const v = r.value;
    if (v == null) return;
    const x = f.padL + (rows.length === 1 ? f.cw / 2 : f.cw * i / (rows.length - 1));
    const y = f.padT + f.ch * (1 - v / max);
    pts.push({ x, y });
  });

  if (pts.length > 1) {
    const grad = ctx.createLinearGradient(0, f.padT, 0, f.padT + f.ch);
    grad.addColorStop(0, 'rgba(63,185,80,.28)');
    grad.addColorStop(1, 'rgba(63,185,80,0)');
    ctx.beginPath();
    ctx.moveTo(pts[0].x, f.padT + f.ch);
    for (const p of pts) ctx.lineTo(p.x, p.y);
    ctx.lineTo(pts[pts.length - 1].x, f.padT + f.ch);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  ctx.fillStyle = color;
  for (const p of pts) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = '#6e7681';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  rows.forEach((r, i) => {
    if (i % 5 === 0 || i === rows.length - 1) {
      const x = f.padL + (rows.length === 1 ? f.cw / 2 : f.cw * i / (rows.length - 1));
      ctx.fillText(r.label, x, h - f.padB + 5);
    }
  });
}

/** 把日序列转成图表输入 */
export function toBarRows(series) {
  return series.map(d => ({ label: d.date.slice(5), value: d.total }));
}

export function toLineRows(series) {
  return series.map(d => ({
    label: d.date.slice(5),
    value: d.total >= 3 ? d.correct / d.total : null,   // 样本太少不画点
  }));
}

export default {
  progressOverview, dailySeries, rangeSummary, lifetime, bumpLifetime,
  drawBars, drawLine, toBarRows, toLineRows,
};
