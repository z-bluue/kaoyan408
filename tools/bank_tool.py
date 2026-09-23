#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
408 刷题 —— 题库工具

用法（在项目根目录下执行）：

    # 1. 校验题库（不填解析、答案不在选项里，都会报出来）
    python tools/bank_tool.py validate

    # 2. 生成 / 更新 data/bank-manifest.json（改了题目后必须跑一次）
    python tools/bank_tool.py build

    # 3. 看题库统计
    python tools/bank_tool.py stats

    # 4. 导入自己的题目（CSV / TSV / txt / xlsx）
    python tools/bank_tool.py import --subject ds --input 我的题.csv
    python tools/bank_tool.py import --subject ds --input 我的题.csv --append

只依赖标准库；只有导入 .xlsx 时才需要 openpyxl（pip install openpyxl）。
"""

import argparse
import csv
import hashlib
import json
import os
import re
import sys
import time
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
SUBJECTS_FILE = os.path.join(DATA, "subjects.json")
MANIFEST_FILE = os.path.join(DATA, "bank-manifest.json")

VALID_TYPES = {"single", "multi", "judge", "fill", "short"}

TYPE_ALIAS = {
    "单选": "single", "单选题": "single", "single": "single", "choice": "single",
    "多选": "multi", "多选题": "multi", "multiple": "multi", "multi": "multi",
    "判断": "judge", "判断题": "judge", "judge": "judge", "tf": "judge",
    "填空": "fill", "填空题": "fill", "fill": "fill", "blank": "fill",
    "简答": "short", "简答题": "short", "综合": "short", "综合题": "short",
    "short": "short", "essay": "short",
}

# 表头别名 -> 内部字段名
HEADER_ALIAS = {
    "id": "id", "题号": "id", "编号": "id",
    "chapter": "chapter", "章节": "chapter",
    "topics": "topics", "知识点": "topics", "考点": "topics", "tags": "topics",
    "type": "type", "题型": "type",
    "difficulty": "difficulty", "难度": "difficulty",
    "stem": "stem", "题干": "stem", "题目": "stem", "question": "stem",
    "answer": "answer", "答案": "answer",
    "explain": "explain", "解析": "explain", "分析": "explain", "explanation": "explain",
    "accept": "accept", "可接受答案": "accept", "其他答案": "accept", "其它可接受答案": "accept",
    "source": "source", "来源": "source",
    "a": "A", "选项a": "A", "optiona": "A",
    "b": "B", "选项b": "B", "optionb": "B",
    "c": "C", "选项c": "C", "optionc": "C",
    "d": "D", "选项d": "D", "optiond": "D",
    "e": "E", "选项e": "E", "optione": "E",
    "f": "F", "选项f": "F", "optionf": "F",
}

TRUE_WORDS = {"正确", "对", "是", "√", "t", "true", "a", "1", "y", "yes"}
FALSE_WORDS = {"错误", "错", "否", "×", "x", "f", "false", "b", "0", "n", "no"}


# --------------------------------------------------------------------------
# 基础
# --------------------------------------------------------------------------
def die(msg, code=1):
    print("[错误] " + msg, file=sys.stderr)
    sys.exit(code)


def warn(msg):
    print("[提示] " + msg)


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def dump_json(path, obj):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.write("\n")


def load_subjects():
    if not os.path.exists(SUBJECTS_FILE):
        die("找不到 %s" % SUBJECTS_FILE)
    meta = load_json(SUBJECTS_FILE)
    return meta.get("subjects", [])


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def content_digest(raw):
    """只对 questions 内容算摘要。

    注意：不能对整个文件算 sha256，因为 build 会把版本号回写进题库文件，
    那样每次 build 都会误判为"内容有变"，版本号会无限往上涨。
    """
    questions = raw.get("questions") or []
    blob = json.dumps(questions, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def subject_file(sid):
    return os.path.join(DATA, "%s.json" % sid)


def norm_topics(v):
    if not v:
        return []
    if isinstance(v, list):
        return [str(x).strip() for x in v if str(x).strip()]
    parts = re.split(r"[;|、,，/]+", str(v))
    return [p.strip() for p in parts if p.strip()]


def norm_answer_letters(v):
    """把 'A,B,D' / 'ABD' / 'A|B' 统一成 ['A','B','D']"""
    if v is None:
        return []
    if isinstance(v, list):
        raw = [str(x) for x in v]
    else:
        s = str(v).strip()
        if not s:
            return []
        if re.fullmatch(r"[A-Fa-f][A-Fa-f\s,，、;|/]*", s) and len(re.sub(r"\W", "", s)) <= 6:
            raw = list(re.sub(r"[^A-Fa-f]", "", s).upper())
        else:
            raw = [p for p in re.split(r"[;|,，、/]+", s) if p.strip()]
    out = []
    for x in raw:
        x = str(x).strip().upper()
        if x and x not in out:
            out.append(x)
    return out


# --------------------------------------------------------------------------
# validate
# --------------------------------------------------------------------------
def validate_question(q, sid, chapters, errors, warnings, seen_ids):
    qid = q.get("id") or "(无题号)"

    def err(msg):
        errors.append("%s %s：%s" % (sid, qid, msg))

    def wrn(msg):
        warnings.append("%s %s：%s" % (sid, qid, msg))

    if not q.get("id"):
        err("缺少 id")
    elif q["id"] in seen_ids:
        err("id 重复")
    else:
        seen_ids.add(q["id"])

    if not q.get("stem"):
        err("缺少题干 stem")

    qtype = q.get("type", "single")
    if qtype not in VALID_TYPES:
        err("题型 type 非法：%r（应为 %s）" % (qtype, "/".join(sorted(VALID_TYPES))))
        qtype = "single"

    # ---- 解析：必填 ----
    if not q.get("explain"):
        err("缺少解析 explain")

    # ---- 答案 ----
    ans = q.get("answer")
    if ans is None or (isinstance(ans, (list, str)) and len(ans) == 0):
        err("缺少答案 answer")
        return

    if qtype in ("single", "multi", "judge"):
        letters = norm_answer_letters(ans)
        opts = q.get("options")
        if qtype == "judge" and not opts:
            opts = [{"key": "A", "text": "正确"}, {"key": "B", "text": "错误"}]
        if not opts or len(opts) < 2:
            err("选择题的 options 至少需要 2 个选项")
        else:
            keys = [str(o.get("key", "")).upper() for o in opts]
            if len(set(keys)) != len(keys):
                err("选项 key 有重复：%s" % keys)
            for a in letters:
                if a not in keys:
                    err("答案 %s 不在选项 %s 中" % (a, "/".join(keys)))
            if qtype == "single" and len(letters) != 1:
                err("单选题应有且仅有 1 个答案，当前 %d 个" % len(letters))
            if qtype == "multi" and len(letters) < 2:
                err("多选题应至少有 2 个答案，当前 %d 个" % len(letters))
            if qtype == "judge" and len(letters) != 1:
                err("判断题应有且仅有 1 个答案")

    if qtype == "fill":
        if not norm_answer_letters(ans) and not (q.get("accept")):
            wrn("填空题答案为空且没有 accept 备选")

    # ---- 其它 ----
    diff = q.get("difficulty", 2)
    if not isinstance(diff, int) or not (1 <= diff <= 5):
        wrn("难度 difficulty 建议为 1~5 的整数，当前 %r" % diff)

    if chapters and q.get("chapter") and q["chapter"] not in chapters:
        wrn("章节 %r 不在 subjects.json 的章节列表中（不影响使用）" % q["chapter"])

    if not q.get("topics"):
        wrn("没有知识点 topics，会影响\"薄弱点推题\"的效果")


def cmd_validate(args):
    subjects = load_subjects()
    errors, warnings = [], []
    total = 0

    for sm in subjects:
        path = subject_file(sm["id"])
        if not os.path.exists(path):
            errors.append("%s：找不到文件 %s" % (sm["id"], os.path.relpath(path, ROOT)))
            continue
        try:
            raw = load_json(path)
        except json.JSONDecodeError as e:
            errors.append(
                "%s：JSON 语法错误，第 %d 行第 %d 列——%s。"
                "最常见的原因是字符串里出现了真实换行符，需要改写成转义形式"
                % (sm["id"], e.lineno, e.colno, e.msg)
            )
            continue
        chapters = set(sm.get("chapters") or [])
        seen = set()
        qs = raw.get("questions") or []
        if not qs:
            errors.append("%s：questions 为空" % sm["id"])
        for q in qs:
            total += 1
            validate_question(q, sm["id"], chapters, errors, warnings, seen)

    for w in warnings:
        warn(w)

    print("")
    print("校验了 %d 道题（%d 个科目）" % (total, len(subjects)))
    if errors:
        print("")
        print("发现 %d 个错误：" % len(errors))
        for e in errors:
            print("  ✗ " + e)
        sys.exit(1)
    print("✓ 全部通过")
    if warnings:
        print("  （有 %d 条提示，不影响使用）" % len(warnings))


# --------------------------------------------------------------------------
# build manifest
# --------------------------------------------------------------------------
def cmd_build(args):
    subjects = load_subjects()
    old = load_json(MANIFEST_FILE) if os.path.exists(MANIFEST_FILE) else {}
    old_subjects = old.get("subjects", {})

    base = datetime.now().strftime("%Y%m%d")
    old_version = str(old.get("version", "0.0"))
    # 计数器：同一天多次改题也能拿到递增的版本号
    try:
        old_base, old_seq = old_version.split(".")
        seq = int(old_seq)
    except Exception:
        old_base, seq = "0", 0
    if old_base != base:
        seq = 0

    changed_any = False
    changed_ids = set()
    out_subjects = {}
    total = 0

    for sm in subjects:
        sid = sm["id"]
        path = subject_file(sid)
        if not os.path.exists(path):
            die("找不到 %s" % os.path.relpath(path, ROOT))
        raw = load_json(path)
        digest = content_digest(raw)
        count = len(raw.get("questions") or [])
        total += count

        prev = old_subjects.get(sid, {})
        if prev.get("sha256") == digest:
            sver = prev.get("version") or base + ".0"
        else:
            seq += 1
            sver = "%s.%d" % (base, seq)
            changed_any = True
            changed_ids.add(sid)

        out_subjects[sid] = {
            "file": "%s.json" % sid,
            "name": raw.get("name") or sm.get("name") or sid,
            "count": count,
            "version": sver,
            "sha256": digest,
            "bytes": os.path.getsize(path),
        }
        # 把版本号回写进科目文件，方便本地查看
        if raw.get("version") != sver:
            raw["version"] = sver
            dump_json(path, raw)

    if changed_any:
        manifest_version = "%s.%d" % (base, seq)
    elif old_version != "0.0":
        manifest_version = old_version      # 内容没变，版本号保持不动
    else:
        manifest_version = "%s.1" % base

    manifest = {
        "version": manifest_version,
        "generated": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "count": total,
        "subjects": out_subjects,
    }
    dump_json(MANIFEST_FILE, manifest)

    print("已生成 data/bank-manifest.json")
    print("  题库版本：%s" % manifest_version)
    for sid, info in out_subjects.items():
        mark = "★ 有更新" if sid in changed_ids else ""
        print("  %-5s %-12s %4d 题   v%s  %s" % (sid, info["name"], info["count"], info["version"], mark))
    print("  合计 %d 题" % total)


# --------------------------------------------------------------------------
# stats
# --------------------------------------------------------------------------
def cmd_stats(args):
    subjects = load_subjects()
    grand = 0
    for sm in subjects:
        path = subject_file(sm["id"])
        if not os.path.exists(path):
            continue
        raw = load_json(path)
        qs = raw.get("questions") or []
        grand += len(qs)
        print("\n【%s】共 %d 题  （v%s）" % (sm.get("name", sm["id"]), len(qs), raw.get("version", "?")))

        by_chapter = {}
        by_type = {}
        by_diff = {}
        for q in qs:
            by_chapter[q.get("chapter", "未分类")] = by_chapter.get(q.get("chapter", "未分类"), 0) + 1
            by_type[q.get("type", "single")] = by_type.get(q.get("type", "single"), 0) + 1
            by_diff[q.get("difficulty", 2)] = by_diff.get(q.get("difficulty", 2), 0) + 1

        for ch in sm.get("chapters") or []:
            print("    %-16s %3d" % (ch, by_chapter.get(ch, 0)))
        for ch, n in by_chapter.items():
            if ch not in (sm.get("chapters") or []):
                print("    %-16s %3d  (不在大纲章节列表)" % (ch, n))
        print("    题型：%s" % "，".join("%s=%d" % (k, v) for k, v in sorted(by_type.items())))
        print("    难度：%s" % "，".join("%d★=%d" % (k, v) for k, v in sorted(by_diff.items())))

    print("\n全部科目合计 %d 题" % grand)


# --------------------------------------------------------------------------
# import
# --------------------------------------------------------------------------
def read_table(path):
    """返回 list[dict]（表头 -> 单元格原文）"""
    ext = os.path.splitext(path)[1].lower()

    if ext in (".xlsx", ".xlsm"):
        try:
            from openpyxl import load_workbook
        except ImportError:
            die("读取 Excel 需要 openpyxl，请先执行：pip install openpyxl\n"
                "   或者把 Excel 另存为 CSV（UTF-8）再用 --input 指定。")
        wb = load_workbook(path, data_only=True, read_only=True)
        ws = wb.active
        rows = list(ws.iter_rows(values_only=True))
        wb.close()
        if not rows:
            die("Excel 里没有数据")
        header = [str(c).strip() if c is not None else "" for c in rows[0]]
        out = []
        for r in rows[1:]:
            if r is None or all(c is None or str(c).strip() == "" for c in r):
                continue
            out.append({header[i]: ("" if r[i] is None else str(r[i]).strip())
                        for i in range(min(len(header), len(r)))})
        return out

    # CSV / TSV / TXT
    with open(path, "r", encoding="utf-8-sig", newline="") as f:
        sample = f.read(8192)
        f.seek(0)
        try:
            dialect = csv.Sniffer().sniff(sample, delimiters=",\t;")
        except csv.Error:
            dialect = csv.excel_tab if "\t" in sample.split("\n")[0] else csv.excel
        reader = csv.DictReader(f, dialect=dialect)
        return [{(k or "").strip(): (v or "").strip() for k, v in row.items() if k} for row in reader]


def map_header(row):
    """把中文/英文表头映射成内部字段"""
    out = {"options": {}}
    for k, v in row.items():
        key = HEADER_ALIAS.get(k.strip().lower())
        if key is None:
            key = HEADER_ALIAS.get(k.strip())
        if key is None:
            continue
        if key in ("A", "B", "C", "D", "E", "F"):
            if v:
                out["options"][key] = v
        else:
            out[key] = v
    return out


def convert_row(raw, sid, index, errors):
    m = map_header(raw)

    qtype = TYPE_ALIAS.get(str(m.get("type", "")).strip().lower(), None)
    if qtype is None:
        qtype = TYPE_ALIAS.get(str(m.get("type", "")).strip(), "single")

    stem = m.get("stem", "").strip()
    if not stem:
        errors.append("第 %d 行缺少题干，已跳过" % index)
        return None

    explain = m.get("explain", "").strip()
    if not explain:
        errors.append("第 %d 行缺少解析（题干：%s…），已跳过" % (index, stem[:20]))

    qid = (m.get("id") or "").strip() or "%s-imp-%03d" % (sid, index)

    options = None
    if m["options"]:
        options = [{"key": k, "text": m["options"][k]} for k in sorted(m["options"])]

    answer_raw = m.get("answer", "").strip()

    if qtype == "judge":
        if not options:
            options = [{"key": "A", "text": "正确"}, {"key": "B", "text": "错误"}]
        low = answer_raw.strip().lower()
        if low in TRUE_WORDS:
            answer = ["A"]
        elif low in FALSE_WORDS:
            answer = ["B"]
        else:
            letters = norm_answer_letters(answer_raw)
            answer = letters or ["A"]
    elif qtype == "fill":
        parts = [p.strip() for p in re.split(r"[|｜;；]+", answer_raw) if p.strip()]
        answer = parts or [answer_raw]
    else:
        answer = norm_answer_letters(answer_raw)

    if not answer:
        errors.append("第 %d 行缺少答案，已跳过（题干：%s…）" % (index, stem[:20]))
        return None

    try:
        difficulty = int(float(m.get("difficulty") or 2))
    except ValueError:
        difficulty = 2
    difficulty = min(5, max(1, difficulty))

    q = {
        "id": qid,
        "chapter": (m.get("chapter") or "未分类").strip(),
        "topics": norm_topics(m.get("topics")),
        "type": qtype,
        "difficulty": difficulty,
        "stem": stem,
        "options": options,
        "answer": answer,
        "explain": explain,
    }
    accept = norm_topics(m.get("accept"))
    if accept:
        q["accept"] = accept
    src = (m.get("source") or "").strip()
    if src:
        q["source"] = src

    if qtype in ("single", "multi") and not options:
        errors.append("第 %d 行是选择题但没有填选项，已跳过" % index)
        return None

    return q


def cmd_import(args):
    src = args.input
    if not os.path.exists(src):
        die("找不到文件 %s" % src)

    subjects = load_subjects()
    ids = [s["id"] for s in subjects]
    if args.subject not in ids:
        die("科目 %r 不存在，可选：%s" % (args.subject, "、".join(ids)))

    rows = read_table(src)
    if not rows:
        die("文件里没有数据行")

    print("从 %s 读到 %d 行" % (os.path.basename(src), len(rows)))

    errors = []
    new_qs = []
    for i, row in enumerate(rows, start=2):   # 第 1 行是表头，所以从 2 开始
        q = convert_row(row, args.subject, i, errors)
        if q:
            new_qs.append(q)

    for e in errors:
        warn(e)

    if not new_qs:
        die("没有解析出任何有效题目")

    # 去重
    uniq, seen = [], set()
    for q in new_qs:
        if q["id"] in seen:
            warn("题号 %s 在导入文件内重复，只保留第一条" % q["id"])
            continue
        seen.add(q["id"])
        uniq.append(q)

    target = subject_file(args.subject)
    if args.append and os.path.exists(target):
        raw = load_json(target)
        existing = raw.get("questions") or []
        exist_ids = {q.get("id") for q in existing}
        added = [q for q in uniq if q["id"] not in exist_ids]
        skipped = len(uniq) - len(added)
        raw["questions"] = existing + added
        dump_json(target, raw)
        print("已追加到 %s：新增 %d 题" % (os.path.relpath(target, ROOT), len(added)))
        if skipped:
            print("  跳过 %d 题（题号已存在）" % skipped)
    else:
        out_path = target if args.overwrite else os.path.join(DATA, "%s-imported.json" % args.subject)
        name = next(s["name"] for s in subjects if s["id"] == args.subject)
        dump_json(out_path, {
            "id": args.subject,
            "name": name,
            "version": datetime.now().strftime("%Y%m%d.1"),
            "questions": uniq,
        })
        print("已写出 %s：共 %d 题" % (os.path.relpath(out_path, ROOT), len(uniq)))
        if not args.overwrite and not args.append:
            print("")
            print("下一步：想合进正式题库，就改用 --append：")
            print("  python tools/bank_tool.py import --subject %s --input %s --append"
                  % (args.subject, src))

    print("")
    print("别忘了重新生成清单： python tools/bank_tool.py build")
    print("然后校验一下：       python tools/bank_tool.py validate")


# --------------------------------------------------------------------------
def main():
    p = argparse.ArgumentParser(
        prog="bank_tool.py",
        description="408 题库工具：校验 / 清单 / 统计 / 导入",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    sub = p.add_subparsers(dest="cmd")

    sub.add_parser("validate", help="校验题库（答案、解析、题号、章节）")
    sub.add_parser("build", help="生成 / 更新 data/bank-manifest.json")
    sub.add_parser("stats", help="查看各科题量与分布")

    imp = sub.add_parser("import", help="导入 CSV / TSV / txt / xlsx 题目")
    imp.add_argument("--subject", required=True, help="科目 id：ds / co / os / net")
    imp.add_argument("--input", required=True, help="要导入的文件路径")
    imp.add_argument("--append", action="store_true", help="追加进 data/<科目>.json（自动跳过重复题号）")
    imp.add_argument("--overwrite", action="store_true", help="直接覆盖 data/<科目>.json（危险）")

    args = p.parse_args()
    if not args.cmd:
        p.print_help()
        return

    t0 = time.time()
    {"validate": cmd_validate, "build": cmd_build,
     "stats": cmd_stats, "import": cmd_import}[args.cmd](args)
    print("\n耗时 %.2fs" % (time.time() - t0))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
