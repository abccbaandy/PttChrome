// 文章列表右鍵／長按「稍後再讀」（P53，list_session.readLaterAt、docs/recent-articles.md）。
//
// 列表的列沒有 AID ⇒ 替使用者在那一列按 Q（bbs.c#view_postinfo 資訊框）讀 AID，再送空白關框。
// 承重點：
//   1. 空白只在認出資訊框之後才送。框沒出現時列表上的空白是翻頁（使用者的視野跑掉）。
//   2. 真游標沒對到那一列（同步腿失敗）⇒ 不送 Q：Q 落在別列就收錯篇。
//   3. 自動回好讀（enableListNativeAutoResume）關掉時不給：那條路同步失敗照送。
//   4. 回答只在框關掉、回到乾淨的列表之後才交出去。
// 畫面判準（postInfoAnswer、關框落地）用 upstream 產的畫面守在 ptt_src_screens.test.js。
const prefOverride = vi.hoisted(() => ({}));
vi.mock("../../src/js/pref_storage", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, readEffectivePrefs: () => ({ ...real.readEffectivePrefs(), ...prefOverride }) };
});
import { ListSession } from "../../src/js/list_session";
import { LIST_HEADER_ROWS } from "../../src/js/list_window";

function rowOf(text) {
  return text.split("").map((c) => ({ ch: c, isLeadByte: false }));
}

function makeSession({ count = 8 } = {}) {
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
    mouseListClickStart: "title",
  };
  const listLines = [];
  const listLineNums = [];
  for (let i = 0; i < count; ++i) {
    listLines.push(rowOf(`${101 + i} + author${i}   標題${i}`));
    listLineNums.push(101 + i);
  }
  const termBuf = {
    rows: 24,
    cols: 80,
    useMouseBrowsing: true,
    listLines,
    listLineNums,
    lineChangeds: new Array(24).fill(false),
    changed: false,
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
    hasKind: () => false,
    enqueue(cmd) {
      enqueued.push(cmd);
    },
    onSettle() {},
  };
  const s = new ListSession(core, view, termBuf, queue);
  s.state = "active";
  s._renderMode = "buffer";
  s._edgeUp = true;
  s._edgeDown = true;
  s._selectedNum = 101;
  s._serverNum = 101;
  s._topNum = 101;
  return { s, sent, enqueued, hints };
}

const bodyRow = (idx) => LIST_HEADER_ROWS + idx;
const stepOf = (enqueued, kind) => enqueued.find((c) => c.kind === kind);

function facts(extra, kind) {
  const rowTexts = [];
  for (let r = 0; r < 24; ++r) rowTexts.push("");
  rowTexts[0] = "  【板主：nobody】";
  for (let r = 3; r < 23; ++r) rowTexts[r] = `  ${100 + r} + author  標題`;
  Object.keys(extra || {}).forEach((k) => {
    rowTexts[Number(k)] = extra[k];
  });
  return { rowTexts, rows: 24, kind: kind || null };
}

const BOX = {
  8: "┌─────────────────────────────────────┐",
  9: "│ 文章代碼(AID): #1aBcDeFg (Test) [ptt.cc] [問題] 第一篇",
  10: "│ 文章網址: https://www.ptt.cc/bbs/Test/M.1700000000.A.123.html",
  23: "                        請按任意鍵繼續",
};

afterEach(() => {
  for (const k of Object.keys(prefOverride)) delete prefOverride[k];
});

describe("readLaterTargetAtRow", () => {
  test("跟前已讀後未讀同一組列條件", () => {
    const { s } = makeSession({ count: 5 });
    expect(s.readLaterTargetAtRow(bodyRow(2))).toEqual({ num: 103 });
    expect(s.readLaterTargetAtRow(0)).toBe(null);
    expect(s.readLaterTargetAtRow(bodyRow(5))).toBe(null);
    s._renderMode = "native";
    expect(s.readLaterTargetAtRow(bodyRow(2))).toBe(null);
  });

  test("自動回好讀關掉 ⇒ 不給（readLaterAt 也不接）", () => {
    prefOverride.enableListNativeAutoResume = false;
    const { s, enqueued } = makeSession();
    expect(s.readLaterTargetAtRow(bodyRow(2))).toBe(null);
    expect(s.readLaterAt(103, () => {})).toBe(false);
    expect(enqueued).toEqual([]);
  });
});

describe("readLaterAt 的序列", () => {
  test("游標落後 ⇒ 先跳號同步；同步失敗不送 Q、降級原生、不交答案", () => {
    const { s, sent, enqueued } = makeSession();
    const answers = [];
    expect(s.readLaterAt(105, (a) => answers.push(a))).toBe(true);
    expect(enqueued[0].kind).toBe("native-sync-jump");
    expect(enqueued[0].keys).toBe("105\r");
    enqueued[0].onFail("timeout");
    expect(stepOf(enqueued, "read-later-info")).toBeUndefined();
    expect(sent).toEqual([]);
    expect(s._renderMode).toBe("native");
    expect(answers).toEqual([]);
  });

  // 回歸：背景補頁的跳號還在線上時 _serverNum 是舊值（onDone 才更新）。以前照舊值判「真游標
  // 已在這篇」直接送 Q／v ⇒ 落在補頁落點那一列（收錯篇、拿錯的文章當已讀界線）。
  test("背景補頁在線上 ⇒ 就算 _serverNum 相同也先跳號同步（稍後再讀與前已讀後未讀都是）", () => {
    for (const kind of ["prefetch-anchor-up", "prefetch"]) {
      const a = makeSession();
      a.s._serverNum = 103;
      a.s._queue.inFlightKind = kind;
      a.s.readLaterAt(103, () => {});
      expect(a.enqueued[0].kind).toBe("native-sync-jump");
      expect(a.enqueued[0].keys).toBe("103\r");
      expect(stepOf(a.enqueued, "read-later-info")).toBeUndefined();

      const b = makeSession();
      b.s._serverNum = 103;
      b.s._queue.inFlightKind = kind;
      b.s.markReadUnreadBefore(103);
      expect(b.enqueued[0].kind).toBe("native-sync-jump");
      expect(stepOf(b.enqueued, "mark-read-prompt")).toBeUndefined();
    }
    // 前景命令在線上不算（交易彼此本來就嚴格序列化）。
    const c = makeSession();
    c.s._serverNum = 103;
    c.s._queue.inFlightKind = "native-inplace";
    c.s.readLaterAt(103, () => {});
    expect(c.enqueued[0].kind).toBe("read-later-info");
  });

  test("Q 只在資訊框出現時算數；認出框才送空白；關框回到乾淨列表才交答案", () => {
    const { s, enqueued } = makeSession();
    s._serverNum = 103;
    const answers = [];
    s.readLaterAt(103, (a) => answers.push(a));
    const q = stepOf(enqueued, "read-later-info");
    expect(q.keys).toBe("Q");
    // 尾附的 \f 會被資訊框的 pressanykey 當成關框，框一出現就沒了。
    expect(q.fullRepaint).toBe(false);
    expect(q.expect(null, facts())).toBe(false); // 列表本身
    expect(q.expect(null, facts({ 9: "  109 + author  [問題] #1aBcDeFg 是什麼" }))).toBe(false);
    expect(q.expect(null, facts(BOX))).toBe(true);
    expect(stepOf(enqueued, "read-later-dismiss")).toBeUndefined();
    q.onDone(true);
    const d = stepOf(enqueued, "read-later-dismiss");
    expect(d.keys).toBe(" ");
    expect(d.expect(null, facts(BOX))).toBe(false); // 框還在
    expect(d.expect(null, facts({}, "transient"))).toBe(false);
    expect(answers).toEqual([]);
    expect(d.expect(null, facts({}, "clean-list"))).toBe(true);
    d.onDone(true);
    expect(answers).toEqual([{ aid: "1aBcDeFg", board: "Test" }]);
  });

  test("框裡沒有 AID（只有框線＋pressanykey）⇒ 照樣關框，答案是 null", () => {
    const { s, enqueued } = makeSession();
    s._serverNum = 103;
    const answers = [];
    s.readLaterAt(103, (a) => answers.push(a));
    const q = stepOf(enqueued, "read-later-info");
    expect(q.expect(null, facts({ 8: "┌──────┐", 9: "│", 23: "請按任意鍵繼續" }))).toBe(true);
    q.onDone(true);
    const d = stepOf(enqueued, "read-later-dismiss");
    d.expect(null, facts({}, "clean-list"));
    d.onDone(true);
    expect(answers).toEqual([null]);
  });

  test("框沒出現（Q 逾時）⇒ 不送空白（列表上是翻頁），降級原生", () => {
    const { s, sent, enqueued, hints } = makeSession();
    s._serverNum = 103;
    const answers = [];
    s.readLaterAt(103, (a) => answers.push(a));
    stepOf(enqueued, "read-later-info").onFail("miss", facts());
    expect(stepOf(enqueued, "read-later-dismiss")).toBeUndefined();
    expect(sent).toEqual([]);
    expect(s._renderMode).toBe("native");
    expect(hints.join()).toContain("文章代碼");
    expect(answers).toEqual([]);
  });

  test("交易中再點 ⇒ 接手但只提示、不送", () => {
    const { s, enqueued, hints } = makeSession();
    s._serverNum = 103;
    s.readLaterAt(103, () => {});
    const n = enqueued.length;
    expect(s.readLaterAt(104, () => {})).toBe(true);
    expect(enqueued.length).toBe(n);
    expect(hints.join()).toContain("請稍候");
  });
});
