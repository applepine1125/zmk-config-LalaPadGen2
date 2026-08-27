#!/usr/bin/env python3
"""LalaPad Gen2 のワイヤーフレームテンプレート SVG を生成する。"""

from pathlib import Path

from layout import Key, build

STROKE = "#ffffff"
OUT = Path(__file__).resolve().parent / "template.svg"


def rect(x, y, w, h, r=10, sw=2.5, extra=""):
    return (
        f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" rx="{r}" '
        f'fill="none" stroke="{STROKE}" stroke-width="{sw}" {extra}/>'
    )



def key_frame(k: Key) -> str:
    if k.kind == "key":
        return rect(k.x, k.y, k.w, k.h, r=12, extra=f'id="key-{k.index}"')
    return rect(k.x, k.y, k.w, k.h, r=8, sw=2, extra=f'id="key-{k.index}"')


def build_svg() -> str:
    keys, halves, (width, height) = build()
    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
        f'<rect width="{width}" height="{height}" fill="#000000"/>',
        '<g id="body">',
    ]
    for h in halves:
        out.append(rect(h.x, h.y, h.w, h.h, r=40, sw=3))
        out.append(rect(h.x + 10, h.y + 10, h.w - 20, h.h - 20, r=32, sw=1))
    out.append("</g>")
    out.append('<g id="keys">')
    out.extend(key_frame(k) for k in keys if k.kind != "gesture")
    out.append("</g>")
    out.append("</svg>")
    return "\n".join(out) + "\n"


if __name__ == "__main__":
    OUT.write_text(build_svg())
    print(f"wrote {OUT}")
