// @unit-env browser
// Live 文小幫手（src/js/live_helper.js）：PTT 官方推文實況的操作面板背後的決策。
// 守的是「只在本幀認得出來的畫面上送那一個鍵」——舊版每 N 秒裸送 ←→End，推文型別選單上
// ← 被當成選「推」、游標在輸入欄時打進內容，都是因為不看本幀。
import {
  liveHelperView,
  liveHelperFacts,
  startLive,
  leaveLive,
  toggleLiveBell,
  sameLiveHelperView,
  formatLiveElapsed,
} from "../../src/js/live_helper";

const READ_ROW =
  "  瀏覽 第 1/3 頁 ( 50%)  目前顯示: 第 01~22 行 (y)回應(X)推文  (←)離開(h)說明  ";
const LIVE_ROW =
  " 實況中 01:05 [+2]  (X)留言 (B)鈴聲[關閉] (T/M/S)調時 (q)離開      09/27 09:06 ";
const TYPE_MENU = "您覺得這篇文章 1.值得推薦 2.給它噓聲 3.只加→註解 [1]? ";
const LIST_FOOTER = " 文章選讀  (y)回應(X)推文(^X)轉錄 ";

describe("面板顯示什麼（liveHelperView）", () => {
  test("pmore 文章頁 ⇒ 可以開始", () => {
    expect(liveHelperView({ pageState: 3, lastRowText: READ_ROW })).toEqual({ kind: "ready" });
  });

  test("實況畫面 ⇒ 計時、則數、鈴聲", () => {
    expect(liveHelperView({ pageState: 3, lastRowText: LIVE_ROW })).toEqual({
      kind: "live",
      elapsedSec: 65,
      received: 2,
      canComment: true,
      bell: false,
    });
  });

  test("pageState 黏在 3 但底列是推文型別選單 ⇒ 不能開始（v 會被 vkey() 當成預設的「推」）", () => {
    expect(liveHelperView({ pageState: 3, lastRowText: TYPE_MENU }).kind).toBe("unavailable");
  });

  test("游標在輸入欄（pmore 的 / 搜尋）⇒ 不能開始（v 會打進搜尋字串）", () => {
    expect(
      liveHelperView({ pageState: 3, lastRowText: READ_ROW, cursorOnInputField: true }).kind,
    ).toBe("unavailable");
  });

  test("列表、選單 ⇒ 不能開始", () => {
    expect(liveHelperView({ pageState: 2, lastRowText: LIST_FOOTER }).kind).toBe("unavailable");
    expect(liveHelperView({ pageState: 1, lastRowText: "" }).kind).toBe("unavailable");
  });

  test("線路上有序列化操作 ⇒ busy（實況中也是，免得插鍵進別人的序列）", () => {
    expect(liveHelperView({ pageState: 3, lastRowText: READ_ROW, busy: true }).kind).toBe("busy");
    expect(liveHelperView({ pageState: 3, lastRowText: LIVE_ROW, busy: true }).kind).toBe("busy");
  });
});

// 假的 App：只有本幀的底列、pageState，與送出的鍵。
function fakeCore({ lastRow, pageState = 3, easy = false, live = false, busy = false }) {
  const sent = [];
  const mirrored = [];
  const core = {
    buf: {
      rows: 24,
      cols: 80,
      pageState,
      getRowText: (r) => (r === 23 ? lastRow : ""),
      isCursorOnInputField: () => false,
    },
    view: { _send: (k) => sent.push(k), isLiveReading: () => live },
    commandQueue: { inFlightKind: busy ? "x" : null },
    easyReading: {
      _enabled: easy,
      startedEasyReading: easy,
      _functionMode: false,
      _enterFunctionMode() {
        mirrored.push(true);
      },
    },
  };
  core.easyReading._view = core.view;
  return { core, sent, mirrored };
}

describe("三個動作只在對的畫面送那一個鍵", () => {
  test("開始實況：文章頁送 v；好讀開著先切原生鏡像（v 失敗的 vmsg 才看得到）", () => {
    const a = fakeCore({ lastRow: READ_ROW });
    expect(startLive(a.core)).toBe(true);
    expect(a.sent).toEqual(["v"]);
    expect(a.mirrored).toEqual([]);
    const b = fakeCore({ lastRow: READ_ROW, easy: true });
    expect(startLive(b.core)).toBe(true);
    expect(b.sent).toEqual(["v"]);
    expect(b.mirrored).toEqual([true]);
  });

  test("開始實況：已經在實況、列表、指令在途 ⇒ 什麼都不送", () => {
    for (const c of [
      fakeCore({ lastRow: LIVE_ROW }),
      fakeCore({ lastRow: LIST_FOOTER, pageState: 2 }),
      fakeCore({ lastRow: READ_ROW, busy: true }),
    ]) {
      expect(startLive(c.core)).toBe(false);
      expect(c.sent).toEqual([]);
    }
  });

  test("離開實況：只在實況畫面送 q；好讀正在接實況就先切鏡像", () => {
    const a = fakeCore({ lastRow: LIVE_ROW, easy: true, live: true });
    expect(leaveLive(a.core)).toBe(true);
    expect(a.sent).toEqual(["q"]);
    expect(a.mirrored).toEqual([true]);
    const b = fakeCore({ lastRow: READ_ROW });
    expect(leaveLive(b.core)).toBe(false);
    expect(b.sent).toEqual([]);
  });

  test("鈴聲：只在實況畫面送 B，不切鏡像", () => {
    const a = fakeCore({ lastRow: LIVE_ROW, easy: true, live: true });
    expect(toggleLiveBell(a.core)).toBe(true);
    expect(a.sent).toEqual(["B"]);
    expect(a.mirrored).toEqual([]);
    const b = fakeCore({ lastRow: READ_ROW });
    expect(toggleLiveBell(b.core)).toBe(false);
  });

  test("沒有 buf ⇒ unavailable", () => {
    expect(liveHelperFacts({}).kind).toBe("unavailable");
  });
});

test("面板狀態沒變就不重 render；計時格式 mm:ss", () => {
  const v = liveHelperView({ pageState: 3, lastRowText: LIVE_ROW });
  expect(sameLiveHelperView(v, { ...v })).toBe(true);
  expect(sameLiveHelperView(v, { ...v, received: 3 })).toBe(false);
  expect(sameLiveHelperView({ kind: "ready" }, { kind: "ready" })).toBe(true);
  expect(sameLiveHelperView(null, { kind: "ready" })).toBe(false);
  expect(formatLiveElapsed(65)).toBe("01:05");
  expect(formatLiveElapsed(0)).toBe("00:00");
  // 432e98a：倒數到活動開始
  expect(formatLiveElapsed(-600)).toBe("-10:00");
  expect(formatLiveElapsed(-5)).toBe("-00:05");
  expect(formatLiveElapsed(-3)).toBe("-00:03");
});
