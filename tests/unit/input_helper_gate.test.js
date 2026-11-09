// 輸入小幫手送字的守門（src/js/input_helper_gate.js）。
//
// 症狀：在文章列表／文章裡開著輸入小幫手點顏色，送出的 `^U[1;31m` 讓 PTT 打開「線上使用者」
// 名單（psb.c 的全域 ^U），後面的字落進名單當指令；點符號送出的 Big5 第二位元組（「，」＝A1 41）
// 在列表上是 `A`（搜作者）。色彩只在編輯器打字中送；符號另外允許輸入欄。
import {
  inputHelperSendAllowed,
  INPUT_HELPER_COLOR,
  INPUT_HELPER_TEXT,
} from "../../src/js/input_helper_gate";

const buf = ({ editor = false, input = false } = {}) => ({
  isEditorTypingNow: () => editor,
  isCursorOnInputField: () => input,
});

describe("inputHelperSendAllowed", () => {
  test("色彩：只在編輯器打字中", () => {
    expect(inputHelperSendAllowed(INPUT_HELPER_COLOR, buf({ editor: true }))).toBe(true);
    expect(inputHelperSendAllowed(INPUT_HELPER_COLOR, buf())).toBe(false);
    // 推文／標題的輸入欄：^U 不是插入 ESC，不送
    expect(inputHelperSendAllowed(INPUT_HELPER_COLOR, buf({ input: true }))).toBe(false);
  });

  test("符號：編輯器打字中或游標在輸入欄", () => {
    expect(inputHelperSendAllowed(INPUT_HELPER_TEXT, buf({ editor: true }))).toBe(true);
    expect(inputHelperSendAllowed(INPUT_HELPER_TEXT, buf({ input: true }))).toBe(true);
    expect(inputHelperSendAllowed(INPUT_HELPER_TEXT, buf())).toBe(false);
  });

  test("沒有 buf、未知種類 ⇒ 不送", () => {
    expect(inputHelperSendAllowed(INPUT_HELPER_TEXT, null)).toBe(false);
    expect(inputHelperSendAllowed("other", buf({ editor: true }))).toBe(false);
  });
});
