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
HALF_H = 5.6 + PAD * 2

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


@dataclass
class Key:
    index: int
    kind: str  # "key" | "fiveway" | "gesture" (gesture は描画対象外)
    x: float  # 左上 (px)
    y: float
    w: float
    h: float

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
        fw_cy = oy + (PAD + 4.85) * U
        if side == "left":
            fw_cx = ox + (PAD + 4.5) * U
        else:
            fw_cx = ox + (PAD + 1.5) * U
        halves.append(
            Half(
                side=side,
                x=ox,
                y=oy,
                w=HALF_W * U,
                h=HALF_H * U,
                fiveway_cx=fw_cx,
                fiveway_cy=fw_cy,
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
            # トラックパッドのジェスチャは描画しない (bindings との index 合わせのためだけに保持)
            keys.append(Key(index=i, kind="gesture", x=0, y=0, w=0, h=0))

    width = int(MARGIN * 2 + (HALF_W * 2 + HALF_GAP) * U)
    height = int(MARGIN * 2 + HALF_H * U)
    return keys, halves, (width, height)
