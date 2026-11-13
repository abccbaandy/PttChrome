// 原生文章列表的右鍵／長按「稍後再讀」（src/js/native_read_later.js、docs/recent-articles.md）。
//
// 承重點：
//   1. 不是游標列 ⇒ 先 `<編號>⏎`；落地要游標列＝那個編號＋標題一樣（同編號換了一篇不算）。
//   2. 空白只在認出 Q 資訊框之後才送（框沒出現時列表上的空白是翻頁）。
//   3. 置底文跳不過去 ⇒ 只在游標列時給；刪除文、鎖文、黑名單擋掉的列不給。
//   4. 選單開著期間畫面換了（那一列的字不同、游標移走）⇒ 一個 byte 都不送。
//   5. 列表好讀正在畫（activeListSession 有主）⇒ 不給，那條走 list_session.readLaterAt。
import { beginInFlight } from "../../src/js/article_search";
import {
  nativeReadLaterTarget,
  nativeReadLaterTargetAt,
  readLaterNative,
  NATIVE_READ_LATER_FLAG,
} from "../../src/js/native_read_later";
import { serializedOpHint } from "../../src/js/serialized_op_gate";
import { KEY_DISMISS } from "../../src/js/screen_dismiss";

const ROWS = 24;
const HEADER = "【板主:someone】                  看板《Test》";
const FOOTER =
  " 文章選讀  (y)回應(X)推文(^X)轉錄 (=[]<>)相關主題(/?a)找標題/作者 (b)進板畫面 ";
const row = (num, title, cursor) =>
  (cursor ? ">" : " ") +
  String(num).padStart(6, " ") +
  " +96 6/21 someone      " +
  title;
const PINNED = "    ★  !   2/21 boardmod     □ [公告] 板規";
const PINNED_CURSOR = ">   ★  !   2/21 boardmod     □ [公告] 板規";

function listFrame({ cursorRow = 3, extra } = {}) {
  const rowTexts = Array.from({ length: ROWS }, () => "");
  rowTexts[0] = HEADER;
  for (let r = 3; r < ROWS - 2; ++r)
    rowTexts[r] = row(100 + r, "[問卦] 標題" + r, r === cursorRow);
  rowTexts[ROWS - 2] = PINNED;
  rowTexts[ROWS - 1] = FOOTER;
  Object.keys(extra || {}).forEach((k) => (rowTexts[Number(k)] = extra[k]));
  return { rowTexts, rows: ROWS, curX: 0, curY: cursorRow };
}

// 送鍵之後 list_session._readFacts 會給的 facts（只放這裡用到的欄位）。
function facts(frame, more) {
  const cur = frame.rowTexts[frame.curY] || "";
  const m = /^[> ]\s*(\d+)/.exec(cur);
  return Object.assign(
    {
      rowTexts: frame.rowTexts,
      rows: ROWS,
      curX: frame.curX,
      curY: frame.curY,
      boardName: "Test",
      kind: "clean-list",
      cursorRowNum: m ? Number(m[1]) : null,
    },
    more || {},
  );
}

function infoFrame(base) {
  const rowTexts = base.rowTexts.slice();
  rowTexts[8] = "┌──────────────────────────────────────┐";
  rowTexts[9] = "│ 文章代碼(AID): #1aBcDeFg (Test) [ptt.cc] [問卦] 標題10";
  rowTexts[10] = "└──────────────────────────────────────┘";
  rowTexts[ROWS - 1] = "                        請按任意鍵繼續";
  return { rowTexts, rows: ROWS, curX: 0, curY: ROWS - 1 };
}

function makeCore(frame, opts = {}) {
  const enqueued = [];
  const core = {
    conn: { isConnected: true },
    buf: {
      rows: ROWS,
      cols: 80,
      cur_x: frame.curX,
      cur_y: frame.curY,
      pageState: 2,
      getRowText: (r) => frame.rowTexts[r],
      isCursorOnInputField: () => false,
      isPromptPending: () => false,
    },
    view: { blacklist: opts.blacklist || new Set(), titleBlacklist: [] },
    activeListSession: () => opts.listOwner || null,
    commandQueue: { enqueue: (cmd) => enqueued.push(cmd) },
  };
  return { core, enqueued };
}

describe("nativeReadLaterTarget：哪些列給", () => {
  const f = listFrame({ cursorRow: 5 });
  const at = (r, extra) =>
    nativeReadLaterTarget({
      rowText: f.rowTexts[r],
      row: r,
      cursorRow: f.curY,
      rows: ROWS,
      filter: {},
      ...extra,
    });

  test("一般文章列：給編號與標題；游標列標 onCursor", () => {
    expect(at(10)).toMatchObject({ row: 10, num: 110, onCursor: false });
    expect(at(10).title).toContain("標題10");
    expect(at(5)).toMatchObject({ num: 105, onCursor: true });
  });

  test("置底文：不是游標列不給（沒有編號跳不過去），是游標列才給", () => {
    expect(at(ROWS - 2)).toBeNull();
    expect(
      at(ROWS - 2, { cursorRow: ROWS - 2, rowText: PINNED_CURSOR }),
    ).toMatchObject({
      num: null,
      onCursor: true,
    });
  });

  test("表頭、底列、空白列不給", () => {
    expect(at(0)).toBeNull();
    expect(at(1)).toBeNull();
    expect(at(ROWS - 1)).toBeNull();
    expect(at(10, { rowText: "" })).toBeNull();
  });

  test("刪除文不給", () => {
    const deleted = "    110 -  6/21 -            □ (本文已被刪除) [someone]";
    expect(at(10, { rowText: deleted })).toBeNull();
  });

  test("被作者黑名單擋掉的列不給（使用者看到的是提示列）", () => {
    expect(
      at(10, { filter: { blacklist: new Set(["someone"]), titleKeywords: [] } }),
    ).toBeNull();
  });
});

describe("nativeReadLaterTargetAt：什麼畫面給", () => {
  test("原生文章列表：給", () => {
    const { core } = makeCore(listFrame());
    expect(nativeReadLaterTargetAt(core, 10)).toMatchObject({ num: 110 });
  });
  test("列表好讀正在畫列表 ⇒ 不給（走 list_session.readLaterAt）", () => {
    const { core } = makeCore(listFrame(), { listOwner: {} });
    expect(nativeReadLaterTargetAt(core, 10)).toBeNull();
  });
  test("沒連線不給", () => {
    const { core } = makeCore(listFrame());
    core.conn.isConnected = false;
    expect(nativeReadLaterTargetAt(core, 10)).toBeNull();
  });
});

describe("readLaterNative：跳號 → Q → 空白", () => {
  test("不是游標列：第一步只送 `<編號>⏎`，在途旗標掛上、序列閘門擋使用者的鍵", () => {
    const f = listFrame();
    const { core, enqueued } = makeCore(f);
    const t = nativeReadLaterTargetAt(core, 10);
    expect(readLaterNative(core, t, () => {})).toBe(true);
    expect(enqueued.map((c) => c.keys)).toEqual(["110\r"]);
    expect(core[NATIVE_READ_LATER_FLAG]).toBe(true);
    expect(serializedOpHint(core)).toBeTruthy();
  });

  test("跳號落地要游標列＝編號＋標題一樣；同編號換了另一篇不算", () => {
    const f = listFrame();
    const { core, enqueued } = makeCore(f);
    readLaterNative(core, nativeReadLaterTargetAt(core, 10), () => {});
    const jump = enqueued[0];
    // 游標還在原處（跳號還沒生效）
    expect(jump.expect(null, facts(f))).toBe(false);
    // 游標到了 110，但那一列已經是另一篇
    const swapped = listFrame({
      cursorRow: 10,
      extra: { 10: row(110, "[問卦] 別篇", true) },
    });
    expect(jump.expect(null, facts(swapped))).toBe(false);
    // 正確落地
    expect(jump.expect(null, facts(listFrame({ cursorRow: 10 })))).toBe(true);
  });

  test("整段：Q 不補 \\f；空白只在認出資訊框之後才排；回到乾淨列表才交答案", () => {
    const f = listFrame();
    const { core, enqueued } = makeCore(f);
    let answer;
    readLaterNative(core, nativeReadLaterTargetAt(core, 10), (a) => (answer = a));
    const landed = listFrame({ cursorRow: 10 });
    enqueued[0].onDone(enqueued[0].expect(null, facts(landed)));
    expect(enqueued.map((c) => c.keys)).toEqual(["110\r", "Q"]);
    expect(enqueued[1].fullRepaint).toBe(false);
    // 框還沒出現 ⇒ 不算
    expect(enqueued[1].expect(null, facts(landed))).toBe(false);
    const info = infoFrame(landed);
    expect(enqueued[1].expect(null, facts(info, { kind: "other" }))).toBe(true);
    expect(enqueued.length).toBe(2);
    enqueued[1].onDone(true);
    expect(enqueued[2].keys).toBe(KEY_DISMISS);
    // 框還在 ⇒ 不算落地、答案不交
    expect(enqueued[2].expect(null, facts(info, { kind: "other" }))).toBe(false);
    expect(enqueued[2].expect(null, facts(landed))).toBe(true);
    enqueued[2].onDone(true);
    expect(answer).toEqual({ aid: "1aBcDeFg", board: "Test" });
    expect(core[NATIVE_READ_LATER_FLAG]).toBe(false);
  });

  test("Q 的框沒出現（逾時）⇒ 不送空白、叫 onFail、旗標解除", () => {
    const f = listFrame({ cursorRow: 10 });
    const { core, enqueued } = makeCore(f);
    let failed = 0;
    readLaterNative(
      core,
      nativeReadLaterTargetAt(core, 10),
      () => {},
      () => failed++,
    );
    // 游標列 ⇒ 不跳號，直接 Q
    expect(enqueued.map((c) => c.keys)).toEqual(["Q"]);
    enqueued[0].onFail("timeout");
    expect(enqueued.length).toBe(1);
    expect(failed).toBe(1);
    expect(core[NATIVE_READ_LATER_FLAG]).toBe(false);
  });

  test("選單開著期間那一列換了字 ⇒ 一個 byte 都不送", () => {
    const f = listFrame();
    const { core, enqueued } = makeCore(f);
    const t = nativeReadLaterTargetAt(core, 10);
    f.rowTexts[10] = row(110, "[問卦] 換了", false);
    expect(readLaterNative(core, t, () => {})).toBe(false);
    expect(enqueued).toEqual([]);
  });

  test("游標列的目標：游標移走了 ⇒ 不送（Q 會問到別篇）", () => {
    const f = listFrame({ cursorRow: 10 });
    const { core, enqueued } = makeCore(f);
    const t = nativeReadLaterTargetAt(core, 10);
    core.buf.cur_y = 11;
    expect(readLaterNative(core, t, () => {})).toBe(false);
    expect(enqueued).toEqual([]);
  });

  test("別的序列在線上 ⇒ 不送", () => {
    const { core, enqueued } = makeCore(listFrame());
    beginInFlight(core);
    expect(
      readLaterNative(core, nativeReadLaterTargetAt(core, 10), () => {}),
    ).toBe(false);
    expect(enqueued).toEqual([]);
  });
});
