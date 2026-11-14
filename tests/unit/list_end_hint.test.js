// @unit-env browser
// P85：手機列表這頁不滿時（看板搜尋只有一筆、只剩幾篇的板），PTT 補的空白列不畫成一張張空卡片：
// 空卡片不畫分隔線，第一張（緊接在有內容的卡片後）寫「沒有更多了」（pref mobileListEndHint）。
// 「第一張」由 CSS 相鄰選擇器決定，每列只看自己（dirty-row 逐列 patch 的列獨立前提）。
// 鎖的是畫出來的樣子（真 CSS、真版面），不是 class 名。
import "../../src/css/main.css";
import { buildListCard, isBlankListRow } from "../../src/render/list_card";
import { i18n } from "../../src/js/i18n";
import { mountScreen, unmountAll } from "./helpers/mount_screen";
import { row, seg, listRow } from "./helpers/screen_fixtures";

const BLANK = () => row(seg(""));

let host;
afterEach(() => {
  if (host) host.remove();
  host = null;
  unmountAll();
});

// 與 term_view 掛出來的祖先同形：.main.mobileListCards > .listBodyView > span.listCard。
function mountCards(rows, endHint = true) {
  host = document.createElement("div");
  host.className = "main mobileListCards";
  host.style.cssText = "font: 16px monospace; position: absolute; left: 0; top: 0; width: 400px;";
  const body = document.createElement("div");
  body.className = "listBodyView";
  rows.forEach((chars, i) =>
    body.appendChild(
      buildListCard({ chars, row: 3 + i, kind: "article", forceWidth: 16, endHint }).node,
    ),
  );
  host.appendChild(body);
  document.body.appendChild(host);
  return [...body.children];
}

const after = (el) => getComputedStyle(el, "::after").content;
const shadow = (el) => getComputedStyle(el).boxShadow;

describe("isBlankListRow", () => {
  test("整列空白才算", () => {
    expect(isBlankListRow(BLANK())).toBe(true);
    expect(isBlankListRow(listRow("alice", "□ 第一篇"))).toBe(false);
    expect(isBlankListRow(row(seg(" ".repeat(70)), seg("x")))).toBe(false);
  });
});

describe("buildListCard endHint", () => {
  test("空白列帶提示字；有內容的列不帶；開關關掉都不帶", () => {
    const on = (chars, endHint) =>
      buildListCard({ chars, row: 4, kind: "article", forceWidth: 16, endHint }).node;
    expect(on(BLANK(), true).getAttribute("data-list-blank")).toBe(
      i18n("mobileListEndHint_text"),
    );
    expect(i18n("mobileListEndHint_text")).toBeTruthy();
    expect(on(listRow("alice", "□ 第一篇"), true).hasAttribute("data-list-blank")).toBe(false);
    expect(on(BLANK(), false).hasAttribute("data-list-blank")).toBe(false);
  });

  test("提示字不進文字內容（選取／複製不夾它）", () => {
    const n = buildListCard({ chars: BLANK(), row: 4, kind: "article", forceWidth: 16, endHint: true }).node;
    expect(n.textContent).not.toContain(i18n("mobileListEndHint_text"));
  });
});

describe("畫出來的樣子（真 CSS）", () => {
  test("一筆＋三個空白列：空卡片不畫分隔線，提示只出現在第一張空卡片", () => {
    const [first, b1, b2, b3] = mountCards([listRow("alice", "□ 第一篇"), BLANK(), BLANK(), BLANK()]);
    // 基準：有內容的卡片照舊有分隔線、沒有提示（否則下面「沒有線」是假綠）。
    expect(shadow(first)).not.toBe("none");
    expect(after(first)).toBe("none");
    for (const b of [b1, b2, b3]) expect(shadow(b)).toBe("none");
    expect(after(b1)).toBe(JSON.stringify(i18n("mobileListEndHint_text")));
    expect(after(b2)).toBe("none");
    expect(after(b3)).toBe("none");
  });

  test("提示疊在卡片裡：卡片高度不變、字在卡片範圍內", () => {
    const [first, b1] = mountCards([listRow("alice", "□ 第一篇"), BLANK()]);
    expect(b1.getBoundingClientRect().height).toBe(first.getBoundingClientRect().height);
    expect(b1.scrollHeight).toBeLessThanOrEqual(Math.ceil(b1.clientHeight));
  });

  test("開關關掉：空卡片照舊畫分隔線、沒有提示", () => {
    const [, b1] = mountCards([listRow("alice", "□ 第一篇"), BLANK()], false);
    expect(shadow(b1)).not.toBe("none");
    expect(after(b1)).toBe("none");
  });
});

describe("切開關 ⇒ 同一批列物件重畫（listCardEndHint 進 annotationsKey）", () => {
  const LINES = [
    row(seg("看板《Test》")),
    row(seg("  編號     日 期  作 者        文  章  標  題")),
    row(seg("")),
    listRow("alice", "□ 第一篇"),
    BLANK(),
    BLANK(),
    row(seg(" 文章選讀  (y)回應(X)推文")),
  ];
  const props = (on) => ({
    lines: LINES,
    enableLinkInlinePreview: false,
    enableLinkHoverPreview: false,
    enhance: {
      pageState: 2,
      listEasyReading: true,
      easyReading: true,
      listCards: "article",
      listCardEndHint: on,
      listScroll: { bodyStart: 3, viewportPx: 320, scrollable: true },
    },
  });
  const blanks = (m) => m.container.querySelectorAll(".listCard[data-list-blank]").length;

  test("關 → 開 → 關", () => {
    const m = mountScreen(props(false));
    expect(blanks(m)).toBe(0);
    m.update(props(true));
    expect(blanks(m)).toBe(2);
    m.update(props(false));
    expect(blanks(m)).toBe(0);
  });
});
