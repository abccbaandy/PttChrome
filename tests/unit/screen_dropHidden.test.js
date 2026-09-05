// Rendering test for Screen's dropHidden behaviour. After unifying the render path
// (easy reading also draws through the same renderer), the only per-mode difference is how a
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

import { mountScreen, unmountAll } from "./helpers/mount_screen";

afterEach(unmountAll);

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
  return mountScreen({ lines: lines, forceWidth: 20, enableLinkInlinePreview: false, enableLinkHoverPreview: false, enhance: Object.assign({}, enhanceBase, { dropHidden }) }).container;
}

describe("畫面 blacklist dropHidden", () => {
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

// Board list (pageState 2). Author at col 17-28, title from col 29 (same calibration
// as parseListAuthor). Two modes keyed by enhance.listEasyReading:
//   - easy-reading (listEasyReading:true): deleted + blacklist rows HIDDEN.
//   - native (listEasyReading absent): deleted rows render as-is; blacklist rows
//     render a「(本文已被黑名單)」notice line, NOT hidden.
const IDX_PREFIX = " 350024 + 2 6/14 "; // length 17 → author starts at col 17
const listRow = (author, title) =>
  line(IDX_PREFIX + (author + " ".repeat(12)).slice(0, 12) + title);

const listLines = [
  listRow("gooduser", "R: [情報] 普通文章"),
  listRow("anyuser", "□ [閒聊] 這是廣告貼文"),
  listRow("gooduser", "□ [心得] 另一篇")
];

function renderList(enhanceExtra) {
  return mountScreen({ lines: listLines, forceWidth: 50, enableLinkInlinePreview: false, enableLinkHoverPreview: false, enhance: Object.assign(
        { blacklist: new Set(), titleBlacklist: [], pageState: 2, dropHidden: false },
        enhanceExtra
      ) }).container;
}

const hiddenRows = container =>
  bbsrows(container).filter(n => n.style && n.style.visibility === "hidden");
const noticeRows = container =>
  bbsrows(container).filter(n => (n.textContent || "").includes("（本文已被黑名單）"));

describe("畫面 board-list easy-reading mode (listEasyReading:true → 全部隱藏)", () => {
  test("titleBlacklist keyword hides the matching row (visibility:hidden)", () => {
    const container = renderList({ titleBlacklist: ["廣告"], listEasyReading: true });
    expect(bbsrows(container).length).toBe(3);
    expect(hiddenRows(container).length).toBe(1);
    expect(noticeRows(container).length).toBe(0);
  });

  test("dropHidden removes the matching row entirely", () => {
    const container = renderList({
      titleBlacklist: ["廣告"],
      listEasyReading: true,
      dropHidden: true
    });
    expect(bbslines(container).length).toBe(2);
    expect(dataRows(container)).toEqual([0, 2]);
  });

  test("author blacklist hides the row", () => {
    const container = renderList({
      blacklist: new Set(["anyuser"]),
      listEasyReading: true
    });
    expect(hiddenRows(container).length).toBe(1);
  });
});

describe("畫面 board-list native mode (無 listEasyReading → 黑名單通知列/刪除文原生)", () => {
  test("author blacklist → 通知列「(本文已被黑名單) <作者>」，非隱藏", () => {
    const container = renderList({ blacklist: new Set(["anyuser"]) });
    expect(hiddenRows(container).length).toBe(0);
    const notices = noticeRows(container);
    expect(notices.length).toBe(1);
    expect(notices[0].textContent).toContain("（本文已被黑名單） anyuser");
  });

  test("titleBlacklist → 通知列，非隱藏，且尾端顯示命中的關鍵字而非作者", () => {
    const container = renderList({ titleBlacklist: ["廣告"] });
    expect(hiddenRows(container).length).toBe(0);
    const notices = noticeRows(container);
    expect(notices.length).toBe(1);
    expect(notices[0].textContent).toContain("（本文已被黑名單） 廣告");
    expect(notices[0].textContent).not.toContain("anyuser");
  });

  test("被刪除文（作者欄 -）→ 原生顯示，不隱藏、不轉通知", () => {
    const deletedLines = [
      listRow("gooduser", "R: [情報] 普通文章"),
      line(IDX_PREFIX + ("-" + " ".repeat(12)).slice(0, 12) + "□ (本文已被刪除) [someone]"),
      listRow("gooduser", "□ [心得] 另一篇")
    ];
    const container = mountScreen({ lines: deletedLines, forceWidth: 50, enableLinkInlinePreview: false, enableLinkHoverPreview: false, enhance: { blacklist: new Set(), titleBlacklist: [], pageState: 2, dropHidden: false } }).container;
    expect(hiddenRows(container).length).toBe(0);
    expect(noticeRows(container).length).toBe(0);
  });

  test("no match → nothing hidden, no notice", () => {
    const container = renderList({ titleBlacklist: ["不存在"] });
    expect(hiddenRows(container).length).toBe(0);
    expect(noticeRows(container).length).toBe(0);
  });
});

// REGRESSION 2026-09-05（錄製檔 ptt-debug-20260905-122522 ＋ 使用者截圖）：
// 在文章列表按 Ctrl-P 發文，分類畫面上冒出「（本文已被黑名單） vtub」通知列。
// setPageState 沒有 reset 分支 ⇒ 發文畫面**沿用**列表的 pageState 2，
// term_view 的 inListContext 又是黏的 ⇒ 標註層兩個輸入都指向「這是列表」。
// 守門改成逐列形狀指紋（comment_parse#isListShapedRow）。
const composeLines = [
  line(""),
  line("  [閒聊] 希洽最基本之發文Tag，藉由發表含ACG點的文章開啟話題與其他板友閒聊。"),
  line("  [Vtub] 討論與虛擬實況主 (Vtuber) 有關的事物。"),
  line("  1. 不得張貼廣告或商業性質文章，違者水桶。"),
  line("發表文章於【 C_Chat 】 [希洽] 這裡是希洽板 看板"),
  line("種類：1.閒聊 2.問題 3.討論 4.26夏 5.心得 6.情報 7.Vtub 8.自介 (1-8或不選)")
];

describe("畫面 發文/覆蓋畫面繼承 pageState 2 時不得跑黑名單", () => {
  const renderCompose = enhanceExtra =>
    mountScreen({
      lines: composeLines,
      forceWidth: 80,
      enableLinkInlinePreview: false,
      enableLinkHoverPreview: false,
      enhance: Object.assign(
        {
          blacklist: new Set(),
          titleBlacklist: [],
          pageState: 2,
          inListContext: true,
          dropHidden: false
        },
        enhanceExtra
      )
    }).container;

  test("標題關鍵字 vtub 命中發文分類列 → 不得出現通知列（本次 bug 的現場）", () => {
    const container = renderCompose({ titleBlacklist: ["vtub"] });
    expect(noticeRows(container).length).toBe(0);
    expect(hiddenRows(container).length).toBe(0);
    // 原始文字必須完整保留（通知列會從作者欄整段蓋掉）
    expect(container.textContent).toContain("8.自介");
  });

  test("關鍵字命中板規列 → 不得出現通知列", () => {
    const container = renderCompose({ titleBlacklist: ["閒聊", "廣告"] });
    expect(noticeRows(container).length).toBe(0);
    expect(container.textContent).toContain("希洽最基本之發文Tag");
  });

  test("非列表列不得掛 data-list-author / data-list-title（右鍵快速加黑名單）", () => {
    const container = renderCompose({});
    expect(container.querySelectorAll("[data-list-title]").length).toBe(0);
    expect(container.querySelectorAll("[data-list-author]").length).toBe(0);
  });

  test("好讀視窗模式下同樣不得隱藏", () => {
    const container = renderCompose({
      titleBlacklist: ["vtub"],
      listEasyReading: true
    });
    expect(hiddenRows(container).length).toBe(0);
  });
});

// 同一類誤命中也發生在**真實列表畫面**上：表頭與 footer 的 col≥29 一樣會被
// 關鍵字比對到（footer 含「轉錄」）。逐列形狀守門一併修掉。
describe("畫面 真實列表的表頭/footer 不得被關鍵字吃掉", () => {
  test("footer「(^X)轉錄」不因關鍵字『轉錄』變成通知列", () => {
    const withChrome = [
      line("  【板主】abc 看板《C_Chat》線上1234人, 我是guest"),
      line(""),
      line("   編號    日 期  作  者       文  章  標  題       人氣:12345"),
      listRow("gooduser", "R: [情報] 普通文章"),
      line(" 文章選讀 (y)回應(X)推文(^X)轉錄 (=[]<>)相關主題 (/?)搜尋")
    ];
    const container = mountScreen({
      lines: withChrome,
      forceWidth: 80,
      enableLinkInlinePreview: false,
      enableLinkHoverPreview: false,
      enhance: {
        blacklist: new Set(),
        titleBlacklist: ["轉錄", "編號"],
        pageState: 2,
        dropHidden: false
      }
    }).container;
    expect(noticeRows(container).length).toBe(0);
    // 真正的文章列仍照常掛 data-list-*
    expect(container.querySelectorAll("[data-list-author]").length).toBe(1);
  });
});

// REGRESSION (bug: 按 v 設定已讀未讀記錄時黑名單持續失效). The v prompt overlays a
// question on the board list whose status row no longer parses as LIST(2), so the
// per-frame pageState would be e.g. NORMAL(0) and un-hide every blacklisted row for
// the whole prompt. term_view keeps a sticky `inListContext` flag that survives such
// overlay screens; computeAnnotations must keep hiding list rows when it is set even
// though pageState !== 2.
function renderListCtx(enhanceExtra) {
  return mountScreen({ lines: listLines, forceWidth: 50, enableLinkInlinePreview: false, enableLinkHoverPreview: false, enhance: Object.assign(
        { blacklist: new Set(), dropHidden: false },
        enhanceExtra
      ) }).container;
}

const hiddenCount = container =>
  bbsrows(container).filter(
    n => n.style && n.style.visibility === "hidden"
  ).length;

// The v prompt is an easy-reading (listEasyReading) T2 transaction → listEasyReading
// stays true (derived from the engaged session state), so blacklist rows behind the
// overlay stay HIDDEN even when the overlay frame stops parsing as LIST(2).
describe("畫面 list blacklist sticky inListContext (easy-reading v prompt)", () => {
  test("pageState 0 + inListContext + listEasyReading → author blacklist still hides", () => {
    const container = renderListCtx({
      blacklist: new Set(["anyuser"]),
      pageState: 0,
      inListContext: true,
      listEasyReading: true
    });
    expect(hiddenCount(container)).toBe(1);
  });

  test("pageState 0 + inListContext + listEasyReading → title blacklist still hides", () => {
    const container = renderListCtx({
      titleBlacklist: ["廣告"],
      pageState: 0,
      inListContext: true,
      listEasyReading: true
    });
    expect(hiddenCount(container)).toBe(1);
  });

  test("pageState 0 without inListContext → nothing hidden (no over-hiding)", () => {
    const container = renderListCtx({
      blacklist: new Set(["anyuser"]),
      titleBlacklist: ["廣告"],
      pageState: 0,
      inListContext: false,
      listEasyReading: true
    });
    expect(hiddenCount(container)).toBe(0);
  });
});
