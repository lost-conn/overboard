#!/usr/bin/env python3
"""Generate app icons from the brand exports in assets/brand/.

Inputs (exported from the design tool, checked in):
  assets/brand/icon_full.png      512px, teal rounded square with the card pile
  assets/brand/icon_maskable.png  1024px, square teal field, mark in the safe zone
  assets/brand/icon_raw.png       512px, card pile on transparent (kept for reference)

Outputs:
  public/icon-192.png, public/icon-512.png             PWA icons, purpose "any"
  public/icon-maskable-192.png, public/icon-maskable-512.png  purpose "maskable"
  public/logo.png                                      64px header mark
  src/app/icon.png                                     favicon (Next file convention)
  src/app/apple-icon.png                               180px Apple touch icon

Requires Pillow: python3 -m pip install pillow. Run from the repo root.
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
BRAND = ROOT / "assets" / "brand"
PUBLIC = ROOT / "public"
APP = ROOT / "src" / "app"


def resize(src: Image.Image, size: int) -> Image.Image:
    return src.resize((size, size), Image.LANCZOS)


def main() -> None:
    full = Image.open(BRAND / "icon_full.png").convert("RGBA")
    maskable = Image.open(BRAND / "icon_maskable.png").convert("RGBA")

    resize(full, 192).save(PUBLIC / "icon-192.png", optimize=True)
    resize(full, 512).save(PUBLIC / "icon-512.png", optimize=True)
    resize(full, 64).save(PUBLIC / "logo.png", optimize=True)
    resize(full, 48).save(APP / "icon.png", optimize=True)

    resize(maskable, 192).save(PUBLIC / "icon-maskable-192.png", optimize=True)
    resize(maskable, 512).save(PUBLIC / "icon-maskable-512.png", optimize=True)

    # iOS rounds the corners itself and wants edge-to-edge art. The maskable
    # export keeps the mark inside the central safe zone, so crop the middle
    # 70% to give it sensible margins before scaling to 180px.
    w = maskable.width
    inset = int(w * 0.15)
    apple = maskable.crop((inset, inset, w - inset, w - inset))
    resize(apple, 180).convert("RGB").save(APP / "apple-icon.png", optimize=True)
    print("icons written")


if __name__ == "__main__":
    main()
