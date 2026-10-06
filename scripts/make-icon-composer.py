"""Builds the app icon as an Icon Composer document (build/AppIcon.icon): the logo over a tile that's
white in light mode and deep navy (with a soft blue glow) in dark mode, so macOS shows the right one
in Finder and the Dock even while Zepper isn't running. scripts/make-icon-assets.sh compiles it.

Usage: python3 scripts/make-icon-composer.py
"""
import json
import os
import shutil

from PIL import Image, ImageDraw, ImageFilter

OUT = 'build/AppIcon.icon'
CANVAS = 1024


def color(rgb):
    return 'srgb:' + ','.join(f'{c / 255:.5f}' for c in rgb) + ',1.00000'


shutil.rmtree(OUT, ignore_errors=True)
os.makedirs(f'{OUT}/Assets')

# Icon Composer's canvas is the tile itself (scripts/make-icons.py draws an 824pt tile on 1024), so
# sizes here are those of make-icons.py scaled by 1024/824: the artwork is 80% of the tile.
TILE = CANVAS / 824
art = Image.open('src/renderer/src/assets/logo.png').convert('RGBA')
art.save(f'{OUT}/Assets/logo.png')
scale = round(CANVAS * 0.8 / art.width, 4)

# Dark mode's soft brand-blue glow behind the globe.
glow = Image.new('RGBA', (CANVAS, CANVAS), (0, 0, 0, 0))
r = int(824 * 0.33 * TILE)
lift = 40 * TILE
ImageDraw.Draw(glow).ellipse([CANVAS / 2 - r, CANVAS / 2 - r - lift, CANVAS / 2 + r, CANVAS / 2 + r - lift], fill=(70, 110, 240, 110))
glow.filter(ImageFilter.GaussianBlur(70 * TILE)).save(f'{OUT}/Assets/glow.png')

icon = {
    'fill-specializations': [
        {'value': {'linear-gradient': [color((255, 255, 255)), color((226, 234, 252))]}},
        {'appearance': 'dark', 'value': {'linear-gradient': [color((38, 44, 66)), color((12, 14, 24))]}},
    ],
    'groups': [
        {
            'layers': [
                {
                    'name': 'logo',
                    'image-name': 'logo.png',
                    'glass': False,
                    'position': {'scale': scale, 'translation-in-points': [0, round(6 * TILE, 1)]},
                },
                {
                    'name': 'glow',
                    'image-name': 'glow.png',
                    'glass': False,
                    'hidden-specializations': [{'value': True}, {'appearance': 'dark', 'value': False}],
                },
            ],
            'shadow': {'kind': 'neutral', 'opacity': 0.5},
            'translucency': {'enabled': False, 'value': 0.5},
        }
    ],
    'supported-platforms': {'squares': ['macOS']},
}
with open(f'{OUT}/icon.json', 'w') as f:
    json.dump(icon, f, indent=2)
print('wrote', OUT)
