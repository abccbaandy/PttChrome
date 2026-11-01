// cursor-sync 腿的**落地身分驗證**（2026-09-19）。
//
// `<編號>\r` 只保證真游標停在那個**編號**，不保證停在使用者看到的那一篇：
// pttbbs 的 `crs_ln` 是 `.DIR` 純行號、不綁文章身分，一般刪文（record.c
// #delete_record2）把後面每一筆 index 往前搬 ⇒ 我們幾秒前累積進緩衝的編號
// 可能已經指向別篇（完整推導見 src/js/long_push_anchor.js 檔頭）。
// 這一腿的下游是會對那一列動作的破壞性指令（^X 轉錄、^E 管理、% 推文），誤動作
// 無法收回 ⇒ 讀得出來且確定是別篇時，寧可停手切原生。
//
// **只擋明確的 'moved'**：'unknown'（置底列／已刪除列／facts 沒帶 rowTexts）照舊
// 放行——否則會製造一批「按了就切原生」的假陽性。反向守護在本檔最後兩條。
import { ListSession } from "../../src/js/list_session";

const rowOf = (text) => text.split("").map((c) => ({ ch: c, isLeadByte: false }));

// 欄位對齊 bbs.c#readdoent：編號 %7d、作者欄 col 17..29。
const listRow = (num, author, title) =>
  ` ${String(num).padStart(6)} + 2 6/14 ${author.padEnd(13)}□ ${title}`.padEnd(80);

function makeSession() {
  const enqueued = [];
  const hints = [];
  const lines = [rowOf(listRow(21342, "alice", "[閒聊] 我選的這篇"))];
  const nums = [21342];
  const termBuf = {
    rows: 24,
    cols: 80,
    listLines: lines,
    listLineNums: nums,
    lineChangeds: new Array(24).fill(false),
    changed: false,
    addEventListener() {},
    notify() {},
    getRowText: () => "",
    isUnicolor: () => false,
    settleSnapshot: null,
  };
  const view = {
    hideCursor() {},
    showCursor() {},
    resetListAccumulation() {},
    setListLoading() {},
    flashListHint: (m) => hints.push(m),
    blacklist: new Set(),
    titleBlacklist: [],
  };
  const queue = {
    idle: true,
    inFlightKind: null,
    flush() {},
    flushPending() {},
    flushPendingKind() {},
    expedite() {},
    hasKind: () => false,
    enqueue(cmd) {
      enqueued.push(cmd);
    },
    onSettle() {},
  };
  const s = new ListSession({ conn: { send() {} } }, view, termBuf, queue);
  s.state = "active";
  s._renderMode = "buffer";
  s._boardName = "C_Chat";
  s._selectedNum = 21342;
  s._serverNum = 7; // 真游標落後（背景 prefetch 的落點）⇒ 一定會排 sync 腿
  return { s, enqueued, hints };
}

// 落在 entry 區、游標停在目標序號上的 park 指紋（protocol §4 ✚）。
// rowTexts[curY] 決定「落地那一列到底是誰」。
const parkFacts = (num, curY, rowText) => {
  const rowTexts = new Array(24).fill("");
  rowTexts[curY] = rowText;
  return { kind: "transient", cursorRowNum: num, curX: 0, curY, rows: 24, rowTexts };
};

describe("cursor-sync 腿的落地身分驗證", () => {
  test("身分相符 → 照常送下游那顆鍵", () => {
    const { s, enqueued } = makeSession();
    s.adoptUserBytes("\x18");
    const leg = enqueued[0];
    expect(leg.kind).toBe("native-sync-jump");
    expect(leg.expect(null, parkFacts(21342, 5, listRow(21342, "alice", "[閒聊] 我選的這篇")))).toBe(true);
    leg.onDone();
    // 這之後 _serverNum 是 null 而不是 21342：passthrough 的 finish() 會
    // _enterFunctionMode()（原生 excursion 一律拋 cache，不變量 15）。
    expect(enqueued[1].keys).toBe("\x18");
  });

  test("REGRESSION：同編號換了別篇 → 不送那顆鍵，切原生並說明", () => {
    // 期間板上刪過文 ⇒ 21342 這個行號現在是別人的文章。舊碼只驗編號，
    // 會若無其事地把 ^X 送出去、對別篇開轉錄。
    const { s, enqueued, hints } = makeSession();
    s.adoptUserBytes("\x18");
    const leg = enqueued[0];
    expect(leg.expect(null, parkFacts(21342, 5, listRow(21342, "bob", "[新聞] 完全不同的文")))).toBe(true);
    hints.length = 0;
    leg.onDone();

    expect(enqueued).toHaveLength(1); // 下游那顆鍵一個 byte 都沒送出去
    expect(s._renderMode).toBe("native");
    expect(s._serverNum).toBe(null); // 真游標位置重新變成未知
    expect(hints.some((m) => m.includes("列表已變動"))).toBe(true); // 不變量 N7
  });

  test("反向守護：落地列讀不出身分（unknown）照舊放行", () => {
    // 空列／已刪除列（作者欄是 "-"）會落在這裡。把 unknown 一起擋掉＝一批
    // 「按了就切原生」的假陽性，比原本的問題更常見。
    const { s, enqueued } = makeSession();
    s.adoptUserBytes("\x18");
    const leg = enqueued[0];
    expect(leg.expect(null, parkFacts(21342, 5, ""))).toBe(true);
    leg.onDone();
    expect(enqueued[1].keys).toBe("\x18");
  });

  test("反向守護：本地那一列讀不出身分（沒有基準）照舊放行", () => {
    const { s, enqueued, hints } = makeSession();
    s._termBuf.listLines = [rowOf("".padEnd(80))]; // 緩衝裡是空列
    s.adoptUserBytes("\x18");
    const leg = enqueued[0];
    expect(leg.expect(null, parkFacts(21342, 5, listRow(21342, "bob", "[新聞] 別篇")))).toBe(true);
    hints.length = 0;
    leg.onDone();
    expect(enqueued[1].keys).toBe("\x18");
    expect(hints.some((m) => m.includes("列表已變動"))).toBe(false);
  });

  test("標題被列表截斷（… 結尾）仍算相符", () => {
    // bbs.c#readdoent：strlen(title) > w 時印前綴 ＋ …。兩側都可能是截斷版。
    const { s, enqueued } = makeSession();
    s._termBuf.listLines = [
      rowOf(listRow(21342, "alice", "[閒聊] 這是一個非常長的標題會被列表截斷掉尾巴")),
    ];
    s.adoptUserBytes("\x18");
    const leg = enqueued[0];
    expect(leg.expect(null, parkFacts(21342, 5, listRow(21342, "alice", "[閒聊] 這是一個非常長的標題會被列表截…")))).toBe(true);
    leg.onDone();
    expect(enqueued[1].keys).toBe("\x18");
  });
});

// 同一人同一串的原文＋回文：主題剝掉 Re: 之後相同 ⇒ 列表上同身分。使用者選的是 21342
// （alice 的回文），上一列 21341 是 alice 的原文；期間刪了一篇 ⇒ 21342 現在是緊接著
// 的那篇（alice 的第二篇回文），身分照樣 'ok'。舊碼放行 ⇒ ^X 對別篇開轉錄。
describe("cursor-sync 腿：同頁兩列以上同身分時看鄰居有沒有跟著移", () => {
  const ALICE = (num) => listRow(num, "alice", "Re: [閒聊] 我選的這篇");
  const setup = () => {
    const ctx = makeSession();
    ctx.s._termBuf.listLines = [
      rowOf(listRow(21341, "alice", "[閒聊] 我選的這篇")),
      rowOf(ALICE(21342)),
      rowOf(listRow(21343, "carol", "[問卦] 下一篇")),
    ];
    ctx.s._termBuf.listLineNums = [21341, 21342, 21343];
    return ctx;
  };
  const landedPage = (rows, curY) => {
    const f = parkFacts(21342, curY, "");
    rows.forEach((t, i) => (f.rowTexts[4 + i] = t));
    return f;
  };

  test("REGRESSION 整串往前搬一格、落到同身分的另一篇 → 不送那顆鍵，切原生", () => {
    const { s, enqueued, hints } = setup();
    s.adoptUserBytes("\x18");
    const leg = enqueued[0];
    // 落地頁：21341 變成原本的 21342（alice 的回文）、21342 是 alice 的另一篇回文。
    const f = landedPage([ALICE(21341), ALICE(21342), listRow(21343, "dave", "[新聞] 另一篇")], 5);
    expect(leg.expect(null, f)).toBe(true);
    hints.length = 0;
    leg.onDone();
    expect(enqueued).toHaveLength(1);
    expect(s._renderMode).toBe("native");
    expect(hints.some((m) => m.includes("列表已變動"))).toBe(true);
  });

  test("反向守護：同頁兩列同身分但鄰居都沒動 → 照常送", () => {
    const { s, enqueued } = setup();
    s.adoptUserBytes("\x18");
    const leg = enqueued[0];
    const f = landedPage(
      [listRow(21341, "alice", "[閒聊] 我選的這篇"), ALICE(21342), listRow(21343, "carol", "[問卦] 下一篇")],
      5,
    );
    expect(leg.expect(null, f)).toBe(true);
    leg.onDone();
    expect(enqueued[1].keys).toBe("\x18");
  });
});
