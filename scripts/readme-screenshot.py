"""Builds docs/screenshot.png from a running development instance.

Captures each layer with the debug server, composites them over a soft gradient with a window
shadow and the macOS traffic lights:

    curl -s "127.0.0.1:9876/capture?dir=/tmp/zepper-shot" > /tmp/zepper-shot/layers.json
    python3 scripts/readme-screenshot.py /tmp/zepper-shot/layers.json docs/screenshot.png [#c0,#c1,#c2]

Needs Pillow and NumPy.
"""
import json, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

layers_json, out_path = sys.argv[1], sys.argv[2]
stops = [s for s in sys.argv[3].split(',')] if len(sys.argv) > 3 else ['#aab4c8', '#c9c2dc', '#e8d6cb']

def hex_rgb(h):
    h = h.lstrip('#'); return np.array([int(h[i:i+2], 16) for i in (0, 2, 4)], dtype=np.float32)

layers = json.load(open(layers_json))
chrome = next(l for l in layers if l['name'] == 'chrome')
W, H = Image.open(chrome['file']).size
sc = chrome['scale']

# Backdrop: a soft three-colour diagonal blend with a gentle glow.
pad_x, pad_top, pad_bottom = int(W * 0.07), int(H * 0.08), int(H * 0.10)
CW, CH = W + 2 * pad_x, H + pad_top + pad_bottom
y, x = np.mgrid[0:CH, 0:CW].astype(np.float32)
t = (x / CW * 0.6 + y / CH * 0.4)
c0, c1, c2 = (hex_rgb(s) for s in stops)
t3 = t[..., None]
grad = np.where(t3 < 0.5, c0 + (c1 - c0) * (t3 / 0.5), c1 + (c2 - c1) * ((t3 - 0.5) / 0.5))
glow = np.exp(-(((x - CW * 0.78) / (CW * 0.45)) ** 2 + ((y - CH * 0.15) / (CH * 0.5)) ** 2))[..., None]
grad = grad + (255 - grad) * glow * 0.25
noise = np.random.default_rng(7).normal(0, 1.2, grad.shape[:2])[..., None]
backdrop = Image.fromarray(np.clip(grad + noise, 0, 255).astype(np.uint8), 'RGB').convert('RGBA')

# The window: macOS vibrancy behind the translucent chrome = the blurred backdrop, lightened.
behind = backdrop.crop((pad_x, pad_top, pad_x + W, pad_top + H)).filter(ImageFilter.GaussianBlur(60))
behind = Image.blend(behind, Image.new('RGBA', (W, H), (238, 238, 242, 255)), 0.55)
win = behind.copy()
for l in layers:
    im = Image.open(l['file']).convert('RGBA'); b = l['bounds']
    if l['name'].startswith('tab'):
        mask = Image.new('L', im.size, 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, im.size[0] - 1, im.size[1] - 1], int(10 * sc), fill=255)
        im.putalpha(mask)
    if l['name'] == 'overlay' and b['width'] < 500:
        continue
    win.alpha_composite(im, (int(b['x'] * sc), int(b['y'] * sc)))

# Traffic lights (drawn by macOS, so they're not in the capture).
d = ImageDraw.Draw(win)
for i, (fill, edge) in enumerate([('#ff5f57', '#e0443e'), ('#febc2e', '#dea123'), ('#28c840', '#1aab29')]):
    cx, cy, r = (17 + 6 + i * 20) * sc, (17 + 6) * sc, 6 * sc
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fill, outline=edge, width=1)

radius = int(12 * sc)
mask = Image.new('L', (W, H), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, W - 1, H - 1], radius, fill=255)
# Hairline border like a macOS window.
border = Image.new('RGBA', (W, H), (0, 0, 0, 0))
ImageDraw.Draw(border).rounded_rectangle([0, 0, W - 1, H - 1], radius, outline=(0, 0, 0, 46), width=max(1, int(sc)))
win.alpha_composite(border)

shadow = Image.new('RGBA', (CW, CH), (0, 0, 0, 0))
ImageDraw.Draw(shadow).rounded_rectangle([pad_x, pad_top + int(18 * sc), pad_x + W, pad_top + H + int(18 * sc)], radius, fill=(20, 22, 40, 110))
shadow = shadow.filter(ImageFilter.GaussianBlur(int(28 * sc)))
canvas = backdrop.copy()
canvas.alpha_composite(shadow)
canvas.paste(win, (pad_x, pad_top), mask)

out = canvas.convert('RGB').resize((1800, round(CH * 1800 / CW)), Image.LANCZOS)
out.save(out_path, optimize=True)
print(out.size)
