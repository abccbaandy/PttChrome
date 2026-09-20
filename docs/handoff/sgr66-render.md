# SGR 66 一字雙色的分色渲染

狀態：**目前刻意不做**（`TermChar.assignParams` 的 `case 66:` 是有意的 no-op）
觸發：**本專案改用 UTF-8 連線時**（`src/js/term_view.js` 的 `this.charset = 'big5'`）。
在那之前一行都不用寫 —— Big5 連線收不到 SGR 66。

## 依據（全部 CONFIRMED，出處在 docs/pttbbs-screen-protocol.md §1.1）

- `mbbsd/pfterm.c`：`FTCONF_DBCS_OUTPUT_SGR66 (0)`、`FTCONF_UTF8_OUTPUT_SGR66 (1)`
  ⇒ **Big5 出站不送**。
- 線路格式：`ESC[<前半>m ESC[66;<後半>m <字>`（`fterm_rawattr_half`）。
- 入站語意：`case 66: ft.half_attr = ft.attr; ft.has_half_attr = 1;`
  ⇒ 66 快照**當下累積到的**屬性給前半格；序列剩下的參數繼續改一般屬性、成為後半格。
  快照只被**下一個字元**消費一次（`pfterm.c` 的一般字元分支會立刻清掉 flag）。
- 忽略它的降級結果＝整個字用後半格的顏色（公告原文：「效果不會差太多」）。

## 真要做的話

1. `TermChar` 加一個 latched 的 `halfAttr`（或在 `TermBuf.attr` 上放 `hasHalfAttr`），
   在 `puts` 寫下一個字元時消費一次：lead cell 套 halfAttr、trail cell 套 `this.attr`。
   Big5 模式下 lead/trail 本來就是兩格獨立 cell，模型層幾乎是現成的。
2. 真正的成本在渲染：`src/render/screen.js` 把一個全形字畫成一個 glyph，
   要左右半邊不同色得靠兩層 clip（背景可用 `linear-gradient` 切半，前景要疊兩份
   `clip-path` 的複本）。
3. **代價**：會動到 `tests/unit/fixtures/screen_golden/*.html` 這份外部契約快照
   （`UPDATE_GOLDEN=1 yarn test:unit render_dom_equivalence`，要逐行看 diff），
   以及 `.wpadding` 的寬度契約（`fixedResize` 直接掃 DOM 改寬度）。
   見 CLAUDE.md「核心渲染鏈的 DOM 是外部契約」。
4. 驗證只能靠**合成 cassette**（Big5 連線量不到真的 SGR 66）。

## 相關但不同的一張：送出方向

`docs/handoff/ansi-half-color-send-raw-mode.md` —— 貼 ASCII art 的一字雙色轉換，
那個會因為 PTT 編輯器關閉 Raw mode 而失效，與本張無關。
