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

function buildUserPrompt(sources) {
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

  return `${head}\n\n${blocks}\n\n请诊断这些错题暴露出来的薄弱点，然后生成一道新的单选题，以 json 输出。`;
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
 * @returns {Promise<{question:object, usage:object|null}>}
 */
export async function generateSimilar(sources, settings, { retries = 1, onStage } = {}) {
  const list = (Array.isArray(sources) ? sources : [sources]).filter(q => q && q.stem);
  if (!list.length) throw new Error('缺少可参考的错题');

  const key = String(settings.aiKey || '').trim();
  if (!key) throw new Error('请先到「我的 → AI 出题」填写 DeepSeek API Key');

  const model = settings.aiModel || 'deepseek-flash';
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserPrompt(list) },
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

export default { AI_MODELS, generateSimilar, validateGenerated, buildQuestion, testConnection };
