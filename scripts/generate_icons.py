"""Generate the vector mark and opaque home-screen PNGs (requires Pillow)."""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parents[1] / 'docs' / 'icons'
OUT.mkdir(parents=True, exist_ok=True)
BLUE = '#2b56c8'
LETTERS = [
    [(145,204),(239,204),(239,226),(204,226),(204,308),(180,308),(180,226),(145,226)],
    [(256,308),(256,204),(281,204),(310,249),(339,204),(365,204),(365,308),(341,308),(341,244),(310,289),(280,244),(280,308)],
]
paths = ''.join('<path d="M' + ' L'.join(f'{x} {y}' for x,y in points) + ' Z"/>' for points in LETTERS)
svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><title>Ticket Management</title>
<path fill="{BLUE}" d="M0 0h512v512H0z"/>
<rect x="88" y="152" width="336" height="208" rx="24" fill="#fff"/>
<g fill="{BLUE}"><circle cx="88" cy="256" r="24"/><circle cx="424" cy="256" r="24"/>{paths}</g></svg>\n'''
(OUT / 'ticket.svg').write_text(svg)
scale = 4
im = Image.new('RGB', (512*scale,512*scale), BLUE)
draw = ImageDraw.Draw(im)
draw.rounded_rectangle(tuple(v*scale for v in (88,152,424,360)),radius=24*scale,fill='white')
for x in (88,424):
    draw.ellipse(tuple(v*scale for v in (x-24,232,x+24,280)),fill=BLUE)
for points in LETTERS:
    draw.polygon([(x*scale,y*scale) for x,y in points],fill=BLUE)
for size,name in [(180,'apple-touch-icon.png'),(192,'icon-192.png'),(512,'icon-512.png')]:
    im.resize((size,size),Image.Resampling.LANCZOS).save(OUT / name,optimize=True)
print('Generated SVG and 180 / 192 / 512 px PNG icons.')
