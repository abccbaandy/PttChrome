// Unit tests for AidNavigation (src/js/aid_navigation.js): the serialized
// native-key sequence behind an AID link click. Drives a REAL CommandQueue
// (fake send + jest fake timers) and feeds settle facts by hand — the same
// harness style as command_queue.test.js / list_session.test.js.

import { CommandQueue } from "../../src/js/command_queue";
import { AidNavigation } from "../../src/js/aid_navigation";

jest.useFakeTimers();

// Minimal facts object (shape of list_session._collectFacts).
function facts(kind, over = {}) {
  return {
    kind,
    boardName: null,
    cursorRowNum: null,
    rows: 24,
    rowTexts: new Array(24).fill(""),
    curX: 0,
    curY: 0,
    ...over
  };
}

// Reading-article status row (string_util.parseStatusRow shape).
const STATUS_ROW =
  "  瀏覽 第 1/2 頁 ( 45%)  目前顯示: 第 1~23 行  (y)回應(X%)推文(h)說明(←)離開 ";

function makeHarness({ listState = "suspended" } = {}) {
  const sent = [];
  const queue = new CommandQueue({ send: d => sent.push(d) });
  const hints = [];
  const view = { flashListHint: (msg, ms) => hints.push(msg) };
  const termBuf = { startedEasyReading: true };
  const core = {
    easyReading: {
      enterFunctionModeCalls: 0,
      _enterFunctionMode() {
        this.enterFunctionModeCalls++;
      }
    },
    listSession: {
      state: listState,
      beginCalls: 0,
      beginExternalNavigation() {
        this.beginCalls++;
      }
    }
  };
  const nav = new AidNavigation(core, view, termBuf, queue);
  return { nav, queue, sent, hints, view, termBuf, core };
}

const settle = (queue, f) => queue.onSettle({}, f);

describe("AidNavigation", () => {
  test("happy path: s board ⏎ (from inside the article) → # aid ⏎ → ⏎, active toggles, mirrors entered", () => {
    const { nav, queue, sent, core, hints } = makeHarness();
    nav.start("1gIeu-3A", "Android");
    expect(nav.active).toBe(true);
    expect(core.easyReading.enterFunctionModeCalls).toBe(1);
    expect(core.listSession.beginCalls).toBe(1);
    // Board jump sent immediately — s works from inside the article, no
    // leave-article step (fullRepaint appends \f).
    expect(sent).toEqual(["sAndroid\r\f"]);
    // Board landing: name must match case-insensitively.
    settle(queue, facts("clean-list", { boardName: "android" }));
    expect(sent[1]).toBe("#1gIeu-3A\r\f");
    settle(
      queue,
      facts("clean-list", { boardName: "android", cursorRowNum: 123, curY: 10 })
    );
    expect(sent[2]).toBe("\r\f");
    settle(queue, facts("article"));
    expect(nav.active).toBe(false);
    expect(queue.idle).toBe(true);
    // The 15s "跳至…" progress banner must be replaced by a short confirmation
    // on success (regression: it lingered long into the opened article).
    expect(hints[hints.length - 1]).toContain("已跳至");
  });

  test("no board → refuses to start, nothing sent", () => {
    const { nav, sent, hints } = makeHarness();
    nav.start("1gIeu-3A", null);
    expect(nav.active).toBe(false);
    expect(sent).toEqual([]);
    expect(hints.some(h => h.includes("看板"))).toBe(true);
  });

  test("not in an open post (startedEasyReading false) → ignored", () => {
    const { nav, sent, termBuf } = makeHarness();
    termBuf.startedEasyReading = false;
    nav.start("1gIeu-3A", "Android");
    expect(nav.active).toBe(false);
    expect(sent).toEqual([]);
  });

  test("re-entrant start while active is ignored", () => {
    const { nav, sent } = makeHarness();
    nav.start("1gIeu-3A", "Android");
    nav.start("2AbCdEf0", "C_Chat");
    expect(sent).toEqual(["sAndroid\r\f"]);
  });

  test("idle list session is not disturbed", () => {
    const { nav, core } = makeHarness({ listState: "idle" });
    // beginExternalNavigation guards on idle itself, but the call is still made;
    // assert the navigation works regardless of session state.
    nav.start("1gIeu-3A", "Android");
    expect(core.listSession.beginCalls).toBe(1);
    expect(nav.active).toBe(true);
  });

  test("REGRESSION: AID landing with a BLANK bottom footer (kind 'transient') is accepted", () => {
    // Live-verified 2026-07-10: the # prompt clears the footer row and the
    // jump repaint (even after \f) leaves it blank → classifyListScreen says
    // 'transient' although the cursor is parked on the target article. The
    // old kind==='clean-list' gate turned every successful jump into a
    // 「找不到文章」miss.
    const { nav, queue, sent } = makeHarness();
    nav.start("1gKF7GO4", "C_Chat");
    settle(queue, facts("clean-list", { boardName: "C_Chat" }));
    expect(sent[1]).toBe("#1gKF7GO4\r\f");
    settle(
      queue,
      facts("transient", {
        boardName: "C_Chat",
        cursorRowNum: 353218,
        curY: 18,
        curX: 1
      })
    );
    expect(sent[2]).toBe("\r\f");
    settle(queue, facts("article"));
    expect(nav.active).toBe(false);
  });

  test("AID not found: press-any-key screen never satisfies expect → probe → miss → visible fail", () => {
    const { nav, queue, sent, hints } = makeHarness();
    nav.start("1gIeu-3A", "Android");
    settle(queue, facts("clean-list", { boardName: "Android" }));
    expect(sent[1]).toBe("#1gIeu-3A\r\f");
    // The vmsg press-any-key settle: not clean-list → expect false, timer re-armed.
    settle(queue, facts("prompt"));
    // Soft timeout → probe \f.
    jest.advanceTimersByTime(4000);
    expect(sent[2]).toBe("\f");
    // Probed full frame still shows the message → definitive miss.
    settle(queue, facts("prompt"));
    expect(nav.active).toBe(false);
    expect(hints.some(h => h.includes("找不到文章 #1gIeu-3A"))).toBe(true);
    expect(queue.idle).toBe(true);
  });

  test("error text on a clean-list bottom row also rejects (belt and braces)", () => {
    const { nav, queue, sent } = makeHarness();
    nav.start("1gIeu-3A", "Android");
    settle(queue, facts("clean-list", { boardName: "Android" }));
    const rowTexts = new Array(24).fill("");
    rowTexts[23] = "找不到這個文章代碼(AID)";
    settle(
      queue,
      facts("clean-list", {
        boardName: "Android",
        cursorRowNum: 5,
        curY: 10,
        rowTexts
      })
    );
    // expect false → nothing new sent yet (still waiting / will probe).
    expect(sent.length).toBe(2);
    expect(nav.active).toBe(true);
  });

  test("board jump timeout → visible fail, unlock, queue drained", () => {
    const { nav, queue, sent, hints } = makeHarness();
    nav.start("1gIeu-3A", "Android");
    expect(sent[0]).toBe("sAndroid\r\f");
    // Silent link: soft timeout → probe, then hard silence → timeout fail.
    jest.advanceTimersByTime(6000); // probe
    expect(sent[1]).toBe("\f");
    jest.advanceTimersByTime(6000); // probe timeout
    expect(nav.active).toBe(false);
    expect(hints.some(h => h.includes("切換看板"))).toBe(true);
    // The queued follow-up steps must not fire after the failure.
    expect(queue.idle).toBe(true);
    expect(sent.length).toBe(2);
  });

  test("final open accepts a status-row bottom even if the classifier hesitates", () => {
    const { nav, queue } = makeHarness();
    nav.start("1gIeu-3A", "Android");
    settle(queue, facts("clean-list", { boardName: "Android" }));
    settle(
      queue,
      facts("clean-list", { boardName: "Android", cursorRowNum: 123, curY: 10 })
    );
    const rowTexts = new Array(24).fill("");
    rowTexts[23] = STATUS_ROW;
    settle(queue, facts("prompt", { rowTexts }));
    expect(nav.active).toBe(false);
  });
});
