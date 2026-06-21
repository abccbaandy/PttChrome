// Rendering test for Screen's dropHidden behaviour. After unifying the render path
// (easy reading also draws through <Screen>), the only per-mode difference is how a
// blacklisted comment row is treated:
//   - dropHidden:true  (easy-reading accumulated long page) → row removed entirely
//     (no DOM node, no blank gap); surviving rows keep their ABSOLUTE pageLines
//     index in data-row so term_buf.getText selection across the gap stays aligned.
//   - dropHidden:false (fixed native 24-row grid)           → row kept but hidden
//     via visibility:hidden, so the terminal grid alignment is preserved.
//
// Uses react-test-renderer (no DOM/network). Cells are single-char (isLeadByte
// false) so rowToText just concatenates .ch — the Big5 b2u path (needs window.lib)
// is never exercised, and the 推/噓/→ marker is a plain Unicode char here.

import renderer from "react-test-renderer";
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

// Depth-first collect of host nodes whose props match a predicate, in tree order.
function collect(node, pred, out = []) {
  if (!node || typeof node === "string") return out;
  if (node.props && pred(node.props)) out.push(node);
  for (const child of node.children || []) collect(child, pred, out);
  return out;
}

const bbslines = json => collect(json, p => p["data-type"] === "bbsline");
const bbsrows = json => collect(json, p => p.type === "bbsrow");

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

function render(dropHidden) {
  return renderer
    .create(
      <Screen
        lines={lines}
        forceWidth={20}
        enableLinkInlinePreview={false}
        enableLinkHoverPreview={false}
        enhance={Object.assign({}, enhanceBase, { dropHidden })}
      />
    )
    .toJSON();
}

describe("Screen blacklist dropHidden", () => {
  test("dropHidden:true → blacklisted row produces no node; survivors keep absolute data-row", () => {
    const json = render(true);
    const rows = bbslines(json);
    // baduser row removed entirely → only 2 rows rendered.
    expect(rows.length).toBe(2);
    // Surviving rows keep their absolute index (0 and 2, NOT re-packed to 0 and 1),
    // so selection across the dropped gap (term_buf.getText uses the row index)
    // stays aligned.
    expect(rows.map(n => n.props["data-row"])).toEqual([0, 2]);
  });

  test("dropHidden:false → blacklisted row kept as visibility:hidden; grid preserved", () => {
    const json = render(false);
    // All three rows present (fixed grid, nothing removed).
    expect(bbsrows(json).length).toBe(3);
    expect(bbslines(json).map(n => n.props["data-row"])).toEqual([0, 1, 2]);
    // Exactly the middle bbsrow is hidden via style.visibility.
    const hidden = bbsrows(json).filter(
      n => n.props.style && n.props.style.visibility === "hidden"
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
  return renderer
    .create(
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
    )
    .toJSON();
}

describe("Screen board-list title blacklist", () => {
  test("titleBlacklist keyword hides the matching row (native grid, visibility:hidden)", () => {
    const json = renderList(["廣告"], false);
    expect(bbsrows(json).length).toBe(3);
    const hidden = bbsrows(json).filter(
      n => n.props.style && n.props.style.visibility === "hidden"
    );
    expect(hidden.length).toBe(1);
  });

  test("works with empty author blacklist; dropHidden removes the matching row", () => {
    const json = renderList(["廣告"], true);
    const rows = bbslines(json);
    expect(rows.length).toBe(2);
    expect(rows.map(n => n.props["data-row"])).toEqual([0, 2]);
  });

  test("no keyword match → nothing hidden", () => {
    const json = renderList(["不存在"], false);
    const hidden = bbsrows(json).filter(
      n => n.props.style && n.props.style.visibility === "hidden"
    );
    expect(hidden.length).toBe(0);
  });
});
