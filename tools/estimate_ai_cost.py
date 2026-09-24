#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
估算一次「AI 出题」大概消耗多少 token。

做法：从 js/ai.js 里读出真实的 SYSTEM_PROMPT，再用题库里的真实题目
按 buildUserPrompt() 的格式拼出用户提示词，然后数中文字符/其它字符。

Token 估算法（DeepSeek 官方口径）：
    · 1 个中文字符  ≈ 0.6 token
    · 其它字符（英文字母/数字/符号）≈ 4 字符 1 token
这是经验值，实际会有 ±30% 浮动，但用来判断量级足够了。

    python tools/estimate_ai_cost.py
    python tools/estimate_ai_cost.py --sources 3      # 指定一次参考几道错题
    python tools/estimate_ai_cost.py --price-in 1 --price-out 2   # 元/百万 token
"""

import argparse
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AI_JS = os.path.join(ROOT, "js", "ai.js")
DATA = os.path.join(ROOT, "data")

CJK = re.compile(r"[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]")


def count_tokens(text):
    """返回 (估算 token 数, 中文字符数, 其它字符数)"""
    cjk = len(CJK.findall(text))
    other = len(text) - cjk
    return cjk * 0.6 + other / 4.0, cjk, other


def extract_system_prompt():
    src = open(AI_JS, "r", encoding="utf-8").read()
    m = re.search(r"const SYSTEM_PROMPT = `(.*?)`;", src, re.S)
    if not m:
        print("没能从 js/ai.js 里解析出 SYSTEM_PROMPT", file=sys.stderr)
        sys.exit(1)
    return m.group(1)


def build_user_prompt(questions):
    """完全照搬 js/ai.js 里的 buildUserPrompt()"""
    blocks = []
    for i, q in enumerate(questions):
        opts = "\n".join("%s. %s" % (o["key"], o["text"]) for o in (q.get("options") or []))
        picked = "".join(q.get("lastWrongPick") or [])
        lines = [
            "【错题 %d】" % (i + 1),
            "章节：%s" % q.get("chapter", ""),
            "知识点：%s" % ("、".join(q.get("topics") or []) or "（未标注）"),
            "题干：%s" % q.get("stem", ""),
            "选项：",
            opts or "（无）",
            "正确答案：%s" % "".join(q.get("answer") or []),
            ("学生当时选错成：%s　← 这正是他的误区，请针对它设计迷惑项" % picked) if picked else "",
            "解析：%s" % (q.get("explain") or "（无）"),
        ]
        blocks.append("\n".join(x for x in lines if x))
    head = ("以下是我做错的 %d 道题，它们涉及相近的知识点：" % len(questions)) if len(questions) > 1 \
        else "以下是我做错的一道题："
    return "%s\n\n%s\n\n请诊断这些错题暴露出来的薄弱点，然后生成一道新的单选题，以 json 输出。" % (
        head, "\n\n".join(blocks))


def build_output_sample(q):
    """模型要返回的 JSON（用一道真题当作样本）"""
    payload = {
        "stem": q.get("stem", ""),
        "options": [{"key": o["key"], "text": o["text"]} for o in (q.get("options") or [])],
        "answer": (q.get("answer") or ["B"])[0],
        "explain": q.get("explain", ""),
        "topics": q.get("topics") or [],
    }
    return json.dumps(payload, ensure_ascii=False, indent=2)


def load_all_questions():
    out = []
    for fn in sorted(os.listdir(DATA)):
        if not fn.endswith(".json") or fn in ("subjects.json", "bank-manifest.json"):
            continue
        raw = json.load(open(os.path.join(DATA, fn), encoding="utf-8"))
        for q in raw.get("questions") or []:
            out.append(q)
    return out


def pick_worst(questions, n):
    """挑解析最长、选项文字最多的几道，代表最坏情况"""
    def weight(q):
        return len(q.get("explain") or "") + sum(len(o.get("text") or "") for o in (q.get("options") or []))
    return sorted(questions, key=weight, reverse=True)[:n]


def pick_average(questions, n):
    """挑最接近中位数的几道，代表平均情况"""
    def weight(q):
        return len(q.get("explain") or "") + sum(len(o.get("text") or "") for o in (q.get("options") or []))
    s = sorted(questions, key=weight)
    mid = len(s) // 2
    lo = max(0, mid - n // 2)
    return s[lo:lo + n]


def report(label, text):
    tok, cjk, other = count_tokens(text)
    print("    %-14s %6d 字符（中文 %5d / 其它 %5d）→  约 %6.0f token"
          % (label, len(text), cjk, other, tok))
    return tok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sources", type=int, default=3, help="一次参考几道错题（默认 3，是代码里的上限）")
    ap.add_argument("--price-in", type=float, default=0, help="输入价格（元/百万 token）")
    ap.add_argument("--price-out", type=float, default=0, help="输出价格（元/百万 token）")
    args = ap.parse_args()

    system = extract_system_prompt()
    all_q = load_all_questions()
    if not all_q:
        print("题库里没读到题目", file=sys.stderr)
        sys.exit(1)

    print("=" * 68)
    print("AI 出题 token / 花费估算（基于真实的提示词与题库数据）")
    print("=" * 68)

    print("\n【第一部分：输入（提示词）】")
    sys_tok = report("system 提示词", system)

    worst_qs = pick_worst(all_q, args.sources)
    avg_qs = pick_average(all_q, args.sources)

    print("\n  最坏情况（挑解析最长的 %d 道错题）：" % args.sources)
    w_user = build_user_prompt(worst_qs)
    w_tok = report("user 提示词", w_user)

    print("\n  平均情况（挑中等长度的 %d 道错题）：" % args.sources)
    a_user = build_user_prompt(avg_qs)
    a_tok = report("user 提示词", a_user)

    print("\n  只参考 1 道错题（答错当下手动点「AI 出同类题」时）：")
    one_user = build_user_prompt(pick_average(all_q, 1))
    o_tok = report("user 提示词", one_user)

    print("\n【第二部分：输出（模型返回的题目）】")
    print("  最坏情况（输出一道最长的题）：")
    out_worst = report("JSON 输出", build_output_sample(pick_worst(all_q, 1)[0]))
    print("\n  平均情况：")
    out_avg = report("JSON 输出", build_output_sample(pick_average(all_q, 1)[0]))

    print("\n" + "=" * 68)
    print("【合计】")
    rows = [
        ("平均情况（参考 3 道错题）", sys_tok + a_tok, out_avg),
        ("最坏情况（参考 3 道错题）", sys_tok + w_tok, out_worst),
        ("参考 1 道错题", sys_tok + o_tok, out_avg),
    ]
    print("  %-26s %12s %12s %12s" % ("场景", "输入 token", "输出 token", "合计"))
    for label, i, o in rows:
        print("  %-26s %12.0f %12.0f %12.0f" % (label, i, o, i + o))

    print("")
    print("  说明：")
    print("   · 以上是**非深度思考**模式（设置里默认就是关掉的）")
    print("   · 如果开启了深度思考，输出侧还会多算思考过程的 token，")
    print("     通常比正文多 2~5 倍，也就是一道题可能涨到 800~1500 token 输出")
    print("   · 每天上限设 5 道的话，平均情况下约 %.0f token/天（输入 %.0f + 输出 %.0f）"
          % ((sys_tok + a_tok + out_avg) * 5, (sys_tok + a_tok) * 5, out_avg * 5))

    if args.price_in or args.price_out:
        print("\n【按你给的价格算】")
        pi, po = args.price_in, args.price_out
        print("  输入 %.2f 元/百万，输出 %.2f 元/百万" % (pi, po))
        for label, i, o in rows:
            cost = i / 1e6 * pi + o / 1e6 * po
            print("  %-26s 约 %.6f 元/道   （%.4f 元 / 100 道）" % (label, cost, cost * 100))
        five = (sys_tok + a_tok) / 1e6 * pi + out_avg / 1e6 * po
        print("  按每天 5 道算：约 %.4f 元/天   （%.2f 元/月）" % (five * 5, five * 5 * 30))
    else:
        print("\n  （想算具体花费，把 DeepSeek 官网的单价传进来：")
        print("    python tools/estimate_ai_cost.py --price-in <输入单价> --price-out <输出单价>）")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
