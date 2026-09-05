// 「PTT 開著 vgetstring 輸入欄時不畫功能鍵按鈕」的靜態守護。
//
// 為什麼非有不可（2026-09 複合鍵放開之後才成立的硬需求）：
//   `[Y/n]`（mbbsd/bbs.c:3060 小天使匿名詢問）與 ` 確定[y/N]:`（bbs.c:3098）
//   都畫在**最後一列** ＝ footer_keys.functionKeyRows 會掃的那一列。複合鍵一放開，
//   它們立刻變成兩顆按鈕 —— 但 vans/getdata 是**整行輸入**（vtuikit.c#vgets），
//   點 `Y` 只會把字打進欄位、**不會送出**，使用者會以為壞掉；更糟的是
//   `要使用小天使匿名推文嗎？ [Y/n]` 的語意是「空 Enter ＝匿名 YES」。
//
// 這與 mouse_regions.resolveMouseRegion 的 inputPrompt 早退、
// cursor_highlight 的 inputPrompt、nav_key_gate 的同一條判斷**是同一個事實**，
// 四處一致才守得住。term_view 這兩處是 DOM 耦合的（unit 掛不動整條 render 鏈），
// 所以用靜態掃描鎖住「gate 還在」；行為端由
// tests/e2e/offline/screen_dismiss.offline.spec.js 驗。
//
// 風格比照 tests/unit/native_gesture_css.test.js / e2e_layout_settle.test.js。
import fs from "node:fs";
import path from "node:path";

const SRC = fs.readFileSync(
  path.join(process.cwd(), "src/js/term_view.js"),
  "utf8",
);

// 去掉註解再掃：檔案裡刻意留了大量說明文字，含這條規則的理由。
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

// 從某個 anchor 往後取一段，用來限定「這個 gate 屬於哪一處」。
function after(anchor, len) {
  const at = CODE.indexOf(anchor);
  expect(at, `找不到 anchor：${anchor}`).toBeGreaterThanOrEqual(0);
  return CODE.slice(at, at + len);
}

describe("輸入欄開著時不得產生功能鍵按鈕", () => {
  test("_renderScreenLines 算 fnRows 的 gate 含 isCursorOnInputField", () => {
    // 這一段是全專案唯一算 functionKeyRows 的地方（七條 render 分支的 choke point）。
    const block = after("let fnRows = null;", 400);
    expect(block).toContain("mouseFunctionKeys");
    expect(block).toContain("useMouseBrowsing");
    expect(block).toContain("isCursorOnInputField()");
  });

  test("_mirrorStatusRowToFooter 的 gate 也含 isCursorOnInputField", () => {
    // #easyReadingLastRow 是**唯一不經 computeAnnotations** 的渲染路徑，
    // 它自己呼叫 parseFunctionKeys ⇒ gate 必須各自寫一次。
    const block = after("_mirrorStatusRowToFooter: function()", 900);
    expect(block).toContain("parseFunctionKeys(statusChars)");
    expect(block).toContain("mouseFunctionKeys");
    expect(block).toContain("isCursorOnInputField()");
  });

  test("兩處都還在（漏一處就會有一半的畫面出現送不出去的按鈕）", () => {
    const hits = CODE.match(/isCursorOnInputField\(\)/g) || [];
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });
});
