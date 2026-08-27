"""LalaPad Gen2 の物理配置を SVG 座標に変換する。

キーのインデックスは config/lalapadgen2.json の layout 配列の順序
(= keymap の bindings の順序) と一致する。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

U = 120  # 1u あたりのピクセル数
GAP = 8  # キー枠の内側マージン
MARGIN = 80
HALF_GAP = 1.0  # 左右ハーフ間の隙間 (u)
PAD = 0.3  # ハーフ外形からキー群までの余白 (u)
HALF_W = 6.0 + PAD * 2  # 親指行が 6 キーあるため
HALF_H = 7.0 + PAD * 2

LAYOUT_JSON = Path(__file__).resolve().parents[2] / "config" / "lalapadgen2.json"

# 5way スイッチの各方向オフセット (x, y) [u]。json の row=4 の col 順に対応
FIVE_WAY_OFFSET = {
    1: (0.0, 0.0),  # center
    2: (0.5, 0.0),  # right
    3: (0.0, 0.5),  # down
    4: (-0.5, 0.0),  # left
    5: (0.0, -0.5),  # up
    6: (0.0, -0.5),  # up
    7: (-0.5, 0.0),  # left
    8: (0.0, 0.5),  # down
    9: (0.5, 0.0),  # right
    10: (0.0, 0.0),  # center
}

# トラックパッドのジェスチャ (row 5: タップ, row 6: スワイプ/ピンチ)
GESTURE_NAMES = {
    (5, 0): "1 tap",
    (5, 1): "2 tap",
    (5, 2): "3 tap",
    (5, 9): "1 tap",
    (5, 10): "2 tap",
    (5, 11): "3 tap",
    (6, 0): "3← swipe",
    (6, 1): "3→ swipe",
    (6, 2): "3↑ swipe",
    (6, 3): "3↓ swipe",
    (6, 4): "pinch",
    (6, 7): "3← swipe",
    (6, 8): "3→ swipe",
    (6, 9): "3↑ swipe",
    (6, 10): "3↓ swipe",
    (6, 11): "pinch",
}


@dataclass
class Key:
    index: int
    kind: str  # "key" | "fiveway" | "gesture"
    x: float  # 左上 (px)
    y: float
    w: float
    h: float
    gesture: str = ""

    @property
    def cx(self) -> float:
        return self.x + self.w / 2

    @property
    def cy(self) -> float:
        return self.y + self.h / 2


@dataclass
class Half:
    side: str  # "left" | "right"
    x: float  # 外形左上 (px)
    y: float
    w: float
    h: float
    fiveway_cx: float
    fiveway_cy: float
    trackpad_x: float
    trackpad_y: float
    trackpad_w: float
    trackpad_h: float


def _half_origin(side: str) -> float:
    if side == "left":
        return MARGIN
    return MARGIN + (HALF_W + HALF_GAP) * U


def build() -> tuple[list[Key], list[Half], tuple[int, int]]:
    with open(LAYOUT_JSON) as f:
        raw = json.load(f)["layouts"]["default_layout"]["layout"]

    halves = []
    for side in ("left", "right"):
        ox = _half_origin(side)
        oy = MARGIN
        tp_w, tp_h = 3.3 * U, 2.2 * U
        band_y = oy + (PAD + 4.5) * U
        if side == "left":
            tp_x = ox + PAD * U
            fw_cx = ox + (PAD + 4.75) * U
        else:
            tp_x = ox + (HALF_W - PAD) * U - tp_w
            fw_cx = ox + (PAD + 1.25) * U
        halves.append(
            Half(
                side=side,
                x=ox,
                y=oy,
                w=HALF_W * U,
                h=HALF_H * U,
                fiveway_cx=fw_cx,
                fiveway_cy=band_y + tp_h / 2,
                trackpad_x=tp_x,
                trackpad_y=band_y,
                trackpad_w=tp_w,
                trackpad_h=tp_h,
            )
        )
    left, right = halves

    keys = []
    for i, k in enumerate(raw):
        row, col = k["row"], k["col"]
        side = "left" if col <= 5 else "right"
        half = left if side == "left" else right

        if row <= 3:
            # メインキー / 親指キー。x はハーフ内の列位置 (右ハーフは col-6 または x-7)
            gx = k["x"] if side == "left" else k["x"] - 6
            gy = k["y"] - 1
            keys.append(
                Key(
                    index=i,
                    kind="key",
                    x=half.x + (PAD + gx) * U + GAP,
                    y=half.y + (PAD + gy) * U + GAP,
                    w=U - 2 * GAP,
                    h=U - 2 * GAP,
                )
            )
        elif row == 4:
            dx, dy = FIVE_WAY_OFFSET[col]
            size = 0.42 * U
            keys.append(
                Key(
                    index=i,
                    kind="fiveway",
                    x=half.fiveway_cx + dx * U - size / 2,
                    y=half.fiveway_cy + dy * U - size / 2,
                    w=size,
                    h=size,
                )
            )
        else:
            name = GESTURE_NAMES[(row, col)]
            cells = 3 if row == 5 else 5
            pos = col if side == "left" else col - 9 if row == 5 else col - 7
            inner_x = half.trackpad_x + 0.1 * U
            inner_w = half.trackpad_w - 0.2 * U
            cw = inner_w / cells
            ch = 0.85 * U
            cy = half.trackpad_y + 0.15 * U + (0 if row == 5 else ch + 0.1 * U)
            keys.append(
                Key(
                    index=i,
                    kind="gesture",
                    x=inner_x + pos * cw + 3,
                    y=cy,
                    w=cw - 6,
                    h=ch,
                    gesture=name,
                )
            )

    width = int(MARGIN * 2 + (HALF_W * 2 + HALF_GAP) * U)
    height = int(MARGIN * 2 + HALF_H * U)
    return keys, halves, (width, height)
