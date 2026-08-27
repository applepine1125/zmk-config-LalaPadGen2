"""Binding をキーに表示するラベルへ変換する。"""

from __future__ import annotations

from dataclasses import dataclass

from keymap_parser import Binding, Keymap

KEYCODE_ALIASES = {
    "SEMICOLON": ";", "SEMI": ";", "COMMA": ",", "PERIOD": ".", "DOT": ".", "SLASH": "/", "FSLH": "/",
    "BSLH": "\\", "BACKSLASH": "\\", "MINUS": "-", "EQUAL": "=", "GRAVE": "`", "SQT": "'", "APOS": "'",
    "LBKT": "[", "RBKT": "]", "LBRC": "{", "RBRC": "}", "SPACE": "Space", "BACKSPACE": "BkSp", "BSPC": "BkSp",
    "ENTER": "Enter", "RET": "Enter", "ESC": "Esc", "ESCAPE": "Esc", "TAB": "Tab", "DEL": "Del", "DELETE": "Del",
    "LSHFT": "Shift", "LSHIFT": "Shift", "RSHFT": "Shift", "RSHIFT": "Shift",
    "LCTRL": "Ctrl", "RCTRL": "Ctrl", "LALT": "Opt", "RALT": "Opt", "LCMD": "Cmd", "RCMD": "Cmd",
    "LGUI": "Cmd", "RGUI": "Cmd", "LWIN": "Cmd", "RWIN": "Cmd",
    "UP": "↑", "DOWN": "↓", "LEFT": "←", "RIGHT": "→",
    "UP_ARROW": "↑", "DOWN_ARROW": "↓", "LEFT_ARROW": "←", "RIGHT_ARROW": "→",
    "N0": "0", "N1": "1", "N2": "2", "N3": "3", "N4": "4", "N5": "5", "N6": "6", "N7": "7", "N8": "8", "N9": "9",
    "PG_UP": "PgUp", "PG_DN": "PgDn", "HOME": "Home", "END": "End", "CAPS": "Caps",
}

MOD_FUNCS = {"LC": "Ctrl", "RC": "Ctrl", "LS": "Shift", "RS": "Shift", "LA": "Opt", "RA": "Opt", "LG": "Cmd", "RG": "Cmd"}

MOUSE_ALIASES = {"LCLK": "LClick", "RCLK": "RClick", "MCLK": "MClick", "MB4": "Back", "MB5": "Fwd"}

DYN_SCALE = {
    ("ZDS_XY", "ZDS_INC"): "Ptr +", ("ZDS_XY", "ZDS_DEC"): "Ptr −",
    ("ZDS_SC", "ZDS_INC"): "Scrl +", ("ZDS_SC", "ZDS_DEC"): "Scrl −",
    ("ZDS_ALL", "ZDS_RST"): "Spd Rst",
}

BT_ALIASES = {"BT_CLR": "BT Clr", "BT_CLR_ALL": "BT ClrAll", "BT_NXT": "BT Next", "BT_PRV": "BT Prev"}


@dataclass
class Label:
    tap: str = ""
    hold: str = ""
    transparent: bool = False


def keycode(code: str) -> str:
    if "(" in code:
        func, inner = code.split("(", 1)
        inner = inner.rstrip(")")
        return f"{MOD_FUNCS.get(func, func)}+{keycode(inner)}"
    return KEYCODE_ALIASES.get(code, code.replace("_", " ").title() if len(code) > 3 and code.isupper() else code)


def _layer_name(keymap: Keymap, num: str) -> str:
    try:
        return f"L{int(num)}"
    except ValueError:
        return num


def simple(b: Binding, keymap: Keymap) -> str:
    """ホールド/タップを持たない単一 behavior のラベル。"""
    p = b.params
    if b.behavior == "kp":
        return keycode(p[0]) if p else ""
    if b.behavior in ("mo", "to", "tog", "sl"):
        prefix = {"mo": "", "to": "→", "tog": "⇄", "sl": "•"}[b.behavior]
        return f"{prefix}{_layer_name(keymap, p[0])}"
    if b.behavior == "mkp":
        return MOUSE_ALIASES.get(p[0], p[0])
    if b.behavior == "bt":
        if p[0] == "BT_SEL":
            return f"BT {p[1]}"
        return BT_ALIASES.get(p[0], p[0])
    if b.behavior == "out":
        return "Out Tog" if p[0] == "OUT_TOG" else p[0]
    if b.behavior == "sys_reset":
        return "Reset"
    if b.behavior == "bootloader":
        return "Boot"
    if b.behavior == "zip_dyn_scale":
        return DYN_SCALE.get((p[0], p[1]), " ".join(p))
    if b.behavior in ("none",):
        return ""
    if b.behavior == "trans":
        return "▽"
    return f"&{b.behavior} {' '.join(p)}".strip()


def to_label(b: Binding, keymap: Keymap) -> Label:
    if b.behavior == "trans":
        return Label(transparent=True)
    if b.behavior in keymap.hold_taps and len(b.params) == 2:
        hold_beh, tap_beh = keymap.hold_taps[b.behavior]
        hold = simple(Binding(hold_beh, [b.params[0]]), keymap)
        tap = simple(Binding(tap_beh, [b.params[1]]), keymap)
        return Label(tap=tap, hold=hold)
    return Label(tap=simple(b, keymap))
