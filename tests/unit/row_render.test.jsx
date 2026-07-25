// Rendering test for the same-author / pusher highlight on a comment <Row>.
// Uses @testing-library/react under jsdom (no network). Fake TermChar cells are
// ASCII-only so the DBCS path (which needs window.lib Big5 tables) is never
// exercised.
//
// The marker (推/噓/→) is a 2-col DBCS char in reality; here two placeholder ASCII
// cells stand in for cols 0-1 so the column math (user id at col 3) still holds.

import { render, act } from "@testing-library/react";
import Row from "../../src/components/Row";
import { requestPreview } from "../../src/components/ImagePreviewer";

// Let any ImagePreviewer resolver promise (mounted by an inline preview / fixed-URL
// line) settle inside act() so its trailing async setState doesn't log a "not
// wrapped in act" warning. Non-previewable links reject via the default resolver.
const flushPreviews = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });

// One shared color so all cells coalesce; equals() is identity-based.
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
    isStartOfURL: () => false,
    isEndOfURL: () => false,
    getFullURL: () => null,
    getColor: () => COLOR
  };
}

// "PU wowbenny: hi" → cols: P=0 U=1 (marker stand-in) space=2 user id from col 3.
function chars(str) {
  return str.split("").map(cell);
}

// A URL cell: start/end mark the URL boundary, getFullURL returns it on the start.
function urlCell(c, { start = false, end = false, url = null } = {}) {
  return {
    ch: c,
    isStartOfURL: () => start,
    isEndOfURL: () => end,
    getFullURL: () => url,
    getColor: () => COLOR
  };
}

// "PU wowbenny: <url>" — plain prefix cells then the url marked as a hyperlink.
function urlChars(url) {
  const cells = chars("PU wowbenny: ");
  const u = url.split("");
  u.forEach((c, i) =>
    cells.push(urlCell(c, { start: i === 0, end: i === u.length - 1, url }))
  );
  return cells;
}

// The outer node of a rendered <Row> is the bbsrow span (<span type="bbsrow">).
const bbsrow = container => container.querySelector('span[type="bbsrow"]');

describe("Row same-author highlight", () => {
  test("commentByAuthor wraps exactly the user id columns", () => {
    const { container } = render(
      <Row
        chars={chars("PU wowbenny: hi")}
        row={0}
        authorIdStart={3}
        authorIdEnd={11}
      />
    );
    const authorSpan = container.querySelector(".commentByAuthor");
    expect(authorSpan).not.toBeNull();
    expect(authorSpan.textContent).toBe("wowbenny"); // not "PU ", not the content
  });

  test("no author range → no commentByAuthor span", () => {
    const { container } = render(
      <Row chars={chars("PU wowbenny: hi")} row={0} />
    );
    expect(container.querySelector(".commentByAuthor")).toBeNull();
  });
});

describe("Row pusher highlight", () => {
  test("pusherHighlight → whole-row class + data-pusher on the bbsrow", () => {
    const { container } = render(
      <Row
        chars={chars("PU wowbenny: hi")}
        row={0}
        pusher="wowbenny"
        pusherHighlight={true}
      />
    );
    const row = bbsrow(container);
    expect(row.classList.contains("pusherHighlight")).toBe(true);
    expect(row.getAttribute("data-pusher")).toBe("wowbenny");
  });

  test("data-pusher present but not highlighted when not selected", () => {
    const { container } = render(
      <Row chars={chars("PU wowbenny: hi")} row={0} pusher="wowbenny" />
    );
    const row = bbsrow(container);
    expect(row.getAttribute("data-pusher")).toBe("wowbenny");
    expect(row.classList.contains("pusherHighlight")).toBe(false);
  });
});

// Regression: a row re-render (e.g. on pusherHighlight toggle) must reuse the
// same preview request Promise for an unchanged href. A fresh Promise each
// render would reset ImagePreviewer (PureComponent) state to undefined and
// remount the media element — reloading YouTube iframes and flashing them.
// The stability comes from requestPreview's href→Promise cache; assert it
// directly (the request prop is internal and not observable in the DOM).
describe("Row inline preview request identity", () => {
  test("same href → requestPreview returns the same Promise reference", () => {
    const url = "https://youtu.be/aYIdRD_Gvz0";
    expect(requestPreview(url)).toBe(requestPreview(url));
  });
});

// Auto-fixed URL line (src/js/url_fix.js detects; LinkSegmentBuilder renders below).
describe("Row fixed-URL line", () => {
  const fixed = "https://www.google.com/";

  test("easy-reading (inline preview) → renders a clickable .fixedUrlLine", async () => {
    const { container } = render(
      <Row
        chars={chars("broken url above")}
        row={0}
        enableLinkInlinePreview={true}
        fixedUrls={[{ original: "www . google .com/", fixed }]}
      />
    );
    const line = container.querySelector(".fixedUrlLine");
    expect(line).not.toBeNull();
    expect(line.textContent).toContain(fixed);
    // FixedUrlLine always mounts an ImagePreviewer; google.com/ is non-previewable
    // → the resolver rejects in a later microtask. Flush it under act().
    await flushPreviews();
  });

  test("native grid (no inline preview) → fixed-URL line is NOT rendered", () => {
    const { container } = render(
      <Row
        chars={chars("broken url above")}
        row={0}
        fixedUrls={[{ original: "www . google .com/", fixed }]}
      />
    );
    expect(container.querySelector(".fixedUrlLine")).toBeNull();
  });
});

// X(Twitter) @handle auto-link. Screen decides which handles are verified and
// passes their [startCol, endCol) ranges; Row/LinkSegmentBuilder wraps them.
describe("Row X mention link", () => {
  test("verified mention → .xMention <a> wrapping exactly @handle, opens new tab", () => {
    // h0 i1 sp2 @3 j4 a5 c6 k7 sp8 y9 a10
    const { container } = render(
      <Row
        chars={chars("hi @jack ya")}
        row={0}
        mentions={[
          { startCol: 3, endCol: 8, handle: "jack", href: "https://x.com/jack" }
        ]}
      />
    );
    const a = container.querySelector("a.xMention");
    expect(a).not.toBeNull();
    expect(a.getAttribute("href")).toBe("https://x.com/jack");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noreferrer");
    expect(a.textContent).toBe("@jack");
  });

  test("no mentions prop → plain text, no .xMention", () => {
    const { container } = render(
      <Row chars={chars("hi @jack ya")} row={0} />
    );
    expect(container.querySelector(".xMention")).toBeNull();
    expect(bbsrow(container).textContent).toBe("hi @jack ya");
  });

  test("mention reaching the end of the line is still wrapped", () => {
    // a0 t1 sp2 @3 b4 o5 b6  → endCol 7 == line length
    const { container } = render(
      <Row
        chars={chars("at @bob")}
        row={0}
        mentions={[
          { startCol: 3, endCol: 7, handle: "bob", href: "https://x.com/bob" }
        ]}
      />
    );
    const a = container.querySelector("a.xMention");
    expect(a).not.toBeNull();
    expect(a.textContent).toBe("@bob");
  });
});

// PTT article-code (AID) auto-link. Screen detects #XXXXXXXX ranges (aid_parse)
// and passes them with an onClick; Row/LinkSegmentBuilder wraps them in a
// .aidLink <a> that navigates in-app (preventDefault) instead of a new tab.
describe("Row AID link", () => {
  test("aid → .aidLink <a> wrapping exactly #AID, click calls onClick", () => {
    // s0 e1 e2 sp3 #4..12 sp13
    const onClick = vi.fn();
    const { container } = render(
      <Row
        chars={chars("see #1gIeu-3A ok")}
        row={0}
        aids={[
          { startCol: 4, endCol: 13, aid: "1gIeu-3A", board: "Android", onClick }
        ]}
      />
    );
    const a = container.querySelector("a.aidLink");
    expect(a).not.toBeNull();
    expect(a.textContent).toBe("#1gIeu-3A");
    a.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test("no aids prop → plain text, no .aidLink", () => {
    const { container } = render(
      <Row chars={chars("see #1gIeu-3A ok")} row={0} />
    );
    expect(container.querySelector(".aidLink")).toBeNull();
    expect(bbsrow(container).textContent).toBe("see #1gIeu-3A ok");
  });
});

// Steamgifts giveaway 代碼自動連結。Screen 過文章層 gate 後偵測獨立成列的 5 碼
// 代碼（steamgifts_parse），Row/LinkSegmentBuilder 包成 .sgGiveawayLink 外連。
describe("Row Steamgifts giveaway link", () => {
  test("giveaway → .sgGiveawayLink <a> 只包代碼、開新分頁、href 無 slug", () => {
    // sp0 sp1 j2 Q3 t4 f5 0 6
    const { container } = render(
      <Row
        chars={chars("  jQtf0")}
        row={0}
        giveaways={[
          {
            startCol: 2,
            endCol: 7,
            code: "jQtf0",
            href: "https://www.steamgifts.com/giveaway/jQtf0/"
          }
        ]}
      />
    );
    const a = container.querySelector("a.sgGiveawayLink");
    expect(a).not.toBeNull();
    expect(a.textContent).toBe("jQtf0");
    expect(a.getAttribute("href")).toBe(
      "https://www.steamgifts.com/giveaway/jQtf0/"
    );
    expect(a.getAttribute("target")).toBe("_blank");
  });

  test("no giveaways prop → plain text, no .sgGiveawayLink", () => {
    const { container } = render(<Row chars={chars("jQtf0")} row={0} />);
    expect(container.querySelector(".sgGiveawayLink")).toBeNull();
    expect(bbsrow(container).textContent).toBe("jQtf0");
  });
});

// 好讀「連續同作者推文合併」的 Row 擴充：合併塊樓層／時間都跟一般單則推文一致，
// 只顯示 run 首則——樓層徽章維持單一樓號、trailer 時間標籤附加在 bbsline span 尾端。
describe("Row merged-comment extensions", () => {
  test("合併塊徽章維持單一樓號（首則）", () => {
    const { container } = render(
      <Row
        chars={chars("PU wowbenny: hi")}
        row={0}
        floor={{ seq: 12, sub: 3, type: "推" }}
      />
    );
    expect(container.querySelector("[data-floor]").textContent).toBe("12");
  });

  test("trailer 節點渲染在 bbsline span 內容尾端", () => {
    const { container } = render(
      <Row
        chars={chars("PU wowbenny: hi")}
        row={0}
        trailer={<span className="mergedCommentTime">07/20 14:23</span>}
      />
    );
    const line = container.querySelector('[data-type="bbsline"]');
    const time = line.querySelector(".mergedCommentTime");
    expect(time).not.toBeNull();
    expect(time.textContent).toBe("07/20 14:23");
    // 在內容之後（最後一個子節點）
    expect(line.lastChild).toBe(time);
  });
});

// 樓層徽章的 DOM 契約。徽章是零寬盒（不位移等寬格線），數字靠內層 .floorBadgeNum
// 以 translateX(-100%) 對齊「作者 id 起始欄」向左生長 → 高樓層往標記字方向溢出，
// 永遠不會蓋到作者 id。幾何只能在 e2e 量（jsdom 無 layout），這裡守 DOM 結構契約。
describe("Row 樓層徽章", () => {
  const renderFloor = seq =>
    render(
      <Row
        chars={chars("PU wowbenny: hi")}
        row={0}
        floor={{ seq, sub: 3, type: "推" }}
      />
    );

  test("樓號文字仍是 [data-floor] 的 textContent（scraping 契約）", () => {
    const { container } = renderFloor(123);
    const badge = container.querySelector("[data-floor]");
    expect(badge.textContent).toBe("123");
    expect(badge.querySelector(".floorBadgeNum").textContent).toBe("123");
  });

  test("徽章插在 col 2 空格之前，數字後仍留空格（推文正則 /^(推|噓|→)\\d*\\s+/）", () => {
    const { container } = renderFloor(123);
    expect(bbsrow(container).textContent).toBe("PU123 wowbenny: hi");
  });

  test("3 位數以上掛 floorBadge--wide（要補深色底壓住標記字筆劃）", () => {
    const { container } = renderFloor(123);
    expect(
      container.querySelector("[data-floor]").classList.contains("floorBadge--wide")
    ).toBe(true);
  });

  test("1~2 位數不掛 floorBadge--wide（仍落在空隙內，不需底色）", () => {
    for (const seq of [1, 99]) {
      const { container } = renderFloor(seq);
      const badge = container.querySelector("[data-floor]");
      expect(badge.classList.contains("floorBadge")).toBe(true);
      expect(badge.classList.contains("floorBadge--wide")).toBe(false);
    }
  });
});

describe("Row blacklistNotice (原生列表黑名單通知列)", () => {
  test("blacklistNotice → 內容即通知字串（含 bbsline 結構）、不走原始 char cells", () => {
    const notice = "  62349 + 6 7/09 -            □ （本文已被黑名單） someone";
    const { container } = render(
      <Row
        chars={chars("PU baduser: spam")}
        row={7}
        forceWidth={20}
        blacklistNotice={notice}
      />
    );
    const row = bbsrow(container);
    expect(row).not.toBeNull();
    expect(row.textContent).toBe(notice);
    // 有 bbsline 結構（供選取/getText 對齊），非原始 char cells
    expect(container.querySelector('[data-type="bbsline"]')).not.toBeNull();
    // 原始 chars 內容（baduser: spam）不得外洩
    expect(row.textContent).not.toContain("baduser");
  });

  test("無 blacklistNotice → 照常走 char-span 渲染", () => {
    const { container } = render(
      <Row chars={chars("PU wowbenny: hi")} row={0} />
    );
    expect(bbsrow(container).textContent).toBe("PU wowbenny: hi");
  });
});
