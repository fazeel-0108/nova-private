"""Generate Nova app icons — GLOSSY IRIDESCENT ORB (reference-style).

Look: near-black tile, glassy dark orb, iridescent rim light
(teal upper-left -> violet lower-right), inner nebula glow, crisp
white geometric "N" centered. Matches the user's reference image.

Run: python make_icons.py
Writes: icons/nova.svg (kept in sync is NOT needed for this style),
        icons/icon-192.png, icons/icon-512.png,
        icons/icon-maskable-512.png,
        android/app/src/main/res/drawable-nodpi/nova_fg.png
"""
import math
import os

from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "icons")
FG_DIR = os.path.join(HERE, "android", "app", "src", "main", "res", "drawable-nodpi")
os.makedirs(OUT, exist_ok=True)
os.makedirs(FG_DIR, exist_ok=True)

BLACK = (0, 0, 0)
ORB_DARK = (10, 12, 20)
ORB_EDGE = (26, 32, 48)
TEAL = (72, 224, 216)
CYAN = (120, 220, 255)
VIOLET = (150, 110, 250)
PURPLE = (120, 80, 220)
WHITE = (246, 250, 255)

SS = 4  # supersample factor for smooth gradients


def lerp(c1, c2, t):
    return tuple(int(a + (b - a) * t) for a, b in zip(c1, c2))


def draw_orb(size, orb_r):
    """One glossy orb with iridescent rim + nebula glow, transparent outside."""
    S = size * SS
    C = S / 2
    R = orb_r * SS
    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    # 1) orb body: radial gradient (dark center -> slightly lighter edge)
    steps = 90
    for i in range(steps, 0, -1):
        t = i / steps
        r = R * t
        col = lerp(ORB_EDGE, ORB_DARK, t)  # t=1 -> edge color at r=R
        d.ellipse([C - r, C - r, C + r, C + r], fill=col + (255,))

    # 2) inner nebula: teal cloud upper-left, violet cloud lower-right (soft)
    neb = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    dn = ImageDraw.Draw(neb)
    for (ang, rad, col, a) in (
        (math.radians(215), R * 0.62, TEAL, 90),
        (math.radians(40), R * 0.60, PURPLE, 100),
        (math.radians(160), R * 0.35, CYAN, 55),
        (math.radians(320), R * 0.38, VIOLET, 60),
    ):
        cx = C + math.cos(ang) * rad
        cy = C + math.sin(ang) * rad
        br = R * 0.55
        dn.ellipse([cx - br, cy - br, cx + br, cy + br], fill=col + (a,))
    neb = neb.filter(ImageFilter.GaussianBlur(R * 0.30))
    # clip nebula inside the orb
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).ellipse([C - R, C - R, C + R, C + R], fill=255)
    layer.paste(Image.alpha_composite(layer.crop((0, 0, S, S)), neb), (0, 0), Image.composite(neb.split()[3], Image.new("L", (S, S), 0), mask).point(lambda v: v))

    # 3) iridescent rim: colored ring segments (teal arc + violet arc), soft
    rim = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    dr = ImageDraw.Draw(rim)
    lw = int(R * 0.16)
    # teal upper-left (angles measured with 0 = right, CCW)
    dr.arc([C - R + lw / 2, C - R + lw / 2, C + R - lw / 2, C + R - lw / 2],
           start=110, end=300, fill=TEAL + (255,), width=lw)
    # violet lower-right
    dr.arc([C - R + lw / 2, C - R + lw / 2, C + R - lw / 2, C + R - lw / 2],
           start=300, end=110, fill=VIOLET + (255,), width=lw)
    rim = rim.filter(ImageFilter.GaussianBlur(R * 0.06))
    layer.alpha_composite(rim)

    # rim clipping: nothing may spill outside the orb
    outside = Image.new("L", (S, S), 0)
    ImageDraw.Draw(outside).ellipse([C - R, C - R, C + R, C + R], fill=255)
    layer.putalpha(Image.composite(layer.split()[3], Image.new("L", (S, S), 0), outside))

    # 4) outer colored glow (teal left, violet right) — bloom outside the glass
    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    dg = ImageDraw.Draw(glow)
    dg.arc([C - R, C - R, C + R, C + R], start=120, end=280, fill=TEAL + (200,), width=int(R * 0.10))
    dg.arc([C - R, C - R, C + R, C + R], start=300, end=100, fill=VIOLET + (200,), width=int(R * 0.10))
    glow = glow.filter(ImageFilter.GaussianBlur(R * 0.22))
    layer.alpha_composite(glow)

    # 5) crisp white rim line (glass edge) + specular highlight
    edge = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    de = ImageDraw.Draw(edge)
    de.ellipse([C - R, C - R, C + R, C + R], outline=(235, 245, 255, 210), width=max(2, int(R * 0.022)))
    # glass reflection: bright arc top-left, faint arc bottom-right
    de.arc([C - R * 0.94, C - R * 0.94, C + R * 0.94, C + R * 0.94],
           start=150, end=250, fill=(255, 255, 255, 235), width=max(2, int(R * 0.028)))
    de.arc([C - R * 0.96, C - R * 0.96, C + R * 0.96, C + R * 0.96],
           start=330, end=30, fill=(210, 225, 255, 90), width=max(2, int(R * 0.018)))
    edge = edge.filter(ImageFilter.GaussianBlur(R * 0.012))
    layer.alpha_composite(edge)

    # soft sheen inside top-left (glassy depth)
    sheen = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    dsh = ImageDraw.Draw(sheen)
    sx, sy = C - R * 0.38, C - R * 0.44
    dsh.ellipse([sx - R * 0.34, sy - R * 0.20, sx + R * 0.34, sy + R * 0.20], fill=(190, 220, 255, 34))
    sheen = sheen.filter(ImageFilter.GaussianBlur(R * 0.16))
    layer.alpha_composite(sheen)

    # 6) the letter: bold geometric N (crisp white)
    def bar(x0, y0, x1, y1):
        d.polygon([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], fill=WHITE + (255,))

    h = R * 0.78            # letter height
    bw = R * 0.155          # bar width
    x0, x1 = C - R * 0.34, C + R * 0.34
    y0, y1 = C - h / 2, C + h / 2
    bar(x0, y0, x0 + bw, y1)                      # left stem
    bar(x1 - bw, y0, x1, y1)                      # right stem
    # diagonal (top-left -> bottom-right), as a thick parallelogram
    d.polygon([(x0, y0), (x0 + bw * 1.7, y0), (x1, y1), (x1 - bw * 1.7, y1)], fill=WHITE + (255,))

    return layer.resize((size, size), Image.LANCZOS)


def compose(size, orb_frac, rounded=True, bg=BLACK):
    img = Image.new("RGBA", (size, size), bg + (255,))
    orb = draw_orb(size, size * orb_frac / 2 * 2 * 0.5)
    img.alpha_composite(orb)
    if rounded:
        m = Image.new("L", (size, size), 0)
        ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.22), fill=255)
        img.putalpha(m)
    return img


# ---------- Web icons ----------
compose(512, 0.68).convert("RGB").save(os.path.join(OUT, "icon-512.png"))
compose(192, 0.68).convert("RGB").save(os.path.join(OUT, "icon-192.png"))
# Maskable: full-bleed black, smaller orb inside the 80% safe zone
compose(512, 0.56, rounded=False).convert("RGB").save(os.path.join(OUT, "icon-maskable-512.png"))

# ---------- Android adaptive foreground (transparent bg; orb in safe zone) ----------
fg = Image.new("RGBA", (432, 432), (0, 0, 0, 0))
orb = draw_orb(432, 432 * 0.30)
fg.alpha_composite(orb)
fg.save(os.path.join(FG_DIR, "nova_fg.png"))

print("glossy-orb icons written")
