#!/usr/bin/env python3
"""校验部署出来的站点目录是否完整。

背景：deploy.yml 里「整理站点文件」那一步是白名单式 `cp -r a b c _site/`，
很容易漏掉新目录。曾经就因为漏了 `assets/`，导致线上（尤其是手机端）
所有配图 404 —— 而电脑上跑 `python -m http.server` 读的是源码目录，
图片好端端的，问题完全看不出来。

所以这里做两件事：
1. 关键文件必须在；
2. `data/figures.json`（由 bank_tool.py build 生成）列出的每一张图，
   在站点目录里都得真有对应文件。

用法： python tools/check_site.py [_site]
退出码非 0 表示站点不完整，CI 会直接失败在部署之前。
"""

import json
import os
import sys

REQUIRED = [
    'index.html',
    'manifest.webmanifest',
    'sw.js',
    'css/app.css',
    'js/app.js',
    'js/ui.js',
    'js/store.js',
    'js/ai.js',
    'js/autoai.js',
    'data/subjects.json',
    'data/figures.json',
    'icons/icon-192.png',
]


def main(argv):
    site = argv[1] if len(argv) > 1 else '_site'
    if not os.path.isdir(site):
        print('站点目录不存在：%s' % site)
        return 1

    missing = [p for p in REQUIRED if not os.path.isfile(os.path.join(site, p))]

    fig_path = os.path.join(site, 'data', 'figures.json')
    figures = []
    if os.path.isfile(fig_path):
        try:
            with open(fig_path, encoding='utf-8') as fh:
                figures = json.load(fh).get('files', [])
        except (ValueError, OSError) as exc:
            print('读取 %s 失败：%s' % (fig_path, exc))
            return 1

    missing_figs = [f for f in figures
                    if not os.path.isfile(os.path.join(site, f))]

    if missing or missing_figs:
        if missing:
            print('站点缺少 %d 个关键文件：' % len(missing))
            for p in missing:
                print('  ', p)
        if missing_figs:
            print('站点缺少 %d 张配图（前 20 张）：' % len(missing_figs))
            for p in missing_figs[:20]:
                print('  ', p)
            print('  → 检查 deploy.yml「整理站点文件」是否漏了 assets/ 之类的目录')
        return 1

    print('站点文件完整：关键文件 %d 个、配图 %d 张全部就位'
          % (len(REQUIRED), len(figures)))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
