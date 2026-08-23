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

// 連續雙寬字時開邊界被**連鎖**往右推（使用者 2026-08-23 回報，看板列表）：
//
//   「      9   Browsers     軟體 ◎火狐台北辦公室解散 …」
//
// 底色起始欄 30 正是「中文敘述」欄（board.c#show_brdlist 的 `%-34.34s`）的第一格，
// 也就是「火」的 lead byte，本來不該推。但 trail-cell 的判斷用 isDBCSLead(byte)
// 看**上一格的位元組值**，而 Big5 的 trail byte 有一半（0xA1..0xFE）落在 lead 的
// 值域裡 ⇒ 每一格都被當成 trail、每一格都 +1，一路推到遇上 trail byte < 0x81 的
// 字才停（這裡是「台」的 0x78）⇒ 底色從「北」才開始，整整少了三個字。
// 修法：比照 ColorSegmentBuilder 用交替狀態（上一格是 lead ⇒ 這一格必是 trail，
// 不可能同時是下一個字的 lead）。
describe("連續雙寬字不可讓開邊界連鎖右移", () => {
  const BRD_ROW = "      9   Browsers     軟體 ◎火狐台北辦公室解散    kimari/karst";

  test("底色從中文敘述欄的第一個字（col 30）起，不是第四個字", () => {
    const { container } = mountRow({
      chars: seg(BRD_ROW),
      row: 5,
      highlightClass: "b2",
      highlightColStart: 30,
    });
    const wrap = container.querySelector(".cursorHighlight");
    expect(wrap).not.toBeNull();
    expect(wrap.textContent).toBe("火狐台北辦公室解散    kimari/karst");
  });

  test("整列文字不被拆字", () => {
    const { container } = mountRow({
      chars: seg(BRD_ROW),
      row: 5,
      highlightClass: "b2",
      highlightColStart: 30,
    });
    expect(lineText(container)).toBe(BRD_ROW);
  });
});
