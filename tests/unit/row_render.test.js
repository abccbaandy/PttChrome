// Rendering test for the same-author / pusher highlight on a comment <Row>.
// Uses react-test-renderer (no DOM/network). Fake TermChar cells are ASCII-only so
// the DBCS path (which needs window.lib Big5 tables) is never exercised.
//
// The marker (推/噓/→) is a 2-col DBCS char in reality; here two placeholder ASCII
// cells stand in for cols 0-1 so the column math (user id at col 3) still holds.

import renderer from "react-test-renderer";
import Row from "../../src/components/Row";
import ImagePreviewer from "../../src/components/ImagePreviewer";

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

// Depth-first search over react-test-renderer's toJSON() tree.
function findByClass(node, className) {
  if (!node || typeof node === "string") return null;
  if (node.props && node.props.className === className) return node;
  for (const child of node.children || []) {
    const found = findByClass(child, className);
    if (found) return found;
  }
  return null;
}

function textOf(node) {
  if (node == null) return "";
  if (typeof node === "string") return node;
  return (node.children || []).map(textOf).join("");
}

describe("Row same-author highlight", () => {
  test("commentByAuthor wraps exactly the user id columns", () => {
    const json = renderer
      .create(
        <Row
          chars={chars("PU wowbenny: hi")}
          row={0}
          authorIdStart={3}
          authorIdEnd={11}
        />
      )
      .toJSON();
    const authorSpan = findByClass(json, "commentByAuthor");
    expect(authorSpan).not.toBeNull();
    expect(textOf(authorSpan)).toBe("wowbenny"); // not "PU ", not the content
  });

  test("no author range → no commentByAuthor span", () => {
    const json = renderer
      .create(<Row chars={chars("PU wowbenny: hi")} row={0} />)
      .toJSON();
    expect(findByClass(json, "commentByAuthor")).toBeNull();
  });
});

describe("Row pusher highlight", () => {
  test("pusherHighlight → whole-row class + data-pusher on the bbsrow", () => {
    const json = renderer
      .create(
        <Row
          chars={chars("PU wowbenny: hi")}
          row={0}
          pusher="wowbenny"
          pusherHighlight={true}
        />
      )
      .toJSON();
    // Outer node is the bbsrow span.
    expect(json.props.className).toBe("pusherHighlight");
    expect(json.props["data-pusher"]).toBe("wowbenny");
  });

  test("data-pusher present but not highlighted when not selected", () => {
    const json = renderer
      .create(<Row chars={chars("PU wowbenny: hi")} row={0} pusher="wowbenny" />)
      .toJSON();
    expect(json.props["data-pusher"]).toBe("wowbenny");
    expect(json.props.className).toBeUndefined();
  });
});

// Regression: a row re-render (e.g. on pusherHighlight toggle) must reuse the
// same preview request Promise for an unchanged href. A fresh Promise each
// render would reset ImagePreviewer (PureComponent) state to undefined and
// remount the media element — reloading YouTube iframes and flashing them.
describe("Row inline preview request identity", () => {
  test("same href → referentially stable request prop across renders", () => {
    const url = "https://youtu.be/aYIdRD_Gvz0";
    const make = () =>
      renderer.create(
        <Row chars={urlChars(url)} row={0} enableLinkInlinePreview={true} />
      );
    const reqA = make().root.findByType(ImagePreviewer).props.request;
    const reqB = make().root.findByType(ImagePreviewer).props.request;
    expect(reqA).toBe(reqB);
  });
});

// Auto-fixed URL line (src/js/url_fix.js detects; LinkSegmentBuilder renders below).
describe("Row fixed-URL line", () => {
  const fixed = "https://www.google.com/";

  test("easy-reading (inline preview) → renders a clickable .fixedUrlLine", () => {
    const json = renderer
      .create(
        <Row
          chars={chars("broken url above")}
          row={0}
          enableLinkInlinePreview={true}
          fixedUrls={[{ original: "www . google .com/", fixed }]}
        />
      )
      .toJSON();
    const line = findByClass(json, "fixedUrlLine");
    expect(line).not.toBeNull();
    expect(textOf(line)).toContain(fixed);
  });

  test("native grid (no inline preview) → fixed-URL line is NOT rendered", () => {
    const json = renderer
      .create(
        <Row
          chars={chars("broken url above")}
          row={0}
          fixedUrls={[{ original: "www . google .com/", fixed }]}
        />
      )
      .toJSON();
    expect(findByClass(json, "fixedUrlLine")).toBeNull();
  });
});
