/* ===========================================================
   DOM / 交互小工具
   =========================================================== */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** 把可能含特殊字符的文本安全地插入模板 */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ---------------- 轻量 Markdown 渲染 ---------------- */

/** 行内：粗体 + 行内代码 */
function inline(s) {
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

/** 表格分隔行，例如 |---|:--:|---| */
function isTableSep(line) {
  const t = line.trim();
  return t.includes('-') && /^\|?[\s:|-]+\|?$/.test(t);
}

function splitRow(line) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map(c => c.trim());
}

/**
 * 把题库里的解析文本转成安全 HTML。
 * 支持：段落、换行、无序列表、`行内代码`、**粗体**、``` 代码块 ```、| Markdown 表格 |。
 */
export function richText(src) {
  const lines = String(src ?? '').split('\n');
  const out = [];
  let para = [];

  const flush = () => {
    if (!para.length) return;
    out.push('<p>' + para.map(inline).join('<br>') + '</p>');
    para = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // ``` 代码块 ```
    if (/^\s*```/.test(line)) {
      flush();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      out.push('<pre>' + esc(buf.join('\n')) + '</pre>');
      continue;
    }

    // | 表格 |
    if (line.trim().startsWith('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flush();
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(splitRow(lines[i])); i++; }
      out.push(
        '<table><thead><tr>' + head.map(c => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>' +
        rows.map(r => '<tr>' + r.map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') +
        '</tbody></table>'
      );
      continue;
    }

    // 空行：分段
    if (!line.trim()) { flush(); i++; continue; }

    // 无序列表（- * · •）
    if (/^\s*[-*·•]\s+/.test(line)) {
      flush();
      const items = [];
      while (i < lines.length && /^\s*[-*·•]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*·•]\s+/, ''));
        i++;
      }
      out.push('<ul>' + items.map(t => '<li>' + inline(t) + '</li>').join('') + '</ul>');
      continue;
    }

    para.push(line);
    i++;
  }
  flush();
  return out.join('');
}

let toastTimer = null;
export function toast(msg, ms = 1900) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

export function openSheet(sel) {
  const s = typeof sel === 'string' ? $(sel) : sel;
  if (!s) return;
  s.hidden = false;
}
export function closeSheet(sel) {
  const s = typeof sel === 'string' ? $(sel) : sel;
  if (!s) return;
  s.hidden = true;
}

/** 事件委托 */
export function on(root, evt, sel, handler) {
  root.addEventListener(evt, e => {
    const t = e.target.closest(sel);
    if (t && root.contains(t)) handler(e, t);
  });
}

/* ---------------- 日期 ---------------- */
export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function startOfDay(ts = Date.now()) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function fmtDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtRelative(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 60e3) return '刚刚';
  if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前';
  if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前';
  const d = Math.floor(diff / 86400e3);
  if (d < 30) return d + ' 天前';
  return dayKey(ts);
}

/* ---------------- 其它 ---------------- */
export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function uniq(arr) { return [...new Set(arr)]; }

export function pct(n, d) {
  if (!d) return '—';
  return Math.round(n / d * 100) + '%';
}

export function debounce(fn, ms = 400) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** 规范化填空/简答题答案文本 */
export function normAnswer(s) {
  return String(s ?? '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/[，。；：、,.;:!！?？"'“”‘’]/g, '')
    .toLowerCase();
}

export default {
  $, $$, esc, richText, toast, openSheet, closeSheet, on,
  dayKey, startOfDay, fmtDateTime, fmtRelative, shuffle, uniq, pct, debounce, normAnswer,
};
