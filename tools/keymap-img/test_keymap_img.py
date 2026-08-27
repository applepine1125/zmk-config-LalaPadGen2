import unittest

from keymap_parser import parse_keymap
from labels import to_label
from render import resolve_binding
from layout import build

SAMPLE = """
#define DEFAULT_LAYER 0
/ {
    behaviors {
        mt2: mod_tap2 {
            compatible = "zmk,behavior-hold-tap";
            bindings = <&kp>, <&kp>;
        };
    };
    combos {
        compatible = "zmk,combos";
        combo_tab {
            key-positions = <10 11>;
            bindings = <&kp TAB>;
        };
    };
    keymap {
        compatible = "zmk,keymap";
        DEFAULT_LAYER {
            display-name = "Default";
            bindings = <
&kp Q  &mt2 TAB A  &kp LC(UP_ARROW)  // コメント
&mo 1  &trans  &none  &zip_dyn_scale ZDS_XY ZDS_INC
            >;
        };
    };
};
"""


class KeymapParserTest(unittest.TestCase):
    def setUp(self):
        self.keymap = parse_keymap(SAMPLE)

    def test_レイヤーを読み込むと_defineが解決されbindingsが順に取れる(self):
        layer = self.keymap.layers[0]
        self.assertEqual(layer.name, "0")
        self.assertEqual(layer.display_name, "Default")
        self.assertEqual([b.behavior for b in layer.bindings], ["kp", "mt2", "kp", "mo", "trans", "none", "zip_dyn_scale"])
        self.assertEqual(layer.bindings[2].params, ["LC(UP_ARROW)"])

    def test_combosノードがあるとき_key_positionsとbindingが取れる(self):
        combo = self.keymap.combos[0]
        self.assertEqual(combo.key_positions, [10, 11])
        self.assertEqual(combo.binding.params, ["TAB"])

    def test_hold_tap_behaviorを定義すると_hold_tapsに登録される(self):
        self.assertEqual(self.keymap.hold_taps["mt2"], ("kp", "kp"))


class LabelTest(unittest.TestCase):
    def setUp(self):
        self.keymap = parse_keymap(SAMPLE)
        self.bindings = self.keymap.layers[0].bindings

    def test_ホールドタップのとき_tapとholdが分かれる(self):
        label = to_label(self.bindings[1], self.keymap)
        self.assertEqual((label.tap, label.hold), ("A", "Tab"))

    def test_修飾キー関数付きのとき_修飾名で連結される(self):
        self.assertEqual(to_label(self.bindings[2], self.keymap).tap, "Ctrl+↑")

    def test_transのとき_transparentになる(self):
        self.assertTrue(to_label(self.bindings[4], self.keymap).transparent)

    def test_Shiftで記号が変わるキーのとき_shiftedが付く(self):
        keymap = parse_keymap(SAMPLE.replace("&kp Q", "&kp SEMICOLON"))
        label = to_label(keymap.layers[0].bindings[0], keymap)
        self.assertEqual((label.tap, label.shifted), (";", ":"))

    def test_zip_dyn_scaleのとき_短縮表記になる(self):
        self.assertEqual(to_label(self.bindings[6], self.keymap).tap, "Ptr +")


class ResolveBindingTest(unittest.TestCase):
    def test_transのとき_下位レイヤーの割り当てが引き継ぎ扱いで返る(self):
        src = SAMPLE.replace(
            "        };\n    };\n};",
            "        };\n        L1 { bindings = <&trans &kp B &trans &trans &trans &trans &trans>; };\n    };\n};",
        )
        keymap = parse_keymap(src)
        self.assertEqual(resolve_binding(keymap, 1, 0), (keymap.layers[0].bindings[0], True))
        self.assertEqual(resolve_binding(keymap, 1, 1), (keymap.layers[1].bindings[1], False))
        self.assertEqual(resolve_binding(keymap, 1, 4)[0].behavior, "trans")


class LayoutTest(unittest.TestCase):
    def test_物理配置を読み込むと_68キーがkeymapと同じ順序で並ぶ(self):
        keys, halves, _ = build()
        self.assertEqual(len(keys), 68)
        self.assertEqual([k.kind for k in keys[:42]], ["key"] * 42)
        self.assertEqual([k.kind for k in keys[42:52]], ["fiveway"] * 10)
        self.assertEqual([k.kind for k in keys[52:]], ["gesture"] * 16)
        self.assertEqual([h.side for h in halves], ["left", "right"])


if __name__ == "__main__":
    unittest.main()
