#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把《RELAX 1000题》题册（作者授权）转成本项目的题库格式。

来源仓库：https://github.com/jlshdsdk/relax-1000
授权：作者为项目作者的朋友，已明确同意转载。

用法（在项目根目录执行）：

    python tools/import_relax.py --site _relax/site.json --fetch-figures
    python tools/import_relax.py --site _relax/site.json --apply

  --fetch-figures  下载题目插图到 assets/relax/（已存在则跳过）
  --apply          把转换结果并入 data/*.json，并把合并章名登记进 subjects.json
  --dry-run        只做转换与统计，不写任何文件
"""

import argparse
import collections
import html as html_mod
import json
import os
import pathlib
import re
import sys
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT = ROOT / "_relax" / "out"
FIG_DIR = ROOT / "assets" / "relax"

RAW_BASE = "https://raw.githubusercontent.com/jlshdsdk/relax-1000/main/"
SOURCE_LABEL = "RELAX 1000题"

# 书的四个部分 -> 我们的科目 id
PART_SUBJECT = {1: "ds", 2: "co", 3: "os", 4: "net"}

# 章节 id -> 我们的章节名。凡是与 408 大纲同名的直接沿用，
# 书里把两章合成一章的，保留书的合并名（新增到 subjects.json），避免张冠李戴。
CHAPTER_NAME = {
    "p1c1": "绪论",
    "p1c2": "线性表",
    "p1c3": "栈、队列、数组、字符串",   # 书里第3、4章合一（新增章节）
    "p1c4": "树与二叉树",
    "p1c5": "图",
    "p1c6": "查找",
    "p1c7": "排序",
    "p2c1": "计算机系统概述",
    "p2c2": "数据的表示和运算",
    "p2c3": "存储系统",
    "p2c4": "指令系统",
    "p2c5": "中央处理器",
    "p2c6": "总线和输入/输出系统",      # 书里第6章合一（新增章节）
    "p3c1": "计算机系统概述",
    "p3c2": "进程与线程",
    "p3c3": "内存管理",
    "p3c4": "文件管理",
    "p3c5": "输入/输出管理",
    "p4c1": "计算机网络体系结构",
    "p4c2": "物理层",
    "p4c3": "数据链路层",
    "p4c4": "网络层",
    "p4c5": "传输层",
    "p4c6": "应用层",
}

# 知识点关键词：从题干里命中的词会作为 topics（连同章节名）。
# 只用于「薄弱点推题 / AI 出题」的粒度，不需要非常全。
TOPIC_WORDS = {
    "p1c1": ["时间复杂度", "空间复杂度", "抽象数据类型", "算法特性", "数据结构基本概念"],
    "p1c2": ["顺序表", "单链表", "双链表", "循环链表", "静态链表", "插入删除", "链表操作"],
    "p1c3": ["栈", "队列", "循环队列", "共享栈", "表达式求值", "递归", "特殊矩阵",
             "稀疏矩阵", "数组存储", "串", "KMP", "next数组", "模式匹配"],
    "p1c4": ["二叉树遍历", "完全二叉树", "满二叉树", "哈夫曼树", "二叉排序树", "平衡二叉树",
             "线索二叉树", "树的存储", "森林", "并查集", "红黑树", "B树", "树的性质"],
    "p1c5": ["邻接矩阵", "邻接表", "十字链表", "深度优先", "广度优先", "最小生成树",
             "最短路径", "拓扑排序", "关键路径", "连通分量", "强连通"],
    "p1c6": ["顺序查找", "折半查找", "分块查找", "B树", "B+树", "散列表", "冲突处理",
             "平均查找长度", "平衡二叉树"],
    "p1c7": ["插入排序", "希尔排序", "冒泡排序", "快速排序", "简单选择排序", "堆排序",
             "归并排序", "基数排序", "排序稳定性", "外部排序", "比较次数", "移动次数"],
    "p2c1": ["冯诺依曼", "性能指标", "CPI", "MIPS", "主频", "基准程序", "层次结构"],
    "p2c2": ["补码", "原码", "反码", "移码", "定点数", "浮点数", "IEEE754", "溢出",
             "算术移位", "进位", "标志位", "乘除法", "校验码", "类型转换"],
    "p2c3": ["Cache", "主存", "虚拟存储", "页表", "段表", "TLB", "地址映射", "替换算法",
             "写策略", "存储器扩展", "DRAM刷新", "磁盘", "RAID", "局部性"],
    "p2c4": ["寻址方式", "指令格式", "扩展操作码", "RISC", "CISC", "机器级表示", "汇编", "转移指令"],
    "p2c5": ["数据通路", "控制器", "指令周期", "流水线", "数据相关", "冒险", "超标量",
             "中断", "异常", "微程序", "硬布线"],
    "p2c6": ["总线", "总线带宽", "总线仲裁", "定时", "I/O接口", "程序查询", "中断方式",
             "DMA", "通道", "磁盘访问时间"],
    "p3c1": ["内核态", "用户态", "系统调用", "中断", "异常", "引导", "虚拟机", "运行机制"],
    "p3c2": ["进程状态", "PCB", "同步", "互斥", "PV操作", "信号量", "管程", "死锁",
             "银行家算法", "进程调度", "线程", "上下文切换", "生产者", "消费者"],
    "p3c3": ["分页", "分段", "段页式", "页面置换", "LRU", "FIFO", "时钟算法", "地址转换",
             "抖动", "工作集", "动态分区", "覆盖", "交换"],
    "p3c4": ["文件目录", "索引结点", "索引分配", "链接分配", "连续分配", "空闲空间",
             "文件共享", "磁盘结构", "目录检索"],
    "p3c5": ["缓冲区", "SPOOLing", "设备分配", "磁盘调度", "SSTF", "SCAN", "中断处理", "设备驱动"],
    "p4c1": ["OSI", "TCP/IP", "分层", "协议", "服务", "封装", "时延", "吞吐量", "性能指标"],
    "p4c2": ["奈氏准则", "香农定理", "编码", "调制", "传输介质", "双绞线", "光纤",
             "信道复用", "码元", "波特率", "中继器"],
    "p4c3": ["差错控制", "CRC", "海明码", "滑动窗口", "停等协议", "后退N帧", "选择重传",
             "CSMA/CD", "以太网", "MAC帧", "交换机", "VLAN", "PPP", "网桥"],
    "p4c4": ["IP地址", "子网划分", "CIDR", "路由聚合", "IP分组", "ARP", "ICMP", "路由算法",
             "RIP", "OSPF", "BGP", "NAT", "DHCP", "IPv6", "分片"],
    "p4c5": ["TCP", "UDP", "三次握手", "四次挥手", "流量控制", "拥塞控制", "慢开始",
             "快重传", "序号", "确认", "报文段", "端口"],
    "p4c6": ["DNS", "HTTP", "FTP", "SMTP", "POP3", "电子邮件", "万维网", "URL",
             "递归查询", "迭代查询"],
}

BLOCK_TAG_RE = re.compile(r"<(p|div|li|tr|table)\b[^>]*>", re.I)
BLOCK_END_RE = re.compile(r"</(p|div|li|tr|table)>", re.I)
BR_RE = re.compile(r"<br\s*/?>", re.I)
STRONG_RE = re.compile(r"</?strong>|</?b>", re.I)
EM_RE = re.compile(r"</?em>|</?i>", re.I)
KEEP_RE = re.compile(r"<sup>|</sup>|<sub>|</sub>", re.I)
TAG_RE = re.compile(r"</?[a-zA-Z][a-zA-Z0-9]*[^>]*>")


def clean_html(s):
    """把来源的 HTML 片段转成本项目 richText 能渲染的文本。

    - <br>/<p> 等块级标签 -> 换行
    - <strong> -> **粗体**
    - <sup>/<sub> 原样保留（richText 里做了白名单渲染）
    - 其余标签一律剥掉，实体做反转义
    """
    if not s:
        return ""
    t = str(s)
    t = BR_RE.sub("\n", t)
    t = re.sub(r'<p[^>]*class="errata-fix"[^>]*>', "\n\n**勘误修正：**", t, flags=re.I)
    t = BLOCK_TAG_RE.sub("\n", t)
    t = BLOCK_END_RE.sub("\n", t)
    t = STRONG_RE.sub("**", t)
    t = EM_RE.sub("*", t)
    t = TAG_RE.sub(lambda m: m.group(0) if KEEP_RE.fullmatch(m.group(0)) else "", t)
    t = html_mod.unescape(t)
    t = "\n".join(line.rstrip() for line in t.split("\n"))
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t.strip()


def pick_topics(chapter_id, stem):
    words = TOPIC_WORDS.get(chapter_id, [])
    hit = [w for w in words if w in stem][:3]
    return hit


def fig_path(name):
    """插图引用可能是裸文件名，也可能是带目录的相对路径。"""
    n = str(name).strip()
    if n.startswith("assets/"):
        return n
    return "assets/" + n


def convert(site, want_figures=True):
    """返回 (每个科目的题目列表, 报告)"""
    by_subject = collections.defaultdict(list)
    report = {
        "total": 0,
        "imported": 0,
        "skipped": [],
        "figures": set(),
        "figure_questions": 0,
        "soup": [],
        "chapter_counts": collections.OrderedDict(),
    }

    for ch in site["chapters"]:
        cid = ch["id"]
        if cid not in CHAPTER_NAME:
            raise SystemExit(f"章节 {cid} 没有映射规则，请先补 CHAPTER_NAME")
        sid = PART_SUBJECT[ch["part"]]
        chapter = CHAPTER_NAME[cid]
        report["chapter_counts"][f"{cid} {chapter}"] = len(ch["questions"])

        for q in ch["questions"]:
            report["total"] += 1
            qid = q["id"]

            opts = q.get("opts") or {}
            if len(opts) != 4 or sorted(opts.keys()) != ["A", "B", "C", "D"]:
                report["skipped"].append((qid, "选项不是四个"))
                continue

            ans = str(q.get("ans") or "").strip().upper()
            if ans not in opts:
                report["skipped"].append((qid, f"答案异常({ans or '空'})"))
                continue

            stem = clean_html(q.get("stem_html") or q.get("stem_text"))
            if len(stem) < 5:
                report["skipped"].append((qid, "题干为空"))
                continue

            explain = clean_html(q.get("expl_html") or q.get("expl_text"))
            if len(explain) < 5:
                report["skipped"].append((qid, "解析为空"))
                continue

            options = []
            for k in ["A", "B", "C", "D"]:
                o = opts[k] or {}
                options.append({"key": k, "text": clean_html(o.get("html") or o.get("text"))})

            # ---- 插图 ----
            figs = []
            for name in (q.get("stem_figs") or []):
                figs.append(("stem", name))
            for name in (q.get("sol_figs") or []):
                figs.append(("sol", name))
            for k, names in (q.get("opt_figs") or {}).items():
                for name in names or []:
                    figs.append(("opt:" + k, name))

            if figs and want_figures:
                report["figure_questions"] += 1
            added = {"stem": [], "sol": []}
            for where, name in figs if want_figures else []:
                p = fig_path(name)
                base = os.path.basename(p)
                report["figures"].add(p)
                tag = f'<img src="assets/relax/{base}">'
                if where == "stem":
                    added["stem"].append(tag)
                elif where == "sol":
                    added["sol"].append(tag)
                elif where.startswith("opt:"):
                    key = where.split(":", 1)[1]
                    for o in options:
                        if o["key"] == key:
                            o["text"] = (o["text"] + "\n" + tag).strip()

            # 选项的合法性要挂在插图之后判：选项本身就是一张图的题是正常的
            empty_opt = [o["key"] for o in options if not o["text"]]
            if empty_opt:
                report["skipped"].append((qid, "选项 " + "/".join(empty_opt) + " 为空"))
                continue
            if not added["stem"] and len(stem) < 5:
                report["skipped"].append((qid, "题干为空"))
                continue

            # 统计疑似 PDF 公式残渣（只报告，不自动改，免得误删内容）
            tail = stem.split("\n")[-1].strip()
            if len(tail) >= 8 and not re.search(r"[\u4e00-\u9fff]", tail) and " " not in tail:
                report["soup"].append((qid, tail[:40]))

            if added["stem"]:
                stem = stem + "\n\n" + "\n".join(added["stem"])
            if added["sol"]:
                explain = explain + "\n\n" + "\n".join(added["sol"])

            topics = [chapter] + pick_topics(cid, stem)

            by_subject[sid].append({
                "id": "rx-" + qid,
                "chapter": chapter,
                "topics": topics,
                "type": "single",
                "difficulty": 3,
                "stem": stem,
                "options": options,
                "answer": [ans],
                "accept": [],
                "explain": explain,
                "source": f"{SOURCE_LABEL} · {qid}",
            })
            report["imported"] += 1

    return by_subject, report


def fetch_figures(files, report):
    """把插图抓到 assets/relax/。个别失败不影响整批导入。"""
    FIG_DIR.mkdir(parents=True, exist_ok=True)
    ok = skip = fail = 0
    failed = []
    for rel in sorted(files):
        base = os.path.basename(rel)
        dest = FIG_DIR / base
        if dest.exists() and dest.stat().st_size > 0:
            skip += 1
            continue
        last_err = None
        for url_rel in (rel, "assets/errata/" + base):
            try:
                req = urllib.request.Request(RAW_BASE + url_rel,
                                             headers={"User-Agent": "kaoyan408-import"})
                with urllib.request.urlopen(req, timeout=30) as r:
                    blob = r.read()
                if not blob.startswith(b"\x89PNG"):
                    last_err = "不是 PNG"
                    continue
                dest.write_bytes(blob)
                ok += 1
                last_err = None
                break
            except urllib.error.HTTPError as e:
                last_err = f"HTTP {e.code}"
            except Exception as e:                       # noqa: BLE001
                last_err = str(e)
        if last_err:
            fail += 1
            failed.append((rel, last_err))

    total = sum(f.stat().st_size for f in FIG_DIR.glob("*.png"))
    print(f"[插图] 新下载 {ok}，已存在 {skip}，失败 {fail}，目录合计 {total/1048576:.2f} MB")
    for rel, err in failed[:20]:
        print(f"       失败：{rel}（{err}）")
    return failed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", default="_relax/site.json")
    ap.add_argument("--fetch-figures", action="store_true")
    ap.add_argument("--no-figures", action="store_true", help="丢弃插图（只导纯文字题）")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--replace", action="store_true",
                    help="并库前先删掉上次导入的 rx- 开头的题（可重复导入）")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    site_path = (ROOT / args.site) if not os.path.isabs(args.site) else pathlib.Path(args.site)
    if not site_path.exists():
        print(f"[下载] {site_path.name} 不存在，从源仓库拉取…")
        site_path.parent.mkdir(parents=True, exist_ok=True)
        req = urllib.request.Request(RAW_BASE + "data/site.json",
                                     headers={"User-Agent": "kaoyan408-import"})
        with urllib.request.urlopen(req, timeout=120) as r:
            site_path.write_bytes(r.read())
    site = json.loads(site_path.read_text(encoding="utf-8"))

    by_subject, report = convert(site, want_figures=not args.no_figures)

    print(f"[题目] 源共 {report['total']} 题，可导入 {report['imported']} 题，"
          f"剔除 {len(report['skipped'])} 题")
    for sid in ["ds", "co", "os", "net"]:
        print(f"       {sid}: {len(by_subject.get(sid, []))} 题")
    print(f"[插图] 涉及 {report['figure_questions']} 题、{len(report['figures'])} 个图片文件")
    print(f"[公式残渣] 题干末尾疑似 PDF 杂字符串的题：{len(report['soup'])} 道"
          f"（只统计，不自动清理）")
    for qid, tail in report["soup"][:8]:
        print(f"       {qid}: {tail!r}")
    if report["skipped"]:
        print("[剔除明细]")
        for qid, why in report["skipped"]:
            print(f"       {qid}: {why}")

    if args.dry_run:
        return

    if args.fetch_figures:
        fetch_figures(report["figures"], report)

    if not args.apply:
        OUT.mkdir(parents=True, exist_ok=True)
        for sid, qs in by_subject.items():
            (OUT / f"{sid}.json").write_text(
                json.dumps({"id": sid, "questions": qs}, ensure_ascii=False, indent=2),
                encoding="utf-8", newline="\n")
        print(f"[输出] 已写到 {OUT.relative_to(ROOT)}/（未并入题库，加 --apply 才合并）")
        return

    # ---- 合并进 data/*.json ----
    subjects_file = DATA / "subjects.json"
    meta = json.loads(subjects_file.read_text(encoding="utf-8"))
    meta_by_id = {s["id"]: s for s in meta["subjects"]}

    added_chapters = []
    for sid, qs in by_subject.items():
        path = DATA / f"{sid}.json"
        raw = json.loads(path.read_text(encoding="utf-8"))
        if args.replace:
            dropped = [q for q in raw["questions"] if str(q.get("id", "")).startswith("rx-")]
            raw["questions"] = [q for q in raw["questions"] if not str(q.get("id", "")).startswith("rx-")]
            if dropped:
                print(f"[替换] {sid}.json 先移除旧的导入题 {len(dropped)} 道")
        exist = {q["id"] for q in raw["questions"]}
        new = [q for q in qs if q["id"] not in exist]
        raw["questions"].extend(new)
        path.write_text(json.dumps(raw, ensure_ascii=False, indent=2) + "\n",
                        encoding="utf-8", newline="\n")
        print(f"[合并] {sid}.json 新增 {len(new)} 题，现共 {len(raw['questions'])} 题")

        want = list(dict.fromkeys(q["chapter"] for q in qs))
        chapters = meta_by_id[sid]["chapters"]
        for c in want:
            if c not in chapters:
                chapters.append(c)
                added_chapters.append(f"{sid}: {c}")

    subjects_file.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n",
                            encoding="utf-8", newline="\n")
    if added_chapters:
        print("[章节] 新增到 subjects.json：" + "；".join(added_chapters))
    print("[完成] 记得跑 python tools/bank_tool.py validate && build")


if __name__ == "__main__":
    main()
