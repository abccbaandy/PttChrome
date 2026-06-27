// Rendering test for inline image preview wiring (the "自動開圖" feature). In easy
// reading the article page is drawn via <Screen enableLinkInlinePreview> → <Row> →
// LinkSegmentBuilder, which pushes an <ImagePreviewer component={Inline}> next to
// every hyperlink. A regression where term_view passed enableLinkInlinePreview=false
// silently dropped all inline images, so this guards the Screen→Row→builder path.
//
// @testing-library/react under jsdom (no network): for a plain image URL the
// resolver chain is Promise.resolve({type:"image"}) — no fetch / new Image() — and
// resolves in a microtask AFTER the synchronous render()/assert. So at assert time
// ImagePreviewer's value is still undefined → Inline renders <LoadingOverlay>
// (.previewLoading). We count those nodes: one per mounted inline ImagePreviewer.

import { render, act } from "@testing-library/react";
import Screen from "../../src/components/Screen";
import Row from "../../src/components/Row";

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

// Count the loading overlays present right after mount (one per inline
// ImagePreviewer), then let the resolver promise chain settle inside act() so the
// trailing async setState doesn't log a "not wrapped in act" warning. The overlay
// count is fixed at mount (value still undefined), so flushing doesn't change it.
async function countPreviews(element) {
  const { container } = render(element);
  const n = container.querySelectorAll(".previewLoading").length;
  // Drain the resolver promise chain (of → resolveSrcToImageUrl → handle*) across
  // a couple of macrotasks so the trailing async setState lands inside act().
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  return n;
}

describe("inline image preview wiring", () => {
  test("Row with enableLinkInlinePreview=true → one inline ImagePreviewer per link", async () => {
    expect(
      await countPreviews(<Row chars={urlRow(IMG_URL)} row={0} enableLinkInlinePreview={true} />)
    ).toBe(1);
  });

  test("Row with enableLinkInlinePreview=false → no inline preview", async () => {
    expect(
      await countPreviews(<Row chars={urlRow(IMG_URL)} row={0} enableLinkInlinePreview={false} />)
    ).toBe(0);
  });

  // Screen is the single render path both modes use; verify it forwards the flag to
  // Row (this is exactly the wiring the easy-reading regression broke upstream).
  test("Screen forwards enableLinkInlinePreview to its rows", async () => {
    expect(
      await countPreviews(
        <Screen
          lines={[urlRow(IMG_URL)]}
          forceWidth={20}
          enableLinkInlinePreview={true}
          enableLinkHoverPreview={false}
        />
      )
    ).toBe(1);
    expect(
      await countPreviews(
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
