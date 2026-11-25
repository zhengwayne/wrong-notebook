#!/usr/bin/env python3
"""生成底部标签栏 PNG 图标（81×81，透明底）：未选中灰紫、选中主色。依赖 cairosvg。"""
import os
import re
import cairosvg

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'icons', 'lucide')
OUT = os.path.join(ROOT, 'src', 'assets', 'tabbar')
TABS = {'home': 'house', 'notebook': 'book-open', 'review': 'calendar-check', 'me': 'user'}
COLORS = {'': '#8A8499', '-active': '#6B5CA5'}

os.makedirs(OUT, exist_ok=True)
for tab, icon in TABS.items():
    raw = open(os.path.join(SRC, icon + '.svg'), encoding='utf8').read()
    body = raw[raw.index('>', raw.index('<svg')) + 1:raw.rindex('</svg>')]
    for suffix, color in COLORS.items():
        # 24 视图框留 2 像素边距，线宽 1.8 在 81px 下约 6px，接近微信原生标签栏粗细
        svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="81" height="81" viewBox="-2 -2 28 28" fill="none" '
               f'stroke="{color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">{body}</svg>')
        cairosvg.svg2png(bytestring=svg.encode('utf8'), write_to=os.path.join(OUT, f'{tab}{suffix}.png'),
                         output_width=81, output_height=81)
print('ok')
