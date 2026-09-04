// 回歸守護：文章中按 `\`（pmore 快速設定 - 色彩(ANSI碼)顯示模式）切換顯示模式後，
// 好讀畫面**當場不生效、必須重進文章**。
//
// 根因（實錄，見 docs/easy-reading.md「pmore 設定頁」）：好讀畫的是累積長頁
// buf.pageLines，去重的主判準是狀態列的絕對行號。離開設定頁時 pmore 只重畫「目前
// 這一頁」，而「預設格式化 ↔ 純文字」離開後的行號完全相同（實錄：切換前後都是
// 「第 33~55 行」）⇒ 續接分支算出 begin === newRows.length ⇒ 一列都不 append ⇒
// pageLines 裡仍是舊 rawmode 的舊 chars。切「原始ANSI控制碼」更糟：離開後停在
// 66%，翻頁狀態機會把新格式的推文接在舊格式的長頁尾巴後面。
//
// 修法：functionMode 期間看過 pmore 設定頁 ⇒ 'resume' 時改走 reenterFromTop
// （整篇重讀）而不是續接。這裡用真的 EasyReading 實例驅動兩次 settle
// （設定頁那一幀 → 文章回來那一幀），斷言送出 Home 且 pageLines 被清空。
//
// 反向那條**才是重點**：沒看過設定頁的一般 prompt（X 推文、r 回應…）退出時
// 必須維持現行的續接路徑、一個 byte 都不送。
import { EasyReading } from "../../src/js/easy_reading";

vi.mock("../../src/js/pref_storage", () => ({
  readValuesWithDefault: vi.fn(() => ({ enableEasyReading: true })),
}));

const ROWS = 24;
const COLS = 80;

// 文章第 3/3 頁的狀態列（錄製檔逐字）。rowIndexStart = 33 > 1 ⇒ reenterFromTop 會送 Home。
const STATUS_ROW =
  "  瀏覽 第 3/3 頁 (100%)  目前顯示: 第 33~55 行  (y)回應(X%)推文(h)說明(←)離開  ";
// 快速設定頁的三列（錄製檔逐字，畫在 row 21..23）。
const PREF_TITLE =
  " piaip's more: pmore 2007+ 快速設定 - 色彩(ANSI碼)顯示模式                      ";
const PREF_OPTIONS =
  " \\ 色彩顯示方式:         1 預設格式化內容 |2 原始ANSI控制碼 |3*純文字           ";
const PREF_PROMPT =
  " ◆ 請調整設定 (1-3 可直接選定，\\可切換) 或其它任意鍵結束。     [按任意鍵繼續]  ";
// 一般 in-post prompt（X 推文）：不是設定頁，但一樣走 functionMode。
const PUSH_PROMPT =
  "  這是一篇好文章嗎? [1.推薦] 2.噓文 3.註解 4.取消 [1]:                          ";

function makeHarness() {
  const sent = [];
  const rows = new Array(ROWS).fill("");
  const listeners = {};
  const buf = {
    rows: ROWS,
    cols: COLS,
    pageState: 3,
    prevPageState: 0,
    pageLines: [{ fake: "old-rawmode-row" }],
    lineChangeds: new Array(ROWS).fill(false),
    changed: false,
    cur_x: COLS - 1,
    cur_y: ROWS - 1,
    easyReadingPendingReset: false,
    easyReadingGapDetected: false,
    easyReadingHealInFlight: false,
    startedEasyReading: true,
    easyReadingFunctionMode: false,
    settleSnapshot: null,
    getRowText: (r) => rows[r] || "",
    notify() {},
    addEventListener(name, fn) {
      (listeners[name] = listeners[name] || []).push(fn);
    },
  };
  const view = {
    useEasyReadingMode: true,
    mainDisplay: { scrollTop: 0 },
    mainContainer: { style: {} },
    _send: (d) => sent.push(d),
    _lastAccumulatedSig: null,
    hideEasyReadingOverlays() {},
  };
  const core = { aidNavigation: null, commandQueue: null, connectedUrl: {} };
  const er = new EasyReading(core, view, buf);
  er._enabled = true;
  er._functionMode = true;
  return { er, buf, view, sent, rows, listeners };
}

const settle = (h) => h.er._onScreenSettled();

const showPrefScreen = (h) => {
  h.rows.fill("");
  h.rows[21] = PREF_TITLE;
  h.rows[22] = PREF_OPTIONS;
  h.rows[23] = PREF_PROMPT;
  h.buf.pageState = 5; // vmsg 的 [按任意鍵繼續]
  h.buf.cur_y = 23;
};

const showArticle = (h) => {
  h.rows.fill("");
  h.rows[23] = STATUS_ROW;
  h.buf.pageState = 3;
  h.buf.cur_y = ROWS - 1;
};

describe("離開 pmore 設定頁 → 整篇重讀", () => {
  test("設定頁那一幀不退出 functionMode（vmsg 提示列 ⇒ pageState 5 ⇒ 'stay'）", () => {
    const h = makeHarness();
    showPrefScreen(h);
    settle(h);
    expect(h.er._functionMode).toBe(true);
    expect(h.er._pmorePrefSeen).toBe(true);
    expect(h.sent).toEqual([]);
  });

  test("設定頁 → 文章 ⇒ 送 Home、清空 pageLines、重新開始累積", () => {
    const h = makeHarness();
    showPrefScreen(h);
    settle(h);
    showArticle(h);
    settle(h);
    expect(h.er._functionMode).toBe(false);
    // reenterFromTop：rowIndexStart(33) > 1 ⇒ 把 Home 當一筆 in-flight 交易送出。
    expect(h.sent).toEqual(["\x1b[1~"]);
    expect(h.buf.pageLines).toEqual([]);
    expect(h.buf.easyReadingPendingReset).toBe(true);
    expect(h.buf.prevPageState).toBe(0); // 「新文章」分支，不是續接
    // 一次性旗標必須消費掉，否則之後每個 prompt 退出都會誤觸整篇重讀。
    expect(h.er._pmorePrefSeen).toBe(false);
  });

  test("順手記下選中的色彩顯示模式（給「開燈」按鈕的標籤用）", () => {
    const h = makeHarness();
    expect(h.er.rawMode).toBe(null);
    showPrefScreen(h);
    settle(h);
    expect(h.er.rawMode).toBe(2); // 3*純文字
  });

  test("一般 prompt（X 推文）退出 → 維持現行續接路徑，一個 byte 都不送", () => {
    const h = makeHarness();
    h.rows.fill("");
    h.rows[23] = PUSH_PROMPT;
    h.buf.pageState = 5;
    settle(h);
    expect(h.er._pmorePrefSeen).toBe(false);
    showArticle(h);
    settle(h);
    expect(h.er._functionMode).toBe(false);
    expect(h.sent).toEqual([]);
    expect(h.buf.pageLines.length).toBe(1); // 累積長頁原封不動
    expect(h.buf.prevPageState).toBe(3); // 續接分支
  });

  test("說明頁（h）不算設定頁 → 不重讀", () => {
    const h = makeHarness();
    h.rows.fill("");
    h.rows[21] = " piaip's more: pmore 2007+ 瀏覽程式使用說明";
    h.buf.pageState = 5;
    settle(h);
    expect(h.er._pmorePrefSeen).toBe(false);
  });

  test("好讀關著（原生模式）也追蹤 rawmode，但不設整篇重讀的旗標", () => {
    const h = makeHarness();
    h.er._enabled = false;
    h.er._functionMode = false;
    showPrefScreen(h);
    settle(h);
    expect(h.er.rawMode).toBe(2);
    expect(h.er._pmorePrefSeen).toBe(false);
  });
});
