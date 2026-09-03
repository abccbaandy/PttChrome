vi.mock("../../src/js/pref_storage", () => ({
  readValuesWithDefault: vi.fn(() => ({ enableEasyReading: true }))
}));

// The settle-recovery path (_onScreenSettled / _computeRowState / _currentPageSignature)
// runs parseStatusRow on getRowText output. Mock it so these wiring tests control
// isStatusRow / the page signature directly — parser correctness has its own tests
// (string_util / comment_parse). The pure nextEasyReading* functions below take
// booleans and never touch string_util, so the mock does not affect them.
// COMMENT_TIME_RE 不是這裡要控制的東西，但一定要給：easy_reading → mouse_regions
// → comment_parse 這條 import 鏈在**模組載入期**就用它組 COMMENT_RE，缺了整個
// test file 會在 import 階段就掛掉（不是某條 assertion 紅）。
vi.mock("../../src/js/string_util", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    COMMENT_TIME_RE: actual.COMMENT_TIME_RE,
    parseStatusRow: vi.fn()
  };
});

import {
  nextEasyReadingState,
  nextEasyReadingReentry,
  nextEasyReadingExternalLanding,
  nextEasyReadingRowState,
  nextPageDownDecision,
  PAGE_DOWN_MAX_RETRIES,
  PAGE_DOWN_GRACE_MS,
  functionModeExitDecision,
  EasyReading
} from "../../src/js/easy_reading";
import { readValuesWithDefault } from "../../src/js/pref_storage";
import { parseStatusRow } from "../../src/js/string_util";

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

  // AID 跳文／deep link 途中的每一張畫面都是「別人的」。最痛的是**進板畫面**：
  // 它是不折不扣的 pmore（pageState 3），在主功能表(1) 之後就構成 1→3 edge，
  // 好讀會把進板公告當文章開始累積。
  it("導航進行中一律不開（navActive），連正常的 2→3 edge 也不例外", () => {
    expect(decide({ navActive: true })).toBe(false);
    expect(decide({ prevSettledPageState: 1, navActive: true })).toBe(false);
  });

  // 說明性回歸：deep link 的目標文章是踩著 0→3 進來的（前一步 AID 搜尋落地的
  // footer 列是空的 ⇒ term_buf.setPageState 判 0）。**刻意不在這裡放寬**成
  // 「0→3 也算」——文章中途任何一次 footer 半畫的 dip 都會產生 3→0→3，那會在
  // 同一頁重新 enterEasyReading（清掉 _inFlightSig）並重送 PageDown ⇒ pttbbs
  // typeahead skip ⇒ 整頁文字永久遺失（P4）。落地改由
  // nextEasyReadingExternalLanding 這條一次性路線負責。
  it("0→3 仍不開：那是 ensureEnabledOnArticle 的職責，不是放寬 edge", () => {
    expect(decide({ prevSettledPageState: 0 })).toBe(false);
  });
});

// 第三條自動開好讀的路線：外部導航（AID 跳文／deep link）的落地。
describe("nextEasyReadingExternalLanding", () => {
  const decide = (o = {}) => nextEasyReadingExternalLanding({
    pageState: 3,
    complete: true,
    statusStart: 1,
    enabled: false,
    enablePref: true,
    supported: true,
    navActive: false,
    ...o
  });

  it("落在文章第一頁且畫面完整 → 開", () => {
    expect(decide()).toBe(true);
  });

  // 這條是整個設計最不能拿掉的一行：既有 edge 路線若已經開了好讀，這裡必須
  // no-op，否則第二次 enterEasyReading 會 _resetPagingState 清掉 _inFlightSig
  // 並從同一頁重送 PageDown ⇒ P4 掉頁。
  it("REGRESSION：已經開著就絕不重開（守 P4 重複 PageDown）", () => {
    expect(decide({ enabled: true })).toBe(false);
  });

  it("導航還在跑就不開（要等 onDone 解鎖 active）", () => {
    expect(decide({ navActive: true })).toBe(false);
  });

  it("不是文章畫面 / 畫面還沒完整 → 不開（留給 one-shot 重試）", () => {
    expect(decide({ pageState: 2 })).toBe(false);
    expect(decide({ pageState: 0 })).toBe(false);
    expect(decide({ complete: false })).toBe(false);
  });

  it("只認第一頁：從中途頁開始累積會少掉前面的內容", () => {
    expect(decide({ statusStart: 12 })).toBe(false);
    expect(decide({ statusStart: null })).toBe(false);
  });

  it("pref 關掉 / 連線不支援 → 不開", () => {
    expect(decide({ enablePref: false })).toBe(false);
    expect(decide({ supported: false })).toBe(false);
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
    reachedPageEnd: false,
    sendCommandAfterUpdate: "",
    ignoreOneUpdate: false,
    curX: 0,
    curY: 0,
    lastRowNum: 23,
    lastColNum: 79,
    isStatusRow: false,
    lastRowFirstChFg: 7,
    lastRowFirstChBg: 0,
    ...o
  });

  it("marks startedEasyReading once on an article page (pageState 3)", () => {
    expect(nextEasyReadingRowState(rowInput({ pageState: 3 })).startedEasyReading).toBe(true);
  });

  it("clears startedEasyReading off-article (pageState != 3), even if it was set", () => {
    expect(
      nextEasyReadingRowState(rowInput({ pageState: 0, startedEasyReading: false }))
        .startedEasyReading
    ).toBe(false);
    // pageState 決定一切：舊的 legacy overlay 路徑會靠「未達發文限制」之類的 prompt
    // 把 startedEasyReading 留著，現在那些幀一律由 functionMode 鏡像原生畫面。
    expect(
      nextEasyReadingRowState(rowInput({
        pageState: 0, startedEasyReading: true, curY: 23, curX: 79
      })).startedEasyReading
    ).toBe(false);
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
      startedEasyReading: true, curY: 23, curX: 79, isStatusRow: false
    }));
    expect(r.pageStateOverride).toBe(5);
    expect(r.startedEasyReading).toBe(false);
  });

  // 游標不在末列末欄 ⇒ 半畫好的幀、或文章內的 prompt/選單幀。後者已由 functionMode
  // 鏡像原生畫面接手（_onKeyDownProcessUI 對任何單字元鍵先 _enterFunctionMode，而
  // _onChanged 在 functionMode 下直接 return），所以這裡一律 halt，不再辨識
  // 推文輸入列 / 回應選單。
  it("halts on any frame whose cursor is not parked at the bottom-right", () => {
    for (const pos of [{ curY: 23, curX: 10 }, { curY: 22, curX: 5 }, { curY: 5, curX: 0 }]) {
      const r = nextEasyReadingRowState(rowInput({ startedEasyReading: true, ...pos }));
      expect(r.halt).toBe(true);
      expect(r.pageStateOverride).toBe(null);
      expect(r.sendCommandAfterUpdate).toBe("");
    }
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
      syncSettledPageState,
      settledPageState: settled,
      prevSettledPageState: prevSettled,
      startedEasyReading: false,
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
// TermBuf.syncSettledPageState 的等價實作：本檔的 termBuf 全是手寫 stub，而 string_util
// 在這裡被整包 mock 掉，import 真的 term_buf 會在載入期就炸。exitEasyReading 會呼叫它
// （消除「翻頁全程沒 settle → settledPageState 過期」造成的假 2->3 邊緣，見
// tests/unit/easy_reading_native_switch_settle.test.js）。
function syncSettledPageState() {
  this.prevSettledPageState = this.pageState;
  this.settledPageState = this.pageState;
}

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
    syncSettledPageState,
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
// 切原生（F8）之後的旗標殘留
//
// exitEasyReading 是唯一的關好讀入口，但它漏了兩個 per-post 旗標：
//
// (1) startedEasyReading —— 唯一的清除點是 _applyRowState，而 _onChanged 在
//     `!_enabled` 時早退 ⇒ 關掉好讀之後永遠跑不到。list_session._engageEligible()
//     要求 !startedEasyReading，於是 **F8 之後回看板列表，列表好讀永遠不 engage**
//     （使用者回報的「半永久原生模式」）。
//
// (2) ignoreOneUpdate —— exitEasyReading → switchToEasyReadingMode →
//     leaveCurrentPost 必然把它設成 true，而它只在 _enabled 時被消費 ⇒ 跨文章殘留。
//     後果不是「少一幀」：下一篇的 enterEasyReading() 結尾那個 notify() 是**本地**
//     重繪（沒有 _touchRows ⇒ term_buf._serverActivity 為 false ⇒ 不 re-arm settle
//     計時器）⇒ 沒有 screenSettled 兜底 ⇒ 那一篇一個 PageDown 都送不出去。
// ---------------------------------------------------------------------------
describe("exitEasyReading 的旗標殘留與本地重繪", () => {
  const makeExitER = () => {
    const er = makeER();
    er._view.mainDisplay = { scrollTop: 4200 };
    // 忠實模擬 App.switchToEasyReadingMode 的隱藏傳遞鏈（pttchrome.jsx）
    er._core.switchToEasyReadingMode = vi.fn(() => { er.leaveCurrentPost(); });
    return er;
  };

  beforeEach(() => {
    readValuesWithDefault.mockReturnValue({ enableEasyReading: true });
    parseStatusRow.mockReturnValue({ pagePercent: 33, rowIndexStart: 1, rowIndexEnd: 23 });
  });

  it("清掉 startedEasyReading（否則列表好讀永遠不 engage）", () => {
    const er = makeExitER();
    er.exitEasyReading();
    expect(er._termBufMock.startedEasyReading).toBe(false);
  });

  it("清掉 ignoreOneUpdate（switchToEasyReadingMode 會再把它點起來）", () => {
    const er = makeExitER();
    er.exitEasyReading();
    expect(er.ignoreOneUpdate).toBe(false);
  });

  // 核心回歸：F8 → 回列表 → 下一篇，第一個 PageDown 必須送得出去。
  it("F8 之後下一篇仍會自動翻頁（不得卡在第一頁）", () => {
    const er = makeExitER();
    er.exitEasyReading();
    // 下一篇文章的第一頁（settle 邊緣 → enterEasyReading）
    er.enterEasyReading();
    er._onChanged();
    er._onViewUpdated();
    expect(er._send).toHaveBeenCalledWith("\x1b[6~");
  });

  // 不依賴伺服器往返的本地保險：按 F8 時若還有 PageDown 在途，End／^L 的重繪會被
  // P4 吞掉，DOM 就一直停在數千列的長頁且捲到底 ⇒ 看起來「卡在最底部、PgUp 沒反應」。
  it("立刻本地重繪回 24 列並把捲軸歸零（不等 ^L 往返）", () => {
    const er = makeExitER();
    er.exitEasyReading();
    expect(er._view.mainDisplay.scrollTop).toBe(0);
    expect(er._termBufMock.lineChangeds.fill).toHaveBeenCalledWith(true);
    expect(er._termBufMock.notify).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 切回好讀的兩條新路徑
//
// 舊版唯一的自動重啟是 settled `1|2 → 3` 邊緣（nextEasyReadingState），於是 F8 切原生
// 之後：在同一篇文章內**沒有任何方法**切回好讀；用 [ ] a b f 在原生跳下一篇也沒有 1/2
// 邊緣 ⇒ 一路卡原生（使用者回報的「半永久原生模式」）。
//
// 補兩條：
//   C1 再按一次熱鍵（預設 F8）→ tryReenterFromNative
//   C3 原生模式下settle 在**另一篇**文章的第一頁 → nextEasyReadingReentry
//
// C3 刻意用**文章身分**（畫面第 0~2 列＝作者/標題/時間）而不是 pageState 邊緣：
// [ ] 跳文全程 pageState 都是 3，根本不會有邊緣；而「使用者在原生自己按 Home/0/g 回到
// 第 1 行」則是同一篇，身分比對才擋得掉。docs/easy-reading.md 也明令不可把「掉出 3 再
// 回來」當成換文章。
// ---------------------------------------------------------------------------
describe("nextEasyReadingReentry（原生模式下換文章才重啟）", () => {
  const r = (o = {}) => nextEasyReadingReentry({
    pageState: 3,
    complete: true,
    enabled: false,
    enablePref: true,
    supported: true,
    functionMode: false,
    statusStart: 1,
    articleKey: "作者 B|標題 B|時間 B",
    nativeArticleKey: "作者 A|標題 A|時間 A",
    ...o
  });

  it("原生模式下落在另一篇文章的第一頁 → 重啟", () => {
    expect(r()).toBe(true);
  });

  it("同一篇（原生按 Home/0/g 回到第 1 行）→ 不重啟", () => {
    expect(r({ articleKey: "作者 A|標題 A|時間 A" })).toBe(false);
  });

  // 導航途中的畫面同樣不算「使用者換了文章」。這道 gate 在 _enterFunctionMode
  // 改成好讀關閉時 no-op 之後變成必要：以前是靠 functionMode 旗標順便擋住的。
  it("AID 跳文／deep link 進行中 → 不重啟（中途的進板畫面也是文章形狀）", () => {
    expect(r({ navActive: true })).toBe(false);
  });

  it("文章中段（statusStart != 1）→ 不重啟", () => {
    expect(r({ statusStart: 57 })).toBe(false);
  });

  it("好讀已開／pref 關／不支援／functionMode／半畫幀／非文章 → 都不重啟", () => {
    expect(r({ enabled: true })).toBe(false);
    expect(r({ enablePref: false })).toBe(false);
    expect(r({ supported: false })).toBe(false);
    expect(r({ functionMode: true })).toBe(false);
    expect(r({ complete: false })).toBe(false);
    expect(r({ pageState: 2 })).toBe(false);
  });

  it("讀不到文章身分 → 不重啟（寧可留在原生）", () => {
    expect(r({ articleKey: null })).toBe(false);
    expect(r({ articleKey: "" })).toBe(false);
  });

  // fail-safe 方向：這條路徑只為「使用者主動 F8 切原生之後跳到別篇」而存在，所以
  // 「不知道使用者是從哪一篇切出來的」必須留在原生。舊版把 null 當成「這篇從沒用過
  // 好讀 ⇒ 可重啟」是 fail-OPEN，只要 _articleKey 沒抓到（見下一個 describe 的兩條
  // 路徑），使用者在**同一篇**按 Home 就會被切回好讀。一般的「列表→文章」自動開好讀
  // 由 nextEasyReadingState 負責，不靠這裡。
  it("身分不明（沒有舊身分）→ 不重啟（留在原生，熱鍵永遠還在）", () => {
    expect(r({ nativeArticleKey: null })).toBe(false);
    expect(r({ nativeArticleKey: "" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 文章身分 _articleKey 的捕捉點
//
// nextEasyReadingReentry 靠「畫面第 0~2 列＝作者/標題/時間」比對來擋掉「使用者在原生
// 自己按 Home/0/g 回到同一篇第 1 行」。但身分基準若存錯，比對就形同虛設 —— 使用者回報
// 的「按 Home 就被切回好讀」正是如此。舊版 _articleKey 只在 enterEasyReading() 捕捉
// 一次，有兩條會存到錯誤值的路徑：
//
//   (1) F8 toggle 從文章**中段**切回好讀：reenterFromTop 先 enterEasyReading() 再送
//       Home，捕捉當下畫面是中段 ⇒ 第 0~2 列是內文不是 header ⇒ 存到垃圾。
//   (2) 好讀開著時用 [ ] a b f 跳下一篇：這條路徑**不經過** enterEasyReading()
//       （nextEasyReadingState 要求 !enabled）⇒ _articleKey 停留在**上一篇**。
//
// 修法：改由 _applyRowState 在**每次確認的第一頁**（statusStart === 1）重抓，
// enterEasyReading() 只負責清空。這是唯一同時覆蓋三條路徑（settle 邊緣進文章、跳文、
// toggle 送 Home 後的落地幀）的捕捉點。
// ---------------------------------------------------------------------------
describe("文章身分 _articleKey 的捕捉點", () => {
  // screen.rows = 目前畫面第 0~2 列；改它就等於模擬 PTT 換了一幀。
  const makeIdER = ({ rows = ["作者 A", "標題 A", "時間 A"], rowIndexStart = 1 } = {}) => {
    const screen = { rows };
    const lastChar = { getFg: () => 7, getBg: () => 0 };
    const termBuf = {
      addEventListener() {},
      syncSettledPageState, cols: 80, rows: 24, cur_x: 79, cur_y: 23,
      pageState: 3, prevPageState: 3, settledPageState: 3, prevSettledPageState: 3,
      pageLines: [], lines: { 23: [lastChar] },
      lineChangeds: { fill: vi.fn() }, notify: vi.fn(),
      getRowText: (row) => (row === 23 ? "status-row" : (screen.rows[row] || "")),
      startedEasyReading: false,
      easyReadingGapDetected: false, easyReadingHealInFlight: false
    };
    const view = {
      useEasyReadingMode: false, mainDisplay: { scrollTop: 0 }, _lastAccumulatedSig: null
    };
    const core = { connectedUrl: { easyReadingSupported: true } };
    const er = new EasyReading(core, view, termBuf);
    er._send = vi.fn();
    // 忠實模擬 App.switchToEasyReadingMode 的隱藏傳遞鏈（pttchrome.jsx）
    er._core.switchToEasyReadingMode = vi.fn(() => { er.leaveCurrentPost(); });
    er._termBufMock = termBuf;
    er._screen = screen;
    // 模擬 PTT 送來一幀：換畫面內容 + 狀態列行號，再跑一次快路徑。
    er._frame = (nextRows, start) => {
      screen.rows = nextRows;
      parseStatusRow.mockReturnValue({
        pagePercent: 50, rowIndexStart: start, rowIndexEnd: start + 22
      });
      er._onChanged();
    };
    parseStatusRow.mockReturnValue({
      pagePercent: 50, rowIndexStart, rowIndexEnd: rowIndexStart + 22
    });
    return er;
  };

  const A = ["作者 A", "標題 A", "時間 A"];
  const B = ["作者 B", "標題 B", "時間 B"];
  const MID = [": 這是文章中段的內文", ": 第二行內文", ": 第三行內文"];

  beforeEach(() => {
    readValuesWithDefault.mockReturnValue({
      enableEasyReading: true, easyReadingEndSwitchNative: true, easyReadingEndSwitchKey: "F8"
    });
  });

  // 使用者回報路徑：好讀開著 → [ 或 ] 跳下一篇 → F8 切原生 → 按 Home 回第 1 行。
  // 舊版 _nativeArticleKey 會是**上一篇**的 key ⇒ 身分不同 ⇒ 誤重啟。
  it("好讀下用 [ ] 跳文後切原生，同一篇按 Home 不得切回好讀", () => {
    const er = makeIdER();
    er.enterEasyReading();          // A 篇（列表 → 文章）
    er._frame(A, 1);
    er._frame(A, 23);               // 往下翻，離開第一頁
    er.leaveCurrentPost();          // 按 ] 跳下一篇
    er._frame(B, 1);                // B 篇第一頁落地
    expect(er._articleKey).toBe("作者 B|標題 B|時間 B");

    er.exitEasyReading();           // F8 切原生
    expect(er._nativeArticleKey).toBe("作者 B|標題 B|時間 B");

    // 原生下自己按 Home 回 B 篇第 1 行 → settle
    parseStatusRow.mockReturnValue({ pagePercent: 3, rowIndexStart: 1, rowIndexEnd: 23 });
    er._maybeReenterOnNewArticle();
    expect(er._enabled).toBe(false);
  });

  // 保留下來的功能：真的換到**另一篇**時仍要自動恢復好讀。
  it("原生下跳到另一篇的第一頁 → 仍自動恢復好讀", () => {
    const er = makeIdER();
    er.enterEasyReading();
    er._frame(A, 1);
    er.exitEasyReading();           // F8 切原生（nativeArticleKey = A）

    er._screen.rows = B;            // ] 跳到 B 篇第一頁
    parseStatusRow.mockReturnValue({ pagePercent: 3, rowIndexStart: 1, rowIndexEnd: 23 });
    er._maybeReenterOnNewArticle();
    expect(er._enabled).toBe(true);
  });

  // reenterFromTop 先 enterEasyReading() 再送 Home，捕捉當下畫面還在中段。
  it("F8 toggle 從中段切回好讀 → 不得把內文當成文章身分", () => {
    const er = makeIdER({ rows: MID, rowIndexStart: 500 });
    expect(er.tryReenterFromNative({ key: "F8" })).toBe(true);
    expect(er._articleKey).toBe(null);
    expect(er._send).toHaveBeenCalledWith("\x1b[1~");

    er._frame(A, 1);                // Home 落地，畫面回到第一頁
    expect(er._articleKey).toBe("作者 A|標題 A|時間 A");
  });
});

describe("F8 在原生模式下切回好讀（toggle）", () => {
  const makeNativeER = ({ rowIndexStart = 500, key = "F8" } = {}) => {
    const rows = ["作者 starahsu", "標題 [推薦] PTT Star", "時間 Mon Dec 31"];
    const termBuf = {
      addEventListener() {},
      syncSettledPageState, cols: 80, rows: 24, cur_x: 79, cur_y: 23,
      pageState: 3, prevPageState: 3, settledPageState: 3, prevSettledPageState: 3,
      pageLines: [], lines: { 23: [{ getFg: () => 7, getBg: () => 0 }] },
      lineChangeds: { fill: vi.fn() }, notify: vi.fn(),
      getRowText: (row) => (row === 23 ? "status-row" : (rows[row] || "")),
      startedEasyReading: false,
    };
    const view = { useEasyReadingMode: false, mainDisplay: { scrollTop: 0 } };
    const er = new EasyReading({ connectedUrl: { easyReadingSupported: true } }, view, termBuf);
    er._send = vi.fn();
    er._termBufMock = termBuf;
    readValuesWithDefault.mockReturnValue({
      enableEasyReading: true, easyReadingEndSwitchNative: true, easyReadingEndSwitchKey: key
    });
    parseStatusRow.mockReturnValue({ pagePercent: 80, rowIndexStart, rowIndexEnd: rowIndexStart + 22 });
    return er;
  };

  it("按熱鍵 → 開好讀，並送 Home 回文章開頭重新累積", () => {
    const er = makeNativeER();
    expect(er.tryReenterFromNative({ key: "F8" })).toBe(true);
    expect(er._enabled).toBe(true);
    expect(er._send).toHaveBeenCalledWith("\x1b[1~");
  });

  // pfterm 對「畫面完全沒變」的回應是零 bytes（fterm_rawmove_opt 原地不動、attr 也 diff
  // 掉），所以已經在第 1 行時送 Home 可能得不到任何回應 → 交易永遠等不到 ack。
  it("已經在第 1 行 → 不送 Home（否則交易永遠等不到回應）", () => {
    const er = makeNativeER({ rowIndexStart: 1 });
    expect(er.tryReenterFromNative({ key: "F8" })).toBe(true);
    expect(er._enabled).toBe(true);
    expect(er._send).not.toHaveBeenCalledWith("\x1b[1~");
  });

  it("$ / G 不參與 toggle（原生 pmore 的跳文末，語意不同）", () => {
    const er = makeNativeER();
    expect(er.tryReenterFromNative({ key: "$" })).toBe(false);
    expect(er.tryReenterFromNative({ key: "G" })).toBe(false);
    expect(er._enabled).toBe(false);
  });

  it("熱鍵可自訂；pref 關掉時不攔截", () => {
    const er = makeNativeER({ key: "F9" });
    expect(er.tryReenterFromNative({ key: "F8" })).toBe(false);
    expect(er.tryReenterFromNative({ key: "F9" })).toBe(true);

    const off = makeNativeER();
    readValuesWithDefault.mockReturnValue({
      enableEasyReading: true, easyReadingEndSwitchNative: false, easyReadingEndSwitchKey: "F8"
    });
    expect(off.tryReenterFromNative({ key: "F8" })).toBe(false);
  });

  it("不在文章頁（讀不到狀態列）→ 不攔截", () => {
    const er = makeNativeER();
    parseStatusRow.mockReturnValue(null);
    expect(er.tryReenterFromNative({ key: "F8" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 送鍵錨定的 watchdog：settle 不是可靠的重試觸發點
//
// term_buf._armSettleTimer 只由 notify() 在 _serverActivity（伺服器寫了內容）或
// posChanged（伺服器游標 escape）時 re-arm。PageDown 真的掉了 ⇒ PTT 零回應 ⇒
// **不會再有第二次 settle**。所以「同頁 + 未過 grace ⇒ wait」如果沒有配一個自己
// 持有的計時器，就是把「誤重試」換成「永久卡死」。
//
// watchdog 以**自己送鍵的時刻**為錨（settle 錨的是「送鍵前的靜止」，在長文會被
// React render 延遲污染），並用 _watchdogSig 認身分：回應在 grace 內到達時
// _inFlightSig 已經換頁，計時器一律空轉，絕不多送一個鍵（否則就是 P4）。
// ---------------------------------------------------------------------------
describe("翻頁 watchdog（送鍵錨定的重試）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    parseStatusRow.mockReturnValue({ pagePercent: 33, rowIndexStart: 1, rowIndexEnd: 23 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("送出後 PTT 完全沒回應 → grace 到期由 watchdog 補送一次，再到期就 giveup", () => {
    const er = makeER();
    er._onScreenSettled();
    expect(er._send).toHaveBeenCalledTimes(1);

    // grace 之內的 settle 不得補送（正是錄製檔 t=23124 的情境）
    vi.advanceTimersByTime(77);
    er._onScreenSettled();
    expect(er._send).toHaveBeenCalledTimes(1);

    // 之後畫面一直靜默：settle 不會再來，只有 watchdog 救得了
    vi.advanceTimersByTime(PAGE_DOWN_GRACE_MS + 50);
    expect(er._send).toHaveBeenCalledTimes(2);

    // 重試額度用完 → 不再送（避免一路把畫面推過頭）
    vi.advanceTimersByTime(PAGE_DOWN_GRACE_MS + 50);
    expect(er._send).toHaveBeenCalledTimes(2);
  });

  it("回應在 grace 內到達 → watchdog 到期時空轉，不得多送（否則就是 P4 掉頁）", () => {
    const er = makeER();
    er._onScreenSettled();
    expect(er._send).toHaveBeenCalledTimes(1);

    // 回應到了：換頁 ⇒ 快路徑送下一頁
    vi.advanceTimersByTime(80);
    parseStatusRow.mockReturnValue({ pagePercent: 40, rowIndexStart: 23, rowIndexEnd: 45 });
    er.sendCommandAfterUpdate = "\x1b[6~";
    er._onViewUpdated();
    expect(er._send).toHaveBeenCalledTimes(2);

    // 第一個 watchdog 到期：它守的是上一頁，身分不符 → 什麼都不做
    vi.advanceTimersByTime(PAGE_DOWN_GRACE_MS - 40);
    expect(er._send).toHaveBeenCalledTimes(2);
  });

  it("到底（100%）→ 收掉 watchdog，不再有任何鍵送出", () => {
    const er = makeER();
    er._onScreenSettled();
    parseStatusRow.mockReturnValue({ pagePercent: 100, rowIndexStart: 500, rowIndexEnd: 522 });
    er._termBufMock.getRowText = () => "bottom-status-row";
    er.sendCommandAfterUpdate = "\x1b[6~";
    er._onViewUpdated();
    vi.advanceTimersByTime(PAGE_DOWN_GRACE_MS * 4);
    expect(er._send).toHaveBeenCalledTimes(1);
  });

  it("exitEasyReading 會收掉 watchdog（不得對原生畫面送鍵）", () => {
    const er = makeER();
    er._core.switchToEasyReadingMode = vi.fn();
    er._view.mainDisplay = { scrollTop: 0 };
    er._onScreenSettled();
    er.exitEasyReading();
    vi.advanceTimersByTime(PAGE_DOWN_GRACE_MS * 4);
    expect(er._send).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 跨文章重置（回歸守護：7fdd90a 之後「進文章卡在第一頁、換一篇還是卡」）
//
// 自動翻頁的 per-article 狀態（_inFlightSig / _pageDownRetries / 自癒額度 /
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
    er._healGotoCount = 3;
    er._healHomeUsed = true;
    er.sendCommandAfterUpdate = "\x1b[6~";
    settleEdge(er, 3, 2);   // 離開文章
    expect(er._inFlightSig).toBe(null);
    expect(er._pageDownRetries).toBe(0);
    expect(er._healGotoCount).toBe(0);
    expect(er._healHomeUsed).toBe(false);
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
    er._healGotoCount = 3;
    er._healHomeUsed = true;
    er.leaveCurrentPost();
    expect(er._inFlightSig).toBe(null);
    expect(er._pageDownRetries).toBe(0);
    expect(er._healGotoCount).toBe(0);
    expect(er._healHomeUsed).toBe(false);
    expect(er.easyReadingReachedPageEnd).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// _scrollBy 的「還捲得動嗎」下界。
//
// 這裡鎖的是**現行公式**（`mainContainer.clientHeight - chh*rows`），因為換成看似
// 更權威的 `cont.scrollHeight - cont.clientHeight` 會改變使用者看得到的行為：
//   * 內容項兩式相同（實測 stock-end：mainContainer.clientHeight 2700
//     ＝ .main.scrollHeight 2700）⇒ 「佔位盒塌陷會讓它低估」對兩式一樣成立。
//   * 視窗項不同：.main.clientHeight 實測 730 > chh*rows（24×30＝720）⇒ 現行下界
//     1980 高於真正的 maxScroll 1970，到底之後仍回 true；換公式後回 false ⇒
//     Space／→／↓／Enter 會 leaveCurrentPost() **把文章關掉**（2026-09 live e2e
//     實測：easy-reading.spec.js「第一則推文不消失」整條退回看板列表）。
// 要改這個邊界＝獨立的產品決策，先補 leaveCurrentPost 的守護再說。
describe("_scrollBy 的捲動下界", () => {
  const makeER = ({ scrollTop, scrollHeight, clientHeight, containerHeight }) => {
    const termBuf = { addEventListener() {}, rows: 24 };
    const mainDisplay = { scrollTop, scrollHeight, clientHeight };
    const view = {
      mainDisplay,
      mainContainer: { clientHeight: containerHeight },
      chh: 30,
    };
    return new EasyReading(/* core */ {}, view, termBuf);
  };

  // 實測值（stock-end，chh=30、rows=24）：內容 2700、視窗 730、maxScroll 1970。
  const real = (scrollTop) =>
    makeER({
      scrollTop,
      scrollHeight: 2700,
      clientHeight: 730,
      containerHeight: 2700,
    });

  it("還沒到底 ⇒ 捲得動", () => {
    const er = real(1000);
    expect(er._scrollBy(22)).toBe(true);
    expect(er._view.mainDisplay.scrollTop).toBe(1000 + 30 * 22);
  });

  it("捲到底（scrollTop 已是 maxScroll）⇒ 仍回 true，**不得**把文章關掉", () => {
    // 下界 2700 − 30×24 = 1980 高於 maxScroll 1970 ⇒ 到底之後 Space 只是原地不動，
    // 不會走 leaveCurrentPost()。改用 scrollHeight − clientHeight 會回 false。
    expect(real(1970)._scrollBy(22)).toBe(true);
  });

  it("到頂 ⇒ 往上捲回 false（呼叫端據此離開文章）", () => {
    expect(real(0)._scrollBy(-22)).toBe(false);
  });

  it("沒到頂 ⇒ 往上捲得動", () => {
    const er = real(900);
    expect(er._scrollBy(-22)).toBe(true);
    expect(er._view.mainDisplay.scrollTop).toBe(900 - 30 * 22);
  });
});

// ---------------------------------------------------------------------------
// PgDn 自救：累積頁捲不動又還沒到底時，把翻頁交易踢回去。
// 使用者實際看到的症狀就是「PgDn 沒反應」——累積頁停在第一頁，_scrollBy 捲不動，
// 而原本這個 case 什麼都不做。到底的文章（100%）仍然不送鍵。
describe("PageDown 在累積頁底部的自救", () => {
  beforeEach(() => {
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
    recovery: false,
    // 預設「送出後已久」，讓既有案例維持原意；grace 本身另有專屬案例。
    sinceSentMs: 5000,
    graceMs: PAGE_DOWN_GRACE_MS,
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
    const d = decide({ recovery: true, inFlightSig: "22~44", retries: 0 });
    expect(d.action).toBe("retry");
    expect(d.retries).toBe(1);
  });

  it("settle 重試達上限 → giveup（不再送）", () => {
    const d = decide({ recovery: true, inFlightSig: "22~44", retries: 1 });
    expect(d.action).toBe("giveup");
  });

  // 回歸：ptt-debug-20260809-135157（4700 行超長文）的真實時序。
  //   t=23047 送 PageDown（sig 4620~4642）
  //   t=23124 settle 觸發 → 舊版判「同一頁 ⇒ 掉了」→ retry ⇒ 第二個 PageDown
  //   t=23124 真正的回應（4642~4664）同一毫秒才到
  // ⇒ 兩個 PageDown 同時在途 ⇒ P4 吞掉中間那頁 ⇒ 掉頁 ⇒ 自癒送 Home ⇒ 整篇重讀。
  //
  // settle 的「畫面已靜止 ⇒ PTT 已 flush」推論在長文會失效：settle 計時器是在**我們
  // 送鍵之前**就 armed 的（長頁 4600+ 列，React render 讓 callback 延後到送鍵之後才
  // 跑），它量到的靜止期與「送鍵後 PTT 沒回應」無關。改以「距離自己送鍵多久」為準。
  it("recovery 但距離送鍵還沒超過 grace → wait（回應可能還在路上；掉頁根因）", () => {
    const d = decide({
      recovery: true, inFlightSig: "4620~4642", sig: "4620~4642",
      retries: 0, sinceSentMs: 77
    });
    expect(d.action).toBe("wait");
    expect(d.retries).toBe(0);
  });

  it("recovery 且已超過 grace → retry", () => {
    const d = decide({
      recovery: true, inFlightSig: "4620~4642", sig: "4620~4642",
      retries: 0, sinceSentMs: PAGE_DOWN_GRACE_MS + 1
    });
    expect(d.action).toBe("retry");
  });

  it("recovery 且剛好等於 grace → retry（邊界含等於）", () => {
    const d = decide({
      recovery: true, inFlightSig: "22~44", retries: 0, sinceSentMs: PAGE_DOWN_GRACE_MS
    });
    expect(d.action).toBe("retry");
  });

  // 沒有時間戳（理論上不會發生：呼叫端一律與 _inFlightSig 同時寫入）時 fail-open，
  // 維持舊行為，絕不可因為缺一個時間戳就把交易永久卡死。
  it("sinceSentMs 為 null → 視為已過 grace（fail-open，不得卡死）", () => {
    const d = decide({ recovery: true, inFlightSig: "22~44", retries: 0, sinceSentMs: null });
    expect(d.action).toBe("retry");
  });

  it("grace 只約束 recovery：快路徑同頁一律 wait", () => {
    expect(decide({ inFlightSig: "22~44", sinceSentMs: 5 }).action).toBe("wait");
    expect(decide({ inFlightSig: "22~44", sinceSentMs: 9999 }).action).toBe("wait");
  });

  it("grace 不影響 ack（簽章已變）：照樣 send", () => {
    const d = decide({
      recovery: true, sig: "44~66", inFlightSig: "22~44", retries: 1, sinceSentMs: 5
    });
    expect(d.action).toBe("send");
    expect(d.retries).toBe(0);
  });
});

// 快路徑（_onViewUpdated）的去重接線。舊版這裡無條件送，是掉頁的主要入口。
describe("EasyReading._onViewUpdated 快路徑去重", () => {
  const makeER = () => {
    const termBuf = {
      addEventListener() {},
      syncSettledPageState,
      cols: 80,
      rows: 24,
      cur_x: 79,
      cur_y: 23,
      pageState: 3,
      prevPageState: 3,
      lines: { 23: [{ getFg: () => 7, getBg: () => 0 }] },
      getRowText: () => "status-row-text",
      startedEasyReading: true,
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

// 掉頁自癒：term_view.accumulatePageLines 偵測到 P1 違規會升起 buf.easyReadingGapDetected。
//
// 舊作法是送 Home（\x1b[1~ → pmore#mf_goTop）**整篇重讀**。在 4700 行的超長文上，那正是
// 使用者看到的「讀到一半自動從第一頁開始重讀」——治療比疾病還糟。
//
// 新作法用 pmore 的 goto-line（pmore.c:2735 `case ':'` → pageMode=0 → getdata_buf →
// `if (i-- > 0) mf_goto(i)`）精準跳回缺的那一行：送 `:` + N + `\r` ⇒ 落地畫面的
// rowIndexStart 恰為 N。目標取 _accEndRow（不是 +1）：statusStart === accEndRow 正是
// pmore PageDown 自己的後置條件（P1: S' == E），落地幀與正常翻頁**形狀完全相同**，走
// 既有已被測試覆蓋的 continuation/append 路徑，還多一列可做內容交叉驗證。
describe("EasyReading 掉頁自癒（goto-line 精準補讀）", () => {
  const makeER = () => {
    const termBuf = {
      addEventListener() {},
      syncSettledPageState,
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
    };
    const view = {
      useEasyReadingMode: true, _accEndRow: 44, _lastAccumulatedSig: "22~44",
      mainDisplay: { scrollTop: 1234 }
    };
    const er = new EasyReading({}, view, termBuf);
    er._send = vi.fn();
    return { er, termBuf, view };
  };

  beforeEach(() => {
    // 掉頁後的畫面：累積到第 44 行，但螢幕已經跳到 66~88（中間 45~65 那頁被吞了）
    parseStatusRow.mockReturnValue({ pagePercent: 40, rowIndexStart: 66, rowIndexEnd: 88 });
  });

  it("送 `:accEndRow\\r` 精準跳回缺頁，不整篇重讀", () => {
    const { er, termBuf } = makeER();
    er._healGap();
    expect(er._send).toHaveBeenCalledWith(":44\r");
    expect(termBuf.easyReadingGapDetected).toBe(false);
  });

  // 與舊 Home 版最大的差異：前面累積的內容一列都不能掉。
  it("保留 pageLines／_accEndRow／_lastAccumulatedSig／捲軸位置", () => {
    const { er, termBuf, view } = makeER();
    er._healGap();
    expect(termBuf.pageLines).toEqual([1, 2, 3]);
    expect(view._accEndRow).toBe(44);
    expect(view._lastAccumulatedSig).toBe("22~44");
    expect(view.mainDisplay.scrollTop).toBe(1234);
    // 「換文章」語意的旗標不得被誤設
    expect(termBuf.easyReadingPendingReset).toBeFalsy();
  });

  // heal 期間底部是 prompt、pageState 會掉出 3；不擋住的話
  // decideAccumulateBranch 會走 rebuild 把累積頁從中段重建（靜默刪光前面）。
  it("升起 easyReadingHealInFlight（擋掉 prompt 幀觸發的 rebuild／teardown）", () => {
    const { er, termBuf } = makeER();
    er._healGap();
    expect(termBuf.easyReadingHealInFlight).toBe(true);
  });

  // heal 本身必須是一筆 in-flight 交易。舊版 _healFromTop 先 _resetPagingState() 把
  // _inFlightSig 清成 null 才送 Home ⇒ 任何搶在 heal 回應之前抵達的完整幀都會讓決策
  // 直接回 send ⇒ 又一個 PageDown 進 PTT ⇒ 再撞一次 P4。
  it("heal 在途時翻頁機噤聲（完整幀不得再送 PageDown）", () => {
    const { er } = makeER();
    er._healGap();
    er._send.mockClear();
    er.sendCommandAfterUpdate = "\x1b[6~";
    er._onViewUpdated();
    expect(er._send).not.toHaveBeenCalled();
  });

  it("落地（rowIndexStart 回到 accEndRow）→ 解除噤聲，繼續自動翻頁", () => {
    const { er, termBuf } = makeER();
    er._healGap();
    er._send.mockClear();
    // 補讀的那一頁到了：44~66，且已被 accumulate（_lastAccumulatedSig 前進）
    parseStatusRow.mockReturnValue({ pagePercent: 45, rowIndexStart: 44, rowIndexEnd: 66 });
    termBuf.easyReadingHealInFlight = false;  // accumulatePageLines 在 append 後清掉
    er.sendCommandAfterUpdate = "\x1b[6~";
    er._onViewUpdated();
    expect(er._send).toHaveBeenCalledWith("\x1b[6~");
  });

  it("沒有 _accEndRow 可跳（第一頁就掉了）→ 退回 Home", () => {
    const { er, view } = makeER();
    view._accEndRow = null;
    er._healGap();
    expect(er._send).toHaveBeenCalledWith("\x1b[1~");
  });

  // 有界：精準 heal 便宜（一次往返、不重讀）所以放寬到每篇 3 次，之後才用一次 Home
  // 當最後手段，再之後放手（畫面維持現狀，PgDn／F8 都還在）。
  it("每篇 3 次 goto → 1 次 Home → 放手", () => {
    const { er, termBuf } = makeER();
    const again = () => { termBuf.easyReadingHealInFlight = false; termBuf.easyReadingGapDetected = true; er._healGap(); };
    er._healGap();
    again(); again();
    expect(er._send.mock.calls.map((c) => c[0])).toEqual([":44\r", ":44\r", ":44\r"]);
    again();
    expect(er._send).toHaveBeenLastCalledWith("\x1b[1~");
    again();
    expect(er._send).toHaveBeenCalledTimes(4);
    expect(termBuf.easyReadingGapDetected).toBe(false);
  });

  it("leaveCurrentPost 後重置額度（新文章可再自癒）", () => {
    const { er, termBuf } = makeER();
    er._healGap();
    er.leaveCurrentPost();
    termBuf.easyReadingHealInFlight = false;
    termBuf.easyReadingGapDetected = true;
    er._healGap();
    expect(er._send).toHaveBeenCalledTimes(2);
  });
});
