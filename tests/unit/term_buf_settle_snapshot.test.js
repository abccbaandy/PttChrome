// M2 regression guard for the settle snapshot (docs/handoff blueprint risk #1):
// the snapshot must be frozen INSIDE the settle-timer callback, BEFORE the
// settled events dispatch, and the per-window changed-rows set must be swapped
// for a fresh one — otherwise a listener-triggered notify pollutes the next
// window and burst classification (list session) reads garbage.
//
// Uses the REAL TermBuf + AnsiParser fed with the recorded C_Chat board-list
// cassette (tests/e2e/cassettes/cchat-list.json), the real Big5 tables, and
// jest fake timers to drive the 30ms notify + 50ms settle chain.
import fs from "fs";
import path from "path";
import { TermBuf } from "../../src/js/term_buf";
import { AnsiParser } from "../../src/js/ansi_parser";
import { loadBig5Tables, decodeRecv } from "./helpers/load_big5_tables";

const cassette = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "..", "e2e", "cassettes", "cchat-list.json"),
    "utf8"
  )
);

function makeBuf() {
  const buf = new TermBuf(cassette.cols, cassette.rows);
  // Minimal view stub: notify() touches update/updateCursorPos/blinkOn.
  buf.setView({ update() {}, updateCursorPos() {}, blinkOn: false });
  buf.useMouseBrowsing = false; // keep notify() off the highlight/DOM path
  return buf;
}

function settle() {
  // 30ms queueUpdate -> notify -> _armSettleTimer(50ms) -> snapshot freeze.
  jest.advanceTimersByTime(300);
}

describe("TermBuf settle snapshot", () => {
  beforeAll(() => {
    loadBig5Tables();
  });
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test("board-list paint settles into a snapshot with cursor parked in the entry area", () => {
    const buf = makeBuf();
    const parser = new AnsiParser(buf);
    parser.feed(decodeRecv(cassette.steps[0].recv));
    settle();

    const snap = buf.settleSnapshot;
    expect(snap).toBeTruthy();
    expect(snap.pageState).toBe(2); // LIST
    expect(buf.settledPageState).toBe(2);
    // Server cursor park position (protocol doc §5): on the cursor row inside
    // the entry region, column ≤ 1.
    expect(snap.curY).toBeGreaterThanOrEqual(3);
    expect(snap.curY).toBeLessThanOrEqual(cassette.rows - 2);
    expect(snap.curX).toBeLessThanOrEqual(1);
    // A full board paint touches many rows.
    expect(snap.changedRows.size).toBeGreaterThan(10);
  });

  test("snapshot is frozen per quiet window: the next window starts a fresh set", () => {
    const buf = makeBuf();
    const parser = new AnsiParser(buf);
    parser.feed(decodeRecv(cassette.steps[0].recv));
    settle();

    const first = buf.settleSnapshot;
    const firstSize = first.changedRows.size;

    // Second window: server updates a single row (cursor-move style burst —
    // write on row 5 then park the cursor back at the row head).
    parser.feed("\x1b[5;1H>\x1b[5;2H");
    settle();

    const second = buf.settleSnapshot;
    expect(second).not.toBe(first);
    // Fresh set: only the newly-touched row (row 5 -> index 4), none of the
    // full-paint rows leaked across the freeze.
    expect(Array.from(second.changedRows)).toEqual([4]);
    expect(second.curY).toBe(4);
    expect(second.curX).toBe(1);
    // The frozen first snapshot is untouched by the second window.
    expect(first.changedRows.size).toBe(firstSize);
    expect(first.changedRows.has(4)).toBe(true); // full paint included row 4 too
  });
});
