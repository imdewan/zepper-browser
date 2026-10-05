"""Generates macOS-style app icons (light and dark) from the logo artwork.

Usage: python3 scripts/make-icons.py
"""
from PIL import Image, ImageDraw, ImageFilter, ImageChops
import math

SS = 4
N = 1024 * SS
PLATE = 824 * SS  # Apple's macOS icon grid: 824pt tile on a 1024 canvas
OFF = (N - PLATE) // 2


def superellipse(cx, cy, a, b, n=5.0, steps=720):
    pts = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        c, s = math.cos(t), math.sin(t)
        pts.append((cx + a * abs(c) ** (2 / n) * (1 if c >= 0 else -1), cy + b * abs(s) ** (2 / n) * (1 if s >= 0 else -1)))
    return pts


def make(top, bottom, stroke_rgba, glow, out):
    mask = Image.new('L', (N, N), 0)
    ImageDraw.Draw(mask).polygon(superellipse(N / 2, N / 2, PLATE / 2, PLATE / 2), fill=255)

    shadow = Image.new('RGBA', (N, N), (0, 0, 0, 0))
    soft = ImageChops.offset(mask.filter(ImageFilter.GaussianBlur(14 * SS)), 0, 10 * SS)
    shadow.putalpha(soft.point(lambda v: int(v * 0.32)))

    grad = Image.new('RGBA', (N, N))
    gd = ImageDraw.Draw(grad)
    for y in range(N):
        t = min(1, max(0, (y - OFF) / PLATE))
        gd.line([(0, y), (N, y)], fill=tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3)) + (255,))
    tile = Image.new('RGBA', (N, N), (0, 0, 0, 0))
    tile.paste(grad, (0, 0), mask)

    art = Image.open('src/renderer/src/assets/logo.png').convert('RGBA')
    w = int(PLATE * 0.8)
    h = round(art.height * w / art.width)
    art = art.resize((w, h), Image.LANCZOS)
    pos = ((N - w) // 2, (N - h) // 2 + 6 * SS)

    icon = Image.new('RGBA', (N, N), (0, 0, 0, 0))
    icon.alpha_composite(shadow)
    icon.alpha_composite(tile)

    if glow:
        # Soft brand-blue glow behind the globe so the artwork lifts off a dark tile.
        halo = Image.new('RGBA', (N, N), (0, 0, 0, 0))
        hd = ImageDraw.Draw(halo)
        r = int(PLATE * 0.33)
        hd.ellipse([N / 2 - r, N / 2 - r - 40 * SS, N / 2 + r, N / 2 + r - 40 * SS], fill=glow)
        halo = halo.filter(ImageFilter.GaussianBlur(70 * SS))
        clipped = Image.new('RGBA', (N, N), (0, 0, 0, 0))
        clipped.paste(halo, (0, 0), mask)
        icon.alpha_composite(clipped)

    edge = mask.filter(ImageFilter.MinFilter(2 * SS + 1))
    stroke = Image.new('RGBA', (N, N), stroke_rgba[:3] + (0,))
    stroke.putalpha(ImageChops.subtract(mask, edge).point(lambda v: int(v * stroke_rgba[3] / 255)))
    icon.alpha_composite(stroke)
    icon.alpha_composite(art, pos)
    icon.resize((1024, 1024), Image.LANCZOS).save(out)
    print('wrote', out)


make((255, 255, 255), (226, 234, 252), (40, 65, 147, 46), None, 'resources/icon.png')
make((38, 44, 66), (12, 14, 24), (255, 255, 255, 30), (70, 110, 240, 110), 'resources/icon-dark.png')
