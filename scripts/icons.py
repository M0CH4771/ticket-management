"""Generate the Ticket Management icon SVGs (no dependencies).

The mark is a ticket with a star punched through it and its stub torn off.
Writes docs/icons/icon.svg (full-bleed, for home screens), icon-maskable.svg
(extra padding for Android masks) and favicon.svg (rounded, for browser tabs).
Render the PNGs afterwards with: node scripts/render-icons.mjs
"""
import math
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / 'docs' / 'icons'
NAVY, PAPER, CORAL = '#12233f', '#ffffff', '#ff5b45'


def star(cx, cy, outer, inner):
    pts = []
    for i in range(10):
        a = math.radians(-90 + i * 36)
        r = outer if i % 2 == 0 else inner
        pts.append(f'{cx + r * math.cos(a):.1f},{cy + r * math.sin(a):.1f}')
    return ' '.join(pts)


def ticket_path(x, y, w, h, radius, notch, left=False, right=False):
    cy = y + h / 2
    p = f'M{x + radius},{y} H{x + w - radius} A{radius},{radius} 0 0 1 {x + w},{y + radius} '
    if right:
        p += f'V{cy - notch} A{notch},{notch} 0 0 0 {x + w},{cy + notch} '
    p += (f'V{y + h - radius} A{radius},{radius} 0 0 1 {x + w - radius},{y + h} '
          f'H{x + radius} A{radius},{radius} 0 0 1 {x},{y + h - radius} ')
    if left:
        p += f'V{cy + notch} A{notch},{notch} 0 0 0 {x},{cy - notch} '
    return p + f'V{y + radius} A{radius},{radius} 0 0 1 {x + radius},{y} Z'


def mark_group(scale, bg):
    w, h, stub_w = 250, 190, 96
    x, y = -w / 2 - 42, -h / 2
    main = ticket_path(x, y, w, h, 22, 26, left=True)
    stub = ticket_path(0, -h / 2, stub_w, h, 22, 26, right=True)
    perforation = ''.join(
        f'<circle cx="{x + w}" cy="{y + 18 + i * (h - 36) / 6:.1f}" r="6.5" fill="{bg}"/>' for i in range(7))
    return (f'<defs><mask id="hole"><rect x="-400" y="-400" width="800" height="800" fill="#fff"/>'
            f'<polygon points="{star(x + w * 0.47, 4, 58, 24)}" fill="#000"/></mask></defs>'
            f'<g transform="translate(244 262) scale({scale}) rotate(-12)">'
            f'<path class="ticket" d="{main}" fill="{PAPER}" mask="url(#hole)"/>{perforation}'
            f'<g class="stub" transform="translate({x + w + 16} 8) rotate(11 0 {h / 2})">'
            f'<path d="{stub}" fill="{CORAL}"/></g></g>')


def icon(scale, radius=0):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><title>Ticket Management</title>'
            f'<rect width="512" height="512" rx="{radius}" fill="{NAVY}"/>{mark_group(scale, NAVY)}</svg>\n')


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'icon.svg').write_text(icon(1.04))
    (OUT / 'icon-maskable.svg').write_text(icon(0.84))
    (OUT / 'favicon.svg').write_text(icon(1.0, radius=112))
    print('Wrote icon.svg, icon-maskable.svg, favicon.svg')
