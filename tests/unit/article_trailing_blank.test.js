// @unit-env browser
// 手機好讀文章：PTT 補在文末之後的空白列要收起（docs/mobile.md「文末補白收起」）。
// 文章比一頁短（或末頁）時 pmore 把 EOF 之後的列清成空白（`\x1b[K`），好讀長頁照收
// ⇒ 手機推文區最下面一大塊空白（實錄 ptt-debug-20261010-232349.json：33 列內容＋13 列補白）。
// 鎖：只收「最後一列非空白之後」的空白列、內文中間的空白列不動、外部契約保留、
// 桌機（沒有 commentCards）一列都不收、文章長出新內容後原本收起的列要放回來。
import { mountScreen, unmountAll } from "./helpers/mount_screen";
import { row, seg, color, SCENARIOS } from "./helpers/screen_fixtures";

afterEach(() => unmountAll());

const easy = SCENARIOS.find((s) => s.name === "article_easy_reading");
const BLANK = () => row(seg(""));
const PADDED = [...easy.lines.slice(0, 3), BLANK(), ...easy.lines.slice(3), BLANK(), BLANK(), BLANK()];
const n = PADDED.length;
const props = (lines, commentCards) => ({
  ...easy,
  lines,
  enhance: { ...easy.enhance, commentCards },
});
const node = (m, r) => m.container.querySelector(`[type="bbsrow"][srow="${r}"]`);
const collapsed = (m, r) => node(m, r).classList.contains("articleTrailingBlankRow");

describe("文末補白收起", () => {
  test("手機：最後三列空白收起，契約保留", () => {
    const m = mountScreen(props(PADDED, true));
    for (let r = n - 3; r < n; ++r) {
      expect(collapsed(m, r)).toBe(true);
      expect(node(m, r).classList.contains("mobileCollapsedRow")).toBe(true);
      expect(node(m, r).querySelector(`[data-type="bbsline"][data-row="${r}"]`)).not.toBe(null);
    }
  });

  test("內文中間的空白列不收", () => {
    const m = mountScreen(props(PADDED, true));
    expect(collapsed(m, 2)).toBe(false);
    expect(collapsed(m, 3)).toBe(false);
  });

  test("桌機（沒有 commentCards）：一列都不收", () => {
    const m = mountScreen(props(PADDED, undefined));
    expect(m.container.querySelector(".articleTrailingBlankRow")).toBe(null);
  });

  test("後面接上新內容 ⇒ 原本收起的列放回來", () => {
    const m = mountScreen(props(PADDED, true));
    const grown = [...PADDED, row(seg("→ late: 晚到的推文", color(1, 0)), seg("    06/14 12:09"))];
    m.update(props(grown, true));
    for (let r = n - 3; r < n; ++r) expect(collapsed(m, r)).toBe(false);
    expect(collapsed(m, n)).toBe(false);
  });
});
