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
  // 复习节奏：默认按遗忘曲线（答错的题当天不再安排，隔天再见）
  pacing: 'curve',
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
  aiFixes: [],
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
  S.aiFixes = await store.metaGet('aiFixes', []);
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

/**
 * 重新从本地库加载 AI 题。
 * 同步（拉取）之后必须调一次：否则从别的设备拉下来的 AI 题要重启 App 才能看到。
 */
async function reloadAiQuestions() {
  S.questions = S.questions.filter(q => !q.ai);
  for (const [id, q] of [...S.byId]) if (q.ai) S.byId.delete(id);
  await loadAiQuestions();
  // 会话队列里已经不存在的题要剔掉，否则会卡住
  if (S.session) S.session.queue = S.session.queue.filter(id => S.byId.has(id));
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
  const doRegister = () => {
    navigator.serviceWorker.register('./sw.js').catch(err => {
      // 不要静默吞掉：注册失败会直接导致「离线可用」和「添加到主屏幕」失效
      console.warn('[408] Service Worker 注册失败，离线缓存将不可用：', err);
    });
  };
  // 要兼容两种时序：load 还没触发，又或者已经触发过了
  if (document.readyState === 'complete') doRegister();
  else window.addEventListener('load', doRegister, { once: true });
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
  if (q.aiFixedAt) tagBits.push(`<span class="pill ai">答案已纠正为 ${esc((q.answer || []).join(''))}</span>`);
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
  const ivls = srs.previewIntervals(prev, st.ts || Date.now(), { pacing: S.settings.pacing });
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
  // AI 生成的题允许上报答案错误（已经人工纠正过就不再重复报）
  if (q.ai && !q.aiFixedAt) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn';
    b.id = 'btnAiFix';
    b.textContent = '答案有误';
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
  const cur = srs.schedule(prev, grade, st.ts || Date.now(), { pacing: S.settings.pacing });
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
  // 只有"当天巩固"模式才在本轮内重排；
  // "按遗忘曲线"模式下答错的题最早次日才出现，本轮不再重考。
  const cramMode = S.settings.pacing === srs.PACING.CRAM;
  if (cramMode && cur.due - Date.now() <= REQUEUE_WINDOW) {
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
  $('#inPacing').value = s.pacing || 'curve';
  updatePacingHint();
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
      fixes: S.aiFixes,
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
    autoSyncSoon();        // 尽快把新题传上去，别只留在本机
    toast('AI 题目已生成', 2400);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'AI 出同类题（重试）';
    toast('AI 出题失败：' + e.message, 4500);
  }
}

/* ---------------- AI 答案纠错 ---------------- */
let fixPicked = null;      // 手动选中的正确选项
let recheckPending = null; // AI 重算得出的选项，等用户点头采纳
const AI_FIX_KEEP = 20;

/** 展开纠错面板（就地在答题页操作，不用跳页） */
function openFixPanel() {
  const st = S.quiz;
  if (!st || !st.q) return;
  const q = st.q;
  fixPicked = null;
  recheckPending = null;
  const letters = (q.options || []).map(o => o.key);
  const canAskAi = !!(S.settings.aiKey && S.settings.aiEnabled);
  $('#quizFoot').innerHTML = `
    <div class="fix-panel">
      <div class="fix-row">
        这道题 AI 给的答案是 <b>${esc((q.answer || []).join(''))}</b>。
        你知道正确答案就点下面，拿不准就让 AI 重算一遍：
      </div>
      <div class="chips" id="fixLetters">
        ${letters.map(k => `<div class="chip" data-fix="${esc(k)}">${esc(k)}</div>`).join('')}
      </div>
      <input class="input" id="fixNote" type="text" autocomplete="off"
             placeholder="补充说明（可选）：比如错在哪、为什么" style="margin-top:8px">
      <div class="fix-result" id="fixResult" hidden></div>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn" id="fixCancel" type="button">取消</button>
        <button class="btn" id="fixRecheck" type="button"${canAskAi ? '' : ' disabled'}>AI 重算</button>
        <button class="btn danger" id="fixDelete" type="button">删掉这题</button>
      </div>
      <div class="btn-row" style="margin-top:8px">
        <button class="btn primary" id="fixSubmit" type="button">按上面选的答案纠正</button>
      </div>
      ${canAskAi ? '' : '<div class="muted small">未配置 API Key，「AI 重算」不可用</div>'}
    </div>`;
}

/** 提交纠正：就地改答案 + 记入纠正历史（之后会作为反面例子发给 AI） */
async function submitFix() {
  if (!fixPicked) { toast('先点一下正确的选项'); return; }
  const q = S.quiz && S.quiz.q;
  if (q && fixPicked === (q.answer || []).join('')) { toast('和原答案一样，不用纠正'); return; }
  await applyFixAnswer(fixPicked, fixNote(), '');
}

/**
 * 让 AI 抛开原答案独立重算一遍（用户拿不准答案时用）。
 * AI 算出来和原答案一致 → 告诉用户原答案没问题；
 * 不一致 → 给个「采纳」按钮，由用户拍板，绝不自动改。
 */
async function recheckCurrent(btn) {
  const st = S.quiz;
  if (!st || !st.q) return;
  const box = $('#fixResult');
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '重算中…';
  if (box) {
    box.hidden = false;
    box.className = 'fix-result';
    box.innerHTML = '<span class="muted">AI 正在独立重算这道题（通常 10~30 秒）…</span>';
  }

  try {
    const r = await ai.recheckQuestion(st.q, S.settings, { fixes: S.aiFixes });
    const current = (st.q.answer || []).join('');
    const conf = { high: '较有把握', medium: '一般', low: '不太确定' }[r.confidence] || '一般';
    const body = `<div class="fix-reason">${richText(r.reason)}</div>`;

    if (r.answer === current) {
      recheckPending = null;
      box.className = 'fix-result same';
      box.innerHTML =
        `<div class="fix-head">AI 独立重算后，答案仍然是 <b>${esc(r.answer)}</b>（${conf}）</div>`
        + body
        + '<div class="muted small">它算得和你一样，那这道题多半没错 —— 是你自己看错了，回头对着解析再想一遍。</div>';
    } else {
      recheckPending = r.answer;
      box.className = 'fix-result differ';
      box.innerHTML =
        `<div class="fix-head">AI 重算得出 <b>${esc(r.answer)}</b>，但题库里写的是 <b>${esc(current)}</b>（${conf}）</div>`
        + body
        + '<div class="muted small">核对一下它的推导，如果没问题就采纳（改动会记下来，以后的 AI 题不会重复这个错）。</div>'
        + `<div class="btn-row" style="margin-top:8px">
             <button class="btn primary" id="fixAdopt" type="button">采纳 ${esc(r.answer)}</button>
           </div>`;
    }
  } catch (e) {
    recheckPending = null;
    if (box) {
      box.className = 'fix-result err';
      box.textContent = '重算失败：' + e.message;
    }
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

/** 采纳 AI 重算的结果 */
async function adoptRecheck() {
  if (!recheckPending) return;
  const note = fixNote();
  await applyFixAnswer(recheckPending, note, 'AI 重算');
}

function fixNote() {
  return String(($('#fixNote') || {}).value || '').trim();
}

/** 真正落地一次纠正：改题、存库、记历史、刷新界面 */
async function applyFixAnswer(picked, note, tag) {
  const st = S.quiz;
  if (!st || !st.q) return;
  const q = st.q;
  const from = (q.answer || []).join('');
  if (picked === from) { toast('和原答案一样，不用纠正'); return; }

  const why = [tag, note].filter(Boolean).join('，');
  const fixed = {
    ...q,
    answer: [picked],
    aiOriginalAnswer: from,
    aiFixNote: why,
    aiFixedAt: Date.now(),
    aiFixedBy: tag || 'manual',
    explain: `⚠️ 本题原答案 ${from} 有误，已改为 ${picked}${tag ? `（${tag}）` : ''}。`
      + (note ? `\n纠正说明：${note}` : '')
      + `\n\n—— 以下是模型原来的解析，仅供参考 ——\n${q.explain || ''}`,
  };

  await store.aiPut(fixed);
  S.byId.set(fixed.id, fixed);
  const idx = S.questions.findIndex(x => x.id === fixed.id);
  if (idx >= 0) S.questions[idx] = fixed;

  const list = [{
    qid: fixed.id,
    stem: String(q.stem).slice(0, 42),
    from,
    to: picked,
    note: why,
    at: Date.now(),
  }, ...(S.aiFixes || [])].slice(0, AI_FIX_KEEP);
  S.aiFixes = list;
  await store.metaSet('aiFixes', list);

  // 用户当时选的其实就是正确答案，说明他本来就对，把对错判定一起纠回来
  const wasRight = st.picked && st.picked.size === 1 && [...st.picked][0] === picked;
  st.q = fixed;
  if (wasRight) st.correct = true;
  showFeedback();

  renderStart(); renderWrong(); renderMe();
  autoSyncSoon();
  toast(`已纠正为 ${picked}，之后的 AI 出题会参考它`, 3200);
}

/** 直接删掉这道 AI 题（答案错得没法救时用） */
async function deleteAiQuestion() {
  const st = S.quiz;
  const q = st && st.q;
  if (!q) return;
  if (!confirm('从题库里彻底删掉这道题？答题记录也会一起清掉。')) return;

  await store.aiDelete(q.id);
  try { await store.del('progress', q.id); } catch (_) { /* 可能本来就没有记录 */ }
  try { await store.deleteLogsByQid(q.id); } catch (_) { /* 同上 */ }

  S.byId.delete(q.id);
  S.questions = S.questions.filter(x => x.id !== q.id);
  S.progress.delete(q.id);
  S.aiCount = S.questions.filter(x => x.ai).length;

  // 队列里也要剔掉，否则下一轮会卡在一个不存在的题上
  if (S.session) S.session.queue = S.session.queue.filter(id => S.byId.has(id));

  renderStart(); renderWrong(); renderStats(); renderMe();
  autoSyncSoon();
  toast('已删除这道题');
  if (S.session) renderQuiz();
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
    fixes: S.aiFixes,
  }, {
    max,
    onGenerated: async (q, target) => {
      await store.aiPut(q);
      S.questions.push(q);
      S.byId.set(q.id, q);
      S.aiCount = S.questions.filter(x => x.ai).length;
      renderStart();
      renderWrong();
      autoSyncSoon();
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
  const fixN = (S.aiFixes || []).length;
  if (fixN) rows.push(['已纠正', `${fixN} 道（会作为反面例子告诉 AI）`]);
  host.innerHTML = rows.map(([k, v]) => `<div><b>${esc(k)}</b><span>${esc(v)}</span></div>`).join('');

  const noteEl = $('#aiNote');
  if (!noteEl) return;

  let note = '';
  let cls = 'muted small';
  const syncReady = !!(S.settings.token && S.settings.gistId);

  if (total > 0 && !syncReady) {
    // 这是最容易踩的坑：题生成了，但同步没配好，新题永远出不去，
    // 而界面上看不出任何异常。所以这里要主动、显眼地告诉用户。
    note = `⚠️ 这 ${total} 道 AI 题目前只存在本机。到下面「多设备同步」填好 Token 并点一次`
      + `「立即同步」，之后新生成的题就会自动上传到 GitHub。`;
    cls = 'small';
  } else if (st.disabled) {
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
    const synced = syncReady
      ? (S.settings.lastSync ? `；已开启自动同步（上次 ${fmtRelative(S.settings.lastSync)}）` : '；已开启自动同步')
      : '';
    note = gate.ok ? ('空闲中，会在你答错题后自动补题' + synced) : gate.why;
  }
  noteEl.className = cls;
  noteEl.textContent = note;
}

/* ===========================================================
   复习节奏
   =========================================================== */
function updatePacingHint() {
  const el = $('#pacingHint');
  if (!el) return;
  const curve = (S.settings.pacing || 'curve') !== srs.PACING.CRAM;
  el.textContent = curve
    ? '答错的题当天不再出现。复习间隔走 1 天 → 3 天 → 7 天 → 17 天 → 43 天…，中间再答错就退回 1 天重新爬。'
    : '答错的题本轮会再练一遍（1 分钟 → 10 分钟 → 次日），之后再按天数逐级拉长。适合时间紧、想当天就把题吃透。';
}

/** 切到"遗忘曲线"时，把还卡在分钟级阶梯里的题顺延到次日 */
async function migrateLearningToCurve() {
  const all = await store.getAll('progress');
  const now = Date.now();
  const rows = [];
  for (const p of all) {
    if (p.state !== srs.STATE.LEARNING && p.state !== srs.STATE.RELEARN) continue;
    if (!p.due || p.due - now >= srs.DAY_MS) continue;
    rows.push({
      ...p,
      state: srs.STATE.LEARNING,
      step: 0,
      interval: 1,
      due: now + srs.DAY_MS,
      updated: now,
    });
  }
  if (rows.length) await store.bulkPut('progress', rows);
  return rows.length;
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
    await reloadAiQuestions();   // AI 题也在同步范围内，拉到的要立刻可用
    renderStart(); renderWrong(); renderStats(); renderMe();
  } catch (e) {
    console.warn('自动同步失败', e);
  }
}

/**
 * AI 出题之后延迟自动上传。
 * 没有这个的话，手机上刚生成的题会一直只留在本机，
 * 要等下次启动 App 或手动点同步才会传上去。
 */
let syncTimer = null;
function autoSyncSoon(delay = 25000) {
  if (!S.settings.token || !S.settings.gistId) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { autoSync(); }, delay);
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
    if (e.target.closest('#btnAiFix')) { openFixPanel(); return; }
    if (e.target.closest('#fixCancel')) { recheckPending = null; renderSrsRow(); return; }
    if (e.target.closest('#fixRecheck')) { await recheckCurrent(e.target.closest('#fixRecheck')); return; }
    if (e.target.closest('#fixAdopt')) { await adoptRecheck(); return; }
    if (e.target.closest('#fixSubmit')) { await submitFix(); return; }
    if (e.target.closest('#fixDelete')) { await deleteAiQuestion(); return; }
    const fixChip = e.target.closest('#fixLetters .chip');
    if (fixChip) {
      fixPicked = fixChip.dataset.fix;
      document.querySelectorAll('#fixLetters .chip').forEach(c =>
        c.classList.toggle('on', c.dataset.fix === fixPicked));
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

  $('#inPacing').addEventListener('change', async e => {
    const v = e.target.value;
    await saveSettings({ pacing: v });
    if (v === srs.PACING.CURVE) {
      // 否则那些已经排到 1~10 分钟后的题会立刻冒出来，和"不要当日就做"矛盾
      const n = await migrateLearningToCurve();
      await refreshProgress();
      renderStart();
      if (n) toast(`已把 ${n} 道还在当天巩固的题顺延到明天`, 3000);
    }
    updatePacingHint();
    renderStats();
  });
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
    // 纠正历史也一起清掉
    S.aiFixes = [];
    await store.metaSet('aiFixes', []);

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
      await reloadAiQuestions();   // 拉到的 AI 题立刻可用，不用重启 App
      renderStart(); renderWrong(); renderStats(); renderMe();
      const p = res.pulled || { progress: 0, logs: 0, ai: 0 };
      const u = res.pushed || { progress: 0, logs: 0, ai: 0 };
      $('#syncMsg').textContent =
        `同步完成 · 下载 ${p.progress || 0} 条进度 / ${p.logs || 0} 条记录 / ${p.ai || 0} 道 AI 题，`
        + `上传 ${u.progress || 0} 条进度 / ${u.logs || 0} 条记录 / ${u.ai || 0} 道 AI 题`;
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
// Service Worker 必须尽早注册：boot() 里有一堆 await（IndexedDB、题库加载），
// 如果放到 boot() 末尾再挂 load 监听器，那时 load 事件早已触发，注册永远不会执行，
// 这正是之前线上"离线可用"失效的原因。
registerSW();
boot();
