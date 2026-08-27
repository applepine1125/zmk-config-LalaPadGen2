"""ZMK keymap (devicetree) から必要な情報だけを取り出す簡易パーサ。

cpp を通さず、bindings ブロックのトークン化と #define の置換のみを行う。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass
class Binding:
    behavior: str  # 例: "kp", "mt2", "mo"
    params: list[str] = field(default_factory=list)


@dataclass
class Layer:
    name: str
    display_name: str
    bindings: list[Binding]


@dataclass
class Combo:
    name: str
    key_positions: list[int]
    binding: Binding


@dataclass
class Keymap:
    layers: list[Layer]
    combos: list[Combo]
    hold_taps: dict[str, tuple[str, str]]  # behavior 名 -> (hold behavior, tap behavior)
    defines: dict[str, str]


def _strip_comments(src: str) -> str:
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    return re.sub(r"//[^\n]*", "", src)


def _parse_defines(src: str) -> dict[str, str]:
    return {m.group(1): m.group(2).strip() for m in re.finditer(r"^\s*#define\s+(\w+)\s+(.+)$", src, flags=re.M)}


def parse_bindings(text: str) -> list[Binding]:
    """`&kp A &mt2 TAB S ...` 形式の文字列を Binding のリストにする。"""
    tokens = re.findall(r"&\w+|[A-Za-z_][\w()]*(?:\([^)]*\))?|\d+", text)
    result = []
    for tok in tokens:
        if tok.startswith("&"):
            result.append(Binding(behavior=tok[1:]))
        elif result:
            result[-1].params.append(tok)
    return result


def _find_block(src: str, start: int) -> str:
    """start 位置以降の最初の `{` から対応する `}` までを返す。"""
    open_idx = src.index("{", start)
    depth = 0
    for i in range(open_idx, len(src)):
        if src[i] == "{":
            depth += 1
        elif src[i] == "}":
            depth -= 1
            if depth == 0:
                return src[open_idx + 1 : i]
    raise ValueError("unbalanced braces")


def _child_nodes(block: str):
    """ブロック直下の `name { ... };` ノードを (name, body) で列挙する。"""
    pos = 0
    while True:
        m = re.compile(r"(\w+)\s*(?::\s*\w+\s*)?\{").search(block, pos)
        if not m:
            return
        body = _find_block(block, m.start())
        yield m.group(1), body
        pos = m.start() + len(body)


def _prop(body: str, name: str) -> str | None:
    m = re.search(rf'\b{name}\s*=\s*(<[^;]*>|"[^"]*")\s*;', body, flags=re.S)
    if not m:
        return None
    return m.group(1).strip('<>"')


def parse_keymap(src: str) -> Keymap:
    defines = _parse_defines(src)
    src = _strip_comments(src)
    for name, value in defines.items():
        src = re.sub(rf"\b{name}\b", value, src)

    layers = []
    combos = []
    hold_taps = {}

    for node, body in _child_nodes(src):
        compat = _prop(body, "compatible")
        if compat == "zmk,keymap":
            for lname, lbody in _child_nodes(body):
                bindings = parse_bindings(_prop(lbody, "bindings") or "")
                layers.append(Layer(name=lname, display_name=_prop(lbody, "display-name") or lname, bindings=bindings))
        elif compat == "zmk,combos":
            for cname, cbody in _child_nodes(body):
                positions = [int(p) for p in (_prop(cbody, "key-positions") or "").split()]
                b = parse_bindings(_prop(cbody, "bindings") or "")
                combos.append(Combo(name=cname, key_positions=positions, binding=b[0] if b else Binding("none")))
        elif node == "behaviors":
            for bname, bbody in _child_nodes(body):
                if _prop(bbody, "compatible") == "zmk,behavior-hold-tap":
                    refs = re.findall(r"<&(\w+)>", _prop_raw(bbody, "bindings"))
                    if len(refs) == 2:
                        hold_taps[bname] = (refs[0], refs[1])

    hold_taps.setdefault("mt", ("kp", "kp"))
    hold_taps.setdefault("lt", ("mo", "kp"))
    return Keymap(layers=layers, combos=combos, hold_taps=hold_taps, defines=defines)


def _prop_raw(body: str, name: str) -> str:
    m = re.search(rf"\b{name}\s*=\s*([^;]*);", body, flags=re.S)
    return m.group(1) if m else ""
