// @unit-env browser
// real-input: tests/e2e/offline/list_fast_scroll.offline.spec.js
// 列表快速捲動把手（P30，js/list_fast_scroll.js、docs/easy-reading-list.md「快速捲動把手」）。
//
// 鎖的症狀：
//   1. 軌道位置 ↔ 編號：最上面＝1、最下面＝這個看板看過的最大編號，線性；超出範圍夾住。
//   2. 看過的最大編號：換板重來；補到板尾以緩衝為準；遠跳到舊的那段不會讓它變小。
//   3. 只在捲動時出現、停下就收起；緩衝已涵蓋整個看板、搜尋結果、開關關 ⇒ 不出現。
//   4. 拖動途中一個 byte 都不送；放開送一次跳號（閱讀紀錄 'list-fast-scroll'）；取消零送出。
import {
  ListFastScroll,
  fastScrollNumAt,
  fastScrollFracOf,
  fastScrollFracFromPointer,
  fastScrollAvailable,
  nextHiSeen,
  FAST_SCROLL_IDLE_MS,
  FAST_SCROLL_HANDLE_H,
} from "../../src/js/list_fast_scroll";
import { OWNER_ARTICLE_LIST } from "../../src/js/list_render_owner";
import { DEFAULT_PREFS } from "../../src/js/pref_storage";

describe("軌道位置 ↔ 編號", () => {
  test("最上面＝1、最下面＝最大編號；超出範圍夾住；來回換算一致", () => {
    expect(fastScrollNumAt(0, 98000)).toBe(1);
    expect(fastScrollNumAt(1, 98000)).toBe(98000);
    expect(fastScrollNumAt(0.5, 101)).toBe(51);
    expect(fastScrollNumAt(-3, 500)).toBe(1);
    expect(fastScrollNumAt(7, 500)).toBe(500);
    expect(fastScrollNumAt(fastScrollFracOf(4321, 98000), 98000)).toBe(4321);
    expect(fastScrollFracOf(5, 1)).toBe(0);
  });

  test("指標位置抓在把手中間：軌道頂＋半個把手＝0、軌道底－半個把手＝1", () => {
    const track = { top: 100, height: 400 };
    expect(fastScrollFracFromPointer(100 + FAST_SCROLL_HANDLE_H / 2, track)).toBe(0);
    expect(fastScrollFracFromPointer(500 - FAST_SCROLL_HANDLE_H / 2, track)).toBe(1);
    expect(fastScrollFracFromPointer(0, track)).toBe(0);
    expect(fastScrollFracFromPointer(9999, track)).toBe(1);
  });

  test("看過的最大編號：換板重來、板尾以緩衝為準、遠跳到舊段不變小", () => {
    let h = nextHiSeen(null, { board: "C_Chat", hi: 900, edgeDown: false });
    expect(h).toEqual({ board: "C_Chat", hi: 900 });
    h = nextHiSeen(h, { board: "C_Chat", hi: 300, edgeDown: false });
    expect(h.hi).toBe(900);
    h = nextHiSeen(h, { board: "C_Chat", hi: 880, edgeDown: true });
    expect(h.hi).toBe(880);
    h = nextHiSeen(h, { board: "Gossiping", hi: 50, edgeDown: false });
    expect(h).toEqual({ board: "Gossiping", hi: 50 });
    expect(nextHiSeen(h, null)).toBe(h);
  });

  test("出現條件：開關開、有現況、緩衝沒涵蓋整個看板", () => {
    expect(fastScrollAvailable(true, { lo: 400, hi: 900 }, 900)).toBe(true);
    expect(fastScrollAvailable(true, { lo: 1, hi: 300 }, 900)).toBe(true);
    expect(fastScrollAvailable(true, { lo: 1, hi: 900 }, 900)).toBe(false);
    expect(fastScrollAvailable(false, { lo: 400, hi: 900 }, 900)).toBe(false);
    expect(fastScrollAvailable(true, null, 900)).toBe(false);
  });

  test("功能開關預設開", () => {
    expect(DEFAULT_PREFS.enableListFastScroll).toBe(true);
  });
});

describe("ListFastScroll（把手的控制器）", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const makeCore = (info) => {
    const jumps = [];
    const rr = { begin: vi.fn(() => ({ bm: 1 })), end: vi.fn() };
    const core = {
      buf: {
        listRenderMode: "buffer",
        listRenderOwner: OWNER_ARTICLE_LIST,
        addEventListener() {},
      },
      readingRecord: rr,
      listSession: {
        fastScrollInfo: () => info.v,
        jumpToNumber: vi.fn((num, hooks) => {
          jumps.push({ num, hooks });
          return true;
        }),
      },
      view: {
        mainDisplay: {
          querySelector: () => ({
            getBoundingClientRect: () => ({ top: 100, height: 400, right: 900, width: 800 }),
          }),
        },
      },
    };
    return { core, jumps, rr };
  };
  const INFO = { board: "C_Chat", lo: 9000, hi: 9300, topNum: 9100, edgeDown: true };

  test("捲動才出現（位置＝視口頂端那篇）；停下 FAST_SCROLL_IDLE_MS 收起", () => {
    const { core } = makeCore({ v: INFO });
    const fs = new ListFastScroll(core, { document: null });
    fs.refresh();
    expect(fs.state.visible).toBe(false);
    fs.noteScroll();
    expect(fs.state).toMatchObject({ visible: true, dragging: false, hi: 9300, top: 100, height: 400, right: 900 });
    expect(fs.state.frac).toBeCloseTo(fastScrollFracOf(9100, 9300));
    vi.advanceTimersByTime(FAST_SCROLL_IDLE_MS + 10);
    expect(fs.state.visible).toBe(false);
  });

  test("拖動途中不送；放開送一次跳號（編號＝放開位置換算）；閱讀紀錄 done", () => {
    const { core, jumps, rr } = makeCore({ v: INFO });
    const fs = new ListFastScroll(core, { document: null });
    fs.noteScroll();
    expect(fs.dragStart(300)).toBe(true);
    fs.dragMove(100 + FAST_SCROLL_HANDLE_H / 2); // 軌道最上面
    expect(fs.state).toMatchObject({ dragging: true, num: 1 });
    fs.dragMove(300);
    const num = fs.state.num;
    expect(num).toBe(fastScrollNumAt(fastScrollFracFromPointer(300, fs.state), 9300));
    // 拖很久也不收起、不送
    vi.advanceTimersByTime(FAST_SCROLL_IDLE_MS * 3);
    expect(fs.state.visible).toBe(true);
    expect(jumps.length).toBe(0);
    expect(fs.dragEnd(true)).toBe(true);
    expect(jumps.map((j) => j.num)).toEqual([num]);
    expect(rr.begin).toHaveBeenCalledWith("list-fast-scroll");
    jumps[0].hooks.onDone();
    expect(rr.end).toHaveBeenCalledWith({ bm: 1 }, "done");
    expect(fs.state.dragging).toBe(false);
  });

  test("取消（pointercancel）／放回原處 ⇒ 零送出", () => {
    const { core, jumps } = makeCore({ v: INFO });
    const fs = new ListFastScroll(core, { document: null });
    fs.noteScroll();
    fs.dragStart(250);
    expect(fs.dragEnd(false)).toBe(false);
    // 放在視口頂端那篇自己的位置
    fs.noteScroll();
    fs.dragStart(0);
    fs._drag.frac = fastScrollFracOf(9100, 9300);
    expect(fs.dragEnd(true)).toBe(false);
    expect(jumps.length).toBe(0);
  });

  test("session 不收（交易中）⇒ 閱讀紀錄 cancel", () => {
    const { core, rr } = makeCore({ v: INFO });
    core.listSession.jumpToNumber = vi.fn(() => false);
    const fs = new ListFastScroll(core, { document: null });
    fs.noteScroll();
    fs.dragStart(120);
    fs.dragMove(480);
    expect(fs.dragEnd(true)).toBe(false);
    expect(rr.end).toHaveBeenCalledWith({ bm: 1 }, "cancel");
  });

  test("不出現：搜尋結果／不在緩衝（info＝null）、緩衝涵蓋整個看板、看板列表在畫", () => {
    const info = { v: null };
    const { core } = makeCore(info);
    const fs = new ListFastScroll(core, { document: null });
    fs.noteScroll();
    expect(fs.state.visible).toBe(false);
    info.v = { board: "C_Chat", lo: 1, hi: 120, topNum: 30, edgeDown: true };
    fs.noteScroll();
    expect(fs.state.visible).toBe(false);
    info.v = INFO;
    core.buf.listRenderOwner = "board-list";
    fs.noteScroll();
    expect(fs.state.visible).toBe(false);
  });
});
