// 寬螢幕雙欄閱讀（src/js/split_reader.js、docs/split-reader.md）：文章列表一頁怎麼讀進快照、
// 正在讀的是清單上哪一篇、左欄什麼時候出現（認不出 ⇒ 原生）、點一篇走 aid_navigation.startNum。
// 列表列照 bbs.c#readdoent 的欄位手寫（同 long_push_anchor.test.js 的 listRow）。
const prefOverride = vi.hoisted(() => ({}));
vi.mock("../../src/js/pref_storage", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, readEffectivePrefs: () => ({ ...real.readEffectivePrefs(), ...prefOverride }) };
});
import { DEFAULT_PREFS, NATIVE_SAFE_MODE_KEYS } from "../../src/js/pref_storage";
import { parseBlacklist, parseTitleBlacklist } from "../../src/js/comment_parse";
import {
  listRowUnread,
  listPageOf,
  mergeSnapshot,
  findCurrentNum,
  cursorHintFresh,
  paneWidthFor,
  sameBoard,
  SplitReader,
  SPLIT_MIN_PANE_PX,
  SPLIT_MAX_PANE_PX,
  SPLIT_GAP_PX,
  SPLIT_SNAPSHOT_LIMIT,
} from "../../src/js/split_reader";
import { RESTORE_TABLE } from "../../src/js/reading_record";
import { HINT_ERROR } from "../../src/js/status_hint";

const ROWS = 24;

//   0-6 %7d 序號 | 7 空格 | 8 型別 | 9-10 推文數 | 11-16 %-6.5s 日期
//   17-29 %-13.12s 作者 | 30- mark + 標題
function listRow(num, author, title, o = {}) {
  const seq = o.cursor ? ">" + String(num).padStart(6) : String(num).padStart(7);
  return (
    seq + " " + (o.type || " ") + (o.push || "  ") + " 9/01 " + author.padEnd(13).slice(0, 13) + (o.mark || "□") + " " + title
  );
}
const PINNED_ROW = "    ★ " + " " + " " + "  " + " 9/01 " + "sysop".padEnd(13) + "□ 公告";
const DELETED_ROW = (num) => listRow(num, "-", "(本文已被刪除) [someone]");

const PLAIN_CAPTION = " 文章選讀  (y)回應(X)推文(^X)轉錄 (=[]<>)相關主題(/?a)找標題/作者 (b)進板畫面 ";
const SELECT_CAPTION = " 系列文章  (y)回應(X)推文(^X)轉錄 (=[]<>)相關主題(/?a)找標題/作者 (b)進板畫面 ";

function listScreen(rows, { board = "C_Chat", caption = PLAIN_CAPTION } = {}) {
  const rowTexts = Array.from({ length: ROWS }, () => "");
  rowTexts[0] = "【板主:someone】                  看板《" + board + "》";
  rowTexts[1] = "[←]離開 [→]閱讀 [Ctrl-P]發表文章 [d]刪除 [z]精華區 [i]看板資訊/設定 [h]說明";
  rowTexts[2] = "   編號    日 期 作  者       文  章  標  題                       人氣:123";
  rows.forEach((t, i) => (rowTexts[3 + i] = t));
  rowTexts[ROWS - 1] = caption;
  return { rowTexts, pageState: 2 };
}

function articleScreen() {
  const rowTexts = Array.from({ length: ROWS }, () => "");
  rowTexts[ROWS - 1] = "  瀏覽 第 1/3 頁 ( 30%)  目前顯示: 第 01~22 行  (y)回應(X%)推文(h)說明(←)離開 ";
  return { rowTexts, pageState: 3 };
}

const PAGE = () =>
  listScreen([
    listRow(101, "alice", "[閒聊] 第一篇", { type: "+" }),
    listRow(102, "bob", "[問題] 第二篇", { push: " 5" }),
    listRow(103, "carol", "[閒聊] 第三篇", { cursor: true, type: "+" }),
    DELETED_ROW(104),
    PINNED_ROW,
  ]);

// ── 純判讀 ────────────────────────────────────────────────────────────────
describe("listRowUnread：bbs.c#readdoent 的型別欄（第 8 格）", () => {
  test.each([
    ["+", true],
    ["~", true],
    ["M", true],
    ["=", true],
    ["S", true],
    [" ", false],
    ["m", false],
    ["s", false],
    ["!", false],
  ])("%s ⇒ %s", (type, unread) => {
    expect(listRowUnread(listRow(5, "alice", "x", { type }))).toBe(unread);
  });
  test("游標列（>）與五位數以上的編號一樣照格算", () => {
    expect(listRowUnread(listRow(12345, "alice", "x", { type: "+", cursor: true }))).toBe(true);
  });
});

describe("listPageOf", () => {
  test("完整列表：條目、游標、未讀；置底文（沒有編號）不收", () => {
    const page = listPageOf(PAGE().rowTexts);
    expect(page.board).toBe("C_Chat");
    expect(page.mode).toBe("plain");
    expect(page.cursorNum).toBe(103);
    expect(page.entries.map((e) => e.num)).toEqual([101, 102, 103, 104]);
    expect(page.entries[0]).toMatchObject({ author: "alice", unread: true, deleted: false, subject: "[閒聊] 第一篇" });
    expect(page.entries[1]).toMatchObject({ recommend: "5", unread: false });
    expect(page.entries[3]).toMatchObject({ deleted: true, unread: false });
  });
  test("游標列：終端機游標的 curY 優先，沒有才看列首的 > 或 ●", () => {
    expect(listPageOf(PAGE().rowTexts, 4).cursorNum).toBe(102);
    // ● 是全形（兩格），蓋掉序號欄最前面兩格。
    const dot = listScreen([listRow(7, "alice", "x"), "●" + listRow(8, "bob", "y").slice(2)]);
    expect(listPageOf(dot.rowTexts).cursorNum).toBe(8);
  });
  test("搜尋結果／文摘（系列文章 caption）⇒ mode select", () => {
    expect(listPageOf(listScreen([listRow(1, "a", "x")], { caption: SELECT_CAPTION }).rowTexts).mode).toBe("select");
  });
  test.each([
    ["文章畫面", articleScreen().rowTexts],
    ["標題列不是看板", (() => { const s = PAGE().rowTexts.slice(); s[0] = "【主功能表】"; return s; })()],
    ["底列不是文章列表的 caption", (() => { const s = PAGE().rowTexts.slice(); s[ROWS - 1] = ""; return s; })()],
  ])("%s ⇒ null", (_l, rowTexts) => {
    expect(listPageOf(rowTexts)).toBeNull();
  });
});

describe("mergeSnapshot", () => {
  const page = (board, nums, cursorNum) => ({
    board,
    mode: "plain",
    cursorNum,
    entries: nums.map((num) => ({ num, title: "t" + num })),
  });
  test("同板併頁、照編號排序、同編號以新的為準", () => {
    const a = mergeSnapshot(null, page("C_Chat", [21, 22], 22));
    const b = mergeSnapshot(a, { ...page("c_chat", [1, 2, 22], 2), entries: [{ num: 1 }, { num: 2 }, { num: 22, title: "新" }] });
    expect(b.entries.map((e) => e.num)).toEqual([1, 2, 21, 22]);
    expect(b.entries.find((e) => e.num === 22).title).toBe("新");
  });
  test("換板就整份換掉", () => {
    const a = mergeSnapshot(null, page("C_Chat", [1, 2], 1));
    expect(mergeSnapshot(a, page("Stock", [9], 9)).entries.map((e) => e.num)).toEqual([9]);
  });
  test("超過上限丟離游標最遠的", () => {
    const a = mergeSnapshot(null, page("C_Chat", [1, 2, 3, 4, 5], 5), 3);
    expect(a.entries.map((e) => e.num)).toEqual([3, 4, 5]);
    expect(SPLIT_SNAPSHOT_LIMIT).toBeGreaterThanOrEqual(100);
  });
});

describe("findCurrentNum：作者＋主題，先信開文前的游標", () => {
  const entries = listPageOf(
    listScreen([
      listRow(1, "alice", "[閒聊] 同一串"),
      listRow(2, "bob", "[閒聊] 同一串", { mark: "R:" }),
      listRow(3, "alice", "[閒聊] 同一串", { mark: "R:" }),
      listRow(4, "dave", "[閒聊] 很長很長很長很長很長很長很長很長很長很長很…"),
    ]).rowTexts
  ).entries;
  test("唯一符合", () => {
    expect(findCurrentNum(entries, { author: "Bob", title: "Re: [閒聊] 同一串" }, null)).toBe(2);
  });
  test("多個符合 ⇒ 用游標挑；游標不在符合者裡 ⇒ 不標", () => {
    expect(findCurrentNum(entries, { author: "alice", title: "[閒聊] 同一串" }, 3)).toBe(3);
    expect(findCurrentNum(entries, { author: "alice", title: "[閒聊] 同一串" }, 2)).toBeNull();
  });
  test("列表標題被截成 … 也認得", () => {
    expect(
      findCurrentNum(entries, { author: "dave", title: "[閒聊] 很長很長很長很長很長很長很長很長很長很長很長很長的標題" }, null)
    ).toBe(4);
  });
  test("對不上（別人寫的、沒有作者）⇒ null", () => {
    expect(findCurrentNum(entries, { author: "eve", title: "[閒聊] 同一串" }, 1)).toBeNull();
    expect(findCurrentNum(entries, { author: null, title: "[閒聊] 同一串" }, 1)).toBeNull();
  });
  // PTT 的 T（bbs.c edit_title）只改 .DIR 的標題（modify_dir_lite），文章檔頭不動 ⇒ 改過標題的
  // 文章，列表與檔頭的主題永遠對不上。
  test("改過標題（列表≠檔頭）：游標可信、作者對得上 ⇒ 信游標", () => {
    const edited = { author: "bob", title: "[閒聊] 改標題前" };
    expect(findCurrentNum(entries, edited, 2, true)).toBe(2);
    // 游標不可信（看過列表之後已經在文章裡換過篇）⇒ 不猜。
    expect(findCurrentNum(entries, edited, 2, false)).toBeNull();
    expect(findCurrentNum(entries, edited, 2)).toBeNull();
    // 游標那篇是別人寫的 ⇒ 不是它。
    expect(findCurrentNum(entries, edited, 1, true)).toBeNull();
  });
});

describe("cursorHintFresh：開文前的游標只對看過列表後的第一篇可信", () => {
  test("第一篇記下來；同一篇一直可信；換成別篇（原生鍵換文，沒經過列表）⇒ 不可信", () => {
    const list = { board: "C_Chat", mode: "plain", cursorNum: 2 };
    const a = { board: "C_Chat", author: "bob", title: "[閒聊] 改標題前" };
    expect(cursorHintFresh(list, a)).toBe(true);
    expect(cursorHintFresh(list, { ...a })).toBe(true);
    expect(cursorHintFresh(list, { board: "C_Chat", author: "alice", title: "[閒聊] 下一篇" })).toBe(false);
    // 換回第一篇：游標記的就是它，照樣可信。
    expect(cursorHintFresh(list, a)).toBe(true);
  });
  test("沒有列表、沒有作者 ⇒ 不可信（也不記）", () => {
    expect(cursorHintFresh(null, { author: "bob", title: "x" })).toBe(false);
    const list = { cursorNum: 2 };
    expect(cursorHintFresh(list, { author: null, title: "x" })).toBe(false);
    expect(cursorHintFresh(list, { board: "C_Chat", author: "bob", title: "x" })).toBe(true);
  });
});

test("paneWidthFor：放得下才給寬度，有上限", () => {
  expect(paneWidthFor(SPLIT_MIN_PANE_PX + SPLIT_GAP_PX - 1)).toBe(0);
  expect(paneWidthFor(SPLIT_MIN_PANE_PX + SPLIT_GAP_PX)).toBe(SPLIT_MIN_PANE_PX);
  expect(paneWidthFor(2000)).toBe(SPLIT_MAX_PANE_PX);
  expect(paneWidthFor(0)).toBe(0);
});

test("sameBoard 不分大小寫，空的不算", () => {
  expect(sameBoard("C_Chat", "c_chat")).toBe(true);
  expect(sameBoard(null, null)).toBe(false);
});

test("閱讀紀錄：split-open 不還原（目的地就是結果；失敗停在 PTT 給的畫面）", () => {
  expect(RESTORE_TABLE["split-open"]).toEqual(RESTORE_TABLE["aid-jump"]);
});

// ── 控制器：假 App ─────────────────────────────────────────────────────────
function makeCore({ side = 600, mobile = false } = {}) {
  let frame = PAGE();
  const listeners = {};
  const hints = [];
  const starts = [];
  let queueIdle = true;
  const core = {
    mobile,
    buf: {
      rows: ROWS,
      cols: 80,
      get pageState() {
        return frame.pageState;
      },
      getRowText: (r) => frame.rowTexts[r],
      addEventListener: (name, fn) => (listeners[name] = fn),
    },
    view: {
      mainDisplay: { getBoundingClientRect: () => ({ left: side }) },
      _articleBoard: null,
      _articleAuthor: null,
      _articleTitle: null,
      flashListHint: (m, ms, level) => hints.push({ m, level }),
    },
    commandQueue: {
      get idle() {
        return queueIdle;
      },
    },
    aidNavigation: {
      active: false,
      startNum(board, num, onEnd, verify) {
        starts.push({ board, num, onEnd, verify });
        return true;
      },
    },
  };
  const split = new SplitReader(core);
  const show = (f) => {
    frame = f;
    if (f.pageState !== 3) {
      core.view._articleBoard = null;
      core.view._articleAuthor = null;
      core.view._articleTitle = null;
    }
    listeners.screenSettled();
  };
  const read = (board, author, title) => {
    core.view._articleBoard = board;
    core.view._articleAuthor = author;
    core.view._articleTitle = title;
    show(articleScreen());
  };
  return {
    core,
    split,
    hints,
    starts,
    show,
    read,
    busyQueue: (v) => (queueIdle = !v),
  };
}

describe("SplitReader：何時出現", () => {
  test("從完整列表進文章 ⇒ 出現，標出正在讀的那篇", () => {
    const { split, show, read } = makeCore();
    show(PAGE());
    expect(split.state.visible).toBe(false);
    read("C_Chat", "carol", "[閒聊] 第三篇");
    expect(split.state).toMatchObject({ visible: true, board: "C_Chat", currentNum: 103 });
    expect(split.state.entries.map((e) => e.num)).toEqual([101, 102, 103, 104]);
    expect(split.state.width).toBe(SPLIT_MAX_PANE_PX);
  });
  // 列表好讀把黑名單列藏起來；左欄要跟列表上看到的一樣（list_row_filter#blacklistHit）。
  test("黑名單（作者／標題）命中的不列；正在讀的那篇就算命中也留著；刪除文照舊列出", () => {
    const { core, split, show, read } = makeCore();
    core.view.blacklist = parseBlacklist("Bob");
    core.view.titleBlacklist = parseTitleBlacklist("第一篇");
    show(PAGE());
    read("C_Chat", "carol", "[閒聊] 第三篇");
    expect(split.state.entries.map((e) => e.num)).toEqual([103, 104]);
    // 讀的就是被擋的那篇（例如從別處直接開）⇒「目前這篇」不能不見。
    show(PAGE());
    read("C_Chat", "bob", "[問題] 第二篇");
    expect(split.state.currentNum).toBe(102);
    expect(split.state.entries.map((e) => e.num)).toEqual([102, 103, 104]);
  });
  test("快照、黑名單都沒變 ⇒ 左欄條目是同一個陣列（不重畫）", () => {
    const { core, split, show, read } = makeCore();
    core.view.blacklist = parseBlacklist("bob");
    show(PAGE());
    read("C_Chat", "carol", "[閒聊] 第三篇");
    const first = split.state.entries;
    read("C_Chat", "carol", "[閒聊] 第三篇");
    expect(split.state.entries).toBe(first);
    core.view.blacklist = parseBlacklist("bob\nalice");
    read("C_Chat", "carol", "[閒聊] 第三篇");
    expect(split.state.entries.map((e) => e.num)).toEqual([103, 104]);
  });
  test("回到列表 ⇒ 收起（列表本身就在畫面上）", () => {
    const { split, show, read } = makeCore();
    show(PAGE());
    read("C_Chat", "carol", "[閒聊] 第三篇");
    show(PAGE());
    expect(split.state.visible).toBe(false);
  });
  test.each([
    ["搜尋結果進的文章（另一個編號空間）", (t) => {
      t.show(listScreen([listRow(1, "carol", "[閒聊] 第三篇", { cursor: true })], { caption: SELECT_CAPTION }));
      t.read("C_Chat", "carol", "[閒聊] 第三篇");
    }],
    ["文章的看板不是快照的看板（AID 跳去別板、沒經過列表）", (t) => {
      t.show(PAGE());
      t.read("Stock", "carol", "[閒聊] 第三篇");
    }],
    ["從沒看過列表（deep link 直接開文）", (t) => t.read("C_Chat", "carol", "[閒聊] 第三篇")],
    ["看不出看板（站內信、精華區）", (t) => {
      t.show(PAGE());
      t.read(null, "carol", "[閒聊] 第三篇");
    }],
  ])("%s ⇒ 不出現", (_l, run) => {
    const t = makeCore();
    run(t);
    expect(t.split.state.visible).toBe(false);
  });
  test("左邊空白放不下 ⇒ 不出現；手機 ⇒ 不出現", () => {
    for (const opts of [{ side: SPLIT_MIN_PANE_PX }, { mobile: true }]) {
      const t = makeCore(opts);
      t.show(PAGE());
      t.read("C_Chat", "carol", "[閒聊] 第三篇");
      expect(t.split.state.visible).toBe(false);
    }
  });
  test("pref 關 ⇒ 不出現；讀到一半關掉 ⇒ 下一次 settle 收起", () => {
    const t = makeCore();
    t.show(PAGE());
    t.read("C_Chat", "carol", "[閒聊] 第三篇");
    expect(t.split.state.visible).toBe(true);
    prefOverride.enableSplitReading = false;
    try {
      t.read("C_Chat", "carol", "[閒聊] 第三篇");
      expect(t.split.state.visible).toBe(false);
    } finally {
      delete prefOverride.enableSplitReading;
    }
  });
  test("預設開，而且在安全模式名單內", () => {
    expect(DEFAULT_PREFS.enableSplitReading).toBe(true);
    expect(NATIVE_SAFE_MODE_KEYS).toContain("enableSplitReading");
  });
  test("改過標題的文章（列表≠檔頭）從列表進 ⇒ 照樣標出來；在文章裡換到別篇 ⇒ 不再信舊游標", () => {
    const { split, show, read } = makeCore();
    show(PAGE());
    read("C_Chat", "carol", "[閒聊] 第三篇改標題前");
    expect(split.state.currentNum).toBe(103);
    read("C_Chat", "carol", "[閒聊] 另一篇");
    expect(split.state.currentNum).toBeNull();
  });
  test("清單上找不到這篇 ⇒ 照樣出現，只是不標", () => {
    const { split, show, read } = makeCore();
    show(PAGE());
    read("C_Chat", "zed", "[閒聊] 不在這頁");
    expect(split.state).toMatchObject({ visible: true, currentNum: null });
  });
});

describe("SplitReader：點一篇換過去", () => {
  test("走 startNum(板, 編號)；成功 ⇒ 標成目前這篇、拿掉未讀", () => {
    const { split, show, read, starts } = makeCore();
    show(PAGE());
    read("C_Chat", "carol", "[閒聊] 第三篇");
    expect(split.openNum(101)).toBe(true);
    expect(starts).toEqual([expect.objectContaining({ board: "C_Chat", num: 101 })]);
    expect(split.state.pendingNum).toBe(101);
    // 途中經過列表：左欄留著。
    show(PAGE());
    expect(split.state.visible).toBe(true);
    starts[0].onEnd({ ok: true });
    read("C_Chat", "alice", "[閒聊] 第一篇");
    expect(split.state).toMatchObject({ visible: true, currentNum: 101, pendingNum: null });
    expect(split.state.entries.find((e) => e.num === 101).unread).toBe(false);
  });
  // 左欄是列表快照：之後有人刪文、搬文，同一個編號就是別篇（完整列表的編號是位置）。
  // ⏎ 之前先認游標那列，認不出就停在列表，不替使用者讀錯的那篇。
  test("帶 verify：<編號>⏎ 後游標那列要是左欄那篇才開", () => {
    const { split, show, read, starts } = makeCore();
    show(PAGE());
    read("C_Chat", "carol", "[閒聊] 第三篇");
    split.openNum(102);
    const { verify } = starts[0];
    expect(typeof verify).toBe("function");
    expect(verify(listRow(102, "bob", "[問題] 第二篇", { cursor: true }))).toBe(true);
    expect(verify(listRow(102, "eve", "[問題] 第二篇", { cursor: true }))).toBe(false);
    expect(verify(listRow(102, "bob", "[閒聊] 別篇", { cursor: true }))).toBe(false);
    expect(verify(listRow(101, "bob", "[問題] 第二篇", { cursor: true }))).toBe(false);
    expect(verify(DELETED_ROW(102))).toBe(false);
  });
  test("失敗 ⇒ 清掉開啟中，留在 PTT 給的畫面", () => {
    const { split, show, read, starts } = makeCore();
    show(PAGE());
    read("C_Chat", "carol", "[閒聊] 第三篇");
    split.openNum(102);
    starts[0].onEnd({ ok: false, error: "x" });
    expect(split.state.pendingNum).toBeNull();
    expect(split.state.currentNum).toBe(103);
  });
  test("已刪除、目前這篇、換文途中 ⇒ 不送", () => {
    const { split, show, read, starts } = makeCore();
    show(PAGE());
    read("C_Chat", "carol", "[閒聊] 第三篇");
    expect(split.openNum(104)).toBe(false);
    expect(split.openNum(103)).toBe(false);
    split.openNum(101);
    expect(split.openNum(102)).toBe(false);
    expect(starts).toHaveLength(1);
  });
  test("線路上有別人的事 ⇒ 不送", () => {
    const t = makeCore();
    t.show(PAGE());
    t.read("C_Chat", "carol", "[閒聊] 第三篇");
    t.busyQueue(true);
    expect(t.split.openNum(101)).toBe(false);
    t.busyQueue(false);
    t.core.aidNavigation.active = true;
    expect(t.split.openNum(101)).toBe(false);
    expect(t.starts).toHaveLength(0);
    expect(t.hints.some((h) => h.level === HINT_ERROR)).toBe(true);
  });
  test("startNum 拒絕（忙）⇒ 不留開啟中", () => {
    const t = makeCore();
    t.core.aidNavigation.startNum = () => false;
    t.show(PAGE());
    t.read("C_Chat", "carol", "[閒聊] 第三篇");
    expect(t.split.openNum(101)).toBe(false);
    expect(t.split.state.pendingNum).toBeNull();
  });
  test("看門狗：結束回呼一直沒來 ⇒ 清掉開啟中", () => {
    vi.useFakeTimers();
    try {
      const { split, show, read } = makeCore();
      show(PAGE());
      read("C_Chat", "carol", "[閒聊] 第三篇");
      split.openNum(101);
      vi.advanceTimersByTime(60000);
      expect(split.state.pendingNum).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
