#!/usr/bin/env python3
"""从《RELAX 1000题》解析册 PDF 里补出「解析说"如图所示"但源数据没给图」的插图。

背景
----
源站 data/site.json 的 `sol_figs` 只覆盖了 59 题（84 张图），另有 33 题的解析
明确写着"如下图所示/见下表"，却一张图都没有 —— 作者最初的抽图脚本
（tools/figures.py）用 `cluster_drawings()` 找矢量簇，而这本书里相当一部分
插图在 PyMuPDF 眼里既不是聚类矢量、也不是 XObject 图片，于是被整体漏掉了。

做法（不依赖图形对象检测）
----
  1. 用解析正文把题定位到解析册的某一页（长探针 -> 题号标记 + 短探针 -> 靠已知页对预测）
  2. 在该页找到含"如图/下图"的那一行，取它到"下一题号标记"之间的区域
  3. 优先用「矢量路径 / 栅格图」的外接框把区域收紧到图本身；本页没有图形、且
     下一页顶部就有图形的，视为"图排在下一页"
  4. 按 170 dpi 渲染该区域，再按深色像素外接框裁掉四周空白与水印

人工核验（2026-09-28）
----
逐张目视核对了 33 题的裁剪结果，其中 28 张确认是本题的正确插图；
NO_FIGURE_IN_PDF 里的 5 题在解析册 PDF 里**根本没有配图**（正文只写了
"如下图所示"却没有任何图形），属于原书缺陷，无法从 PDF 补出，只能由
import_relax.py 加一句"源数据缺图"的说明。

用法
----
    python tools/recover_figs.py              # 生成到 assets/relax/（已存在则覆盖）
    python tools/recover_figs.py --dry-run    # 只报结果，不写文件

PDF 不存在时会自动从源仓库下载（约 18 MB，两册）到 _relax/upstream/。
生成后需要跑 import_relax.py 重新导入（或在题库里按 import_relax.py 的
RECOVERED_FIGS 表重新挂图），再跑 bank_tool.py build。
"""

import argparse
import json
import os
import pathlib
import re
import socket
import sys
import urllib.parse
import urllib.request

import pymupdf as pm
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
UP_DIR = ROOT / '_relax' / 'upstream'
FIG_DIR = ROOT / 'assets' / 'relax'
SITE_JSON = ROOT / '_relax' / 'site.json'
OUT_JSON = ROOT / '_relax' / 'recovered_figs.json'

RAW_BASE = 'https://raw.githubusercontent.com/jlshdsdk/relax-1000/main/'
PDF_A = 'relax1000题解析册.pdf'          # 解析册（插图从这一册取）

DPI = 170
CLIP_X0, CLIP_X1 = 26.0, 570.0           # 左右留足余量，之后靠像素裁边收紧
PAD_PT = 7.0                             # 区域外扩（pt），保证图上的文字标签不被切
PAD_PX = 5                               # 像素裁边后再留的白边
BODY_MAX_SIZE = 16                       # 正文约 10.5pt；水印/页眉字号远大于此
MARKER = re.compile(r'^\s*(\d{1,3})\s*[．.、]')
REF = re.compile(r'如图|下图|如下表|下表|见图')
PROXY = 'http://127.0.0.1:7890'

# 人工核验：这些题在解析册 PDF 里确实没有配图（原书正文写了"如下图所示"但没画）
NO_FIGURE_IN_PDF = {
    'p1c4q46': '第 32 页正文之后无图，第 33 页整页无任何图形对象',
    'p1c4q71': '第 37 页该段之后无图，第 38 页只有正文里零星的小图形碎片',
    'p1c5q58': '第 48 页正文之后整页空白，无图（题干自带图，解析指向的是它）',
    'p3c3q15': '第 195 页全页纯文字，"如下表"指的是正文里直接列出的数值',
    'p4c6q33': '第 285 页全页纯文字，无图',
}


def norm(s):
    return re.sub(r'\s+', '', s or '')


def setup_network():
    """本机代理工具开着就走代理，否则直连。"""
    s = socket.socket()
    s.settimeout(1.0)
    try:
        s.connect(('127.0.0.1', 7890))
        handlers = {'http': PROXY, 'https': PROXY}
    except OSError:
        handlers = {}
    finally:
        s.close()
    urllib.request.install_opener(
        urllib.request.build_opener(urllib.request.ProxyHandler(handlers)))


def ensure_pdf(name):
    dest = UP_DIR / name
    if dest.exists() and dest.stat().st_size > 100_000:
        return dest
    UP_DIR.mkdir(parents=True, exist_ok=True)
    url = RAW_BASE + 'sources/' + urllib.parse.quote(name)
    print('[下载] %s …' % name)
    req = urllib.request.Request(url, headers={'User-Agent': 'recover-figs'})
    with urllib.request.urlopen(req, timeout=300) as res, open(dest, 'wb') as fh:
        while True:
            chunk = res.read(1 << 16)
            if not chunk:
                break
            fh.write(chunk)
    print('  -> %.2f MB' % (dest.stat().st_size / 1048576))
    return dest


def merge_boxes(boxes, gap=14.0):
    boxes = [list(b) for b in boxes]
    changed = True
    while changed:
        changed = False
        out = []
        while boxes:
            b = boxes.pop()
            hit = None
            for o in out:
                if not (b[2] + gap < o[0] or b[0] - gap > o[2]
                        or b[3] + gap < o[1] or b[1] - gap > o[3]):
                    hit = o
                    break
            if hit:
                hit[0] = min(hit[0], b[0]); hit[1] = min(hit[1], b[1])
                hit[2] = max(hit[2], b[2]); hit[3] = max(hit[3], b[3])
                changed = True
            else:
                out.append(b)
        boxes = out
    return boxes


class Book:
    def __init__(self, path):
        self.doc = pm.open(str(path))
        self.npage = self.doc.page_count
        self._geo = {}
        self._lines = {}
        self._norm = [norm(self.doc[i].get_text()) for i in range(self.npage)]

    def lines(self, pno):
        if pno in self._lines:
            return self._lines[pno]
        out = []
        for blk in self.doc[pno].get_text('dict').get('blocks', []):
            if blk.get('type') != 0:
                continue
            for line in blk.get('lines', []):
                txt = ''.join(s['text'] for s in line['spans'])
                if not txt.strip():
                    continue
                size = max(s.get('size', 0) for s in line['spans'])
                if size > BODY_MAX_SIZE:
                    continue                     # 水印 / 页眉
                out.append({'bbox': list(line['bbox']), 'text': txt})
        out.sort(key=lambda l: l['bbox'][1])
        self._lines[pno] = out
        return out

    def graphics(self, pno):
        if pno in self._geo:
            return self._geo[pno]
        page = self.doc[pno]
        W, H = page.rect.width, page.rect.height
        raw = []
        try:
            for d in page.get_drawings():
                r = d.get('rect')
                if r is None:
                    continue
                if r.width > 0.9 * W and r.height > 0.9 * H:
                    continue                     # 整页背景框
                if r.height < 1.8 or r.width < 1.8:
                    continue                     # 页眉横线 / 表格细线
                # 单个 re 矩形往往是文字框或字符级碎片（下划线、小方块、箭头头），
                # 真正的插图一定由很多条路径拼出来。
                if len(d.get('items') or []) < 2:
                    continue
                raw.append([r.x0, r.y0, r.x1, r.y1])
        except Exception:
            pass
        try:
            for info in page.get_images(full=True):
                for r in page.get_image_rects(info[0]):
                    if r.width > 0.9 * W and r.height > 0.9 * H:
                        continue
                    if r.width < 4 or r.height < 4:
                        continue
                    raw.append([r.x0, r.y0, r.x1, r.y1])
        except Exception:
            pass
        self._geo[pno] = merge_boxes(raw)
        return self._geo[pno]

    def find_page(self, probe):
        return [p for p in range(self.npage) if probe in self._norm[p]]

    def page_with_marker(self, num, probe=None, window=None):
        out = []
        rng = range(self.npage) if window is None else range(*window)
        for p in rng:
            if probe and probe not in self._norm[p]:
                continue
            for l in self.lines(p):
                m = MARKER.match(l['text'])
                if m and int(m.group(1)) == num:
                    out.append(p)
                    break
        return out


def trim_white(img):
    g = img.convert('L')
    w, h = g.size
    px = g.load()
    x0, y0, x1, y1 = w, h, -1, -1
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            if px[x, y] < 170:
                if x < x0: x0 = x
                if x > x1: x1 = x
                if y < y0: y0 = y
                if y > y1: y1 = y
    if x1 < 0:
        return None
    return img.crop((max(0, x0 - PAD_PX), max(0, y0 - PAD_PX),
                     min(w, x1 + PAD_PX), min(h, y1 + PAD_PX)))


def recovered_figure(book, qid, q, predict):
    """返回 (PIL.Image, 说明字符串) 或 (None, 原因)。"""
    n = norm(q.get('expl_text') or q.get('expl_html') or '')
    pages, probe, how = [], '', ''
    for plen in (18, 12, 8):
        if len(n) < plen:
            continue
        cand = book.find_page(n[:plen])
        if cand:
            pages, probe, how = cand, n[:plen], '长探针'
            break

    if not pages or len(pages) > 1:
        m = re.match(r'p(\d)c(\d+)q(\d+)$', qid)
        num = int(m.group(3)) if m else None
        short, sprobe = None, ''
        if num is not None:
            for plen in (6, 4, 3):
                if len(n) < plen:
                    continue
                c = book.page_with_marker(num, n[:plen])
                if c:
                    short, sprobe = c, n[:plen]
                    break
        if short is None and num is not None:
            win = (max(0, predict - 4), min(book.npage, predict + 6))
            short, sprobe = book.page_with_marker(num, None, win), '(仅题号标记)'
        if short:
            pool = [p for p in pages if p in short] or short
            pages = [min(pool, key=lambda p: abs(p - predict))]
            probe = sprobe
            how += ' -> 短探针/题号'

    for pno in pages[:3]:
        lines = book.lines(pno)
        ai = None
        for i, l in enumerate(lines):
            if probe and probe in norm(l['text']):
                ai = i
                break
        anchor_y = lines[ai]['bbox'][3] if ai is not None else 60.0
        end_y = book.doc[pno].rect.height - 45
        if ai is not None:
            for l in lines[ai + 1:]:
                if MARKER.match(l['text']):
                    end_y = l['bbox'][1] - 4
                    break

        boxes = [b for b in book.graphics(pno) if b[3] > anchor_y + 2]
        src_page = pno
        region = None
        if boxes:
            boxes.sort(key=lambda b: b[1])
            region = list(boxes[0])
            for b in boxes[1:]:
                if b[1] - region[3] < 25:
                    region[0] = min(region[0], b[0]); region[1] = min(region[1], b[1])
                    region[2] = max(region[2], b[2]); region[3] = max(region[3], b[3])
        elif pno + 1 < book.npage:
            nxt = [b for b in book.graphics(pno + 1) if b[1] < 220]
            if nxt:
                nxt.sort(key=lambda b: b[1])
                region = list(nxt[0])
                src_page = pno + 1
        if region is None:
            return None, '锚点后没有图形（图也不在下一页顶部）'

        page = book.doc[src_page]
        y0 = max(0.0, region[1] - PAD_PT)
        y1 = min(page.rect.height, region[3] + PAD_PT)
        if y1 - y0 < 12:
            return None, '图形区域过小'
        pix = page.get_pixmap(clip=pm.Rect(CLIP_X0, y0, CLIP_X1, y1), dpi=DPI)
        img = Image.frombytes('RGB', (pix.width, pix.height), pix.samples)
        cropped = trim_white(img)
        if cropped is None or cropped.height < 40 or cropped.width < 60:
            return None, '裁边后过小'
        how = '%s, %s页%d' % (how, '同' if src_page == pno else '下', src_page)
        return cropped, how
    return None, '定位到页但未取到图（pages=%s）' % pages


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true', help='只报结果，不写文件')
    args = ap.parse_args()

    if not SITE_JSON.exists():
        print('缺少 %s —— 先跑一次 tools/import_relax.py 让它下载源数据' % SITE_JSON)
        return 2
    site = json.loads(SITE_JSON.read_text(encoding='utf-8'))
    src = {}
    for ch in site.get('chapters', []):
        for q in ch.get('questions', []):
            src[q['id']] = q

    targets = [qid for qid, q in sorted(src.items())
               if REF.search(q.get('expl_html') or '')
               and not (q.get('sol_figs') or [])]
    print('源数据里"解析提如图但没有图"的题：%d 道' % len(targets))

    setup_network()
    book = Book(ensure_pdf(PDF_A))

    # 先用能唯一定位的题拟合"习题册页 -> 解析册页"的映射，用于给短解析兜底
    pairs = []
    for qid in targets:
        n = norm(src[qid].get('expl_text') or src[qid].get('expl_html') or '')
        for plen in (18, 12, 8):
            if len(n) < plen:
                continue
            cand = book.find_page(n[:plen])
            if len(cand) == 1:
                bp = (src[qid].get('pages') or [None])[0]
                if bp:
                    pairs.append((bp, cand[0]))
            break
    pairs.sort()

    def predict(book_page):
        if not pairs:
            return 0
        if book_page <= pairs[0][0]:
            return pairs[0][1]
        if book_page >= pairs[-1][0]:
            return pairs[-1][1]
        for (b1, a1), (b2, a2) in zip(pairs, pairs[1:]):
            if b1 <= book_page <= b2:
                if b2 == b1:
                    return a1
                t = (book_page - b1) / (b2 - b1)
                return int(round(a1 + t * (a2 - a1)))
        return pairs[-1][1]

    mapping = {}
    skipped = []
    FIG_DIR.mkdir(parents=True, exist_ok=True)
    for qid in targets:
        if qid in NO_FIGURE_IN_PDF:
            skipped.append((qid, NO_FIGURE_IN_PDF[qid]))
            continue
        q = src[qid]
        pred = predict((q.get('pages') or [0])[0] or 0)
        img, how = recovered_figure(book, qid, q, pred)
        if img is None:
            skipped.append((qid, how))
            print('  %-10s 未取到：%s' % (qid, how))
            continue
        out = FIG_DIR / ('%s_sol1.png' % qid)
        if not args.dry_run:
            img.save(out)
        mapping[qid] = out.name
        print('  %-10s -> %-22s %dx%d  (%s)'
              % (qid, out.name, img.width, img.height, how))

    print('\n补出 %d 张，未能补出 %d 题：' % (len(mapping), len(skipped)))
    for qid, why in skipped:
        print('   %-10s %s' % (qid, why))
    if not args.dry_run:
        OUT_JSON.write_text(json.dumps(mapping, ensure_ascii=False, indent=2) + '\n',
                            encoding='utf-8')
        print('\n已写入 %s' % OUT_JSON.relative_to(ROOT))
        print('下一步：把 mapping 同步进 import_relax.py 的 RECOVERED_FIGS，再重新导入')
    return 0


if __name__ == '__main__':
    sys.exit(main())
