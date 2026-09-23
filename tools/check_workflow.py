#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
校验 .github/workflows/*.yml

为什么需要这个工具：
GitHub Actions 对工作流文件非常严格。一旦文件有语法问题（最常见的是
**重复的 key**），GitHub 不会给你友好的语法错误提示，而是表现为：
  · Actions 里一个 job 都不启动
  · 工作流名字退化成文件路径（.github/workflows/xxx.yml）
  · jobs 接口返回 total_count: 0
这种故障很难从表面看出来，所以必须在推送前本地校验一遍。

PyYAML 默认**容忍**重复 key（后者覆盖前者，静默丢失配置），
所以这里用一个严格 Loader，把重复 key 直接报成错误。

    pip install PyYAML
    python tools/check_workflow.py
"""

import os
import sys

try:
    import yaml
except ImportError:
    print("需要 PyYAML：pip install PyYAML", file=sys.stderr)
    sys.exit(1)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WF_DIR = os.path.join(ROOT, ".github", "workflows")


class StrictLoader(yaml.SafeLoader):
    """把重复 key 当成错误的 Loader"""


def _no_duplicates(loader, node, deep=False):
    seen = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in seen:
            raise yaml.YAMLError(
                "重复的 key 「%s」（第 %d 行）—— YAML 不允许同一个映射出现两次同名 key，"
                "GitHub 会因此拒绝解析整个工作流文件"
                % (key, key_node.start_mark.line + 1)
            )
        seen[key] = loader.construct_object(value_node, deep=deep)
    return seen


StrictLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _no_duplicates
)


def check(path):
    with open(path, "r", encoding="utf-8-sig") as f:
        doc = yaml.load(f, Loader=StrictLoader)
    if not isinstance(doc, dict):
        raise yaml.YAMLError("顶层不是一个映射")
    name = doc.get("name") or "(没有 name)"
    jobs = doc.get("jobs") or {}
    if not jobs:
        raise yaml.YAMLError("没有定义任何 job")
    return name, list(jobs.keys()), doc


def main():
    if not os.path.isdir(WF_DIR):
        print("没有 .github/workflows 目录，跳过")
        return

    files = [f for f in sorted(os.listdir(WF_DIR)) if f.endswith((".yml", ".yaml"))]
    if not files:
        print("没有工作流文件，跳过")
        return

    bad = 0
    for fn in files:
        path = os.path.join(WF_DIR, fn)
        try:
            name, jobs, doc = check(path)
            print("  ✓ %s" % fn)
            print("      名称：%s" % name)
            print("      jobs：%s" % "、".join(jobs))
            for jn, jd in (doc.get("jobs") or {}).items():
                steps = jd.get("steps") or []
                if not steps:
                    print("      ⚠ job 「%s」没有任何 step" % jn)
        except Exception as e:
            bad += 1
            print("  ✗ %s" % fn)
            print("      %s" % e)

    print("")
    if bad:
        print("%d 个文件有问题 —— 推送前必须修好。" % bad)
        sys.exit(1)
    print("全部通过")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
