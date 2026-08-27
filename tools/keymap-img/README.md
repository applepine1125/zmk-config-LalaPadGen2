# keymap-img

`config/lalapadgen2.keymap` を読み込み、レイヤーごとにキー配列画像 (SVG / PNG) を生成する CLI。

```sh
python3 tools/keymap-img/render.py            # docs/keymap/ に出力
python3 tools/keymap-img/render.py --no-png   # SVG のみ
python3 tools/keymap-img/render.py --keymap path/to/x.keymap --out out/
```

- 依存: Python 3.9+ (標準ライブラリのみ)。PNG 化には `rsvg-convert` (`brew install librsvg`) が必要
- テンプレ (`template.svg`) は `config/lalapadgen2.json` の物理配置から `python3 tools/keymap-img/gen_template.py` で再生成できる
- 表記: ホールドタップはキー下部に水色で hold 側を表示、Shift 同時押しで変わる記号はキー右上に灰色で表示、コンボは対象キー間に水色バッジ、`&trans` は下位レイヤーの割り当てを灰色で表示 (最下層まで `&trans` なら `▽`)、`&none` は空欄。トラックパッドのジェスチャは描画しない
- テスト: `python3 -m unittest discover -s tools/keymap-img`
