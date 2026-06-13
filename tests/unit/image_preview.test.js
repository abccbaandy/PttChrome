// Rendering test for inline image preview wiring (the "自動開圖" feature). In easy
// reading the article page is drawn via <Screen enableLinkInlinePreview> → <Row> →
// LinkSegmentBuilder, which pushes an <ImagePreviewer component={Inline}> next to
// every hyperlink. A regression where term_view passed enableLinkInlinePreview=false
// silently dropped all inline images, so this guards the Screen→Row→builder path.
//
// react-test-renderer (no DOM/network): for a plain image URL the resolver chain is
// Promise.resolve({type:"image"}) — no fetch / new Image() — and resolves in a
// microtask AFTER the synchronous create()/assert, so the ImagePreviewer is created
// at render time regardless. We assert on the component instance count, not markup.

import renderer from "react-test-renderer";
import Screen from "../../src/components/Screen";
import Row from "../../src/components/Row";
import ImagePreviewer from "../../src/components/ImagePreviewer";

const COLOR = {
  fg: 7,
  bg: 0,
  blink: false,
  equals(o) {
    return o === this;
  }
};

// A row of cells spelling out a single hyperlink: first cell is start-of-URL, last
// is end-of-URL, getFullURL returns the whole link (how TermBuf marks URL runs).
function urlRow(url) {
  return url.split("").map((c, i) => ({
    ch: c,
    isLeadByte: false,
    isStartOfURL: () => i === 0,
    isEndOfURL: () => i === url.length - 1,
    getFullURL: () => url,
    getColor: () => COLOR
  }));
}

const IMG_URL = "http://example.com/a.jpg";

function countPreviews(element) {
  return renderer.create(element).root.findAllByType(ImagePreviewer).length;
}

describe("inline image preview wiring", () => {
  test("Row with enableLinkInlinePreview=true → one inline ImagePreviewer per link", () => {
    expect(
      countPreviews(<Row chars={urlRow(IMG_URL)} row={0} enableLinkInlinePreview={true} />)
    ).toBe(1);
  });

  test("Row with enableLinkInlinePreview=false → no inline preview", () => {
    expect(
      countPreviews(<Row chars={urlRow(IMG_URL)} row={0} enableLinkInlinePreview={false} />)
    ).toBe(0);
  });

  // Screen is the single render path both modes use; verify it forwards the flag to
  // Row (this is exactly the wiring the easy-reading regression broke upstream).
  test("Screen forwards enableLinkInlinePreview to its rows", () => {
    expect(
      countPreviews(
        <Screen
          lines={[urlRow(IMG_URL)]}
          forceWidth={20}
          enableLinkInlinePreview={true}
          enableLinkHoverPreview={false}
        />
      )
    ).toBe(1);
    expect(
      countPreviews(
        <Screen
          lines={[urlRow(IMG_URL)]}
          forceWidth={20}
          enableLinkInlinePreview={false}
          enableLinkHoverPreview={false}
        />
      )
    ).toBe(0);
  });
});
