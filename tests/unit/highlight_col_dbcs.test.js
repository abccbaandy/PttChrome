// 部分底色（防誤觸模式的 `[highlightColStart, 行尾)` 包裝）**不可以切在雙寬字中間**。
//
// 壞過的行為（使用者 2026-08 回報，看板列表按 s 的「搜尋全站看板」畫面）：
// 底色起始欄是列表的標題欄 30（LIST_TITLE_COL_START），而 prompt 那一列的
// 「請輸入看板名稱(按空白鍵自動搜尋): 」剛好把「尋」放在 cols 29-30 ⇒ 切點落在
// 它的 trail byte 上。LinkSegmentBuilder 在切點無條件 saveSegment()，而
// ColorSegmentBuilder 的 `lead` 是 per-segment 狀態 ⇒ lead byte(0xB4) 隨舊 builder
// 被丟棄、trail byte(0x4D) 在新 builder 裡被當成 ASCII 畫出來：
// 畫面變成「自動搜M」，該字從 2 格縮成 1 格 ⇒ 後面整段左移、游標與輸入框錯位。
import { mountRow, unmountAll } from "./helpers/mount_screen";
import { seg } from "./helpers/screen_fixtures";
import { LIST_TITLE_COL_START } from "../../src/js/comment_parse";

const PROMPT = "請輸入看板名稱(按空白鍵自動搜尋): ";

const lineText = (container) =>
  container.querySelector('[data-type="bbsline"]').textContent;

afterEach(unmountAll);

describe("部分底色的切點落在 DBCS trail cell 上", () => {
  test("雙寬字不被拆掉（「搜尋」不能變成「搜M」）", () => {
    const { container } = mountRow({
      chars: seg(PROMPT),
      row: 1,
      highlightClass: "b1",
      highlightColStart: LIST_TITLE_COL_START, // 30 ＝「尋」的 trail byte
    });
    expect(lineText(container)).toBe(PROMPT);
  });

  test("底色改從該字之後開始（整個字留在底色外，欄寬不位移）", () => {
    const { container } = mountRow({
      chars: seg(PROMPT),
      row: 1,
      highlightClass: "b1",
      highlightColStart: LIST_TITLE_COL_START,
    });
    const wrap = container.querySelector(".cursorHighlight");
    expect(wrap).not.toBeNull();
    expect(wrap.classList.contains("b1")).toBe(true);
    // 切點被推到「尋」的後一格：底色段從 ')' 起，而不是半個字。
    expect(wrap.textContent).toBe("): ");
  });

  test("切點落在半形字上（常態）時行為一字不變", () => {
    const { container } = mountRow({
      chars: seg(PROMPT),
      row: 1,
      highlightClass: "b1",
      highlightColStart: 31, // ')' 本身
    });
    expect(lineText(container)).toBe(PROMPT);
    expect(container.querySelector(".cursorHighlight").textContent).toBe("): ");
  });

  test("切點落在雙寬字的 lead cell 上：整個字進底色區", () => {
    const { container } = mountRow({
      chars: seg(PROMPT),
      row: 1,
      highlightClass: "b1",
      highlightColStart: 29, // 「尋」的 lead byte
    });
    expect(lineText(container)).toBe(PROMPT);
    expect(container.querySelector(".cursorHighlight").textContent).toBe("尋): ");
  });
});
