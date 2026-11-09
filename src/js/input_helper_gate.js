// 輸入小幫手（右鍵「輸入小幫手」，components/ContextMenu/InputHelperModal）送字的守門。
//
// 它不是 modal、開著時終端機照收鍵盤，使用者可以在任何畫面上點它 ⇒ 送出前要看本幀畫面：
//   - 色彩（顏色盤「送出」、「重設」）送的是 `^U` ＋ `[…m`。`^U` 只有在編輯器裡是「插入 ESC」
//     （edit.c 的 Ctrl('U')）；其他畫面它是全域熱鍵「線上使用者」（psb.c 的 bbs_cmd_ctrl_u），
//     後面的 `[`、數字、`;`、`m` 全落進使用者名單當指令。⇒ **只在編輯器打字中**送。
//   - 符號送的是 Big5 字：第二個位元組常在 0x40–0x7E（例：「，」＝A1 41，41 是 `A`），落在列表
//     就是單鍵指令（`A` 搜作者）。⇒ 只在編輯器打字中、或游標在輸入欄（推文、標題…）時送。
// 判準用本幀事實（term_buf.isEditorTypingNow／isCursorOnInputField），不看會黏住的 pageState。
//
// 守護 tests/unit/input_helper_gate.test.js。

export const INPUT_HELPER_COLOR = 'color';
export const INPUT_HELPER_TEXT = 'text';

export function inputHelperSendAllowed(kind, buf) {
  if (!buf) return false;
  const editorTyping = typeof buf.isEditorTypingNow === 'function' && !!buf.isEditorTypingNow();
  if (kind === INPUT_HELPER_COLOR) return editorTyping;
  if (kind === INPUT_HELPER_TEXT)
    return editorTyping || (typeof buf.isCursorOnInputField === 'function' && !!buf.isCursorOnInputField());
  return false;
}
