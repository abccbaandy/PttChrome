jest.mock("../../src/js/pref_storage", () => ({
  readValuesWithDefault: jest.fn(() => ({ enableEasyReading: true }))
}));

// The settle-recovery path (_onScreenSettled / _computeRowState / _currentPageSignature)
// runs the four string_util parsers on getRowText output. Mock them so these wiring
// tests control isStatusRow / the page signature directly — parser correctness has its
// own tests (string_util / comment_parse). The pure nextEasyReading* functions below
// take booleans and never touch string_util, so the mock does not affect them.
jest.mock("../../src/js/string_util", () => ({
  parseStatusRow: jest.fn(),
  parseReplyText: jest.fn(() => false),
  parsePushInitText: jest.fn(() => false),
  parseReqNotMetText: jest.fn(() => false)
}));

import {
  nextEasyReadingState,
  nextEasyReadingRowState,
  functionModeExitDecision,
  EasyReading
} from "../../src/js/easy_reading";
import { readValuesWithDefault } from "../../src/js/pref_storage";
import {
  parseStatusRow,
  parseReplyText,
  parsePushInitText,
  parseReqNotMetText
} from "../../src/js/string_util";

// nextEasyReadingState now decides auto-enable from term_buf's DEBOUNCED pageState
// stream (settledPageState / prevSettledPageState), evaluated once per settle edge
// by _onPageStateSettled — not per redraw frame. The transient-frame race that the
// old _cameFromList latch worked around is handled upstream by the settle debounce,
// so the check is the clean, edge-correct "settled into an article (3) from a
// list(2)/menu(1)". The menu(1) source covers 精華區 (essence) so that after the
// user switched to native at the bottom, the next 精華 article still re-engages.
describe("nextEasyReadingState", () => {
  const decide = (o = {}) => nextEasyReadingState({
    settledPageState: 3,
    prevSettledPageState: 2,
    enabled: false,
    enablePref: true,
    supported: true,
    ...o
  });

  it("enables on a settled list -> article edge (2 -> 3)", () => {
    expect(decide()).toBe(true);
  });

  // 精華區: top level settles to MENU(1), sub-folders to MENU(1) or LIST(2); opening
  // an article from there is a 1 -> 3 edge. Without this, easy reading stayed off
  // after switchToNativeAtBottom until the user backed out to a real board list (2).
  it("enables on a settled menu -> article edge (1 -> 3), covering 精華區", () => {
    expect(decide({ prevSettledPageState: 1 })).toBe(true);
  });

  it("does not enable from a non-list/menu previous state (pass/edit/normal)", () => {
    expect(decide({ prevSettledPageState: 0 })).toBe(false);
    expect(decide({ prevSettledPageState: 5 })).toBe(false);
    expect(decide({ prevSettledPageState: 6 })).toBe(false);
    expect(decide({ prevSettledPageState: 3 })).toBe(false);
  });

  it("does not enable unless the current settled state is an article (3)", () => {
    expect(decide({ settledPageState: 2 })).toBe(false);
  });

  it("does not re-enable when already enabled", () => {
    expect(decide({ enabled: true })).toBe(false);
  });

  it("never enables when the preference is off", () => {
    expect(decide({ enablePref: false })).toBe(false);
  });

  it("never enables when the connection does not support easy reading", () => {
    expect(decide({ supported: false })).toBe(false);
  });

  // Regression guard for switchToNativeAtBottom: after the user pressed End the post
  // stays on pageState 3, so settledPageState stays 3 (no new list/menu -> 3 edge). A
  // transient 0 -> 3 flicker never settles, so prevSettled stays 3 -> no re-enable.
  it("does not re-enable on an in-post flicker after manual native switch (settled stays 3)", () => {
    expect(decide({ settledPageState: 3, prevSettledPageState: 3 })).toBe(false);
  });
});

// nextEasyReadingRowState is the per-frame row-state machine extracted from
// _onChanged. The caller (EasyReading._onChanged) computes the parse booleans and
// applies the returned flags back onto term_buf. Defaults below describe an
// article-reading frame with the cursor parked on the bottom-right status row.
describe("nextEasyReadingRowState", () => {
  const rowInput = (o = {}) => ({
    pageState: 3,
    startedEasyReading: false,
    showReplyText: false,
    showPushInitText: false,
    reachedPageEnd: false,
    sendCommandAfterUpdate: "",
    ignoreOneUpdate: false,
    curX: 0,
    curY: 0,
    lastRowNum: 23,
    lastColNum: 79,
    isReqNotMetRow: false,
    isStatusRow: false,
    isPushInitRow: false,
    isReplyRow: false,
    lastRowFirstChFg: 7,
    lastRowFirstChBg: 0,
    ...o
  });

  it("marks startedEasyReading once on an article page (pageState 3)", () => {
    expect(nextEasyReadingRowState(rowInput({ pageState: 3 })).startedEasyReading).toBe(true);
  });

  it("clears easy-reading flags when leaving the article (not started, pageState != 3)", () => {
    const r = nextEasyReadingRowState(rowInput({ pageState: 0, startedEasyReading: false }));
    expect(r.startedEasyReading).toBe(false);
    expect(r.showReplyText).toBe(false);
    expect(r.showPushInitText).toBe(false);
  });

  it("keeps started + shows push-init when a 'request not met' row appears off-article", () => {
    const r = nextEasyReadingRowState(rowInput({
      pageState: 0, startedEasyReading: true, isReqNotMetRow: true, curY: 23, curX: 79
    }));
    expect(r.startedEasyReading).toBe(true);
    expect(r.showPushInitText).toBe(true);
  });

  it("sends a page-down on a status row that is not yet at the bottom", () => {
    const r = nextEasyReadingRowState(rowInput({
      startedEasyReading: true, curY: 23, curX: 79, isStatusRow: true,
      lastRowFirstChBg: 0, lastRowFirstChFg: 7
    }));
    expect(r.sendCommandAfterUpdate).toBe("\x1b[6~");
    expect(r.reachedPageEnd).toBe(false);
  });

  it("stops paging and marks page end on a bottom status row (bg 4 / fg 7)", () => {
    const r = nextEasyReadingRowState(rowInput({
      startedEasyReading: true, curY: 23, curX: 79, isStatusRow: true,
      lastRowFirstChBg: 4, lastRowFirstChFg: 7
    }));
    expect(r.reachedPageEnd).toBe(true);
    expect(r.sendCommandAfterUpdate).toBe("");
  });

  it("does not overwrite a queued command (skipOne) with a page-down", () => {
    const r = nextEasyReadingRowState(rowInput({
      startedEasyReading: true, curY: 23, curX: 79, isStatusRow: true,
      lastRowFirstChBg: 0, sendCommandAfterUpdate: "skipOne"
    }));
    expect(r.sendCommandAfterUpdate).toBe("skipOne");
  });

  it("consumes ignoreOneUpdate and halts without sending anything", () => {
    const r = nextEasyReadingRowState(rowInput({
      startedEasyReading: true, curY: 23, curX: 79, ignoreOneUpdate: true, isStatusRow: true
    }));
    expect(r.consumeIgnoreOneUpdate).toBe(true);
    expect(r.halt).toBe(true);
    expect(r.sendCommandAfterUpdate).toBe("");
  });

  it("overrides pageState to 5 (pass screen) on a non-status bottom row", () => {
    const r = nextEasyReadingRowState(rowInput({
      startedEasyReading: true, curY: 23, curX: 79, isStatusRow: false, showPushInitText: false
    }));
    expect(r.pageStateOverride).toBe(5);
    expect(r.startedEasyReading).toBe(false);
  });

  it("shows push-init text when the cursor sits on a push-init last row", () => {
    const r = nextEasyReadingRowState(rowInput({
      startedEasyReading: true, curY: 23, curX: 10, isPushInitRow: true, showPushInitText: false
    }));
    expect(r.showPushInitText).toBe(true);
    expect(r.halt).toBe(false);
  });

  it("halts on a last row that is neither status nor push-init", () => {
    const r = nextEasyReadingRowState(rowInput({
      startedEasyReading: true, curY: 23, curX: 10, isPushInitRow: false, showPushInitText: false
    }));
    expect(r.halt).toBe(true);
    expect(r.showPushInitText).toBe(false);
  });

  it("shows reply text when the cursor sits on a reply row (row 22)", () => {
    const r = nextEasyReadingRowState(rowInput({
      startedEasyReading: true, curY: 22, curX: 5, isReplyRow: true
    }));
    expect(r.showReplyText).toBe(true);
    expect(r.halt).toBe(false);
  });

  it("halts on row 22 when it is not a reply row", () => {
    const r = nextEasyReadingRowState(rowInput({
      startedEasyReading: true, curY: 22, isReplyRow: false
    }));
    expect(r.halt).toBe(true);
    expect(r.showReplyText).toBe(false);
  });

  it("halts when the cursor is on an unchanged interior line", () => {
    const r = nextEasyReadingRowState(rowInput({ startedEasyReading: true, curY: 5 }));
    expect(r.halt).toBe(true);
  });
});

// functionModeExitDecision drives leaving functionMode (native-LIVE mirroring) on each
// settle. While functionMode is on, the user is interacting with a native PTT prompt /
// menu / editor opened from inside the article (r 回應、X/% 推文、y 收暫存檔…); we mirror
// whatever PTT draws verbatim and decide here when to stop.
describe("functionModeExitDecision", () => {
  it("resumes when back on a clean article page (status row + cursor parked on it)", () => {
    expect(functionModeExitDecision({
      pageState: 3, isStatusRow: true, curY: 23, lastRowNum: 23
    })).toBe("resume");
  });

  it("stays while the reply menu is up (status on row 23 but cursor on the menu row 22)", () => {
    expect(functionModeExitDecision({
      pageState: 3, isStatusRow: true, curY: 22, lastRowNum: 23
    })).toBe("stay");
  });

  it("stays on an editor / pass screen (pageState 6/5/0), not a list or menu", () => {
    expect(functionModeExitDecision({ pageState: 6, isStatusRow: false, curY: 0, lastRowNum: 23 })).toBe("stay");
    expect(functionModeExitDecision({ pageState: 5, isStatusRow: false, curY: 0, lastRowNum: 23 })).toBe("stay");
    expect(functionModeExitDecision({ pageState: 0, isStatusRow: false, curY: 0, lastRowNum: 23 })).toBe("stay");
  });

  it("leaves when the screen settled into a board list (2) or menu (1)", () => {
    expect(functionModeExitDecision({ pageState: 2, isStatusRow: false, curY: 23, lastRowNum: 23 })).toBe("leave");
    expect(functionModeExitDecision({ pageState: 1, isStatusRow: false, curY: 0, lastRowNum: 23 })).toBe("leave");
  });

  it("does not resume on a pageState-3 frame whose last row is not a status row", () => {
    expect(functionModeExitDecision({
      pageState: 3, isStatusRow: false, curY: 23, lastRowNum: 23
    })).toBe("stay");
  });
});

// leaveCurrentPost stays in easy reading (does not touch _enabled) and only resets
// per-post render state. It no longer clears a latch (auto re-enable is now
// edge-triggered on the settle stream), but it still zeroes prevPageState so the next
// article renders via accumulatePageLines' "new article" branch.
describe("EasyReading.leaveCurrentPost", () => {
  const makeER = () => {
    const termBuf = { addEventListener() {}, prevPageState: 0, pageState: 0 };
    return new EasyReading(/* core */ {}, /* view */ {}, termBuf);
  };

  it("resets prevPageState to 0", () => {
    const er = makeER();
    er._termBuf.prevPageState = 3;
    er.leaveCurrentPost();
    expect(er._termBuf.prevPageState).toBe(0);
  });
});

// Wiring guard for the 精華區 fix. The pure nextEasyReadingState case above proves
// the DECISION (1 -> 3 enables); this proves the PLUMBING: _onPageStateSettled must
// read the settle edge off term_buf, feed it through nextEasyReadingState (with the
// live pref + connection support), and actually call enterEasyReading. A refactor
// could keep the pure function correct yet break this hop (e.g. re-inline the old
// `=== 2` check, drop the pref/supported lookup), silently regressing 精華區 — so
// guard the integration, not just the predicate.
describe("EasyReading._onPageStateSettled", () => {
  const makeER = ({ settled, prevSettled, enabled = false, supported = true } = {}) => {
    const termBuf = {
      addEventListener() {},
      settledPageState: settled,
      prevSettledPageState: prevSettled,
      startedEasyReading: false,
      easyReadingShowReplyText: false,
      easyReadingShowPushInitText: false
    };
    const view = { useEasyReadingMode: enabled };
    const core = { connectedUrl: { easyReadingSupported: supported } };
    const er = new EasyReading(core, view, termBuf);
    er.enterEasyReading = jest.fn(); // stub the side-effecting entry point
    return er;
  };

  beforeEach(() => {
    readValuesWithDefault.mockReturnValue({ enableEasyReading: true });
  });

  it("enters easy reading on a settled menu -> article edge (1 -> 3), covering 精華區", () => {
    const er = makeER({ settled: 3, prevSettled: 1 });
    er._onPageStateSettled();
    expect(er.enterEasyReading).toHaveBeenCalledTimes(1);
  });

  it("enters easy reading on a settled list -> article edge (2 -> 3)", () => {
    const er = makeER({ settled: 3, prevSettled: 2 });
    er._onPageStateSettled();
    expect(er.enterEasyReading).toHaveBeenCalledTimes(1);
  });

  it("does not enter on an in-post flicker after manual native switch (3 -> 3)", () => {
    const er = makeER({ settled: 3, prevSettled: 3 });
    er._onPageStateSettled();
    expect(er.enterEasyReading).not.toHaveBeenCalled();
  });

  it("does not enter from a pass-screen edge (5 -> 3)", () => {
    const er = makeER({ settled: 3, prevSettled: 5 });
    er._onPageStateSettled();
    expect(er.enterEasyReading).not.toHaveBeenCalled();
  });

  it("does not enter when easy reading is already enabled", () => {
    const er = makeER({ settled: 3, prevSettled: 1, enabled: true });
    er._onPageStateSettled();
    expect(er.enterEasyReading).not.toHaveBeenCalled();
  });

  it("does not enter when the preference is off", () => {
    readValuesWithDefault.mockReturnValue({ enableEasyReading: false });
    const er = makeER({ settled: 3, prevSettled: 1 });
    er._onPageStateSettled();
    expect(er.enterEasyReading).not.toHaveBeenCalled();
  });

  it("does not enter when the connection does not support easy reading", () => {
    const er = makeER({ settled: 3, prevSettled: 1, supported: false });
    er._onPageStateSettled();
    expect(er.enterEasyReading).not.toHaveBeenCalled();
  });
});

// End-key behavior in easy reading is gated by the easyReadingEndSwitchNative pref
// and a configurable switch key. Two cases must hold:
//  - pref ON  + key matches  -> switchToNativeAtBottom(), preventDefault, stop early
//  - pref OFF (or key !=)     -> scroll the easy-reading view to the bottom and STAY
//    in easy reading (official-term behavior). Regression guard: a prior version let
//    End fall through to the native terminal, so the view never scrolled to the
//    article bottom when the pref was off.
describe("EasyReading._onKeyDownProcessUI End handling", () => {
  const makeER = (prefs) => {
    readValuesWithDefault.mockReturnValue(prefs);
    const termBuf = { addEventListener() {} };
    const mainDisplay = { scrollTop: 0, scrollHeight: 5000 };
    const er = new EasyReading(/* core */ {}, /* view */ { mainDisplay }, termBuf);
    er.switchToNativeAtBottom = jest.fn();
    return { er, mainDisplay };
  };
  const keyEvent = key => ({
    key, ctrlKey: false, altKey: false, preventDefault: jest.fn()
  });

  it("switches to native on End when the pref is on and key matches", () => {
    const { er, mainDisplay } = makeER({
      easyReadingEndSwitchNative: true, easyReadingEndSwitchKey: "End"
    });
    const e = keyEvent("End");
    er._onKeyDownProcessUI(e);
    expect(er.switchToNativeAtBottom).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(mainDisplay.scrollTop).toBe(0); // did not scroll; switched instead
  });

  it("scrolls to bottom (stays in easy reading) on End when the pref is off", () => {
    const { er, mainDisplay } = makeER({
      easyReadingEndSwitchNative: false, easyReadingEndSwitchKey: "End"
    });
    const e = keyEvent("End");
    er._onKeyDownProcessUI(e);
    expect(er.switchToNativeAtBottom).not.toHaveBeenCalled();
    expect(mainDisplay.scrollTop).toBe(mainDisplay.scrollHeight);
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it("scrolls to bottom on End when the configured switch key is something else", () => {
    const { er, mainDisplay } = makeER({
      easyReadingEndSwitchNative: true, easyReadingEndSwitchKey: "q"
    });
    const e = keyEvent("End");
    er._onKeyDownProcessUI(e);
    expect(er.switchToNativeAtBottom).not.toHaveBeenCalled();
    expect(mainDisplay.scrollTop).toBe(mainDisplay.scrollHeight);
  });

  it("$ / G still switch to native when the pref is on (fixed vi aliases)", () => {
    for (const key of ["$", "G"]) {
      const { er } = makeER({
        easyReadingEndSwitchNative: true, easyReadingEndSwitchKey: "End"
      });
      er._onKeyDownProcessUI(keyEvent(key));
      expect(er.switchToNativeAtBottom).toHaveBeenCalledTimes(1);
    }
  });

  it("$ / G scroll to bottom (stay in easy reading) when the pref is off", () => {
    for (const key of ["$", "G"]) {
      const { er, mainDisplay } = makeER({
        easyReadingEndSwitchNative: false, easyReadingEndSwitchKey: "End"
      });
      er._onKeyDownProcessUI(keyEvent(key));
      expect(er.switchToNativeAtBottom).not.toHaveBeenCalled();
      expect(mainDisplay.scrollTop).toBe(mainDisplay.scrollHeight);
    }
  });
});

// Settle-driven page-down recovery (the truncated-pushes fix). The per-frame loop
// (_onChanged/_onViewUpdated) only fires on content ('changed') frames, but PTT parks
// the cursor on the bottom status row in a SEPARATE cursor-only ('posChanged') frame
// that can land on its own — so on a heavy first article the deciding frame is missed,
// no further PageDown is queued, and the accumulated page is truncated. 'screenSettled'
// fires once the screen is truly quiet (content AND cursor stopped); _onScreenSettled
// re-runs the SAME pure decision and re-sends the missed PageDown, deduped by the page
// signature so a slow PTT response cannot double-send (which would skip a page). The
// decision itself is covered by nextEasyReadingRowState above; this guards the PLUMBING.
describe("EasyReading._onScreenSettled", () => {
  const makeER = ({
    enabled = true,
    pageState = 3,
    sendCommandAfterUpdate = "",
    reachedPageEnd = false,
    curX = 79,
    curY = 23,
    lastRowFirstChBg = 0,
    lastRowFirstChFg = 7,
    lastPagedSig = null
  } = {}) => {
    const lastRowNum = 23;
    const lastChar = { getFg: () => lastRowFirstChFg, getBg: () => lastRowFirstChBg };
    const termBuf = {
      addEventListener() {},
      cols: 80,
      rows: 24,
      cur_x: curX,
      cur_y: curY,
      pageState,
      prevPageState: 0,
      lines: { [lastRowNum]: [lastChar] },
      getRowText: () => "status-row-text",
      startedEasyReading: true,
      easyReadingShowReplyText: false,
      easyReadingShowPushInitText: false
    };
    const view = { useEasyReadingMode: enabled };
    const er = new EasyReading(/* core */ {}, view, termBuf);
    er._send = jest.fn(); // stub the network send
    er.easyReadingReachedPageEnd = reachedPageEnd;
    er.sendCommandAfterUpdate = sendCommandAfterUpdate;
    er._lastPagedDownSignature = lastPagedSig;
    return er;
  };

  beforeEach(() => {
    // Default: a non-bottom status row showing "第 1~23 行".
    parseStatusRow.mockReturnValue({ pagePercent: 33, rowIndexStart: 1, rowIndexEnd: 23 });
    parseReplyText.mockReturnValue(false);
    parsePushInitText.mockReturnValue(false);
    parseReqNotMetText.mockReturnValue(false);
  });

  it("re-sends the missed page-down on a settled non-bottom status row", () => {
    const er = makeER();
    er._onScreenSettled();
    expect(er._send).toHaveBeenCalledTimes(1);
    expect(er._send).toHaveBeenCalledWith("\x1b[6~");
    expect(er._lastPagedDownSignature).toBe("1~23"); // records the page it paged from
  });

  it("does not double-send when this exact page was already paged down (signature match)", () => {
    const er = makeER({ lastPagedSig: "1~23" });
    er._onScreenSettled();
    expect(er._send).not.toHaveBeenCalled();
  });

  it("does not send on the bottom 100% status row, and marks page end", () => {
    const er = makeER({ lastRowFirstChBg: 4, lastRowFirstChFg: 7 });
    er._onScreenSettled();
    expect(er._send).not.toHaveBeenCalled();
    expect(er.easyReadingReachedPageEnd).toBe(true);
  });

  it("does not send once page end has already been reached", () => {
    const er = makeER({ reachedPageEnd: true });
    er._onScreenSettled();
    expect(er._send).not.toHaveBeenCalled();
  });

  it("does not send while a command is already in flight (lets the frame loop drive)", () => {
    const er = makeER({ sendCommandAfterUpdate: "\x1b[6~" });
    er._onScreenSettled();
    expect(er._send).not.toHaveBeenCalled();
  });

  it("does not send when not on an article page (pageState != 3)", () => {
    const er = makeER({ pageState: 2 });
    er._onScreenSettled();
    expect(er._send).not.toHaveBeenCalled();
  });

  it("does not send when easy reading is disabled", () => {
    const er = makeER({ enabled: false });
    er._onScreenSettled();
    expect(er._send).not.toHaveBeenCalled();
  });
});
