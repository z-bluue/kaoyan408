/* ===========================================================
   408 刷题 —— 主控制器
   =========================================================== */
import * as store from './store.js';
import * as bank from './bank.js';
import * as rec from './recommend.js';
import * as stats from './stats.js';
import * as sync from './sync.js';
import * as srs from './srs.js';
import * as ai from './ai.js';
import * as autoAi from './autoai.js';
import {
  $, esc, richText, toast, openSheet, closeSheet,
  dayKey, fmtRelative, shuffle, uniq, pct, normAnswer, debounce,
} from './ui.js';

/* ---------------- 常量 ---------------- */
const DEFAULT_SETTINGS = {
  goal: 40,
  autoUpdate: true,
  repo: '',
  branch: 'main',
  mirror: 'jsdelivr',
  token: '',
  gistId: '',
  lastSync: 0,
  lastUpdate: 0,
  bankVersion: '',
  // AI 出题（DeepSeek）
  aiKey: '',
  aiModel: 'deepseek-flash',
  aiFast: true,
  aiEnabled: true,
  aiAuto: false,        // 自动出题默认关闭：自动调用会产生 API 费用
  aiDailyLimit: 5,      // 每天最多生成几道
};

const DIFF_LABELS = { 1: '基础', 2: '较易', 3: '中等', 4: '较难', 5: '困难' };
const LIMIT_CHOICES = [10, 20, 30, 50, 100];
const REQUEUE_WINDOW = 20 * 60 * 1000;   // 20 分钟内到期的题，本轮内重排
const REQUEUE_MAX = 3;

/* ---------------- 全局状态 ---------------- */
const S = {
  subjectsMeta: [],
  subjects: [],
  questions: [],
  byId: new Map(),
  progress: new Map(),
  settings: { ...DEFAULT_SETTINGS },
  scope: { subjects: new Set(), chapters: new Set(), diff: new Set(), limit: 20 },
  session: null,
  quiz: {},
  view: 'practice',
  wrongFilter: { subjects: new Set(), onlyUnmastered: true },
  bankWarnings: [],
  aiCount: 0,
};

/* ===========================================================
   启动
   =========================================================== */
async function boot() {
  bindGlobalEvents();
  S.settings = { ...DEFAULT_SETTINGS, ...(await store.metaGet('settings', {})) };

  try {
    await loadBankAndProgress();
  } catch (e) {
    console.error(e);
    toast('题库加载失败：' + e.message, 4000);
  }

  fillSettingsForm();
  renderStart();
  renderWrong();
  renderStats();
  renderMe();
  showView('practice');

  registerSW();
  kickOffBackgroundTasks();
  // 先让首页渲染完，再在后台自动补题
  scheduleAutoAi(6000, 3);
  renderAiPanel();
}

async function loadBankAndProgress() {
  S.subjectsMeta = await bank.loadSubjectsMeta();
  applyBankResult(await bank.loadBank(S.subjectsMeta));
  S.progress = new Map((await store.getAll('progress')).map(p => [p.id, p]));
  await loadAiQuestions();
}

/** 把之前用 AI 生成过的题目也接入题库（它们沿用原题的科目/章节） */
async function loadAiQuestions() {
  try {
    const qs = await store.aiAll();
    for (const q of qs) {
      if (!q || !q.id || S.byId.has(q.id)) continue;
      S.byId.set(q.id, q);
      S.questions.push(q);
    }
    S.aiCount = qs.length;
  } catch (e) {
    console.warn('加载 AI 题库失败', e);
  }
}

/** 把一次 loadBank 的结果应用到全局状态 */
function applyBankResult(r) {
  S.questions = r.questions;
  S.byId = r.byId;
  S.bankWarnings = r.warnings;
  S.subjects = r.subjects || [];
}

async function refreshProgress() {
  S.progress = new Map((await store.getAll('progress')).map(p => [p.id, p]));
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

function kickOffBackgroundTasks() {
  const t = [];
  if (S.settings.autoUpdate && S.settings.repo && navigator.onLine) {
    t.push(checkBankUpdate({ silent: true }));
  }
  if (S.settings.token && S.settings.gistId && navigator.onLine) {
    t.push(autoSync());
  }
  t.push(store.trimLogs(30000).catch(() => {}));
  Promise.allSettled(t).then(() => { renderStart(); renderMe(); });
}

/* ===========================================================
   设置
   =========================================================== */
async function saveSettings(patch = {}) {
  S.settings = { ...S.settings, ...patch };
  await store.metaSet('settings', S.settings);
}

/* ===========================================================
   范围
   =========================================================== */
function inScope(q) {
  const sc = S.scope;
  if (sc.subjects.size && !sc.subjects.has(q.subject)) return false;
  if (sc.chapters.size && !sc.chapters.has(q.chapter)) return false;
  if (sc.diff.size && !sc.diff.has(String(q.difficulty))) return false;
  return true;
}

function scopePool() { return S.questions.filter(inScope); }

function scopeText() {
  const sc = S.scope;
  const subj = sc.subjects.size
    ? [...sc.subjects].map(id => (S.subjectsMeta.find(s => s.id === id) || {}).name || id).join('、')
    : '全部科目';
  const extra = [];
  if (sc.chapters.size) extra.push(`${sc.chapters.size} 个章节`);
  if (sc.diff.size) extra.push('难度 ' + [...sc.diff].map(d => DIFF_LABELS[d]).join('/'));
  return `范围：${subj}${extra.length ? ' · ' + extra.join(' · ') : ''} · 每轮 ${sc.limit} 题`;
}

function dueCount() {
  const now = Date.now();
  return scopePool().filter(q => {
    const p = S.progress.get(q.id);
    return p && p.reps && p.due && p.due <= now;
  }).length;
}

function newCount() {
  return scopePool().filter(q => { const p = S.progress.get(q.id); return !p || !p.reps; }).length;
}

function wrongCount() {
  return rec.wrongQuestions(scopePool(), S.progress, { onlyUnmastered: true }).length;
}

/* ===========================================================
   组卷
   =========================================================== */
function buildQueue(mode) {
  const now = Date.now();
  const pool = scopePool();
  let list = [];

  switch (mode) {
    case 'due': {
      list = pool
        .filter(q => { const p = S.progress.get(q.id); return p && p.reps && p.due && p.due <= now; })
        .sort((a, b) => (S.progress.get(a.id).due) - (S.progress.get(b.id).due));
      if (!list.length) {
        toast('当前范围内没有到期要复习的题，先刷新题吧');
        return [];
      }
      break;
    }
    case 'new': {
      list = shuffle(pool.filter(q => { const p = S.progress.get(q.id); return !p || !p.reps; }));
      if (!list.length) toast('这个范围内已经没有新题了');
      break;
    }
    case 'wrong': {
      list = rec.wrongQuestions(pool, S.progress, { onlyUnmastered: true })
        .map(x => x.q)
        .sort((a, b) => (S.progress.get(b.id).wrongCount || 0) - (S.progress.get(a.id).wrongCount || 0));
      if (!list.length) toast('没有待攻克的错题，很棒');
      break;
    }
    case 'weak': {
      const wtopics = rec.weakTopics(S.questions, S.progress, { limit: 20 }).map(e => e.topic);
      if (!wtopics.length) {
        toast('还没有足够数据判断薄弱点，先刷一些题吧');
        return [];
      }
      list = rec.recommendNew(pool, S.progress, { topics: wtopics, limit: 999 });
      if (!list.length) toast('薄弱知识点的相关新题已经做完了');
      break;
    }
    case 'random':
    default:
      list = shuffle(pool);
      break;
  }
  // 会话队列统一存"题号"，渲染时再从 byId 取题目
  return list.slice(0, S.scope.limit).map(q => q.id);
}

function startSession(mode, explicitIds = null) {
  const queue = explicitIds ? explicitIds.slice(0, S.scope.limit) : buildQueue(mode);
  if (!queue.length) return;

  S.session = {
    mode,
    queue,
    idx: 0,
    ok: 0,
    no: 0,
    extra: {},
    startedAt: Date.now(),
  };
  $('#startScreen').hidden = true;
  $('#quizScreen').hidden = false;
  $('#quizSummary').hidden = true;
  renderQuiz();
}

function endSession(showSummary = true) {
  const s = S.session;
  S.session = null;
  $('#quizScreen').hidden = true;
  $('#quizSummary').hidden = true;
  $('#startScreen').hidden = false;
  if (showSummary && s && (s.ok + s.no) > 0) {
    const total = s.ok + s.no;
    toast(`本轮 ${total} 题，正确率 ${pct(s.ok, total)}`, 2600);
  }
  refreshProgress().then(() => {
    renderStart();
    renderWrong();
    renderStats();
  });
}

/* ===========================================================
   刷题渲染
   =========================================================== */
function renderQuiz() {
  const s = S.session;
  if (!s) return;
  if (s.idx >= s.queue.length) { finishSession(); return; }

  const q = S.byId.get(s.queue[s.idx]);
  if (!q) { s.idx++; return renderQuiz(); }

  const now = Date.now();
  S.quiz = { q, picked: new Set(), answered: false, correct: false, ts: 0, ms: null, shownAt: now, committed: false };

  const total = s.queue.length;
  $('#pBar').style.width = `${Math.round(s.idx / total * 100)}%`;
  $('#qCounter').textContent = `${s.idx + 1}/${total}`;
  $('#qOk').textContent = `✓ ${s.ok}`;
  $('#qNo').textContent = `✗ ${s.no}`;

  // 标签
  const tagBits = [
    `<span class="pill">${esc(q.subjectName || q.subject)}</span>`,
    `<span class="pill">${esc(q.chapter)}</span>`,
    `<span class="pill">${esc(DIFF_LABELS[q.difficulty] || '中等')}</span>`,
  ];
  if (q.topics.length) tagBits.push(`<span class="pill">${esc(q.topics.slice(0, 3).join(' / '))}</span>`);
  const p = S.progress.get(q.id);
  if (p && p.wrongCount) tagBits.push(`<span class="pill" style="color:#f85149">错过 ${p.wrongCount} 次</span>`);
  if (q.ai) tagBits.push('<span class="pill ai">AI 生成 · 答案请核对</span>');
  $('#qTag').innerHTML = tagBits.join('');

  // 题干
  const typeHint = q.type === 'multi' ? '（多选题，选完后点提交）'
    : q.type === 'fill' ? '（填空题）'
      : q.type === 'short' ? '（综合/short 题，答完后对照参考解析自评）'
        : q.type === 'judge' ? '（判断题）' : '';
  $('#qStem').innerHTML =
    (typeHint ? `<span class="q-hint">${typeHint}</span>` : '') + richText(q.stem);

  // 选项
  const opts = $('#qOptions');
  const fill = $('#fillWrap');
  const foot = $('#quizFoot');
  const fb = $('#qFeedback');
  const srsRow = $('#srsRow');
  ['#qTag', '#qStem', '#qOptions', '#qFeedback', '#srsRow', '#quizFoot'].forEach(sel => {
    const el = $(sel); if (el) el.hidden = false;
  });
  $('#quizSummary').hidden = true;
  fb.hidden = true; fb.innerHTML = '';
  srsRow.hidden = true;
  foot.innerHTML = '';
  opts.innerHTML = '';
  fill.hidden = true;

  if (q.options && q.options.length) {
    opts.innerHTML = q.options.map(o =>
      `<div class="opt" data-key="${esc(o.key)}"><span class="key">${esc(o.key)}</span><span class="txt">${richText(o.text)}</span></div>`
    ).join('');
  } else if (q.type === 'fill') {
    fill.hidden = false;
    $('#fillInput').value = '';
    $('#fillInput').focus();
  } else if (q.type === 'short') {
    foot.innerHTML = `<button class="btn primary" id="btnShowRef">查看参考答案</button>`;
  }
}

function onPickOption(key) {
  const st = S.quiz;
  if (!st || !st.q || st.answered) return;
  const q = st.q;
  const node = $(`.opt[data-key="${CSS.escape(key)}"]`);
  if (q.type === 'multi') {
    if (st.picked.has(key)) { st.picked.delete(key); node?.classList.remove('picked'); }
    else { st.picked.add(key); node?.classList.add('picked'); }
    syncMultiSubmitButton();
    return;
  }
  st.picked = new Set([key]);
  node?.classList.add('picked');
  submitAnswer([key]);
}

function syncMultiSubmitButton() {
  const st = S.quiz;
  const foot = $('#quizFoot');
  if (!st || !st.q || st.q.type !== 'multi' || st.answered) return;
  const n = st.picked.size;
  if (n === 0) { foot.innerHTML = ''; return; }
  if (!$('#btnMultiSubmit')) {
    foot.innerHTML = `<button class="btn primary" id="btnMultiSubmit">提交答案</button>`;
    $('#btnMultiSubmit').addEventListener('click', () => submitAnswer([...S.quiz.picked]));
  }
}

function submitAnswer(picked) {
  const st = S.quiz;
  if (!st || st.answered) return;
  const q = st.q;
  st.ts = Date.now();
  st.ms = st.ts - st.shownAt;
  st.picked = new Set(picked);

  let correct;
  if (q.type === 'fill') {
    correct = checkFill(q, picked[0]);
  } else {
    const a = new Set(q.answer);
    const b = new Set(picked);
    correct = a.size === b.size && [...a].every(k => b.has(k));
  }
  st.answered = true;
  st.correct = correct;
  showFeedback();
}

function checkFill(q, input) {
  const val = normAnswer(input);
  if (!val) return false;
  const candidates = [...(q.answer || []), ...(q.accept || [])];
  return candidates.some(c => {
    const n = normAnswer(c);
    return n === val || (n.length >= 4 && val.includes(n));
  });
}

function showFeedback() {
  const st = S.quiz;
  const q = st.q;
  const fb = $('#qFeedback');

  // 标记选项
  document.querySelectorAll('#qOptions .opt').forEach(node => {
    const k = node.dataset.key;
    node.classList.add('locked');
    node.classList.remove('picked');
    if (q.answer.includes(k)) node.classList.add('right');
    else if (st.picked.has(k)) node.classList.add('wrong');
  });

  const thisQ = S.progress.get(q.id) || {};
  fb.className = 'card feedback ' + (st.correct ? 'ok' : 'no');
  const answerText = (q.options && q.options.length)
    ? q.answer.map(k => {
      const o = q.options.find(x => x.key === k);
      return `${k}${o ? '. ' + o.text : ''}`;
    }).join('   ')
    : q.answer.join(' / ');

  fb.innerHTML = `
    <div class="fb-head">${st.correct ? '✓ 回答正确' : '✗ 回答错误'}
      <span class="muted small" style="font-weight:400">
        ${thisQ.wrongCount ? `本题历史错误 ${thisQ.wrongCount} 次` : ''}
        ${st.ms != null ? ` · 用时 ${(st.ms / 1000).toFixed(1)}s` : ''}
      </span>
    </div>
    <div class="fb-ans"><b style="color:#e6edf3">正确答案：</b>${richText(answerText)}</div>
    <div class="fb-exp"><b>解析：</b>${q.explain ? richText(q.explain) : '<span class="muted">这道题暂无解析</span>'}</div>
    ${q.source ? `<div class="muted small" style="margin-top:8px">来源：${esc(q.source)}</div>` : ''}
  `;
  fb.hidden = false;

  $('#quizFoot').innerHTML = '';
  renderSrsRow();
  fb.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderSrsRow() {
  const st = S.quiz;
  const q = st.q;
  const prev = S.progress.get(q.id) || srs.newRecord(q.id);
  const ivls = srs.previewIntervals(prev, st.ts || Date.now());
  const auto = srs.autoGrade({ correct: st.correct, ms: st.ms, state: prev.state });

  $('#srsIvl0').textContent = ivls[0];
  $('#srsIvl1').textContent = ivls[1];
  $('#srsIvl2').textContent = ivls[2];
  $('#srsIvl3').textContent = ivls[3];
  document.querySelectorAll('#srsRow .srs').forEach(b => {
    b.classList.toggle('auto', Number(b.dataset.grade) === auto);
  });
  $('#srsRow').hidden = false;
  const foot = $('#quizFoot');
  foot.innerHTML = `<button class="btn primary" id="btnNext">下一题（推荐：${['重来', '困难', '一般', '简单'][auto]}）</button>`;
  // 答错了、且配了 API Key 时，才给「AI 出同类题」入口
  if (!st.correct && S.settings.aiKey && S.settings.aiEnabled) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn';
    b.id = 'btnAiGen';
    b.textContent = 'AI 出同类题';
    foot.appendChild(b);
  }
  $('#btnNext').addEventListener('click', () => commitGrade(auto));
}

async function commitGrade(grade) {
  const st = S.quiz;
  const s = S.session;
  if (!s || !st.q || st.committed) return;
  st.committed = true;

  const q = st.q;
  const prev = S.progress.get(q.id) || srs.newRecord(q.id);
  const cur = srs.schedule(prev, grade, st.ts || Date.now());
  cur.id = q.id;
  // 记下当时选错的选项：之后 AI 出题时才知道你具体错在哪，能针对性设陷阱
  if (!st.correct && st.picked && st.picked.size) cur.lastWrongPick = [...st.picked];
  S.progress.set(q.id, cur);

  await store.put('progress', cur);
  await store.put('logs', {
    k: `${q.id}|${st.ts}`,
    qid: q.id, ts: st.ts, correct: st.correct, ms: st.ms,
    subject: q.subject, chapter: q.chapter, topics: q.topics, mode: s.mode, grade,
  });
  await stats.bumpLifetime({ correct: st.correct, ts: st.ts });

  if (st.correct) s.ok++; else s.no++;

  // 答错就在后台让 AI 补一道同知识点的题（错得越具体，出的题越对症）
  if (!st.correct) scheduleAutoAi(12000, 1);

  // 短间隔的题在本轮内重排，形成"立即再练一遍"
  if (cur.due - Date.now() <= REQUEUE_WINDOW) {
    const n = s.extra[q.id] || 0;
    if (n < REQUEUE_MAX) {
      s.extra[q.id] = n + 1;
      s.queue.push(q.id);
    }
  }

  s.idx++;
  renderQuiz();
}

function finishSession() {
  const s = S.session;
  if (!s) return;
  const total = s.ok + s.no;
  const acc = total ? s.ok / total : 0;

  $('#pBar').style.width = '100%';
  $('#qCounter').textContent = `${total}/${total}`;
  ['#qTag', '#qStem', '#qOptions', '#fillWrap', '#qFeedback', '#srsRow', '#quizFoot'].forEach(sel => {
    const el = $(sel); if (el) el.hidden = true;
  });

  const summary = $('#quizSummary');
  summary.hidden = false;
  summary.innerHTML = `
    <div class="card" style="text-align:center">
      <div style="font-size:15px;font-weight:650;margin-bottom:6px">本轮完成</div>
      <div class="big-num" style="font-size:36px;margin:10px 0">${pct(s.ok, total)}</div>
      <div class="muted">共 ${total} 题 · 正确 ${s.ok} · 错误 ${s.no} · 用时 ${Math.max(1, Math.round((Date.now() - s.startedAt) / 60000))} 分钟</div>
    </div>
    <div class="btn-row">
      <button class="btn" id="btnAgainWrong" ${s.no === 0 ? 'disabled' : ''}>只重做错的</button>
      <button class="btn primary" id="btnBackHome">返回首页</button>
    </div>
  `;

  $('#btnBackHome').addEventListener('click', () => {
    S.session = null;
    $('#quizScreen').hidden = true;
    $('#startScreen').hidden = false;
    summary.hidden = true;
    refreshProgress().then(() => { renderStart(); renderWrong(); renderStats(); });
  });
  $('#btnAgainWrong').addEventListener('click', () => {
    const wrongIds = [...new Set(s.queue.slice(0, s.idx))].filter(id => {
      const p = S.progress.get(id);
      return p && p.lastCorrect === false;
    });
    S.session = null;
    $('#quizSummary').hidden = true;
    if (!wrongIds.length) { toast('没有需要重做的题'); return; }
    startSession('wrong', wrongIds);
  });
}

/* ===========================================================
   首页
   =========================================================== */
function renderStart() {
  const due = dueCount();
  const nw = newCount();
  const wr = wrongCount();
  $('#dueCount').textContent = due;
  $('#statNew').textContent = nw;
  $('#statTotal').textContent = S.questions.length;
  $('#badgeDue').textContent = due;
  $('#badgeNew').textContent = nw;
  $('#badgeWrong').textContent = wr;
  $('#scopeLine').textContent = scopeText();

  stats.lifetime().then(s => { $('#statStreak').textContent = s.streak || 0; });

  const bits = [];
  if (!S.questions.length) bits.push('题库为空，请检查 ./data 目录');
  if (S.bankWarnings.length) bits.push(`题库提示：${S.bankWarnings[0]}${S.bankWarnings.length > 1 ? ` 等 ${S.bankWarnings.length} 条` : ''}`);
  if (S.settings.lastSync) bits.push(`上次同步 ${fmtRelative(S.settings.lastSync)}`);
  $('#syncTip').textContent = bits.join('｜');
}

/* ===========================================================
   错题本
   =========================================================== */
function renderWrong() {
  const f = S.wrongFilter;
  const chipHost = $('#wrongChips');
  const all = rec.wrongQuestions(S.questions, S.progress, { onlyUnmastered: f.onlyUnmastered });
  $('#wrongCount').textContent = all.length;

  chipHost.innerHTML =
    `<div class="chip ${f.subjects.size ? '' : 'on'}" data-subj="">全部</div>` +
    S.subjectsMeta.map(s => {
      const n = all.filter(x => x.q.subject === s.id).length;
      return `<div class="chip ${f.subjects.has(s.id) ? 'on' : ''}" data-subj="${esc(s.id)}">${esc(s.name)} ${n}</div>`;
    }).join('');

  const list = all.filter(x => !f.subjects.size || f.subjects.has(x.q.subject));
  const host = $('#wrongList');
  const empty = $('#wrongEmpty');

  if (!list.length) {
    host.innerHTML = '';
    empty.hidden = false;
    empty.innerHTML = all.length
      ? '当前筛选下没有错题。'
      : '还没有错题 🎉<br>刷题时答错的题目会自动收进这里。';
    return;
  }
  empty.hidden = true;

  host.innerHTML = list.slice(0, 300).map(({ q, p }) => `
    <div class="item" data-qid="${esc(q.id)}">
      <div class="it-top">
        <span>${esc(q.subjectName || q.subject)} · ${esc(q.chapter)}</span>
        <span class="bad-no">错 ${p.wrongCount} 次${p.lastCorrect === false ? ' · 上次仍错' : ''}</span>
      </div>
      <div class="it-stem">${richText(q.stem)}</div>
      <div class="it-foot">
        ${(q.topics || []).slice(0, 3).map(t => `<span>${esc(t)}</span>`).join('')}
        <span>${fmtRelative(p.lastSeen)}</span>
      </div>
    </div>
  `).join('');
}

/* ===========================================================
   统计
   =========================================================== */
async function renderStats() {
  const ov = stats.progressOverview(S.questions, S.progress);
  const life = await stats.lifetime();
  const today = life.todayDate === dayKey() ? life.todayCount : 0;

  $('#stToday').textContent = `${today}/${S.settings.goal || 40}`;
  $('#stAcc').textContent = pct(life.totalCorrect || 0, life.total || 0);
  $('#stDone').textContent = `${ov.covered}/${S.questions.length}`;
  $('#stStreak').textContent = life.streak || 0;

  const series = await stats.dailySeries({ days: 30 });
  requestAnimationFrame(() => {
    stats.drawBars($('#chartDaily'), stats.toBarRows(series));
    stats.drawLine($('#chartAcc'), stats.toLineRows(series));
  });

  // 科目条
  const bars = S.subjectsMeta.map(sm => {
    const s = ov.bySubject.get(sm.id) || { covered: 0, total: 0, mastered: 0, accuracy: null };
    const done = s.total ? s.covered / s.total : 0;
    return `
      <div class="bar-row">
        <span class="bl">${esc(sm.name)}</span>
        <span class="bar"><i style="width:${Math.round(done * 100)}%"></i></span>
        <span class="bv">${s.covered}/${s.total}</span>
      </div>
      <div class="muted small" style="margin:-6px 0 12px 94px">
        正确率 ${s.accuracy == null ? '—' : pct(Math.round(s.accuracy * 100), 100)} · 已掌握 ${s.mastered} 题
      </div>`;
  }).join('');
  $('#subjectBars').innerHTML = bars || '<div class="muted small">暂无数据</div>';

  // 薄弱知识点
  const wt = rec.weakTopics(S.questions, S.progress, { limit: 12 });
  const wl = $('#weakList');
  if (!wt.length) {
    wl.innerHTML = '<div class="muted small">还没有足够数据。多刷一些题后这里会列出你最容易错的知识点。</div>';
  } else {
    wl.innerHTML = wt.map(e => `
      <div class="weak-item" data-topic="${esc(e.topic)}">
        <span class="wn">${esc(e.topic)}</span>
        <span class="wv">错 ${e.wrong} / 对 ${e.right}</span>
      </div>
    `).join('');
  }
}

/* ===========================================================
   我的
   =========================================================== */
function renderMe() {
  const base = S.questions.filter(q => !q.ai);
  const rows = S.subjectsMeta.map(sm => {
    const qs = base.filter(q => q.subject === sm.id);
    const s = S.subjects.find(x => x.id === sm.id);
    return `<div><b>${esc(sm.name)}</b><span>${qs.length} 题${s && s.version ? ' · v' + esc(s.version) : ''}</span></div>`;
  }).join('');
  const aiN = S.questions.length - base.length;
  $('#bankInfo').innerHTML = rows
    + (aiN ? `<div><b>AI 出题</b><span>${aiN} 题</span></div>` : '')
    + `<div><b>合计</b><span>${S.questions.length} 题</span></div>`;
  renderAiPanel();
}

function fillSettingsForm() {
  const s = S.settings;
  $('#inGoal').value = s.goal;
  $('#inAutoUpdate').checked = !!s.autoUpdate;
  $('#inToken').value = s.token || '';
  $('#inGist').value = s.gistId || '';
  $('#inRepo').value = s.repo || '';
  $('#inBranch').value = s.branch || 'main';
  $('#inMirror').value = s.mirror || 'jsdelivr';
  $('#inAiKey').value = s.aiKey || '';
  $('#inAiModel').value = s.aiModel || 'deepseek-flash';
  $('#inAiFast').checked = s.aiFast !== false;
  $('#inAiAuto').checked = !!s.aiAuto;
  $('#inAiDailyLimit').value = s.aiDailyLimit ?? 5;
}

/* ===========================================================
   AI 出题
   =========================================================== */
async function generateSimilarForCurrent(btn) {
  const st = S.quiz;
  if (!st || !st.q) return;
  const q = st.q;

  btn.disabled = true;
  btn.textContent = '正在生成…';
  try {
    const { question } = await ai.generateSimilar(q, S.settings, {
      onStage: t => { btn.textContent = t; },
    });

    await store.aiPut(question);
    S.questions.push(question);
    S.byId.set(question.id, question);

    // 插到当前题后面：评分完点"下一题"就是它
    if (S.session) {
      const at = Math.min(S.session.idx + 1, S.session.queue.length);
      S.session.queue.splice(at, 0, question.id);
    }

    btn.textContent = '✓ 已生成，下一题就是它';
    btn.classList.add('primary');
    renderMe();
    toast('AI 题目已生成', 2400);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'AI 出同类题（重试）';
    toast('AI 出题失败：' + e.message, 4500);
  }
}

/* ---------------- 自动出题调度 ---------------- */
let autoAiTimer = null;

function scheduleAutoAi(delay = 6000, max = 2) {
  if (!S.settings.aiAuto || !S.settings.aiKey) return;
  clearTimeout(autoAiTimer);
  autoAiTimer = setTimeout(() => { runAutoAi(max); }, delay);
}

async function runAutoAi(max = 3, { force = false } = {}) {
  if (!S.settings.aiKey) {
    toast('请先填写 DeepSeek API Key');
    return { ran: 0 };
  }
  if (!force && !S.settings.aiAuto) return { ran: 0 };

  // 手动点"立即生成"时，即使开关没开也允许跑
  const settings = force ? { ...S.settings, aiAuto: true } : S.settings;

  const res = await autoAi.tick({
    questions: S.questions,
    progress: S.progress,
    settings,
  }, {
    max,
    onGenerated: async (q, target) => {
      await store.aiPut(q);
      S.questions.push(q);
      S.byId.set(q.id, q);
      S.aiCount = S.questions.filter(x => x.ai).length;
      renderStart();
      renderWrong();
      toast(`AI 出了一道「${target.topic}」的新题`, 2600);
    },
    onStatus: ({ state, ran, reason, error }) => renderAiPanel(state, reason, error),
  });

  renderStart();
  renderAiPanel();
  return res;
}

async function renderAiPanel(state, reason, isError) {
  const host = $('#aiStatus');
  if (!host) return;
  const st = state || await autoAi.loadState();
  const total = S.questions.filter(q => q.ai).length;
  const limit = Number(S.settings.aiDailyLimit) || 0;

  const rows = [
    ['今日生成', `${st.madeToday || 0} / ${limit} 道`],
    ['AI 题库', `${total} 道`],
    ['上次运行', st.lastRun ? fmtRelative(st.lastRun) : '还没跑过'],
  ];
  if (st.lastTopic) rows.push(['最近补题', st.lastTopic]);
  host.innerHTML = rows.map(([k, v]) => `<div><b>${esc(k)}</b><span>${esc(v)}</span></div>`).join('');

  const noteEl = $('#aiNote');
  if (!noteEl) return;

  let note = '';
  let cls = 'muted small';
  if (st.disabled) {
    note = '⚠️ 已自动暂停：' + (st.lastError || '未知错误') + '（重新打开开关即可恢复）';
    cls = 'small';
  } else if (isError && reason) {
    note = '⚠️ ' + reason;
  } else if (!S.settings.aiKey) {
    note = '还没填 API Key';
  } else if (!S.settings.aiAuto) {
    note = '自动出题未开启。开启后会在你答错题时自动补题。';
  } else {
    const gate = autoAi.canRun(st, S.settings);
    note = gate.ok ? '空闲中，会在你答错题后自动补题' : gate.why;
  }
  noteEl.className = cls;
  noteEl.textContent = note;
}

/* ===========================================================
   题库更新 / 同步
   =========================================================== */
async function checkBankUpdate({ silent = false } = {}) {
  const msg = $('#bankMsg');
  const say = t => { if (msg) msg.textContent = t; if (!silent) toast(t, 2600); };
  try {
    say('正在检查更新…');
    const { base, manifest } = await bank.checkUpdate(S.settings);
    const res = await bank.applyUpdate(base, manifest, {
      onProgress: (i, n, sid) => say(`下载中 ${i + 1}/${n}：${sid}`),
    });
    if (!res.changed.length) {
      say('已是最新题库');
    } else {
      say(`更新完成：${res.changed.length} 个科目，新增 ${res.added} 题`);
      const r = await bank.loadBank(S.subjectsMeta);
      applyBankResult(r);
      renderStart(); renderWrong(); renderStats(); renderMe();
    }
    await saveSettings({ lastUpdate: Date.now(), bankVersion: manifest.version || '' });
  } catch (e) {
    say('检查更新失败：' + e.message);
  }
}

async function autoSync() {
  try {
    const res = await sync.sync({ token: S.settings.token, gistId: S.settings.gistId });
    await saveSettings({ gistId: res.gistId, lastSync: Date.now() });
    await refreshProgress();
    renderStart(); renderWrong(); renderStats();
  } catch (e) {
    console.warn('自动同步失败', e);
  }
}

/* ===========================================================
   视图切换
   =========================================================== */
const VIEW_TITLES = { practice: '刷题', wrong: '错题本', stats: '统计', me: '我的' };

function showView(name) {
  S.view = name;
  document.querySelectorAll('.view').forEach(v => {
    v.hidden = v.id !== `view-${name}`;
  });
  document.querySelectorAll('.tabbar .tab').forEach(t => {
    t.classList.toggle('active', t.dataset.view === name);
  });
  $('#viewTitle').textContent = VIEW_TITLES[name] || '408';
  $('#viewSub').textContent = name === 'practice' ? scopeText().replace(/^范围：/, '') : '';
  $('#btnScope').style.visibility = name === 'practice' ? 'visible' : 'hidden';
  if (name === 'stats') renderStats();
  if (name === 'wrong') renderWrong();
  if (name === 'me') renderMe();
  window.scrollTo(0, 0);
}

/* ===========================================================
   范围选择弹层
   =========================================================== */
function renderScopeSheet() {
  const sc = S.scope;

  $('#scopeSubjects').innerHTML = S.subjectsMeta.map(s =>
    `<div class="chip ${sc.subjects.has(s.id) ? 'on' : ''}" data-sc-subj="${esc(s.id)}">${esc(s.name)}</div>`
  ).join('');

  const visibleSubjects = sc.subjects.size ? S.subjectsMeta.filter(s => sc.subjects.has(s.id)) : S.subjectsMeta;
  $('#scopeChapters').innerHTML = visibleSubjects.map(s => `
    <div class="sec-title" style="margin-top:10px">${esc(s.name)}</div>
    <div class="chips">
      ${(s.chapters || []).map(c =>
    `<div class="chip ${sc.chapters.has(c) ? 'on' : ''}" data-sc-chap="${esc(c)}">${esc(c)}</div>`
  ).join('')}
    </div>
  `).join('');

  $('#scopeDiff').innerHTML = [1, 2, 3, 4, 5].map(d =>
    `<div class="chip ${sc.diff.has(String(d)) ? 'on' : ''}" data-sc-diff="${d}">${DIFF_LABELS[d]}</div>`
  ).join('');

  $('#scopeLimit').innerHTML = LIMIT_CHOICES.map(n =>
    `<div class="chip ${sc.limit === n ? 'on' : ''}" data-sc-limit="${n}">${n} 题</div>`
  ).join('');
}

/* ===========================================================
   事件绑定
   =========================================================== */
function bindGlobalEvents() {
  // 底栏
  document.querySelector('.tabbar').addEventListener('click', e => {
    const t = e.target.closest('.tab');
    if (!t) return;
    if (S.session && S.view === 'practice') {
      if (!confirm('正在刷题，确定要离开吗？进度已保存到当前题。')) return;
      endSession(false);
    }
    showView(t.dataset.view);
  });

  // 开始按钮
  $('#startScreen').addEventListener('click', e => {
    const b = e.target.closest('[data-mode]');
    if (!b) return;
    startSession(b.dataset.mode);
  });

  // 选项
  $('#qOptions').addEventListener('click', e => {
    const o = e.target.closest('.opt');
    if (o) onPickOption(o.dataset.key);
  });

  // 填空题提交
  $('#btnFillSubmit').addEventListener('click', () => submitAnswer([$('#fillInput').value]));
  $('#fillInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); submitAnswer([$('#fillInput').value]); }
  });

  // 简答题参考 / AI 出题
  $('#quizFoot').addEventListener('click', async e => {
    if (e.target.closest('#btnAiGen')) {
      await generateSimilarForCurrent(e.target.closest('#btnAiGen'));
      return;
    }
    if (e.target.closest('#btnShowRef')) {
      S.quiz.answered = true;
      S.quiz.ts = Date.now();
      S.quiz.ms = S.quiz.ts - S.quiz.shownAt;
      const q = S.quiz.q;
      const fb = $('#qFeedback');
      fb.className = 'card feedback';
      fb.innerHTML = `
        <div class="fb-head">参考答案</div>
        <div class="fb-exp">${richText(q.answer.join('\n'))}</div>
        <div class="fb-exp" style="margin-top:10px"><b>解析：</b>${q.explain ? richText(q.explain) : '<span class="muted">暂无解析</span>'}</div>
        <div class="muted small" style="margin-top:10px">对照上面内容自评，然后选择你认为的掌握程度 👇</div>`;
      fb.hidden = false;
      $('#quizFoot').innerHTML = `
        <button class="btn" id="btnSelfNo">没答对</button>
        <button class="btn primary" id="btnSelfYes">答对了</button>`;
      $('#btnSelfNo').addEventListener('click', () => { S.quiz.correct = false; revealSrs(); });
      $('#btnSelfYes').addEventListener('click', () => { S.quiz.correct = true; revealSrs(); });
    }
  });

  // SRS 评分
  $('#srsRow').addEventListener('click', e => {
    const b = e.target.closest('.srs');
    if (b) commitGrade(Number(b.dataset.grade));
  });

  // 结束本轮
  $('#btnQuit').addEventListener('click', () => {
    if (S.session && (S.session.ok + S.session.no) > 0) {
      if (!confirm('结束本轮并查看成绩？')) return;
      finishSession();
    } else {
      endSession(false);
    }
  });

  // 范围弹层
  $('#btnScope').addEventListener('click', () => { renderScopeSheet(); openSheet('#scopeSheet'); });
  $('#scopeSheet').addEventListener('click', e => {
    if (e.target.closest('[data-close]')) return closeSheet('#scopeSheet');
    const c = e.target.closest('.chip');
    if (!c) return;
    const sc = S.scope;
    if (c.dataset.scSubj !== undefined) { toggle(sc.subjects, c.dataset.scSubj); renderScopeSheet(); }
    else if (c.dataset.scChap !== undefined) { toggle(sc.chapters, c.dataset.scChap); renderScopeSheet(); }
    else if (c.dataset.scDiff !== undefined) { toggle(sc.diff, c.dataset.scDiff); renderScopeSheet(); }
    else if (c.dataset.scLimit !== undefined) { sc.limit = Number(c.dataset.scLimit); renderScopeSheet(); }
  });
  $('#btnScopeReset').addEventListener('click', () => {
    S.scope = { subjects: new Set(), chapters: new Set(), diff: new Set(), limit: 20 };
    renderScopeSheet();
  });
  $('#btnScopeApply').addEventListener('click', () => {
    closeSheet('#scopeSheet');
    renderStart();
    $('#viewSub').textContent = scopeText().replace(/^范围：/, '');
    toast('范围已更新');
  });

  // 错题本
  $('#wrongChips').addEventListener('click', e => {
    const c = e.target.closest('.chip');
    if (!c) return;
    const id = c.dataset.subj;
    if (!id) S.wrongFilter.subjects.clear();
    else toggle(S.wrongFilter.subjects, id);
    renderWrong();
  });
  $('#wrongOnlyUnmastered').addEventListener('change', e => {
    S.wrongFilter.onlyUnmastered = e.target.checked;
    renderWrong();
  });
  $('#wrongList').addEventListener('click', e => {
    const it = e.target.closest('.item');
    if (it) startSession('wrong', [it.dataset.qid]);
  });
  $('#btnRedoWrong').addEventListener('click', () => startSession('wrong'));
  $('#btnPushFromWrong').addEventListener('click', () => {
    const wrongs = rec.wrongQuestions(S.questions, S.progress, { onlyUnmastered: true });
    if (!wrongs.length) return toast('还没有错题，先刷点题吧');
    const topics = uniq(wrongs.flatMap(x => x.q.topics || []));
    const list = rec.recommendNew(S.questions, S.progress, { topics, limit: S.scope.limit });
    if (!list.length) return toast('这些知识点的相关新题已经做完了');
    toast(`根据 ${topics.length} 个薄弱知识点挑了 ${list.length} 道新题`, 2400);
    showView('practice');
    startSession('weak', list.map(q => q.id));
  });

  // 统计：点击薄弱知识点
  $('#weakList').addEventListener('click', e => {
    const it = e.target.closest('.weak-item');
    if (!it) return;
    const topic = it.dataset.topic;
    const list = rec.recommendNew(S.questions, S.progress, { topics: [topic], limit: S.scope.limit });
    if (!list.length) {
      const fallback = rec.byTopics(S.questions, [topic]).filter(q => {
        const p = S.progress.get(q.id); return !p || !p.reps;
      });
      if (!fallback.length) return toast('这个知识点暂时没有可推的新题');
      showView('practice'); return startSession('weak', fallback.slice(0, S.scope.limit).map(q => q.id));
    }
    showView('practice');
    startSession('weak', list.map(q => q.id));
  });

  // 我的 —— 表单
  const saveNum = debounce(async () => {
    await saveSettings({ goal: Math.max(1, Number($('#inGoal').value) || 40) });
    renderStats();
  }, 500);
  $('#inGoal').addEventListener('input', saveNum);
  $('#inAutoUpdate').addEventListener('change', e => saveSettings({ autoUpdate: e.target.checked }));
  $('#inToken').addEventListener('change', e => saveSettings({ token: e.target.value.trim() }));
  $('#inGist').addEventListener('change', e => saveSettings({ gistId: e.target.value.trim() }));
  $('#inRepo').addEventListener('change', e => saveSettings({ repo: e.target.value.trim() }));
  $('#inBranch').addEventListener('change', e => saveSettings({ branch: e.target.value.trim() || 'main' }));
  $('#inMirror').addEventListener('change', e => saveSettings({ mirror: e.target.value }));

  // 我的 —— AI 出题
  $('#inAiKey').addEventListener('change', e => saveSettings({ aiKey: e.target.value.trim() }));
  $('#inAiModel').addEventListener('change', e => saveSettings({ aiModel: e.target.value }));
  $('#inAiFast').addEventListener('change', e => saveSettings({ aiFast: e.target.checked }));

  $('#inAiAuto').addEventListener('change', async e => {
    const on = e.target.checked;
    await saveSettings({ aiAuto: on });
    if (on) {
      // 用户重新打开，说明之前的错误可能已经解决，清掉暂停标记
      await autoAi.saveState(autoAi.reenable(await autoAi.loadState()));
      toast('已开启自动出题，会在后台根据错题补充新题', 3000);
      scheduleAutoAi(3000, 3);
    } else {
      clearTimeout(autoAiTimer);
    }
    renderAiPanel();
  });

  $('#inAiDailyLimit').addEventListener('change', async e => {
    const n = Math.min(50, Math.max(0, Math.round(Number(e.target.value) || 0)));
    e.target.value = n;
    await saveSettings({ aiDailyLimit: n });
    renderAiPanel();
  });

  $('#btnAiRun').addEventListener('click', async () => {
    const btn = $('#btnAiRun');
    btn.disabled = true;
    btn.textContent = '生成中…';
    $('#aiNote').textContent = '正在根据错题生成…';
    try {
      const res = await runAutoAi(3, { force: true });
      if (!res.ran) toast('这次没有生成新题：' + (res.reason || '原因未知'), 3200);
      else toast(`已生成 ${res.ran} 道新题`, 2600);
    } catch (err) {
      toast('生成失败：' + err.message, 4000);
    } finally {
      btn.disabled = false;
      btn.textContent = '立即生成一批';
      renderAiPanel();
    }
  });

  $('#btnAiTest').addEventListener('click', async () => {
    const msg = $('#aiMsg');
    msg.textContent = '正在测试连接…';
    try {
      const r = await ai.testConnection(S.settings);
      const tok = r.usage ? ` · 本次用量 ${r.usage.total_tokens ?? '?'} tokens` : '';
      msg.textContent = `连接正常 · 模型 ${r.model}${tok}`;
      toast('DeepSeek 连接正常');
    } catch (err) {
      msg.textContent = '连接失败：' + err.message;
      toast('连接失败', 2600);
    }
  });

  $('#btnAiClear').addEventListener('click', async () => {
    const n = S.questions.filter(q => q.ai).length;
    if (!n) { toast('AI 题库已经是空的'); return; }
    if (!confirm(`确定删除全部 ${n} 道 AI 生成的题？此操作不可撤销。`)) return;
    await store.aiClear();
    // 清掉每个知识点的已生成计数，之后还能重新补题
    const st = await autoAi.loadState();
    st.topics = {};
    await autoAi.saveState(st);

    S.questions = S.questions.filter(q => !q.ai);
    for (const [id, q] of [...S.byId]) if (q.ai) S.byId.delete(id);
    if (S.session) S.session.queue = S.session.queue.filter(id => S.byId.has(id));
    S.aiCount = 0;
    renderStart(); renderWrong(); renderStats(); renderMe();
    toast('已清空 AI 题库');
  });

  // 我的 —— 题库
  $('#btnUpdateBank').addEventListener('click', () => checkBankUpdate({ silent: false }));
  $('#btnReloadBank').addEventListener('click', async () => {
    $('#bankMsg').textContent = '正在重新加载本地题库…';
    try {
      const r = await bank.reloadLocal(S.subjectsMeta);
      applyBankResult(r);
      $('#bankMsg').textContent = `已重载 ${S.questions.length} 题`;
      renderStart(); renderWrong(); renderStats(); renderMe();
    } catch (e) {
      $('#bankMsg').textContent = '重载失败：' + e.message;
    }
  });

  // 我的 —— 同步
  const doSync = async fn => {
    try {
      $('#syncMsg').textContent = '同步中…';
      const res = await fn({ token: S.settings.token, gistId: S.settings.gistId, onStep: t => { $('#syncMsg').textContent = t; } });
      if (res.gistId) await saveSettings({ gistId: res.gistId, lastSync: Date.now() });
      $('#inGist').value = S.settings.gistId || '';
      await refreshProgress();
      renderStart(); renderWrong(); renderStats();
      const p = res.pulled || { progress: 0, logs: 0 };
      const u = res.pushed || { progress: 0, logs: 0 };
      $('#syncMsg').textContent = `同步完成 · 下载 ${p.progress || 0} 条进度 / ${p.logs || 0} 条记录，上传 ${u.progress || 0} 条进度 / ${u.logs || 0} 条记录`;
      toast('同步完成');
    } catch (e) {
      $('#syncMsg').textContent = '同步失败：' + e.message;
      toast('同步失败', 2600);
    }
  };
  $('#btnSyncNow').addEventListener('click', () => doSync(sync.sync));
  $('#btnPush').addEventListener('click', () => doSync(sync.pushOnly));
  $('#btnPull').addEventListener('click', () => doSync(sync.pullOnly));

  // 我的 —— 数据
  $('#btnExport').addEventListener('click', async () => {
    const data = await store.exportAll({ withSecrets: true });
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `kaoyan408-${dayKey()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('已导出');
  });
  $('#btnImport').addEventListener('click', () => $('#fileImport').click());
  $('#fileImport').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const st = await store.importAll(data, { merge: true });
      await refreshProgress();
      renderStart(); renderWrong(); renderStats();
      toast(`导入完成：进度 ${st.progress} 条，记录 ${st.logs} 条`, 2600);
    } catch (err) {
      toast('导入失败：' + err.message, 3000);
    }
    e.target.value = '';
  });
  $('#btnReset').addEventListener('click', async () => {
    if (!confirm('确定清空所有学习进度？此操作不可撤销。')) return;
    await store.resetProgress();
    await store.metaSet('stats', { total: 0, totalCorrect: 0, streak: 0, lastDate: '', todayDate: '', todayCount: 0, todayCorrect: 0 });
    await refreshProgress();
    renderStart(); renderWrong(); renderStats();
    toast('已清空');
  });

  // 窗口尺寸变化时重绘统计图（手机转屏、桌面缩放都会触发）
  window.addEventListener('resize', debounce(() => {
    if (S.view === 'stats') renderStats();
  }, 300));

  // 键盘（桌面端）
  document.addEventListener('keydown', e => {
    if (S.view !== 'practice' || !S.session) return;
    const st = S.quiz;
    if (!st || !st.q) return;
    if (st.answered && !st.committed) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#btnNext')?.click(); return; }
      const n = Number(e.key);
      if (n >= 1 && n <= 4) { e.preventDefault(); commitGrade(n - 1); return; }
    }
    if (!st.answered && st.q.options) {
      const k = e.key.toUpperCase();
      if (/^[A-D]$/.test(k) && st.q.options.some(o => o.key === k)) { e.preventDefault(); onPickOption(k); }
    }
  });
}

function toggle(set, v) { set.has(v) ? set.delete(v) : set.add(v); }

/* 简答题自评后展示评分按钮 */
function revealSrs() {
  $('#quizFoot').innerHTML = '';
  renderSrsRow();
  $('#qFeedback')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* 启动 */
boot();
