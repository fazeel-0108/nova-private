"""Generate Nova PNG app icons with PIL. Run: python make_icons.py"""
import math
import os

from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "icons")
os.makedirs(OUT, exist_ok=True)


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def gradient_bg(size):
    """Diagonal gradient: #1a2456 -> #0b1022 -> #070a13."""
    img = Image.new("RGB", (size, size))
    px = img.load()
    c1, c2, c3 = (0x1A, 0x24, 0x56), (0x0B, 0x10, 0x22), (0x07, 0x0A, 0x13)
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * size)
            if t < 0.55:
                px[x, y] = lerp(c1, c2, t / 0.55)
            else:
                px[x, y] = lerp(c2, c3, (t - 0.55) / 0.45)
    return img


def star_points(cx, cy, r_long, r_short):
    """Four-point star (concave diamond) as a polygon."""
    pts = []
    for i in range(8):
        angle = math.pi / 2 * (i / 2) - math.pi / 2
        r = r_long if i % 2 == 0 else r_short
        pts.append((cx + r * math.cos(angle), cy + r * math.sin(angle)))
    return pts


def star_gradient(size):
    """Small image with the blue->violet->cyan gradient used to fill stars."""
    img = Image.new("RGB", (size, size))
    px = img.load()
    c1, c2, c3 = (0x8A, 0xB4, 0xFF), (0xC4, 0xB5, 0xFD), (0x67, 0xE8, 0xF9)
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * size)
            if t < 0.5:
                px[x, y] = lerp(c1, c2, t / 0.5)
            else:
                px[x, y] = lerp(c2, c3, (t - 0.5) / 0.5)
    return img


def draw_icon(size, maskable=False):
    img = gradient_bg(size).convert("RGBA")

    # Rounded-rectangle mask for the non-maskable icon.
    if not maskable:
        mask = Image.new("L", (size, size), 0)
        ImageDraw.Draw(mask).rounded_rectangle(
            [0, 0, size - 1, size - 1], radius=int(size * 0.22), fill=255
        )
        img.putalpha(mask)

    draw = ImageDraw.Draw(img)

    if maskable:
        # Keep artwork inside the safe zone (center ~66%).
        scale = 0.62
    else:
        scale = 0.80

    cx = cy = size / 2
    r_long = size * 0.29 * (scale / 0.80)
    r_short = r_long * 0.28

    # Glow: draw a blurred copy of the big star behind.
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glow)
    gdraw.polygon(star_points(cx, cy - size * 0.02, r_long, r_short), fill=(138, 180, 255, 160))
    glow = glow.filter(ImageFilter.GaussianBlur(size * 0.04))
    img = Image.alpha_composite(img, glow)
    draw = ImageDraw.Draw(img)

    # Main star (slightly above center) filled with the gradient via mask.
    star_mask = Image.new("L", (size, size), 0)
    smd = ImageDraw.Draw(star_mask)
    smd.polygon(star_points(cx, cy - size * 0.02, r_long, r_short), fill=255)

    # Small companion star, lower-right.
    s2_r = r_long * 0.34
    s2x, s2y = cx + r_long * 0.68, cy + r_long * 0.55
    smd.polygon(star_points(s2x, s2y, s2_r, s2_r * 0.30), fill=230)

    grad = star_gradient(size).convert("RGBA")
    grad.putalpha(star_mask)
    img = Image.alpha_composite(img, grad)
    draw = ImageDraw.Draw(img)

    # Tiny sparkle dots.
    dot = size * 0.014
    for (dx, dy, col) in [
        (-0.42, 0.30, (138, 180, 255, 210)),
        (-0.28, 0.18, (103, 232, 249, 190)),
        (0.34, -0.44, (196, 181, 253, 210)),
    ]:
        x, y = cx + size * dx, cy + size * dy
        draw.ellipse([x - dot, y - dot, x + dot, y + dot], fill=col)

    return img


def main():
    draw_icon(192).save(os.path.join(OUT, "icon-192.png"))
    draw_icon(512).save(os.path.join(OUT, "icon-512.png"))
    draw_icon(512, maskable=True).save(os.path.join(OUT, "icon-maskable-512.png"))
    print("Wrote icons/icon-192.png, icon-512.png, icon-maskable-512.png")


if __name__ == "__main__":
    main()
