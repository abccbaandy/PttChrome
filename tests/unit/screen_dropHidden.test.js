// Rendering test for Screen's dropHidden behaviour. After unifying the render path
// (easy reading also draws through <Screen>), the only per-mode difference is how a
// blacklisted comment row is treated:
//   - dropHidden:true  (easy-reading accumulated long page) → row removed entirely
//     (no DOM node, no blank gap); surviving rows keep their ABSOLUTE pageLines
//     index in data-row so term_buf.getText selection across the gap stays aligned.
//   - dropHidden:false (fixed native 24-row grid)           → row kept but hidden
//     via visibility:hidden, so the terminal grid alignment is preserved.
//
// @testing-library/react under jsdom (no network). Cells are single-char (isLeadByte
// false) so rowToText just concatenates .ch — the Big5 b2u path (needs window.lib)
// is never exercised, and the 推/噓/→ marker is a plain Unicode char here.

import { render } from "@testing-library/react";
import Screen from "../../src/components/Screen";

const COLOR = {
  fg: 7,
  bg: 0,
  blink: false,
  equals(o) {
    return o === this;
  }
};

function cell(c) {
  return {
    ch: c,
    isLeadByte: false,
    isStartOfURL: () => false,
    isEndOfURL: () => false,
    getFullURL: () => null,
    getColor: () => COLOR
  };
}

function line(str) {
  return str.split("").map(cell);
}

// The bbsline span carries data-type/data-row; the bbsrow span carries the
// per-row visibility toggle (<span type="bbsrow">).
const bbslines = container =>
  Array.from(container.querySelectorAll('[data-type="bbsline"]'));
const bbsrows = container =>
  Array.from(container.querySelectorAll('span[type="bbsrow"]'));
const dataRows = container =>
  bbslines(container).map(n => parseInt(n.getAttribute("data-row"), 10));

// Three comment rows; the middle one (baduser) is blacklisted.
const lines = [
  line("推 gooduser: first 06/13 12:01"),
  line("推 baduser: nope 06/13 12:02"),
  line("推 gooduser: third 06/13 12:03")
];

const enhanceBase = {
  blacklist: new Set(["baduser"]),
  showFloorNumbers: true,
  highlightAuthor: false,
  articleAuthor: null,
  selectedPusher: null,
  pageState: 3
};

function render_(dropHidden) {
  return render(
    <Screen
      lines={lines}
      forceWidth={20}
      enableLinkInlinePreview={false}
      enableLinkHoverPreview={false}
      enhance={Object.assign({}, enhanceBase, { dropHidden })}
    />
  ).container;
}

describe("Screen blacklist dropHidden", () => {
  test("dropHidden:true → blacklisted row produces no node; survivors keep absolute data-row", () => {
    const container = render_(true);
    // baduser row removed entirely → only 2 rows rendered.
    expect(bbslines(container).length).toBe(2);
    // Surviving rows keep their absolute index (0 and 2, NOT re-packed to 0 and 1),
    // so selection across the dropped gap (term_buf.getText uses the row index)
    // stays aligned.
    expect(dataRows(container)).toEqual([0, 2]);
  });

  test("dropHidden:false → blacklisted row kept as visibility:hidden; grid preserved", () => {
    const container = render_(false);
    // All three rows present (fixed grid, nothing removed).
    expect(bbsrows(container).length).toBe(3);
    expect(dataRows(container)).toEqual([0, 1, 2]);
    // Exactly the middle bbsrow is hidden via style.visibility.
    const hidden = bbsrows(container).filter(
      n => n.style && n.style.visibility === "hidden"
    );
    expect(hidden.length).toBe(1);
  });
});

// Board list (pageState 2) title keyword blacklist. Author at col 17-28, title from
// col 29 (same calibration as parseListAuthor). The middle row's title contains a
// blacklisted keyword and must be hidden, even with an empty author blacklist.
const IDX_PREFIX = " 350024 + 2 6/14 "; // length 17 → author starts at col 17
const listRow = (author, title) =>
  line(IDX_PREFIX + (author + " ".repeat(12)).slice(0, 12) + title);

const listLines = [
  listRow("gooduser", "R: [情報] 普通文章"),
  listRow("anyuser", "□ [閒聊] 這是廣告貼文"),
  listRow("gooduser", "□ [心得] 另一篇")
];

function renderList(titleBlacklist, dropHidden) {
  return render(
    <Screen
      lines={listLines}
      forceWidth={50}
      enableLinkInlinePreview={false}
      enableLinkHoverPreview={false}
      enhance={{
        blacklist: new Set(),
        titleBlacklist,
        pageState: 2,
        dropHidden
      }}
    />
  ).container;
}

describe("Screen board-list title blacklist", () => {
  test("titleBlacklist keyword hides the matching row (native grid, visibility:hidden)", () => {
    const container = renderList(["廣告"], false);
    expect(bbsrows(container).length).toBe(3);
    const hidden = bbsrows(container).filter(
      n => n.style && n.style.visibility === "hidden"
    );
    expect(hidden.length).toBe(1);
  });

  test("works with empty author blacklist; dropHidden removes the matching row", () => {
    const container = renderList(["廣告"], true);
    expect(bbslines(container).length).toBe(2);
    expect(dataRows(container)).toEqual([0, 2]);
  });

  test("no keyword match → nothing hidden", () => {
    const container = renderList(["不存在"], false);
    const hidden = bbsrows(container).filter(
      n => n.style && n.style.visibility === "hidden"
    );
    expect(hidden.length).toBe(0);
  });
});

// REGRESSION (bug: 按 v 設定已讀未讀記錄時黑名單持續失效). The v prompt overlays a
// question on the board list whose status row no longer parses as LIST(2), so the
// per-frame pageState would be e.g. NORMAL(0) and un-hide every blacklisted row for
// the whole prompt. term_view keeps a sticky `inListContext` flag that survives such
// overlay screens; computeAnnotations must keep hiding list rows when it is set even
// though pageState !== 2.
function renderListCtx(enhanceExtra) {
  return render(
    <Screen
      lines={listLines}
      forceWidth={50}
      enableLinkInlinePreview={false}
      enableLinkHoverPreview={false}
      enhance={Object.assign(
        { blacklist: new Set(), dropHidden: false },
        enhanceExtra
      )}
    />
  ).container;
}

const hiddenCount = container =>
  bbsrows(container).filter(
    n => n.style && n.style.visibility === "hidden"
  ).length;

describe("Screen list blacklist sticky inListContext (v prompt)", () => {
  test("pageState 0 + inListContext → author blacklist still hides the row", () => {
    const container = renderListCtx({
      blacklist: new Set(["anyuser"]),
      pageState: 0,
      inListContext: true
    });
    expect(hiddenCount(container)).toBe(1);
  });

  test("pageState 0 + inListContext → title blacklist still hides the row", () => {
    const container = renderListCtx({
      titleBlacklist: ["廣告"],
      pageState: 0,
      inListContext: true
    });
    expect(hiddenCount(container)).toBe(1);
  });

  test("pageState 0 without inListContext → nothing hidden (no over-hiding)", () => {
    const container = renderListCtx({
      blacklist: new Set(["anyuser"]),
      titleBlacklist: ["廣告"],
      pageState: 0,
      inListContext: false
    });
    expect(hiddenCount(container)).toBe(0);
  });
});
