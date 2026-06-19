// Unit guard for TermView.hideEasyReadingOverlays (src/js/term_view.js).
// Returning to the board list while easy reading is still enabled must clear the
// bottom padding added for the footer overlay AND reset scrollTop — otherwise the
// list stays scrolled up ~one row while the absolutely-positioned #cursor does not,
// so the cursor sits a row below the highlighted line. The reset is plain DOM-prop
// assignment, so we drive the real method on a minimal stub view (no jsdom needed).

import { TermView } from "../../src/js/term_view";

test("hideEasyReadingOverlays clears overlays, bottom padding, scrollTop and pageLines", () => {
  const view = {
    lastRowDiv: { style: { display: "block" } },
    replyRowDiv: { style: { display: "block" } },
    mainContainer: { style: { paddingBottom: "1em" } },
    mainDisplay: { scrollTop: 50 },
    buf: { pageLines: [["row"], ["row"]] }
  };

  TermView.prototype.hideEasyReadingOverlays.call(view);

  expect(view.lastRowDiv.style.display).toBe("");
  expect(view.replyRowDiv.style.display).toBe("");
  expect(view.mainContainer.style.paddingBottom).toBe("");
  expect(view.mainDisplay.scrollTop).toBe(0);
  expect(view.buf.pageLines).toEqual([]);
});
