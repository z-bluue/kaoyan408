/* ===========================================================
   AI 出题 —— 调用 DeepSeek 现场生成同知识点的新题

   已验证：api.deepseek.com 允许浏览器直接跨域调用，无需中转服务器。
   文档：https://api-docs.deepseek.com/api/create-chat-completion
   =========================================================== */

const ENDPOINT = 'https://api.deepseek.com/chat/completions';

export const AI_MODELS = [
  { id: 'deepseek-flash', name: 'deepseek-flash（快、便宜，推荐）' },
  { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro（更强、更贵）' },
];

/* ---------------- 提示词 ---------------- */
// 注意：DeepSeek 的 JSON 模式要求提示词里出现 "json" 字样，并给出格式示例。
const SYSTEM_PROMPT = `你是一位资深的考研计算机学科专业基础综合（408）命题老师，负责编写高质量的单项选择题。

你的任务：根据用户提供的**错题**（可能是一道，也可能是同知识点的多道），先诊断他薄弱的地方，再编写一道**考查相同知识点、难度相当的全新题目**。

如果用户告知了"学生当时选错成"哪个选项，说明他在这个点上存在具体误解（比如算错了一步、漏了某个条件、混淆了两个概念、忽略了边界情况）。你必须**针对那个误解设计题干情境和迷惑项**，让他下次能真正分清。

必须严格输出 json（不要 markdown 代码块，不要任何额外文字说明），结构如下：
{
  "stem": "题干文字",
  "options": [
    { "key": "A", "text": "选项内容" },
    { "key": "B", "text": "选项内容" },
    { "key": "C", "text": "选项内容" },
    { "key": "D", "text": "选项内容" }
  ],
  "answer": "B",
  "explain": "解析文字",
  "topics": ["知识点1", "知识点2"]
}

命题要求：
1. 只出四选一的单选题，有且只有一个正确选项。
2. 考查的知识点必须和错题一致，但**题目情境、数据必须全新**，绝不能照抄错题或只改个数字。
3. 难度和错题相当，贴近 408 真题风格：尽量需要分析、计算或手工模拟，不要出纯概念背诵题。
4. 四个选项都要有迷惑性。错误选项应当是考生容易得出的错误结果，**并且要特意包含一个"像用户犯的那个错"的选项**，不要写成明显荒谬的表述。
5. 正确答案的字母位置要随机，不要总是同一个字母。
6. explain 必须写清楚：为什么选它、完整推导过程、以及其它三个选项各自错在哪里。尤其要点明"当年那个错误"错在思路上。可以换行，但不要用 markdown 表格或代码块。
7. topics 填 2~4 个具体知识点关键词，需与考查内容相关。
8. 题干中如果需要代码或公式，用纯文本描述即可。`;

function buildUserPrompt(sources, fixes) {
  const blocks = sources.map((q, i) => {
    const opts = (q.options || []).map(o => `${o.key}. ${o.text}`).join('\n');
    const picked = Array.isArray(q.lastWrongPick) && q.lastWrongPick.length
      ? q.lastWrongPick.join('')
      : '';
    return [
      `【错题 ${i + 1}】`,
      `章节：${q.chapter}`,
      `知识点：${(q.topics || []).join('、') || '（未标注）'}`,
      `题干：${q.stem}`,
      '选项：',
      opts || '（无）',
      `正确答案：${(q.answer || []).join('')}`,
      picked ? `学生当时选错成：${picked}　← 这正是他的误区，请针对它设计迷惑项` : '',
      `解析：${q.explain || '（无）'}`,
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  const head = sources.length > 1
    ? `以下是我做错的 ${sources.length} 道题，它们涉及相近的知识点：`
    : '以下是我做错的一道题：';

  return `${head}\n\n${blocks}\n\n请诊断这些错题暴露出来的薄弱点，然后生成一道新的单选题，以 json 输出。`
    + buildFixHint(fixes);
}

/**
 * 把用户上报的「你上次这题答案错了」拼进提示词。
 * 这是让模型别反复犯同类错误的唯一手段。
 */
function buildFixHint(fixes) {
  if (!Array.isArray(fixes) || !fixes.length) return '';
  const lines = fixes.slice(0, 5).map((f, i) => {
    const note = f.note ? `，错因：${f.note}` : '';
    return `${i + 1}. 题目「${f.stem}…」你当时给的答案是 ${f.from}，正确答案是 ${f.to}${note}`;
  });
  return `\n\n【你之前出过的错，这次务必避免】\n${lines.join('\n')}`
    + `\n（尤其是计算类题目，请把每一步都算一遍再定答案，不要凭感觉）`;
}

/* ---------------- 网络 ---------------- */
function httpError(status, json) {
  const raw = (json && (json.error?.message || json.message)) || '';
  const map = {
    400: '请求参数有问题',
    401: 'API Key 无效，请检查是否填错、或已被停用',
    402: 'DeepSeek 账户余额不足',
    422: '请求参数不合法',
    429: '请求太频繁或额度用尽，稍后再试',
    500: 'DeepSeek 服务端错误',
    503: 'DeepSeek 服务繁忙，稍后再试',
  };
  const err = new Error((map[status] || `HTTP ${status}`) + (raw ? '（' + raw + '）' : ''));
  err.status = status;
  err.fatal = [401, 402, 422].includes(status);   // 这些错误重试没意义
  return err;
}

async function requestOnce(body, key, timeout) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    let json = null;
    try { json = await res.json(); } catch (_) { /* 可能不是 JSON */ }
    return { status: res.status, json };
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error(`AI 请求超时（已等待 ${Math.round(timeout / 1000)} 秒），请检查网络后重试`);
    }
    throw new Error('无法连接 DeepSeek：' + (e.message || '网络错误'));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 发一次请求。
 * 先尝试「关闭深度思考」以加快出题速度；若服务端不接受该参数，自动退回默认设置。
 */
async function callAPI({ key, model, messages, temperature, disableThinking = true, timeout = 90000 }) {
  const variants = disableThinking
    ? [{ thinking: { type: 'disabled' } }, {}]
    : [{}];
  let lastErr = null;

  for (let i = 0; i < variants.length; i++) {
    const body = {
      model,
      messages,
      response_format: { type: 'json_object' },
      max_tokens: 3000,
      stream: false,
      temperature,
      ...variants[i],
    };

    const { status, json } = await requestOnce(body, key, timeout);

    if (status === 400 && i < variants.length - 1) {
      lastErr = new Error('服务端不接受 thinking 参数，已改用默认设置重试');
      continue;
    }
    if (status !== 200) throw httpError(status, json);

    const content = json?.choices?.[0]?.message?.content;
    if (!content || !content.trim()) {
      // 官方文档明确说明：JSON 模式偶发返回空内容
      lastErr = new Error('AI 返回了空内容（DeepSeek 已知的偶发问题），请重试');
      continue;
    }
    return { content, usage: json.usage || null, model: json.model || model };
  }
  throw lastErr || new Error('AI 出题失败');
}

/* ---------------- 解析与校验 ---------------- */
function stripFences(s) {
  let t = String(s || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  if (!t.startsWith('{')) {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) t = t.slice(a, b + 1);
  }
  return t;
}

/** 校验模型返回的题目结构；不合法就报出来，绝不悄悄放行 */
export function validateGenerated(raw) {
  const errs = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errs: ['返回内容不是 JSON 对象'] };
  }

  const stem = typeof raw.stem === 'string' ? raw.stem.trim() : '';
  if (stem.length < 5) errs.push('题干为空或过短');

  let options = null;
  if (!Array.isArray(raw.options) || raw.options.length !== 4) {
    errs.push('选项必须正好 4 个');
  } else {
    options = raw.options.map((o, i) => ({
      key: String((o && o.key) || 'ABCD'[i]).trim().toUpperCase().slice(0, 1),
      text: String((o && o.text) || '').trim(),
    }));
    const keys = options.map(o => o.key);
    if (new Set(keys).size !== 4 || !keys.every(k => /^[A-D]$/.test(k))) errs.push('选项编号必须是 A/B/C/D 且不重复');
    if (options.some(o => !o.text)) errs.push('存在空选项');
  }

  const answer = (Array.isArray(raw.answer) ? raw.answer : [raw.answer])
    .map(x => String(x ?? '').trim().toUpperCase().slice(0, 1))
    .filter(Boolean);
  if (answer.length !== 1) errs.push('答案必须是单个选项字母');
  else if (options && !errs.includes('选项必须正好 4 个') && !options.some(o => o.key === answer[0])) {
    errs.push(`答案 ${answer[0]} 不在选项中`);
  }

  const explain = typeof raw.explain === 'string' ? raw.explain.trim() : '';
  if (explain.length < 10) errs.push('解析为空或过短');

  const topics = Array.isArray(raw.topics)
    ? raw.topics.map(t => String(t).trim()).filter(Boolean).slice(0, 6)
    : [];

  return {
    ok: errs.length === 0,
    errs,
    value: { stem, options, answer, explain, topics },
  };
}

/* ---------------- 对外接口 ---------------- */

/**
 * 根据错题生成同类新题。
 * @param {object|object[]} sources 一道或多道错题（多道时需涉及相近知识点）
 * @param {object} settings { aiKey, aiModel, aiFast }
 * @param {object} opts { retries, onStage, fixes }
 * @returns {Promise<{question:object, usage:object|null}>}
 */
export async function generateSimilar(sources, settings, { retries = 1, onStage, fixes = [] } = {}) {
  const list = (Array.isArray(sources) ? sources : [sources]).filter(q => q && q.stem);
  if (!list.length) throw new Error('缺少可参考的错题');

  const key = String(settings.aiKey || '').trim();
  if (!key) throw new Error('请先到「我的 → AI 出题」填写 DeepSeek API Key');

  const model = settings.aiModel || 'deepseek-flash';
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserPrompt(list, fixes) },
  ];

  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (onStage) onStage(attempt === 0 ? '正在生成…' : `第 ${attempt + 1} 次尝试…`);
    try {
      // 重试时把温度调高一点，避免又生成出一模一样的
      const out = await callAPI({
        key, model, messages,
        temperature: attempt === 0 ? 1 : 1.4,
        disableThinking: settings.aiFast !== false,
      });
      const parsed = JSON.parse(stripFences(out.content));
      const v = validateGenerated(parsed);
      if (v.ok) {
        return {
          question: buildQuestion(v.value, list[0], model),
          usage: out.usage,
        };
      }
      lastErr = new Error('AI 出的题不合格：' + v.errs.join('；'));
    } catch (e) {
      if (e.fatal) throw e;
      lastErr = e;
    }
  }
  throw lastErr || new Error('AI 出题失败，请重试');
}

/* ---------------- 答案复核（让 AI 重新算一遍） ---------------- */
const RECHECK_PROMPT = `你是一位严谨的考研计算机学科专业基础综合（408）阅卷老师，正在复核一道单选题的答案。

请把这道题当成全新题目**独立重做一遍**：不要预设给出的原答案是对的，也不要用原解析倒推结论。
- 计算类题目（进制、浮点、存储器容量、CPU 时间、流水线加速比、页面置换等）必须一步一步算出结果，把关键中间值写清楚，最后再对选项；
- 概念类题目要说明判断依据（出自哪条定义、协议层次、定理）。
- 算完后自己再检查一遍：有没有算错、有没有看漏题干条件、有没有把单位搞混。

严格输出 json（不要 markdown 代码块，不要任何额外文字），结构如下：
{
  "answer": "B",
  "reason": "你的完整推导过程",
  "confidence": "high"
}
answer 只能是一个选项字母；confidence 取 high / medium / low。`;

/** 校验复核结果；不能确认合法就不放行 */
function validateRecheck(raw, question) {
  const errs = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errs: ['返回内容不是 JSON 对象'] };
  }
  const answer = String(raw.answer ?? '').trim().toUpperCase().slice(0, 1);
  if (!/^[A-D]$/.test(answer)) errs.push('没有给出有效的选项字母');
  else if (Array.isArray(question.options) && question.options.length
    && !question.options.some(o => o.key === answer)) {
    errs.push(`重算结果 ${answer} 不在选项中`);
  }
  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
  if (reason.length < 5) errs.push('没有给出推导过程');
  const confidence = ['high', 'medium', 'low'].includes(raw.confidence) ? raw.confidence : 'medium';
  return { ok: errs.length === 0, errs, value: { answer, reason, confidence } };
}

/**
 * 让 AI 抛开原答案，独立重算这道题的正确答案。
 * 用于用户怀疑 AI 出题答案有误时，先让模型自己复核一遍。
 * @param {object} question 待复核的题目
 * @param {object} settings { aiKey, aiModel, aiFast }
 * @param {object} opts { fixes } 历史纠错，避免它又犯同类错
 * @returns {Promise<{answer:string, reason:string, confidence:string, model:string}>}
 */
export async function recheckQuestion(question, settings, { fixes = [] } = {}) {
  const key = String(settings.aiKey || '').trim();
  if (!key) throw new Error('请先到「我的 → AI 出题」填写 DeepSeek API Key');
  if (!question || !question.stem) throw new Error('缺少题目内容');

  const model = settings.aiModel || 'deepseek-flash';
  const opts = (question.options || []).map(o => `${o.key}. ${o.text}`).join('\n');
  const user = [
    `章节：${question.chapter || '（未标注）'}`,
    (question.topics && question.topics.length) ? `知识点：${question.topics.join('、')}` : '',
    `题干：${question.stem}`,
    '选项：',
    opts || '（无）',
    `原答案：${(question.answer || []).join('')}`,
    question.explain ? `原解析：${question.explain}` : '',
  ].filter(Boolean).join('\n') + buildFixHint(fixes);

  const messages = [
    { role: 'system', content: RECHECK_PROMPT },
    { role: 'user', content: user },
  ];

  let lastErr = null;
  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      // 复核要稳：温度压低，尽量避免它随机换答案
      const out = await callAPI({
        key, model, messages,
        temperature: attempt === 0 ? 0.3 : 0.6,
        disableThinking: settings.aiFast !== false,
      });
      const parsed = JSON.parse(stripFences(out.content));
      const v = validateRecheck(parsed, question);
      if (v.ok) return { ...v.value, model, usage: out.usage };
      lastErr = new Error('AI 复算结果不合法：' + v.errs.join('；'));
    } catch (e) {
      if (e.fatal) throw e;
      lastErr = e;
    }
  }
  throw lastErr || new Error('AI 复算失败，请重试');
}

/** 把模型返回的内容包装成应用内部的题目结构 */
export function buildQuestion(value, sourceQ, model) {
  const rnd = Math.random().toString(36).slice(2, 7);
  return {
    id: `ai-${Date.now().toString(36)}-${rnd}`,
    subject: sourceQ.subject,
    subjectName: sourceQ.subjectName || sourceQ.subject,
    chapter: sourceQ.chapter,          // 沿用原题章节，自然落进对应的筛选分类
    topics: value.topics.length ? value.topics : (sourceQ.topics || []),
    type: 'single',
    difficulty: sourceQ.difficulty || 3,
    stem: value.stem,
    options: value.options,
    answer: value.answer,
    accept: [],
    explain: value.explain,
    source: `AI 生成 · ${model}`,
    ai: true,
    aiModel: model,
    aiFrom: sourceQ.id,
    createdAt: Date.now(),
  };
}

/** 测试连接是否可用（只发一个最小的请求） */
export async function testConnection(settings) {
  const key = String(settings.aiKey || '').trim();
  if (!key) throw new Error('请先填写 DeepSeek API Key');
  const model = settings.aiModel || 'deepseek-flash';
  const out = await callAPI({
    key,
    model,
    messages: [
      { role: 'system', content: '你必须输出 json。' },
      { role: 'user', content: '请输出 json: {"ok": true}' },
    ],
    temperature: 1,
    disableThinking: settings.aiFast !== false,
    timeout: 30000,
  });
  return { model: out.model, usage: out.usage };
}

export default {
  AI_MODELS, generateSimilar, validateGenerated, buildQuestion,
  testConnection, buildFixHint, recheckQuestion,
};
