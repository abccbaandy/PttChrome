// 列表好讀「貼上」合約（2026-08 起）：貼上＝T3 整串 passthrough。
// 舊行為：貼上完全繞過 ListSession（App.onPasteDone → view.onTextInput →
// _convSend 裸送），加上 Shift+Insert 被 passthrough 的 preventDefault 吃掉，
// 症狀＝「第一次只切原生、要貼第二次」（Shift+Insert 的回歸守護在 list_keys.test.js）。
// 新合約：onPaste(text) 回 true＝已接手（呼叫端不得再送）；有序號選取且 server
// 游標未同步時先 native-sync-jump，完成後 enter-function-mode ＋ native-paste
// 佇列命令送整串 Big5 bytes。PTT 收到後的行為完全原生（# 仍要 Enter 才跳、
// 且只移游標不開文——pttbbs read.c#select_by_aid），本層不代按鍵、不特判 AID。
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
    enqueue(cmd) {
      enqueued.push(cmd);
    },
    onSettle() {},
  };
  const s = new ListSession(core, view, termBuf, queue);
  return { s, sent, enqueued, queue };
}

const AID = "#1gTTD8RU";

describe("ListSession.onPaste — 一次貼上即生效", () => {
  test("active＋游標未同步：先 native-sync-jump，完成後切原生＋native-paste", () => {
    const { s, sent, enqueued } = makeSession();
    s.state = "active";
    s._renderMode = "buffer";
    s._selectedNum = 42;

    expect(s.onPaste(AID)).toBe(true);
    // sync 腿在途不得閃現原生（同 passthrough）
    expect(s._renderMode).toBe("frozen");
    expect(enqueued.length).toBe(1);
    expect(enqueued[0].kind).toBe("native-sync-jump");
    expect(enqueued[0].keys).toBe("42\r");
    expect(sent).toEqual([]); // 全程不裸送

    enqueued[0].onDone();
    expect(s.state).toBe("functionMode");
    expect(s._renderMode).toBe("native");
    expect(enqueued[1].kind).toBe("native-paste");
    expect(enqueued[1].keys).toBe(AID);
    expect(enqueued[1].expect()).toBe(true); // 任一 settle 即回應
    expect(sent).toEqual([]);
  });

  test("已同步（_serverNum===選取）→ 跳過 sync 腿，直接切原生＋native-paste", () => {
    const { s, sent, enqueued } = makeSession();
    s.state = "active";
    s._renderMode = "buffer";
    s._selectedNum = 7;
    s._serverNum = 7;

    expect(s.onPaste(AID)).toBe(true);
    expect(s.state).toBe("functionMode");
    expect(s._renderMode).toBe("native");
    expect(enqueued.length).toBe(1);
    expect(enqueued[0].kind).toBe("native-paste");
    expect(enqueued[0].keys).toBe(AID);
    expect(sent).toEqual([]);
  });

  test("pinned/無選取（num null）→ 無跳號可同步，直接切原生＋native-paste", () => {
    const { s, enqueued } = makeSession();
    s.state = "active";
    s._selectedNum = null;
    s._selectedPinnedKey = "arrenwu|[公告] 板規";

    expect(s.onPaste(AID)).toBe(true);
    expect(enqueued.length).toBe(1);
    expect(enqueued[0].kind).toBe("native-paste");
  });

  test("sync 腿失敗 → 仍送 native-paste（顯性降級，不得靜默吞掉貼上）", () => {
    const { s, enqueued } = makeSession();
    s.state = "active";
    s._selectedNum = 42;

    s.onPaste(AID);
    enqueued[0].onFail("timeout");
    expect(s.state).toBe("functionMode");
    expect(s._renderMode).toBe("native");
    expect(enqueued[1].kind).toBe("native-paste");
    expect(enqueued[1].keys).toBe(AID);
  });

  test("切原生後有提示（不得無聲切換）", () => {
    const { s } = makeSession();
    const hints = [];
    s._view.flashListHint = (m) => hints.push(m);
    s.state = "active";
    s._selectedNum = 7;
    s._serverNum = 7;
    s.onPaste(AID);
    expect(hints.length).toBeGreaterThan(0);
  });

  test("原生鏡像/idle（state 非 active）→ 回 false，交還原生裸送路徑", () => {
    for (const state of ["idle", "functionMode", "suspended"]) {
      const { s, enqueued } = makeSession();
      s.state = state;
      s._renderMode = "native";
      expect(s.onPaste(AID)).toBe(false);
      expect(enqueued).toEqual([]);
    }
  });

  test("交易在途（opening / functionMode+frozen）→ 吞掉但回 true，且必有提示", () => {
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
      expect(s.onPaste(AID)).toBe(true);
      expect(enqueued).toEqual([]);
      expect(sent).toEqual([]);
      expect(hints.length).toBe(1); // 吞掉不得無聲
    }
  });

  test("空字串/空白貼上 → 回 false，不燒掉一次切原生", () => {
    const { s, enqueued } = makeSession();
    s.state = "active";
    s._renderMode = "buffer";
    s._selectedNum = 42;
    expect(s.onPaste("")).toBe(false);
    expect(s.state).toBe("active");
    expect(s._renderMode).toBe("buffer");
    expect(enqueued).toEqual([]);
  });

  test("尾隨換行照送 Enter（原生行為：貼上即送出 prompt），不額外代按鍵", () => {
    const { s, enqueued } = makeSession();
    s.state = "active";
    s._selectedNum = 7;
    s._serverNum = 7;
    s.onPaste(AID + "\n");
    expect(enqueued[0].keys).toBe(AID + "\r");
  });

  test("送出 bytes 與原生 convSend 路徑逐字相同（Big5＋半形色碼）", () => {
    loadBig5Tables();
    const { s, enqueued } = makeSession();
    const text = "測試 paste 中文";
    s.state = "active";
    s._selectedNum = 7;
    s._serverNum = 7;
    s._view.lineWrap = 0;
    s.onPaste(text);
    // 原生路徑＝view.onTextInput(text, true) → _convSend → conn.convSend
    expect(enqueued[0].keys).toBe(
      ansiHalfColorConv(u2b(normalizePasteText(text, 0)))
    );
  });
});
