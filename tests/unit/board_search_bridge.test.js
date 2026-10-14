// 搜尋彈窗「看板」種類的原生補全橋接（src/js/board_search_bridge.js）。
//
// 守的是使用者要的行為（比照 PTT 原生的 namecomplete，mbbsd/name.c）：
//   1. 不存在的看板開頭打不進去（PTT 回 bell 丟字 ⇒ 我們讀輸入欄知道哪個字被拒）。
//   2. 打字即查，讀回 PTT 畫的「相關資訊一覽表」當建議清單。
//   3. 送出／取消都在**同一個**已開的 prompt 上做，不會再按一次 `s`（字母落進輸入欄）。
//   4. 收尾期間握著 searchInFlight，prompt 消失前使用者的鍵不可落進 prompt。
import {
  acceptedPrefixLength,
  BoardSearchBridge,
  boardQueryResult,
  parseBoardPromptFrame,
  resolvedBoardName,
  sanitizeBoardQuery,
} from "../../src/js/board_search_bridge";
import { CommandQueue } from "../../src/js/command_queue";

const ROWS = 24;
const PROMPT = "請輸入看板名稱(按空白鍵自動搜尋): ";
const DASH = "----------------------------- 相關資訊一覽表 -----------------------------";

function listFrame() {
  const rowTexts = Array.from({ length: ROWS }, () => "");
  rowTexts[0] = " 【板主:none】看板《Test》";
  rowTexts[23] = " 文章選讀  (y)回應(X)推文(^X)轉錄 ";
  return { rowTexts, rows: ROWS, curX: 0, curY: 5 };
}

// do_select 的版面：row0 標題、row1 prompt＋輸入欄、row2 分隔線、row3 起每欄 22 格
//（len 20 + 2）。columns：每欄一個陣列，依 PTT 的「先往下填滿再換欄」。
function promptFrame(field, columns, opts) {
  const o = opts || {};
  const width = o.colWidth || 22;
  const rowTexts = Array.from({ length: ROWS }, () => "");
  rowTexts[0] = "【 選擇看板 】";
  rowTexts[1] = PROMPT + field.padEnd(20);
  if (columns) {
    rowTexts[2] = DASH;
    columns.forEach((col, c) => {
      col.forEach((name, r) => {
        rowTexts[3 + r] = rowTexts[3 + r].padEnd(c * width) + name + " ";
      });
    });
  }
  if (o.more) rowTexts[23] = "按空白鍵可列出更多項目";
  return { rowTexts, rows: ROWS, curX: PROMPT.length + field.length, curY: 1 };
}

describe("parseBoardPromptFrame", () => {
  test("讀出輸入欄與依欄順序排的清單", () => {
    const f = promptFrame("go", [["GO", "Golf"], ["Gossiping"]]);
    expect(parseBoardPromptFrame(f)).toEqual({
      field: "go",
      candidates: ["GO", "Golf", "Gossiping"],
      more: false,
    });
  });

  test("看板列表的 s（欄寬 15）同樣讀得出來；有下一頁會標 more", () => {
    const f = promptFrame("a", [["A1", "A2"], ["AB", "AC"], ["AD"]], {
      colWidth: 15,
      more: true,
    });
    f.rowTexts[0] = "【 搜尋全站看板 】  (若要限定搜尋範圍為目前列表請改用 Ctrl-S)";
    const p = parseBoardPromptFrame(f);
    expect(p.candidates).toEqual(["A1", "A2", "AB", "AC", "AD"]);
    expect(p.more).toBe(true);
  });

  test("輸入欄與冒號之間的空白數不寫死", () => {
    const f = promptFrame("", null);
    f.rowTexts[1] = "請輸入看板名稱(按空白鍵自動搜尋):   Android     ";
    expect(parseBoardPromptFrame(f).field).toBe("Android");
  });

  test("還沒按過空白鍵＝沒有清單（null，不是空陣列）", () => {
    expect(parseBoardPromptFrame(promptFrame("", null)).candidates).toBe(null);
  });

  test("不是看板 prompt 回 null", () => {
    expect(parseBoardPromptFrame(listFrame())).toBe(null);
  });
});

describe("純函式", () => {
  test("sanitizeBoardQuery：只留可列印 ASCII、去空白、最長 12", () => {
    expect(sanitizeBoardQuery(" Gos sip中ing ")).toBe("Gossiping");
    expect(sanitizeBoardQuery("abcdefghijklmnop")).toBe("abcdefghijkl");
  });

  test("acceptedPrefixLength：大小寫不分的共同前綴＝第一個被拒的字", () => {
    expect(acceptedPrefixLength("bbb", "bb")).toBe(2);
    // 被拒的字後面的字又被收下（bbx1 → bb1）：仍判在 x
    expect(acceptedPrefixLength("bbx1", "bb1")).toBe(2);
    expect(acceptedPrefixLength("gos", "Gossiping")).toBe(3);
  });

  test("boardQueryResult：被拒時不給清單；收下時 completion＝延伸後的輸入欄", () => {
    const ok = boardQueryResult("goss", parseBoardPromptFrame(promptFrame("Gossiping", [["Gossiping"]])));
    expect(ok).toMatchObject({ rejected: false, completion: "Gossiping", candidates: ["Gossiping"] });
    const bad = boardQueryResult("bbb", parseBoardPromptFrame(promptFrame("bb", [["BB1", "BB2"]])));
    expect(bad).toMatchObject({ rejected: true, accepted: 2, candidates: [] });
  });

  test("resolvedBoardName：唯一符合或完全相符才算（同 PTT 的 Enter 規則）", () => {
    const r = (q, field, cols, more) =>
      boardQueryResult(q, parseBoardPromptFrame(promptFrame(field, cols, { more })));
    expect(resolvedBoardName(r("goss", "Gossiping", [["Gossiping"]]), "goss")).toBe("Gossiping");
    expect(resolvedBoardName(r("go", "go", [["GO", "Golf"]]), "go")).toBe("GO");
    expect(resolvedBoardName(r("gol", "gol", [["Golf", "Golfer"]]), "gol")).toBe("");
    // 只有一筆但後面還有頁 ⇒ 不是唯一
    expect(resolvedBoardName(r("x", "x", [["Xa"]], true), "x")).toBe("");
    // 結論是別的字的 ⇒ 不採用
    expect(resolvedBoardName(r("goss", "Gossiping", [["Gossiping"]]), "gos")).toBe("");
  });
});

function setup(opts) {
  vi.useFakeTimers();
  const sent = [];
  const queue = new CommandQueue({ send: (s) => sent.push(s) });
  // 「當下畫面」＝最後一次 settle 的那幀（橋接在逾時後會回頭量 buf）。
  let screen = listFrame();
  const buf = {
    rows: ROWS,
    cols: 80,
    get cur_x() {
      return screen.curX;
    },
    get cur_y() {
      return screen.curY;
    },
    getRowText: (r) => screen.rowTexts[r] || "",
  };
  const core = { commandQueue: queue, buf, searchInFlight: false, ...(opts && opts.core) };
  const updates = [];
  const bridge = new BoardSearchBridge(core, (u) => updates.push(u));
  const settle = (f) => {
    screen = f;
    queue.onSettle(null, f);
  };
  return { sent, queue, core, bridge, updates, settle };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("BoardSearchBridge（共用 CommandQueue）", () => {
  test("開啟：送 s，prompt 出現才算 ready；打字即查（字＋空白鍵＋\\f）", () => {
    const t = setup();
    expect(t.sent).toEqual(["s\f"]);
    expect(t.bridge.status).toBe("opening");
    t.bridge.query("go"); // prompt 還沒出現：先不送
    expect(t.sent).toEqual(["s\f"]);
    t.settle(promptFrame("", null));
    expect(t.bridge.status).toBe("ready");
    expect(t.sent[1]).toBe("go \f");
    t.settle(promptFrame("go", [["GO", "Golf", "Gossiping"]]));
    expect(t.bridge.result).toMatchObject({ query: "go", candidates: ["GO", "Golf", "Gossiping"] });
  });

  test("下一趟先退格清掉 PTT 輸入欄（含空白鍵延伸出來的字）再重打", () => {
    const t = setup();
    t.settle(promptFrame("", null));
    t.bridge.query("goss");
    t.settle(promptFrame("Gossiping", [["Gossiping"]]));
    t.bridge.query("gos");
    expect(t.sent[2]).toBe("\b".repeat(9) + "gos \f");
  });

  test("被拒的字：結論標 rejected＋收下幾個字（彈窗據此退回）", () => {
    const t = setup();
    t.settle(promptFrame("", null));
    t.bridge.query("bbb");
    t.settle(promptFrame("bb", [["BB1", "BB2"]]));
    expect(t.bridge.result).toMatchObject({ query: "bbb", rejected: true, accepted: 2 });
  });

  test("回應回來前連打：只查最新的那串（不會一個字一趟排隊）", () => {
    const t = setup();
    t.settle(promptFrame("", null));
    t.bridge.query("a");
    t.bridge.query("ab");
    t.bridge.query("abc");
    expect(t.sent).toEqual(["s\f", "a \f"]);
    t.settle(promptFrame("a", [["A1", "AB"]]));
    expect(t.sent[2]).toBe("\b" + "abc \f");
  });

  test("還掛著上一趟清單的中間幀不算結論（清單每項都要以輸入欄開頭）", () => {
    const t = setup();
    t.settle(promptFrame("", null));
    t.bridge.query("go");
    t.settle(promptFrame("go", [["GO", "Golf"]]));
    t.bridge.query("b");
    t.settle(promptFrame("b", [["GO", "Golf"]])); // 舊清單
    expect(t.bridge.result.query).toBe("go");
    t.settle(promptFrame("b", [["BB1", "Baseball"]]));
    expect(t.bridge.result).toMatchObject({ query: "b", candidates: ["BB1", "Baseball"] });
  });

  test("送出：在同一個 prompt 上退格＋板名＋Enter，不再按 s；prompt 消失前握著 searchInFlight", () => {
    const t = setup();
    t.settle(promptFrame("", null));
    t.bridge.query("goss");
    t.settle(promptFrame("Gossiping", [["Gossiping"]]));
    const onDone = vi.fn();
    expect(t.bridge.submit("Gossiping", { onDone })).toBe(true);
    expect(t.core.searchInFlight).toBe(true);
    expect(t.sent[2]).toBe("\b".repeat(9) + "Gossiping\r");
    t.settle(promptFrame("Gossiping", [["Gossiping"]])); // 還在 prompt：不算
    expect(onDone).not.toHaveBeenCalled();
    t.settle(listFrame());
    expect(onDone).toHaveBeenCalled();
    expect(t.core.searchInFlight).toBe(false);
  });

  test("送出排在查詢後面：查詢落地才送", () => {
    const t = setup();
    t.settle(promptFrame("", null));
    t.bridge.query("go");
    t.bridge.submit("GO");
    expect(t.sent).toEqual(["s\f", "go \f"]);
    t.settle(promptFrame("go", [["GO", "Golf"]]));
    expect(t.sent[2]).toBe("\b\bGO\r");
  });

  test("取消：Ctrl-C（ESC 不是 vgetstring 的取消鍵）；prompt 還沒開出來就等它開了再取消", () => {
    const t = setup();
    t.bridge.cancel();
    expect(t.core.searchInFlight).toBe(true);
    expect(t.sent).toEqual(["s\f"]);
    t.settle(promptFrame("", null));
    expect(t.sent[1]).toBe("\x03\f");
    t.settle(listFrame());
    expect(t.core.searchInFlight).toBe(false);
    expect(t.bridge.submit("x")).toBe(false); // 收尾後不再送任何東西
  });

  test("命令逾時：探針幀其實就是答案 ⇒ 照樣採用；判不出來 ⇒ unknown，不卡住後續查詢", () => {
    const t = setup();
    t.settle(promptFrame("", null));
    t.bridge.query("go");
    vi.advanceTimersByTime(3000); // 回應遲到：soft timeout → \f 探針
    t.settle(promptFrame("go", [["GO", "Golf"]]));
    expect(t.bridge.result).toMatchObject({ query: "go", candidates: ["GO", "Golf"] });

    t.bridge.query("gol");
    vi.advanceTimersByTime(10000); // server 完全沒回
    expect(t.bridge.result).toMatchObject({ query: "gol", unknown: true });
    expect(t.bridge.status).toBe("ready");
    t.bridge.query("golf");
    expect(t.sent[t.sent.length - 1]).toBe("\b\bgolf \f");
  });

  test("prompt 沒開出來（探針幀仍是列表）：unavailable，送出交回呼叫端", () => {
    const t = setup();
    vi.advanceTimersByTime(3000); // soft timeout → \f 探針
    expect(t.sent).toEqual(["s\f", "\f"]);
    t.settle(listFrame());
    expect(t.bridge.status).toBe("unavailable");
    expect(t.bridge.submit("Gossiping")).toBe(false);
    t.bridge.query("go");
    expect(t.sent).toEqual(["s\f", "\f"]);
  });

  test("被別的擁有者 flush（離板、開文）：unavailable、放開 searchInFlight、送出回報失敗", () => {
    const t = setup();
    t.settle(promptFrame("", null));
    const onFail = vi.fn();
    t.bridge.query("go");
    t.bridge.submit("GO", { onFail });
    t.queue.flush();
    expect(t.bridge.status).toBe("unavailable");
    expect(t.core.searchInFlight).toBe(false);
    expect(onFail).toHaveBeenCalledWith("lost");
  });

  test("列表 session 接管中：開啟走它的 passthrough（cursor sync＋原生鏡像）；凍結中則不送", () => {
    const owner = { state: "active", _renderMode: "buffer", _beginPassthroughBytes: vi.fn() };
    const t = setup({ core: { activeListSession: () => owner } });
    expect(owner._beginPassthroughBytes).toHaveBeenCalledTimes(1);
    const [steps, opts] = owner._beginPassthroughBytes.mock.calls[0];
    expect(steps[0].keys).toBe("s");
    expect(opts).toMatchObject({ kind: "search-board", hint: null });
    expect(t.sent).toEqual([]);

    const frozen = { state: "functionMode", _renderMode: "frozen", _beginPassthroughBytes: vi.fn() };
    const t2 = setup({ core: { activeListSession: () => frozen } });
    expect(frozen._beginPassthroughBytes).not.toHaveBeenCalled();
    expect(t2.bridge.status).toBe("unavailable");
  });
});
