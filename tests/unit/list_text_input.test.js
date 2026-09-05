// 列表好讀「文字輸入（IME）」合約：組字送出＝T3 整串 passthrough，與貼上同源。
//
// 舊行為：中文輸入法組完字後 compositionend → term_view.onInput → onTextInput →
// _convSend **裸送**，完全繞過 ListSession。IME 的 keydown keyCode 是 229，被
// term_view 的 keyEventFilter 擋在 onKeyDown 之外 ⇒ _classifyKey 的 passthrough
// （一鍵切原生）對 IME 永遠不觸發。兩個症狀：
//   a) 畫面仍是累積緩衝視窗，PTT 只 patch 最後一列畫的 prompt 完全看不見
//      ⇒ 使用者讀成「整個畫面卡住」；
//   b) bytes 繞過 CommandQueue，與 in-flight prefetch/jump 互撞（pttbbs typeahead）。
// 這與不變量 12b 修好的貼上 bug 是同一個形狀，故走同一條路（_beginTextPassthrough）。
//
// 新合約：noteTextInput(text) 回 true＝已接手（term_view 不得再 _convSend）；
// 有序號選取且 server 游標未同步時先 native-sync-jump，完成後 enter-function-mode
// ＋ native-input 佇列命令送整串 Big5 bytes。**不套 normalizePasteText**（那是
// 貼上專屬的換行／折行正規化，IME 送的是剛組完的一段字，沒有多行語意）。
import { ListSession } from "../../src/js/list_session";
import { normalizePasteText, u2b, ansiHalfColorConv } from "../../src/js/string_util";
import { loadBig5Tables } from "./helpers/load_big5_tables";

function makeSession() {
  const sent = [];
  const enqueued = [];
  const core = { conn: { isConnected: true, send: (d) => sent.push(d) } };
  const view = {
    hideCursor() {},
    showCursor() {},
    resetListAccumulation() {},
    flashListHint() {},
    lineWrap: 0,
    blacklist: new Set(),
    titleBlacklist: [],
  };
  const termBuf = {
    rows: 24,
    cols: 80,
    listLines: [],
    listLineNums: [],
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
    flush() {
      this.flushed = (this.flushed || 0) + 1;
    },
    flushPending() {
      this.pendingFlushed = (this.pendingFlushed || 0) + 1;
    },
    flushPendingKind() {},
    hasKind: () => false,
    enqueue(cmd) {
      enqueued.push(cmd);
    },
    onSettle() {},
  };
  const s = new ListSession(core, view, termBuf, queue);
  return { s, sent, enqueued, queue };
}

const TEXT = "測試";

describe("ListSession.noteTextInput — IME 送字＝一鍵切原生", () => {
  test("active＋游標未同步：先 native-sync-jump，完成後切原生＋native-input", () => {
    loadBig5Tables();
    const { s, sent, enqueued } = makeSession();
    s.state = "active";
    s._renderMode = "buffer";
    s._selectedNum = 42;

    expect(s.noteTextInput(TEXT)).toBe(true);
    // sync 腿在途不得閃現原生（同 passthrough／貼上）
    expect(s._renderMode).toBe("frozen");
    expect(enqueued.length).toBe(1);
    expect(enqueued[0].kind).toBe("native-sync-jump");
    expect(enqueued[0].keys).toBe("42\r");
    expect(sent).toEqual([]); // 全程不裸送

    enqueued[0].onDone();
    expect(s.state).toBe("functionMode");
    expect(s._renderMode).toBe("native");
    expect(enqueued[1].kind).toBe("native-input");
    expect(enqueued[1].keys).toBe(ansiHalfColorConv(u2b(TEXT)));
    expect(enqueued[1].expect()).toBe(true); // 任一 settle 即回應
    expect(sent).toEqual([]);
  });

  test("已同步（_serverNum===選取）→ 跳過 sync 腿，直接切原生＋native-input", () => {
    loadBig5Tables();
    const { s, sent, enqueued } = makeSession();
    s.state = "active";
    s._renderMode = "buffer";
    s._selectedNum = 7;
    s._serverNum = 7;

    expect(s.noteTextInput(TEXT)).toBe(true);
    expect(s.state).toBe("functionMode");
    expect(s._renderMode).toBe("native");
    expect(enqueued.length).toBe(1);
    expect(enqueued[0].kind).toBe("native-input");
    expect(sent).toEqual([]);
  });

  test("pinned/無選取（num null）→ 無跳號可同步，直接切原生＋native-input", () => {
    loadBig5Tables();
    const { s, enqueued } = makeSession();
    s.state = "active";
    s._selectedNum = null;
    s._selectedPinnedKey = "arrenwu|[公告] 板規";

    expect(s.noteTextInput(TEXT)).toBe(true);
    expect(enqueued.length).toBe(1);
    expect(enqueued[0].kind).toBe("native-input");
  });

  test("sync 腿失敗 → 仍送 native-input（顯性降級，不得靜默吞掉輸入）", () => {
    loadBig5Tables();
    const { s, enqueued } = makeSession();
    s.state = "active";
    s._selectedNum = 42;

    s.noteTextInput(TEXT);
    enqueued[0].onFail("timeout");
    expect(s.state).toBe("functionMode");
    expect(s._renderMode).toBe("native");
    expect(enqueued[1].kind).toBe("native-input");
    expect(enqueued[1].keys).toBe(ansiHalfColorConv(u2b(TEXT)));
  });

  test("切原生後有提示（不得無聲切換）", () => {
    loadBig5Tables();
    const { s } = makeSession();
    const hints = [];
    s._view.flashListHint = (m) => hints.push(m);
    s.state = "active";
    s._selectedNum = 7;
    s._serverNum = 7;
    s.noteTextInput(TEXT);
    expect(hints.length).toBeGreaterThan(0);
  });

  test("原生鏡像/idle（state 非 active）→ 回 false，交還原生裸送路徑", () => {
    loadBig5Tables();
    for (const state of ["idle", "functionMode", "suspended"]) {
      const { s, enqueued } = makeSession();
      s.state = state;
      s._renderMode = "native";
      expect(s.noteTextInput(TEXT)).toBe(false);
      expect(enqueued).toEqual([]);
    }
  });

  test("交易在途（opening / functionMode+frozen）→ 吞掉但回 true，且必有提示", () => {
    loadBig5Tables();
    for (const setup of [
      (s) => {
        s.state = "opening";
      },
      (s) => {
        s.state = "functionMode";
        s._renderMode = "frozen";
      },
    ]) {
      const { s, enqueued, sent } = makeSession();
      const hints = [];
      s._view.flashListHint = (m) => hints.push(m);
      setup(s);
      expect(s.noteTextInput(TEXT)).toBe(true);
      expect(enqueued).toEqual([]);
      expect(sent).toEqual([]);
      expect(hints.length).toBe(1); // 吞掉不得無聲
    }
  });

  test("空字串 → 回 false，不燒掉一次切原生", () => {
    loadBig5Tables();
    const { s, enqueued } = makeSession();
    s.state = "active";
    s._renderMode = "buffer";
    s._selectedNum = 42;
    expect(s.noteTextInput("")).toBe(false);
    expect(s.state).toBe("active");
    expect(s._renderMode).toBe("buffer");
    expect(enqueued).toEqual([]);
  });

  test("送出 bytes 與原生 convSend 路徑逐字相同（Big5＋半形色碼）", () => {
    loadBig5Tables();
    const { s, enqueued } = makeSession();
    const text = "測試 IME 中文";
    s.state = "active";
    s._selectedNum = 7;
    s._serverNum = 7;
    s.noteTextInput(text);
    expect(enqueued[0].keys).toBe(ansiHalfColorConv(u2b(text)));
  });

  test("IME 路徑不套 normalizePasteText（與貼上路徑的折行處理不同）", () => {
    loadBig5Tables();
    // 夠長才會被 wrapText 折：lineWrap=40 下貼上會插入 Enter，IME 不得插。
    const text = "abcdefghij".repeat(6); // 60 bytes > 40
    const { s, enqueued } = makeSession();
    s.state = "active";
    s._selectedNum = 7;
    s._serverNum = 7;
    s._view.lineWrap = 40;
    s.noteTextInput(text);

    const pasteBytes = ansiHalfColorConv(u2b(normalizePasteText(text, 40)));
    expect(enqueued[0].keys).toBe(ansiHalfColorConv(u2b(text)));
    // 前提成立：兩條路徑在此輸入上真的會產生不同 bytes（否則本測試沉默地永真）
    expect(pasteBytes).not.toBe(ansiHalfColorConv(u2b(text)));
  });
});
