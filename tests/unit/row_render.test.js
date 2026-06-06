// Rendering test for the same-author / pusher highlight on a comment <Row>.
// Uses react-test-renderer (no DOM/network). Fake TermChar cells are ASCII-only so
// the DBCS path (which needs window.lib Big5 tables) is never exercised.
//
// The marker (推/噓/→) is a 2-col DBCS char in reality; here two placeholder ASCII
// cells stand in for cols 0-1 so the column math (user id at col 3) still holds.

import renderer from "react-test-renderer";
import Row from "../../src/components/Row";

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
