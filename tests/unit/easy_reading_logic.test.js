vi.mock("../../src/js/pref_storage", () => ({
  readValuesWithDefault: vi.fn(() => ({ enableEasyReading: true }))
}));

// The settle-recovery path (_onScreenSettled / _computeRowState / _currentPageSignature)
// runs the four string_util parsers on getRowText output. Mock them so these wiring
// tests control isStatusRow / the page signature directly — parser correctness has its
// own tests (string_util / comment_parse). The pure nextEasyReading* functions below
// take booleans and never touch string_util, so the mock does not affect them.
vi.mock("../../src/js/string_util", () => ({
  parseStatusRow: vi.fn(),
  parseReplyText: vi.fn(() => false),
  parsePushInitText: vi.fn(() => false),
  parseReqNotMetText: vi.fn(() => false)
}));

import {
  nextEasyReadingState,
  nextEasyReadingRowState,
  nextPageDownDecision,
  PAGE_DOWN_MAX_RETRIES,
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

  // pmore footer 第一段的三種配色（mbbsd/pmore.c#mf_display_footer 依
  // mf_viewedAll()/mf_viewedNone() 選，pttbbs @ c1ff72df）。只有 VIEWALL
  // 代表「整篇看完」，另兩種都必須繼續往下翻——否則好讀模式會在第一頁
  // 或中間頁就停住。
  it("pmore FOOTER1 配色：只有 VIEWALL(37;44) 算看完", () => {
    const at = (bg, fg) => nextEasyReadingRowState(rowInput({
      startedEasyReading: true, curY: 23, curX: 79, isStatusRow: true,
      lastRowFirstChBg: bg, lastRowFirstChFg: fg
    }));
    // PMORE_COLOR_FOOTER1_VIEWALL  ANSI_COLOR(37;44) → fg 7 / bg 4
    expect(at(4, 7).reachedPageEnd).toBe(true);
    // PMORE_COLOR_FOOTER1_VIEWNONE ANSI_COLOR(33;45) → fg 3 / bg 5
    expect(at(5, 3).reachedPageEnd).toBe(false);
    // PMORE_COLOR_FOOTER1          ANSI_COLOR(34;46) → fg 4 / bg 6
    expect(at(6, 4).reachedPageEnd).toBe(false);
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
    er.enterEasyReading = vi.fn(); // stub the side-effecting entry point
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
    er.switchToNativeAtBottom = vi.fn();
    return { er, mainDisplay };
  };
  const keyEvent = key => ({
    key, ctrlKey: false, altKey: false, preventDefault: vi.fn()
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

  // pmore function keys (說明/選單/搜尋/指定頁/左右捲…) used to be swallowed by an
  // upstream pre-functionMode "123456789hops;,./\H#OP:<>" list (preventDefault → no-op,
  // 說明(h) etc. dead in easy reading). That list is removed: they now fall through to
  // functionMode like r/X/%/y, so PTT draws the native menu/help and we mirror it LIVE.
  // Guard: each enters functionMode and is NOT preventDefault'd (the key must reach PTT).
  it("pmore function keys enter functionMode and reach PTT (no preventDefault)", () => {
    for (const key of ["h", "H", "o", "p", "\\", "/", ";", ":", "#", "s", "1", "9", ",", ".", "<", ">"]) {
      const { er } = makeER({
        easyReadingEndSwitchNative: true, easyReadingEndSwitchKey: "End"
      });
      er._enterFunctionMode = vi.fn();
      er.leaveCurrentPost = vi.fn();
      const e = keyEvent(key);
      er._onKeyDownProcessUI(e);
      expect(er._enterFunctionMode).toHaveBeenCalledTimes(1);
      expect(er.leaveCurrentPost).not.toHaveBeenCalled();
      expect(e.preventDefault).not.toHaveBeenCalled();
    }
  });

  // Leave-post keys (next/prev article, same-thread, same-author) stay on the OTHER
  // branch: they navigate out of the post (leaveCurrentPost) and must NOT enter
  // functionMode. Guards the two key classes don't get crossed.
  it("article-navigation keys leave the post, not functionMode", () => {
    for (const key of ["a", "b", "f", "[", "]", "=", "A", "B", "F"]) {
      const { er } = makeER({
        easyReadingEndSwitchNative: true, easyReadingEndSwitchKey: "End"
      });
      er._enterFunctionMode = vi.fn();
      er.leaveCurrentPost = vi.fn();
      er._onKeyDownProcessUI(keyEvent(key));
      expect(er.leaveCurrentPost).toHaveBeenCalledTimes(1);
      expect(er._enterFunctionMode).not.toHaveBeenCalled();
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
const makeER = ({
  enabled = true,
  pageState = 3,
  sendCommandAfterUpdate = "",
  reachedPageEnd = false,
  curX = 79,
  curY = 23,
  lastRowFirstChBg = 0,
  lastRowFirstChFg = 7,
  lastPagedSig = null,
  pageDownRetries = 0,
  // 目前这一页**已经累积过**（正常情形：完整回应帧进过 redraw）。设成别的值就会
  // 走「这次回应从没进过 redraw」的补画分支（见下方专测）。
  accSig = "1~23"
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
    settledPageState: pageState,
    prevSettledPageState: pageState,
    lines: { [lastRowNum]: [lastChar] },
    lineChangeds: { fill: vi.fn() },
    notify: vi.fn(),
    getRowText: () => "status-row-text",
    startedEasyReading: true,
    easyReadingShowReplyText: false,
    easyReadingShowPushInitText: false
  };
  const view = { useEasyReadingMode: enabled, _lastAccumulatedSig: accSig };
  const core = { connectedUrl: { easyReadingSupported: true } };
  const er = new EasyReading(core, view, termBuf);
  er._send = vi.fn(); // stub the network send
  er.easyReadingReachedPageEnd = reachedPageEnd;
  er.sendCommandAfterUpdate = sendCommandAfterUpdate;
  er._inFlightSig = lastPagedSig;
  er._pageDownRetries = pageDownRetries;
  er._termBufMock = termBuf;
  return er;
};

// term_buf 只在 pageState 真的變動時才 dispatch 'pageStateSettled'，所以測試也照著
// 「先把 debounced 狀態推到新值再呼叫」來模擬一次 settle edge。
const settleEdge = (er, from, to) => {
  er._termBufMock.prevSettledPageState = from;
  er._termBufMock.settledPageState = to;
  er._termBufMock.pageState = to;
  er._onPageStateSettled();
};

describe("EasyReading._onScreenSettled", () => {
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
    expect(er._inFlightSig).toBe("1~23"); // 記下本頁為 in-flight
  });

  // 同一頁在 settle 時仍在 in-flight：畫面已靜止 SETTLE_MS ⇒ PTT 已 flush 並卡在
  // dogetch（沒有進行中的重繪會被 typeahead 吞），此時補送一次是安全的；但有上限，
  // 之後就放手不再送（見 nextPageDownDecision）。
  it("settle 時同一頁仍在 in-flight：補送一次後就不再送", () => {
    const er = makeER({ lastPagedSig: "1~23" });
    er._onScreenSettled();
    expect(er._send).toHaveBeenCalledTimes(1);
    er.sendCommandAfterUpdate = "";
    er._onScreenSettled();
    expect(er._send).toHaveBeenCalledTimes(1); // giveup，不再送
  });

  // P3：progress==100 ⟺ mf_viewedAll()（pmore.c#mf_display_footer 的整數除法），
  // 這是主判準；狀態列首格配色只是 pagePercent 拿不到時的 fallback。
  it("狀態列 100% → 不送並標記已到底（P3）", () => {
    parseStatusRow.mockReturnValue({ pagePercent: 100, rowIndexStart: 500, rowIndexEnd: 522 });
    const er = makeER({ accSig: "500~522" });
    er._onScreenSettled();
    expect(er._send).not.toHaveBeenCalled();
    expect(er.easyReadingReachedPageEnd).toBe(true);
  });

  it("拿不到 pagePercent 時退回配色判定（VIEWALL 37;44 → fg7/bg4）", () => {
    parseStatusRow.mockReturnValue({ rowIndexStart: 500, rowIndexEnd: 522 });
    const er = makeER({ accSig: "500~522", lastRowFirstChBg: 4, lastRowFirstChFg: 7 });
    er._onScreenSettled();
    expect(er._send).not.toHaveBeenCalled();
    expect(er.easyReadingReachedPageEnd).toBe(true);
  });

  // 「到底了」只認**當下狀態列**（pagePercent==100 ⟺ mf_viewedAll()，P3），不認
  // easyReadingReachedPageEnd 這個旗標——它會跨文章殘留（← 離開走 stopEasyReading，
  // 不經 leaveCurrentPost；好讀已開著時換文章也不走 enterEasyReading），一旦讓它有權
  // 否決 settle，下一篇文章的第一個 PageDown 就永遠送不出去（卡在第一頁）。
  it("狀態列已 100% → settle 不再送（唯一的停止判準）", () => {
    parseStatusRow.mockReturnValue({ pagePercent: 100, rowIndexStart: 500, rowIndexEnd: 522 });
    const er = makeER({ reachedPageEnd: true, accSig: "500~522" });
    er._onScreenSettled();
    expect(er._send).not.toHaveBeenCalled();
  });

  it("旗標殘留為 true 但狀態列還沒到底 → 照樣送（旗標不得否決 settle）", () => {
    const er = makeER({ reachedPageEnd: true });
    er._onScreenSettled();
    expect(er._send).toHaveBeenCalledWith("\x1b[6~");
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

  // 回应的游标 park 落在 cursor-only 的 notify 视窗时，notify 只走 posChanged 分支、
  // 不呼叫 view.update() ⇒ 那一页从没进过 redraw/accumulate。画面已静止且游标已 park，
  // 这里补一次完整重绘把它累积进去。
  // **必须走 term_buf.notify()**（_forceRepaint）而不是直接 view.redraw()：notify 才会
  // 跑 updateCharAttr()，那是 Big5 lead byte 标上 isLeadByte 的地方；少了它，clone 进
  // pageLines 的列 rowToText 会得到未转码的原始 Big5，下一页比对不上 → 重叠算成 0 →
  // 重叠列被 append 两次（离线拆帧测试抓到的重复「※ 文章網址」）。
  it("本页尚未累积过 → 走 notify 补一次完整重绘（不可绕过 updateCharAttr）", () => {
    const er = makeER({ accSig: "第一页的旧签章" });
    er._onScreenSettled();
    expect(er._termBufMock.lineChangeds.fill).toHaveBeenCalledWith(true);
    expect(er._termBufMock.notify).toHaveBeenCalledTimes(1);
    // 补画会重播 change/viewUpdate，快路径已经做过翻页决策，settle 不再自行送键。
    expect(er._send).not.toHaveBeenCalled();
  });

  it("本页已累积过 → 不重复补画", () => {
    const er = makeER();
    er._onScreenSettled();
    expect(er._termBufMock.notify).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 跨文章重置（回歸守護：7fdd90a 之後「進文章卡在第一頁、換一篇還是卡」）
//
// 自動翻頁的 per-article 狀態（_inFlightSig / _pageDownRetries / _healedOnce /
// easyReadingReachedPageEnd）以前只在 enterEasyReading / leaveCurrentPost 重置，
// 但這兩條**都不涵蓋最常見的換文章路徑**：
//   - ← 離開文章走 stopEasyReading()，不經 leaveCurrentPost()；
//   - 好讀已經開著時再進下一篇，nextEasyReadingState 要求 !enabled ⇒ 不走 enterEasyReading()。
// 於是上一篇的殘留跟著使用者到下一篇：
//   (1) 上一篇讀到底 ⇒ easyReadingReachedPageEnd 殘留 true ⇒ _onScreenSettled 早退；
//   (2) 上一篇卡在 giveup ⇒ _inFlightSig 殘留 "1~22"，而**每篇文章第一頁的簽章都是
//       "1~22"**（sig 不跨文章唯一）⇒ 下一篇被誤判成「同一頁還在途」。
// 兩者都讓第一個 PageDown 永遠送不出去。重置改由 settle 過的 pageState 進出 3 的
// edge 驅動（_onPageStateSettled），與使用者按了哪個鍵無關。
describe("跨文章重置（文章邊界 = settled pageState 進出 3）", () => {
  beforeEach(() => {
    parseStatusRow.mockReturnValue({ pagePercent: 14, rowIndexStart: 1, rowIndexEnd: 23 });
    parseReplyText.mockReturnValue(false);
    parsePushInitText.mockReturnValue(false);
    parseReqNotMetText.mockReturnValue(false);
  });

  it("上一篇讀到底（reachedPageEnd 殘留）→ 下一篇仍會自動翻頁", () => {
    const er = makeER({ reachedPageEnd: true, accSig: "1~23" });
    settleEdge(er, 3, 2);   // ← 回列表
    settleEdge(er, 2, 3);   // 進下一篇
    er._onScreenSettled();
    expect(er._send).toHaveBeenCalledWith("\x1b[6~");
  });

  it("上一篇卡在 giveup（_inFlightSig/retries 殘留）→ 下一篇仍會自動翻頁", () => {
    const er = makeER({
      lastPagedSig: "1~23",
      pageDownRetries: PAGE_DOWN_MAX_RETRIES,
      accSig: "1~23"
    });
    settleEdge(er, 3, 2);
    settleEdge(er, 2, 3);
    er._onScreenSettled();
    expect(er._send).toHaveBeenCalledWith("\x1b[6~");
  });

  it("進出文章的 edge 會清掉整組 per-article 狀態", () => {
    const er = makeER({ reachedPageEnd: true, lastPagedSig: "1~23", pageDownRetries: 1 });
    er._healedOnce = true;
    er.sendCommandAfterUpdate = "\x1b[6~";
    settleEdge(er, 3, 2);   // 離開文章
    expect(er._inFlightSig).toBe(null);
    expect(er._pageDownRetries).toBe(0);
    expect(er._healedOnce).toBe(false);
    expect(er.easyReadingReachedPageEnd).toBe(false);
    expect(er.sendCommandAfterUpdate).toBe("");
  });

  // 反向守護 P4：文章**中途**狀態列失配一幀而掉出 3 再回來，不是換文章，不可重置——
  // 清掉 _inFlightSig 會讓同一頁再送一次 PageDown，正是 7fdd90a 要防的重複送鍵。
  it("文章中途 3→0→3 的抖動不重置（否則會重複送 PageDown）", () => {
    const er = makeER({ lastPagedSig: "1~23", pageDownRetries: 1 });
    settleEdge(er, 3, 0);
    settleEdge(er, 0, 3);
    expect(er._inFlightSig).toBe("1~23");
    expect(er._pageDownRetries).toBe(1);
  });

  // 不經列表的文章→文章（[ ] 同標題跳、a/b/f/=/+/-）沒有 1/2 的 settle edge，
  // 靠 leaveCurrentPost() 補上——它以前漏了 easyReadingReachedPageEnd。
  it("leaveCurrentPost 也清掉整組 per-article 狀態", () => {
    const er = makeER({ reachedPageEnd: true, lastPagedSig: "1~23", pageDownRetries: 1 });
    er._healedOnce = true;
    er.leaveCurrentPost();
    expect(er._inFlightSig).toBe(null);
    expect(er._pageDownRetries).toBe(0);
    expect(er._healedOnce).toBe(false);
    expect(er.easyReadingReachedPageEnd).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PgDn 自救：累積頁捲不動又還沒到底時，把翻頁交易踢回去。
// 使用者實際看到的症狀就是「PgDn 沒反應」——累積頁停在第一頁，_scrollBy 捲不動，
// 而原本這個 case 什麼都不做。到底的文章（100%）仍然不送鍵。
describe("PageDown 在累積頁底部的自救", () => {
  beforeEach(() => {
    parseReplyText.mockReturnValue(false);
    parsePushInitText.mockReturnValue(false);
    parseReqNotMetText.mockReturnValue(false);
  });

  const press = (er) => {
    const e = { key: "PageDown", ctrlKey: false, altKey: false, preventDefault: vi.fn() };
    er._onKeyDownProcessUI(e);
    return e;
  };

  it("捲不動且還沒到底 → 補送 PageDown（並清掉卡住的 in-flight）", () => {
    parseStatusRow.mockReturnValue({ pagePercent: 14, rowIndexStart: 1, rowIndexEnd: 23 });
    const er = makeER({ lastPagedSig: "1~23", pageDownRetries: PAGE_DOWN_MAX_RETRIES });
    er._scrollBy = vi.fn(() => false);
    press(er);
    expect(er._send).toHaveBeenCalledWith("\x1b[6~");
  });

  it("捲不動但已到底（100%）→ 不送鍵", () => {
    parseStatusRow.mockReturnValue({ pagePercent: 100, rowIndexStart: 500, rowIndexEnd: 522 });
    const er = makeER();
    er._scrollBy = vi.fn(() => false);
    press(er);
    expect(er._send).not.toHaveBeenCalled();
  });

  it("還捲得動 → 只捲動，不送鍵", () => {
    parseStatusRow.mockReturnValue({ pagePercent: 14, rowIndexStart: 1, rowIndexEnd: 23 });
    const er = makeER();
    er._scrollBy = vi.fn(() => true);
    press(er);
    expect(er._send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// nextPageDownDecision — 自動翻頁的單一 in-flight 交易決策（pmore 不變量 P3/P4/P6，
// docs/pttbbs-screen-protocol.md §13）。
//
// P4：pfterm.c#refresh 在 client 還有按鍵在途時直接 return 不畫 ⇒ **同時兩個
// PageDown 在途，中間那頁的畫面永遠不會送出來**，該頁文字永久消失（正是「※ 發信站/
// ※ 文章網址 那段不見」的成因）。所以翻頁必須是 request/response：送出後在看到
// **不同的頁面簽章**（狀態列 "第 S~E 行"）之前，一律不得再送。
// P3：progress==100 ⟺ mf_viewedAll()（整數除法剛好等價），到底就別再送——PTT 對
// 已 viewedAll 的 PageDown 是零回應。
// ---------------------------------------------------------------------------
describe("nextPageDownDecision（單一 in-flight 交易, P3/P4）", () => {
  const decide = (o = {}) => nextPageDownDecision({
    enabled: true,
    functionMode: false,
    complete: true,
    isStatusRow: true,
    pagePercent: 40,
    sig: "22~44",
    inFlightSig: null,
    retries: 0,
    fromSettle: false,
    ...o
  });

  it("閒置 ＋ 未到底 → send，並記下本頁簽章為 in-flight", () => {
    const d = decide();
    expect(d.action).toBe("send");
    expect(d.inFlightSig).toBe("22~44");
    expect(d.retries).toBe(0);
  });

  // 主回歸：舊版 _onViewUpdated 寫入簽章卻從不檢查（只有 settle 路徑有去重），
  // 於是同一頁再出現一次完整幀（functionMode resume 的強制 notify、水球後游標歸位…）
  // 就會再送一個 PageDown → 命中 P4 → 掉一整頁。
  it("同一頁再次出現完整幀 → wait（絕不重送；掉頁主因）", () => {
    const d = decide({ inFlightSig: "22~44" });
    expect(d.action).toBe("wait");
    expect(d.inFlightSig).toBe("22~44");
  });

  it("回應到了（簽章變了）→ send 下一頁，retries 歸零", () => {
    const d = decide({ sig: "44~66", inFlightSig: "22~44", retries: 1 });
    expect(d.action).toBe("send");
    expect(d.inFlightSig).toBe("44~66");
    expect(d.retries).toBe(0);
  });

  it("progress 100% → done（P3），清掉 in-flight 並標記已到底", () => {
    const d = decide({ pagePercent: 100 });
    expect(d.action).toBe("done");
    expect(d.reachedPageEnd).toBe(true);
    expect(d.inFlightSig).toBeNull();
  });

  it("100% 判定不靠狀態列首格顏色：percent 為準", () => {
    expect(decide({ pagePercent: 99 }).action).toBe("send");
  });

  it("半畫幀（complete=false）→ none（狀態不動）", () => {
    const d = decide({ complete: false, inFlightSig: null });
    expect(d.action).toBe("none");
    expect(d.inFlightSig).toBeNull();
  });

  it("functionMode / 非狀態列 / 未啟用 → none", () => {
    expect(decide({ functionMode: true }).action).toBe("none");
    expect(decide({ isStatusRow: false }).action).toBe("none");
    expect(decide({ enabled: false }).action).toBe("none");
    expect(decide({ sig: null }).action).toBe("none");
  });

  // 送出後畫面靜止 SETTLE_MS 都沒回應 ⇒ PTT 已 flush 並卡在 dogetch（沒有進行中的
  // 重繪可被 typeahead 吞），此時補送是安全的；但仍設上限，超過就放手（不再送，
  // 避免一路重送把畫面推過頭；真的跳過去也還有 classifyPageTransition 的掉頁自癒接住）。
  it("settle 時仍是同一頁 → retry 一次", () => {
    const d = decide({ fromSettle: true, inFlightSig: "22~44", retries: 0 });
    expect(d.action).toBe("retry");
    expect(d.retries).toBe(1);
  });

  it("settle 重試達上限 → giveup（不再送）", () => {
    const d = decide({ fromSettle: true, inFlightSig: "22~44", retries: 1 });
    expect(d.action).toBe("giveup");
  });
});

// 快路徑（_onViewUpdated）的去重接線。舊版這裡無條件送，是掉頁的主要入口。
describe("EasyReading._onViewUpdated 快路徑去重", () => {
  const makeER = () => {
    const termBuf = {
      addEventListener() {},
      cols: 80,
      rows: 24,
      cur_x: 79,
      cur_y: 23,
      pageState: 3,
      prevPageState: 3,
      lines: { 23: [{ getFg: () => 7, getBg: () => 0 }] },
      getRowText: () => "status-row-text",
      startedEasyReading: true,
      easyReadingShowReplyText: false,
      easyReadingShowPushInitText: false
    };
    const er = new EasyReading({}, { useEasyReadingMode: true }, termBuf);
    er._send = vi.fn();
    return er;
  };

  beforeEach(() => {
    parseStatusRow.mockReturnValue({ pagePercent: 40, rowIndexStart: 22, rowIndexEnd: 44 });
  });

  it("同一頁連兩次 viewUpdate 只送一個 PageDown", () => {
    const er = makeER();
    er.sendCommandAfterUpdate = "\x1b[6~";
    er._onViewUpdated();
    er.sendCommandAfterUpdate = "\x1b[6~";
    er._onViewUpdated();
    expect(er._send).toHaveBeenCalledTimes(1);
  });

  it("換頁後才會送下一個", () => {
    const er = makeER();
    er.sendCommandAfterUpdate = "\x1b[6~";
    er._onViewUpdated();
    parseStatusRow.mockReturnValue({ pagePercent: 60, rowIndexStart: 44, rowIndexEnd: 66 });
    er.sendCommandAfterUpdate = "\x1b[6~";
    er._onViewUpdated();
    expect(er._send).toHaveBeenCalledTimes(2);
  });
});

// 掉頁自癒：term_view.accumulatePageLines 偵測到 P1 違規會升起 buf.easyReadingGapDetected，
// EasyReading 送 Home（\x1b[1~ → pmore#mf_goTop）重讀整篇。每篇只自癒一次防迴圈。
describe("EasyReading._healFromTop（掉頁自癒）", () => {
  const makeER = () => {
    const termBuf = {
      addEventListener() {},
      cols: 80,
      rows: 24,
      cur_x: 79,
      cur_y: 23,
      pageState: 3,
      prevPageState: 3,
      pageLines: [1, 2, 3],
      easyReadingGapDetected: true,
      lines: { 23: [{ getFg: () => 7, getBg: () => 0 }] },
      getRowText: () => "status-row-text",
      startedEasyReading: true,
      easyReadingShowReplyText: false,
      easyReadingShowPushInitText: false
    };
    const view = { useEasyReadingMode: true, _accEndRow: 44, _lastAccumulatedSig: "22~44" };
    const er = new EasyReading({}, view, termBuf);
    er._send = vi.fn();
    return { er, termBuf, view };
  };

  beforeEach(() => {
    parseStatusRow.mockReturnValue({ pagePercent: 40, rowIndexStart: 66, rowIndexEnd: 88 });
  });

  it("送 Home、清空累積並重設追蹤", () => {
    const { er, termBuf, view } = makeER();
    er._healFromTop();
    expect(er._send).toHaveBeenCalledWith("\x1b[1~");
    expect(termBuf.pageLines).toEqual([]);
    expect(termBuf.easyReadingGapDetected).toBe(false);
    expect(termBuf.easyReadingPendingReset).toBe(true);
    expect(view._accEndRow).toBeNull();
  });

  it("每篇只自癒一次（第二次不再送 Home）", () => {
    const { er, termBuf } = makeER();
    er._healFromTop();
    termBuf.easyReadingGapDetected = true;
    er._healFromTop();
    expect(er._send).toHaveBeenCalledTimes(1);
    expect(termBuf.easyReadingGapDetected).toBe(false);
  });

  it("leaveCurrentPost 後重置額度（新文章可再自癒）", () => {
    const { er, termBuf } = makeER();
    er._healFromTop();
    er.leaveCurrentPost();
    termBuf.easyReadingGapDetected = true;
    er._healFromTop();
    expect(er._send).toHaveBeenCalledTimes(2);
  });
});
