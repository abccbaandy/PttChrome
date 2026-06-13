import { nextEasyReadingState, EasyReading } from "../../src/js/easy_reading";

// Fold a sequence of pageStates through nextEasyReadingState, mimicking how
// _onChanged is invoked once per term_buf 'change' event. Returns the final
// {enabled, cameFromList}. enablePref/supported are held constant per run.
const run = (pageStates, { enabled = false, cameFromList = false, enablePref = true, supported = true } = {}) => {
  let state = { enabled, cameFromList };
  for (const pageState of pageStates) {
    const next = nextEasyReadingState({
      pageState,
      cameFromList: state.cameFromList,
      enabled: state.enabled,
      enablePref,
      supported
    });
    state = { enabled: next.enabled, cameFromList: next.cameFromList };
  }
  return state;
};

describe("nextEasyReadingState", () => {
  it("enables on list -> article (2 -> 3)", () => {
    expect(run([2, 3]).enabled).toBe(true);
  });

  // The actual bug: PTT paints the article over several redraw windows; a
  // half-drawn frame reports pageState 0 between the list (2) and the finished
  // article (3). The old raw prevPageState==2 check broke here.
  it("enables despite a transient pageState 0 between list and article (2 -> 0 -> 3)", () => {
    expect(run([2, 0, 3]).enabled).toBe(true);
  });

  it("clears the latch once enabled so re-entry is independent", () => {
    expect(run([2, 0, 3]).cameFromList).toBe(false);
  });

  // Regression guard for switchToNativeAtBottom: user pressed End to leave easy
  // reading but stays on the same post (pageState 3, enabled already false,
  // cameFromList already false). A transient 0->3 flicker must NOT re-enable.
  it("does not re-enable on an in-post flicker after manual native switch (3 -> 0 -> 3, no list seen)", () => {
    expect(run([3, 0, 3], { enabled: false, cameFromList: false }).enabled).toBe(false);
  });

  it("never enables when the preference is off", () => {
    expect(run([2, 0, 3], { enablePref: false }).enabled).toBe(false);
  });

  it("never enables when the connection does not support easy reading", () => {
    expect(run([2, 0, 3], { supported: false }).enabled).toBe(false);
  });

  it("stays enabled across in-post redraws once on (3 -> 0 -> 3)", () => {
    expect(run([3, 0, 3], { enabled: true }).enabled).toBe(true);
  });
});

// leaveCurrentPost is the explicit "leaving this post" hook and is also called by
// switchToEasyReadingMode on every manual exit (End / 取消好讀 / pref-off). It must
// clear the latch, otherwise the post-exit ^L redraw re-enables easy reading after
// the DOM was torn down -> crash in populateEasyReadingPage (Cannot read 'style').
describe("EasyReading.leaveCurrentPost", () => {
  const makeER = () => {
    const termBuf = { addEventListener() {}, prevPageState: 0, pageState: 0 };
    return new EasyReading(/* core */ {}, /* view */ {}, termBuf);
  };

  it("clears the cameFromList latch so a same-post 0->3 redraw cannot re-enable", () => {
    const er = makeER();
    er._cameFromList = true;
    er.leaveCurrentPost();
    expect(er._cameFromList).toBe(false);

    // The redraw that follows a manual exit: still pageState 3, latch now cleared.
    const next = nextEasyReadingState({
      pageState: 3,
      cameFromList: er._cameFromList,
      enabled: false,
      enablePref: true,
      supported: true
    });
    expect(next.enabled).toBe(false);
  });

  it("still resets prevPageState to 0 (unchanged behavior)", () => {
    const er = makeER();
    er._termBuf.prevPageState = 3;
    er.leaveCurrentPost();
    expect(er._termBuf.prevPageState).toBe(0);
  });
});
