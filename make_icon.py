# Generates the tray/app icon: a mini tachometer matching the widget's look.
# Draws at 1024px with supersampling, exports PNGs + multi-size .ico into assets/.
import math, os
from PIL import Image, ImageDraw

S = 1024
C = S // 2
SWEEP, START = 270, -135  # like the widget gauge

def pt(r, theta_deg):
    a = math.radians(theta_deg)
    return (C + r * math.sin(a), C - r * math.cos(a))

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# Bold, simplified design so it stays legible down to 16px: thick chrome ring,
# a few chunky ticks, a fat needle, a heavy redline. Fine detail is dropped.

# chrome bezel: thinner rings, bigger face
d.ellipse([6, 6, S-6, S-6], fill=(160, 168, 184, 255))       # outer chrome
d.ellipse([40, 40, S-40, S-40], fill=(60, 67, 82, 255))      # dark gap
d.ellipse([58, 58, S-58, S-58], fill=(226, 231, 240, 255))   # bright inner lip
d.ellipse([84, 84, S-84, S-84], fill=(9, 11, 16, 255))       # face

r_out = C - 120
r_in = r_out - 150   # long ticks

# redline arc (75%..100%) — very thick chunk
red_a0 = START + SWEEP * 0.75
red_a1 = START + SWEEP * 1.0
bbox = [C - r_out + 46, C - r_out + 46, C + r_out - 46, C + r_out - 46]
d.arc(bbox, red_a0 - 90, red_a1 - 90, fill=(255, 59, 48, 255), width=92)

# ticks: just 5 fat majors at 0/25/50/75/100%
for i in range(5):
    frac = i / 4
    theta = START + SWEEP * frac
    in_red = frac >= 0.75 - 1e-9
    col = (255, 80, 66, 255) if in_red else (240, 244, 250, 255)
    d.line([pt(r_out, theta), pt(r_in, theta)], fill=col, width=46)

# needle at ~62%: fat tapered wedge, bright red
frac = 0.62
theta = START + SWEEP * frac
pa = math.radians(theta)
px, py = math.cos(pa), math.sin(pa)
def off(p, k):
    return (p[0] + px * k, p[1] + py * k)
tip = pt(r_out - 20, theta)
tail = pt(-130, theta)              # a bold counterweight tail
d.polygon([off(tail, 42), off(tail, -42), off(tip, -14), off(tip, 14)],
          fill=(210, 26, 18, 255))
d.polygon([off(tail, 26), off(tail, -26), off(tip, -8), off(tip, 8)],
          fill=(255, 82, 66, 255))

# hub: big and chunky
d.ellipse([C-120, C-120, C+120, C+120], fill=(70, 78, 95, 255))
d.ellipse([C-92, C-92, C+92, C+92], fill=(22, 26, 36, 255))
d.ellipse([C-44, C-44, C+44, C+44], fill=(90, 98, 116, 255))

os.makedirs("assets", exist_ok=True)
img.save("assets/icon-1024.png")
for size in (256, 64, 48, 32, 24, 16):
    img.resize((size, size), Image.LANCZOS).save(f"assets/icon-{size}.png")
img.resize((256, 256), Image.LANCZOS).save(
    "assets/icon.ico", sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)]
)
print("icons written to assets/")
