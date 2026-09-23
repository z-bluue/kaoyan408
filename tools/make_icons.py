#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成 PWA 需要的 PNG 图标。

    pip install Pillow
    python tools/make_icons.py

会输出到 icons/：
    icon-192.png            普通图标 192
    icon-512.png            普通图标 512
    icon-maskable-512.png   自适应图标（Android 会裁成圆形/方圆形，内容留了安全区）
    apple-touch-icon.png    iOS 添加到主屏幕用（180×180）
"""

import os
import sys

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    print("需要 Pillow：pip install Pillow", file=sys.stderr)
    sys.exit(1)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "icons")

BG_TOP = (59, 142, 247)      # #3b8ef7
BG_BOTTOM = (26, 95, 208)    # #1a5fd0
GREEN = (63, 185, 80)        # #3fb950
WHITE = (255, 255, 255)

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\arialbd.ttf",
    r"C:\Windows\Fonts\segoeuib.ttf",
    r"C:\Windows\Fonts\calibrib.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
]


def load_font(size):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    print("[提示] 没找到合适的粗体字体，将使用 Pillow 默认字体（效果较差）", file=sys.stderr)
    return ImageFont.load_default()


def gradient(size):
    """用一张小图放大，得到平滑的对角渐变（比逐像素快得多）"""
    small = 64
    g = Image.new("RGB", (small, small))
    px = g.load()
    for y in range(small):
        for x in range(small):
            t = (x + y) / (2 * (small - 1))
            px[x, y] = tuple(
                int(round(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t)) for i in range(3)
            )
    return g.resize((size, size), Image.BICUBIC)


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def draw_centered_text(draw, text, font, cx, cy, fill=WHITE):
    bbox = draw.textbbox((0, 0), text, font=font)
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    draw.text((cx - w / 2 - bbox[0], cy - h / 2 - bbox[1]), text, font=font, fill=fill)


def make_icon(size, maskable=False, radius_ratio=0.22):
    SS = 4                                  # 超采样倍数，边缘更平滑
    S = size * SS
    img = gradient(S).convert("RGBA")

    draw = ImageDraw.Draw(img)

    if maskable:
        # 自适应图标：内容统一限制在中间 80% 的安全区内
        font = load_font(int(S * 0.34))
        draw_centered_text(draw, "408", font, S / 2, S / 2)
    else:
        font = load_font(int(S * 0.40))
        draw_centered_text(draw, "408", font, S / 2, S * 0.44)

        # 右下角的绿色对勾
        r = S * 0.088
        cx, cy = S * 0.795, S * 0.775
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=GREEN)
        lw = max(2, int(S * 0.020))
        draw.line(
            [(cx - r * 0.42, cy + r * 0.02), (cx - r * 0.10, cy + r * 0.36), (cx + r * 0.46, cy - r * 0.36)],
            fill=WHITE, width=lw, joint="curve",
        )

        # 圆角
        mask = rounded_mask(S, int(S * radius_ratio))
        out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        out.paste(img, (0, 0), mask)
        img = out

    return img.resize((size, size), Image.LANCZOS)


def main():
    os.makedirs(OUT, exist_ok=True)
    jobs = [
        ("icon-192.png", 192, False),
        ("icon-512.png", 512, False),
        ("icon-maskable-512.png", 512, True),
        ("apple-touch-icon.png", 180, False),
    ]
    for name, size, maskable in jobs:
        img = make_icon(size, maskable=maskable)
        path = os.path.join(OUT, name)
        img.save(path, "PNG", optimize=True)
        print("  %-26s %3d×%-3d  %6d B%s"
              % (name, size, size, os.path.getsize(path), "  (maskable)" if maskable else ""))
    print("\n图标已生成到 icons/")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
