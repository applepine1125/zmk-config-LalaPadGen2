#!/usr/bin/env python3
"""keymap を読み込み、レイヤーごとにキー配列画像 (SVG/PNG) を生成する。

使い方:
    python3 tools/keymap-img/render.py [--keymap PATH] [--out DIR] [--no-png]
"""

import argparse
import html
import shutil
import subprocess
import sys
from pathlib import Path

from keymap_parser import Keymap, parse_keymap
from labels import Label, to_label
from layout import Key, build

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
FONT = "Helvetica Neue, Helvetica, Arial, sans-serif"


def _fit_font(text: str, width: float, base: float) -> float:
    est = len(text) * base * 0.58
    return base if est <= width else max(base * width / est, 9)


def _text(x, y, s, size, fill="#ffffff", weight="normal", anchor="middle"):
    return (
        f'<text x="{x:.1f}" y="{y:.1f}" font-size="{size:.1f}" fill="{fill}" font-weight="{weight}" '
        f'text-anchor="{anchor}" dominant-baseline="middle">{html.escape(s)}</text>'
    )


def key_label_svg(k: Key, label: Label) -> str:
    parts = []
    if label.transparent:
        parts.append(_text(k.cx, k.cy, "▽", 14, fill="#666666"))
        return "\n".join(parts)
    base = 26 if k.kind == "key" else 14
    inner = k.w - 12
    if label.tap:
        size = _fit_font(label.tap, inner, base)
        parts.append(_text(k.cx, k.cy - (6 if label.hold else 0), label.tap, size, weight="bold"))
    if label.shifted:
        parts.append(_text(k.x + k.w - 12, k.y + 20, label.shifted, 20, fill="#d0d0d0", anchor="end"))
    if label.hold:
        size = _fit_font(label.hold, inner, 13)
        parts.append(_text(k.cx, k.y + k.h - 14, label.hold, size, fill="#8fd3ff"))
    return "\n".join(parts)


def combo_svg(keys: list[Key], keymap: Keymap) -> str:
    out = []
    for c in keymap.combos:
        pts = [keys[i] for i in c.key_positions if i < len(keys) and keys[i].kind != "gesture"]
        if not pts:
            continue
        cx = sum(p.cx for p in pts) / len(pts)
        cy = sum(p.cy for p in pts) / len(pts)
        text = to_label(c.binding, keymap).tap
        w = max(34, len(text) * 8 + 12)
        out.append(
            f'<rect x="{cx - w / 2:.1f}" y="{cy - 11:.1f}" width="{w:.1f}" height="22" rx="6" '
            f'fill="#000000" stroke="#8fd3ff" stroke-width="1.5"/>'
        )
        out.append(_text(cx, cy, text, 12, fill="#8fd3ff"))
    return "\n".join(out)


def render_layer(template: str, keys: list[Key], keymap: Keymap, layer_index: int, width: int) -> str:
    layer = keymap.layers[layer_index]
    if len(layer.bindings) != len(keys):
        sys.exit(f"layer {layer.name}: bindings={len(layer.bindings)} but layout keys={len(keys)}")
    body = [f'<g id="labels" font-family="{FONT}">']
    body.append(_text(width / 2, 40, f"Layer {layer_index}: {layer.display_name}", 28, fill="#ffffff", weight="bold"))
    for k, b in zip(keys, layer.bindings):
        if k.kind != "gesture":
            body.append(key_label_svg(k, to_label(b, keymap)))
    body.append(combo_svg(keys, keymap))
    body.append("</g>")
    return template.replace("</svg>", "\n".join(body) + "\n</svg>")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--keymap", type=Path, default=ROOT / "config" / "lalapadgen2.keymap")
    ap.add_argument("--out", type=Path, default=ROOT / "docs" / "keymap")
    ap.add_argument("--template", type=Path, default=HERE / "template.svg")
    ap.add_argument("--no-png", action="store_true", help="SVG のみ出力し PNG 変換を行わない")
    args = ap.parse_args()

    keymap = parse_keymap(args.keymap.read_text())
    keys, _, (width, _) = build()
    template = args.template.read_text()
    args.out.mkdir(parents=True, exist_ok=True)

    rsvg = shutil.which("rsvg-convert")
    if not args.no_png and not rsvg:
        print("warning: rsvg-convert が見つからないため PNG は生成しません (brew install librsvg)", file=sys.stderr)

    for i, layer in enumerate(keymap.layers):
        svg = render_layer(template, keys, keymap, i, width)
        stem = f"{i}_{layer.display_name}".replace(" ", "_")
        svg_path = args.out / f"{stem}.svg"
        svg_path.write_text(svg)
        print(f"wrote {svg_path}")
        if rsvg and not args.no_png:
            png_path = args.out / f"{stem}.png"
            subprocess.run([rsvg, "-z", "1", str(svg_path), "-o", str(png_path)], check=True)
            print(f"wrote {png_path}")


if __name__ == "__main__":
    main()
