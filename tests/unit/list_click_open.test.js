// 列表好讀模式的滑鼠點擊（2026-08-15）。
//
// 壞過的行為：滑鼠移動時有光棒反應，點下去完全沒事——App.mouse_click 對
// listRenderMode buffer/frozen 直接 preventDefault + return（2026-07-08 移除
// 「點擊只移動選取」時留下的封鎖）。現在的合約是「單擊＝移到那一列並開文」，
// 而且**必須**走既有的 _beginOpen 交易（序號跳轉 → Enter），不得像原生滑鼠瀏覽
// 那樣依畫面幾何直接送方向鍵——虛擬視窗的座標與 server 真游標並不對應。
import { ListSession } from "../../src/js/list_session";
import { LIST_HEADER_ROWS } from "../../src/js/list_window";
import { LIST_TITLE_COL_START } from "../../src/js/comment_parse";

// listLines 只需要能被 rowToText 讀（pinnedRowKey 用）：一列 = TermChar-like 陣列。
function rowOf(text) {
  return text.split("").map((c) => ({ ch: c, isLeadByte: false }));
}

function makeSession({ count = 8, pinned = 0, misclickGuard = true } = {}) {
  const sent = [];
  const enqueued = [];
  const hints = [];
  const core = { conn: { isConnected: true, send: (d) => sent.push(d) } };
  const view = {
    hideCursor() {},
    showCursor() {},
    resetListAccumulation() {},
    flashListHint: (m) => hints.push(m),
    setListLoading() {},
    blacklist: new Set(),
    titleBlacklist: [],
    // 防誤觸模式（pref mouseMisclickGuard，預設開）＝只有標題欄可開文。
    mouseMisclickGuard: misclickGuard,
  };
  const listLines = [];
  const listLineNums = [];
  for (let i = 0; i < count; ++i) {
    listLines.push(rowOf(`${101 + i} + author${i}   標題${i}`));
    listLineNums.push(101 + i);
  }
  for (let i = 0; i < pinned; ++i) {
    listLines.push(rowOf(`  ★ + pinner${i}   置底${i}`));
    listLineNums.push(null);
  }
  const termBuf = {
    rows: 24,
    cols: 80,
    useMouseBrowsing: true,
    listLines,
    listLineNums,
    lineChangeds: new Array(24).fill(false),
    changed: false,
    // 靜置探針（非導覽操作完成後自動回好讀）會在 hold 期間量一次當下畫面，
    // 所以 stub 也要有 TermBuf 的畫面讀取介面（真的 TermBuf 一定有）。
    getRowText: () => "",
    isUnicolor: () => false,
    cur_x: 0,
    cur_y: 0,
    addEventListener() {},
    notify() {},
  };
  const queue = {
    idle: true,
    inFlightKind: null,
    flush() {},
    flushPending() {},
    flushPendingKind() {},
    enqueue(cmd) {
      enqueued.push(cmd);
    },
    onSettle() {},
  };
  const s = new ListSession(core, view, termBuf, queue);
  s.state = "active";
  s._renderMode = "buffer";
  s._edgeUp = true;
  s._edgeDown = true; // 讓置底文進入可選序列（native parity：只有最後一頁才有）
  s._selectedNum = 101;
  s._topNum = 101;
  return { s, sent, enqueued, hints };
}

// 渲染列號：body 第 idx 列 = 3 + idx
const bodyRow = (idx) => LIST_HEADER_ROWS + idx;

// 標題欄的任一格（欄位對 pttbbs bbs.c#readdoent 校準，見 comment_parse.js）。
// 虛擬視窗的欄位與 server 逐格對齊，所以原生的欄位表在這裡照樣成立。
const TITLE_COL = LIST_TITLE_COL_START + 5;

describe("ListSession.onMouseClick", () => {
  test("點第 3 個 body 列 → 選取移到該篇並開文（序號跳轉，不送 raw 方向鍵）", () => {
    const { s, sent, enqueued } = makeSession();
    s.onMouseClick(bodyRow(2), TITLE_COL);
    expect(s._selectedNum).toBe(103);
    expect(s.state).toBe("opening");
    expect(s._renderMode).toBe("frozen");
    // 開文一律走 CommandQueue 的序號跳轉，絕不直送 bytes
    expect(sent).toEqual([]);
    expect(enqueued.length).toBe(1);
    expect(enqueued[0].keys).toBe("103\r");
    expect(enqueued[0].kind).toBe("open-jump");
  });

  test("點目前已選取的那一列：一樣直接開文", () => {
    const { s, enqueued } = makeSession();
    s.onMouseClick(bodyRow(0), TITLE_COL);
    expect(s._selectedNum).toBe(101);
    expect(enqueued[0].keys).toBe("101\r");
  });

  test("點置底文（無序號）走 open-pinned 路徑", () => {
    const { s, enqueued } = makeSession({ count: 3, pinned: 2 });
    s.onMouseClick(bodyRow(3), TITLE_COL); // index 3 = 第一篇置底
    expect(s._selectedNum).toBe(null);
    expect(s._selectedPinnedKey).toBeTruthy();
    expect(s.state).toBe("opening");
    expect(enqueued.length).toBeGreaterThan(0);
  });

  test("點空白補列（短頁 filler）：完全不動作", () => {
    const { s, enqueued } = makeSession({ count: 3 });
    s.onMouseClick(bodyRow(10), TITLE_COL); // 只有 3 篇，第 10 格是 filler
    expect(s.state).toBe("active");
    expect(enqueued).toEqual([]);
  });

  test("點 header／footer 列：完全不動作", () => {
    const { s, enqueued } = makeSession();
    s.onMouseClick(0, TITLE_COL);
    s.onMouseClick(2, TITLE_COL);
    s.onMouseClick(23, TITLE_COL);
    expect(s.state).toBe("active");
    expect(enqueued).toEqual([]);
  });

  test("frozen（開文交易進行中）：吞掉並給提示，不排新指令", () => {
    const { s, enqueued, hints } = makeSession();
    s.state = "opening";
    s._renderMode = "frozen";
    s.onMouseClick(bodyRow(1), TITLE_COL);
    expect(enqueued).toEqual([]);
    expect(hints.length).toBe(1);
  });

  // 欄位限制：改版前整列（col 7..63）都可開文，點到日期或作者欄就誤開文章。
  test("點作者欄最後一格（col 29）：完全不動作", () => {
    const { s, enqueued } = makeSession();
    s.onMouseClick(bodyRow(2), LIST_TITLE_COL_START - 1);
    expect(s.state).toBe("active");
    expect(enqueued).toEqual([]);
  });

  test("點序號／日期欄：完全不動作", () => {
    const { s, enqueued } = makeSession();
    [0, 6, 12, 20].forEach((col) => s.onMouseClick(bodyRow(2), col));
    expect(s.state).toBe("active");
    expect(enqueued).toEqual([]);
  });

  test("標題欄第一格（col 30）就可以開文", () => {
    const { s, enqueued } = makeSession();
    s.onMouseClick(bodyRow(2), LIST_TITLE_COL_START);
    expect(s._selectedNum).toBe(103);
    expect(enqueued.length).toBe(1);
  });

  test("防誤觸關閉：整條都能開文", () => {
    [0, 6, 12, LIST_TITLE_COL_START - 1].forEach((col) => {
      const { s, enqueued } = makeSession({ misclickGuard: false });
      s.onMouseClick(bodyRow(2), col);
      expect(s._selectedNum).toBe(103);
      expect(enqueued.length).toBe(1);
    });
  });

  test("原生鏡像（renderMode native）：不處理，交給原生滑鼠瀏覽", () => {
    const { s, enqueued, hints } = makeSession();
    s._renderMode = "native";
    s.onMouseClick(bodyRow(1), TITLE_COL);
    expect(enqueued).toEqual([]);
    expect(hints).toEqual([]);
  });
});
