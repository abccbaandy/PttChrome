// 讀完接著讀下一篇（src/js/next_article.js、docs/next-article.md）：下一篇＝列表快照裡編號接在
// 這篇後面的那一列（read.c 的 crs_ln + 1），只在好讀讀到文末時出現，點了才走 startNum 換文。
// 列表列照 bbs.c#readdoent 的欄位手寫（同 split_reader.test.js）。
const prefOverride = vi.hoisted(() => ({}));
vi.mock("../../src/js/pref_storage", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, readEffectivePrefs: () => ({ ...real.readEffectivePrefs(), ...prefOverride }) };
});
import { DEFAULT_PREFS, NATIVE_SAFE_MODE_KEYS } from "../../src/js/pref_storage";
import {
  NextArticle,
  nextEntryAfter,
  landedOn,
  mergeSubSnapshot,
  sameListEntry,
  listEndsAfter,
  sameSubjectEntryFrom,
} from "../../src/js/next_article";
import { listPageOf } from "../../src/js/split_reader";
import { parseBlacklist, parseTitleBlacklist } from "../../src/js/comment_parse";
import { RESTORE_TABLE } from "../../src/js/reading_record";
import { HINT_ERROR } from "../../src/js/status_hint";

const ROWS = 24;

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
  rowTexts[ROWS - 1] = "  瀏覽 第 3/3 頁 (100%)  目前顯示: 第 45~66 行  (y)回應(X%)推文(h)說明(←)離開 ";
  return { rowTexts, pageState: 3 };
}

const PAGE = (opts) =>
  listScreen(
    [
      listRow(101, "alice", "[閒聊] 第一篇", { type: "+" }),
      listRow(102, "bob", "[問題] 第二篇", { push: " 5", cursor: true }),
      DELETED_ROW(103),
      listRow(104, "carol", "Re: [閒聊] 第一篇", { push: "爆" }),
      PINNED_ROW,
    ],
    opts
  );

// ── 純判讀 ────────────────────────────────────────────────────────────────
describe("nextEntryAfter：列表順序的下一列", () => {
  const entries = [
    { num: 101, title: "a" },
    { num: 102, title: "b" },
    { num: 103, title: "(本文已被刪除)", deleted: true },
    { num: 104, title: "d" },
    { num: 110, title: "z" },
  ];
  test("編號接著的那一篇", () => {
    expect(nextEntryAfter(entries, 101).num).toBe(102);
  });
  test("被刪的跳過", () => {
    expect(nextEntryAfter(entries, 102).num).toBe(104);
  });
  test("下一號沒看過（還沒載入的頁／最後一篇後面是置底文）⇒ null", () => {
    expect(nextEntryAfter(entries, 104)).toBeNull();
    expect(nextEntryAfter(entries, 110)).toBeNull();
  });
  test("沒有快照或不知道這篇 ⇒ null", () => {
    expect(nextEntryAfter(null, 101)).toBeNull();
    expect(nextEntryAfter(entries, null)).toBeNull();
  });
  test("黑名單命中的（看列原文）跟被刪的一樣跳過，並回報跳過了誰、為什麼", () => {
    const withText = [
      { num: 101, text: listRow(101, "alice", "[閒聊] a") },
      { num: 102, text: listRow(102, "bob", "[問題] b") },
      { num: 103, text: listRow(103, "carol", "[公告] 抽獎") },
      { num: 104, text: listRow(104, "dave", "[閒聊] d") },
    ];
    const filter = { blacklist: parseBlacklist("Bob"), titleKeywords: parseTitleBlacklist("抽獎") };
    const skipped = [];
    expect(nextEntryAfter(withText, 101, filter, skipped).num).toBe(104);
    expect(skipped).toEqual([
      { num: 102, why: "author" },
      { num: 103, why: "title" },
    ]);
    expect(nextEntryAfter(withText, 101, { blacklist: null, titleKeywords: null }).num).toBe(102);
  });
});

describe("列表盡頭：listPageOf.endNum／listEndsAfter", () => {
  test("最後一列有編號的文章下面是置底文或空列 ⇒ 它就是最後一篇；排到畫面最底 ⇒ 看不出來", () => {
    expect(listPageOf(PAGE().rowTexts, null).endNum).toBe(104);
    expect(listPageOf(listScreen([listRow(7, "a", "[閒聊] x")]).rowTexts, null).endNum).toBe(7);
    const full = Array.from({ length: ROWS - 4 }, (_, i) => listRow(1 + i, "a", "[閒聊] " + i));
    expect(listPageOf(listScreen(full).rowTexts, null).endNum).toBeNull();
    // 整頁都是置底文（沒有編號文章）⇒ 不知道。
    expect(listPageOf(listScreen([PINNED_ROW]).rowTexts, null).endNum).toBeNull();
  });
  test("listEndsAfter：下一號到盡頭每一號都看過才算到底", () => {
    const e = [{ num: 1 }, { num: 2 }, { num: 3 }, { num: 5 }];
    expect(listEndsAfter(e, 3, 3)).toBe(true);
    expect(listEndsAfter(e, 2, 3)).toBe(true); // 3 看過（被跳過）
    expect(listEndsAfter(e, 3, 5)).toBe(false); // 缺 4
    expect(listEndsAfter(e, 3, null)).toBe(false);
    expect(listEndsAfter(e, 6, 5)).toBe(false);
  });
});

test("landedOn：作者＋主題（不分大小寫、Re: 不影響主題）", () => {
  const entry = { author: "Bob", subject: "[問題] 第二篇" };
  expect(landedOn(entry, { author: "bob", title: "[問題] 第二篇" })).toBe(true);
  expect(landedOn(entry, { author: "bob", title: "Re: [問題] 第二篇" })).toBe(true);
  expect(landedOn({ author: "bob", subject: "[問題] 第二…" }, { author: "bob", title: "[問題] 第二篇" })).toBe(true);
  expect(landedOn(entry, { author: "alice", title: "[問題] 第二篇" })).toBe(false);
  expect(landedOn(entry, { author: "bob", title: "[問題] 第三篇" })).toBe(false);
  expect(landedOn(entry, null)).toBe(false);
});

test("landedOn：檔頭主題對不上（T 只改 .DIR）⇒ 改比途中列表上游標那列（列表對列表）", () => {
  const entry = { author: "bob", subject: "[問題] 第二篇(已解決)" };
  const article = { author: "bob", title: "[問題] 第二篇" };
  expect(landedOn(entry, article)).toBe(false);
  expect(landedOn(entry, article, { author: "Bob", subject: "[問題] 第二篇(已解決)" })).toBe(true);
  expect(landedOn(entry, article, { author: "bob", subject: "[問題] 別篇" })).toBe(false);
  expect(landedOn(entry, article, { author: "eve", subject: "[問題] 第二篇(已解決)" })).toBe(false);
  // 檔頭作者對不上 ⇒ 列表列再像也不算。
  expect(landedOn(entry, { author: "eve", title: "[問題] 第二篇" }, { author: "bob", subject: entry.subject })).toBe(false);
});

test("閱讀紀錄：next-article 不還原（同雙欄閱讀的換文）", () => {
  expect(RESTORE_TABLE["next-article"]).toEqual(RESTORE_TABLE["split-open"]);
});

test("預設開，而且在安全模式名單內（會替使用者送鍵）", () => {
  expect(DEFAULT_PREFS.enableNextArticleCard).toBe(true);
  expect(NATIVE_SAFE_MODE_KEYS).toContain("enableNextArticleCard");
});

// ── 控制器：假 App ─────────────────────────────────────────────────────────
function makeCore() {
  let frame = PAGE();
  const listeners = {};
  const hints = [];
  const starts = [];
  const subStarts = [];
  let queueIdle = true;
  const easyReading = { _enabled: true, _functionMode: false, _reverse: null, easyReadingReachedPageEnd: true };
  const core = {
    easyReading,
    buf: {
      rows: ROWS,
      cols: 80,
      cur_y: null,
      pageLines: [],
      get pageState() {
        return frame.pageState;
      },
      getRowText: (r) => frame.rowTexts[r],
      addEventListener: (name, fn) => (listeners[name] = fn),
    },
    view: {
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
      startNum(board, num, onEnd) {
        starts.push({ board, num, onEnd });
        return true;
      },
      startSubNum(board, num, verify, onEnd) {
        subStarts.push({ board, num, verify, onEnd });
        return true;
      },
    },
  };
  const next = new NextArticle(core);
  const show = (f) => {
    frame = f;
    if (f.pageState !== 3) {
      core.view._articleBoard = null;
      core.view._articleAuthor = null;
      core.view._articleTitle = null;
      core.buf.pageLines = [];
    }
    listeners.screenSettled();
  };
  const read = (board, author, title) => {
    core.view._articleBoard = board;
    core.view._articleAuthor = author;
    core.view._articleTitle = title;
    core.buf.pageLines = [[]];
    show(articleScreen());
  };
  return { core, easyReading, next, hints, starts, subStarts, show, read, busyQueue: (v) => (queueIdle = !v) };
}

describe("NextArticle：何時出現", () => {
  test("從完整列表進文章、讀到文末 ⇒ 出現下一篇（取自快照）", () => {
    const { next, show, read } = makeCore();
    show(PAGE());
    read("C_Chat", "alice", "[閒聊] 第一篇");
    expect(next.state.visible).toBe(true);
    expect(next.state.entry).toMatchObject({ num: 102, author: "bob", title: "[問題] 第二篇", recommend: "5" });
  });
  test("下一列被刪 ⇒ 跳過它", () => {
    const { next, show, read } = makeCore();
    show(PAGE());
    read("C_Chat", "bob", "[問題] 第二篇");
    expect(next.state.entry.num).toBe(104);
  });
  // 錄製檔：C_Chat 351368 讀到文末，卡片顯示 351369（作者在黑名單裡）。列表好讀把黑名單列藏起來
  // （list_session#visibleListIndices），卡片要跟使用者在列表上看到的一樣：跳過它，接著找下一列。
  test("下一列的作者在黑名單 ⇒ 跳過它（不分大小寫）", () => {
    const { core, next, show, read } = makeCore();
    core.view.blacklist = parseBlacklist("Bob");
    show(PAGE());
    read("C_Chat", "alice", "[閒聊] 第一篇");
    expect(next.state.entry.num).toBe(104);
  });
  test("下一列的標題命中標題黑名單 ⇒ 跳過它", () => {
    const { core, next, show, read } = makeCore();
    core.view.titleBlacklist = parseTitleBlacklist("第二篇");
    show(PAGE());
    read("C_Chat", "alice", "[閒聊] 第一篇");
    expect(next.state.entry.num).toBe(104);
  });
  test("黑名單是讀到文末那一刻的設定（看過列表之後才加的也算）", () => {
    const { core, next, show, read } = makeCore();
    show(PAGE());
    core.view.blacklist = parseBlacklist("bob");
    read("C_Chat", "alice", "[閒聊] 第一篇");
    expect(next.state.entry.num).toBe(104);
  });
  test("後面看過的列全被擋、接著就是置底文 ⇒ 終點卡「已無下一篇」（不能點）", () => {
    const { core, next, show, read, starts } = makeCore();
    core.view.blacklist = parseBlacklist("bob\ncarol");
    show(PAGE());
    read("C_Chat", "alice", "[閒聊] 第一篇");
    expect(next.state).toMatchObject({ visible: true, entry: null, end: "last" });
    expect(next.open()).toBe(false);
    expect(starts).toEqual([]);
  });
  test("後面看過的列全被擋，但列表排到畫面最底（看不出盡頭）⇒ 終點卡「已到文末」", () => {
    const { core, next, show, read } = makeCore();
    core.view.blacklist = parseBlacklist("bob");
    const rows = Array.from({ length: ROWS - 4 }, (_, i) =>
      listRow(101 + i, i === 0 ? "alice" : "bob", "[閒聊] 第 " + (101 + i) + " 篇", { cursor: i === 0 })
    );
    show(listScreen(rows));
    read("C_Chat", "alice", "[閒聊] 第 101 篇");
    expect(next.state).toMatchObject({ visible: true, entry: null, end: "unknown" });
  });
  test("錄製中 ⇒ 記下挑了哪篇、跳過誰（結果沒變不重記）", () => {
    const { core, next, show, read } = makeCore();
    const logs = [];
    core.debugRecorder = { log: (tag, info) => logs.push({ tag, info }) };
    core.view.blacklist = parseBlacklist("bob");
    show(PAGE());
    read("C_Chat", "alice", "[閒聊] 第一篇");
    read("C_Chat", "alice", "[閒聊] 第一篇");
    expect(next.state.entry.num).toBe(104);
    expect(logs.filter((l) => l.tag === "nextArticle.pick")).toEqual([
      {
        tag: "nextArticle.pick",
        info: {
          current: 101,
          next: 104,
          skipped: [
            { num: 102, why: "author" },
            { num: 103, why: "deleted" },
          ],
        },
      },
    ]);
  });
  test("下一列是鎖文（開不了）⇒ 跳過它", () => {
    const { next, show, read } = makeCore();
    show(
      listScreen([
        listRow(101, "alice", "[閒聊] 第一篇", { cursor: true }),
        listRow(102, "bob", "[問題] 鎖起來", { push: "--", mark: "鎖" }),
        listRow(103, "carol", "[閒聊] 第三篇"),
      ])
    );
    read("C_Chat", "alice", "[閒聊] 第一篇");
    expect(next.state.entry.num).toBe(103);
  });
  // 使用者回報：最後一篇讀到底什麼都沒有，以為功能壞了 ⇒ 改成明講「已無下一篇」。
  test("最後一篇（下一列是置底文）⇒ 終點卡「已無下一篇」，點了不送鍵", () => {
    const { next, show, read, starts } = makeCore();
    show(PAGE());
    read("C_Chat", "carol", "Re: [閒聊] 第一篇");
    expect(next.state).toMatchObject({ visible: true, entry: null, end: "last" });
    expect(next.open()).toBe(false);
    expect(starts).toEqual([]);
  });
  test("最後一篇（下面是空列，沒有置底文）⇒ 也是「已無下一篇」", () => {
    const { next, show, read } = makeCore();
    show(listScreen([listRow(101, "alice", "[閒聊] 第一篇", { cursor: true })]));
    read("C_Chat", "alice", "[閒聊] 第一篇");
    expect(next.state).toMatchObject({ visible: true, entry: null, end: "last" });
  });
  test("這頁最底一列就是這篇（下一號在還沒看過的頁）⇒「已到文末」；回列表翻過下一頁 ⇒ 換成下一篇", () => {
    const { next, show, read } = makeCore();
    const page1 = Array.from({ length: ROWS - 4 }, (_, i) =>
      listRow(101 + i, "u" + i, "[閒聊] 第 " + (101 + i) + " 篇", { cursor: i === ROWS - 5 })
    );
    show(listScreen(page1));
    read("C_Chat", "u19", "[閒聊] 第 120 篇");
    expect(next.state).toMatchObject({ visible: true, entry: null, end: "unknown" });
    show(listScreen([listRow(121, "zed", "[閒聊] 第 121 篇", { cursor: true }), PINNED_ROW]));
    show(listScreen(page1));
    read("C_Chat", "u19", "[閒聊] 第 120 篇");
    expect(next.state).toMatchObject({ visible: true, end: null });
    expect(next.state.entry.num).toBe(121);
  });
  test("看過列表盡頭之後有新文章進來（快照出現更大的編號）⇒ 舊的盡頭作廢", () => {
    const { next, show, read } = makeCore();
    show(PAGE()); // 盡頭 104
    // 新文 105 進來：這一頁 105 排到最底一列，看不出盡頭。
    const rows = Array.from({ length: 15 }, (_, i) => listRow(86 + i, "u" + i, "[閒聊] 第 " + (86 + i) + " 篇"));
    rows.push(
      listRow(101, "alice", "[閒聊] 第一篇"),
      listRow(102, "bob", "[問題] 第二篇"),
      DELETED_ROW(103),
      listRow(104, "carol", "Re: [閒聊] 第一篇"),
      listRow(105, "dave", "[閒聊] 新文")
    );
    expect(rows).toHaveLength(ROWS - 4);
    show(listScreen(rows));
    read("C_Chat", "carol", "Re: [閒聊] 第一篇");
    expect(next.state.entry.num).toBe(105);
  });
  test("還沒讀到文末、反向讀取中、切原生（functionMode）、好讀關 ⇒ 不出現", () => {
    const { next, easyReading, show, read } = makeCore();
    show(PAGE());
    for (const patch of [
      { easyReadingReachedPageEnd: false },
      { _reverse: {} },
      { _functionMode: true },
      { _enabled: false },
    ]) {
      const saved = { ...easyReading };
      Object.assign(easyReading, patch);
      read("C_Chat", "alice", "[閒聊] 第一篇");
      expect(next.state.visible).toBe(false);
      Object.assign(easyReading, saved);
    }
    read("C_Chat", "alice", "[閒聊] 第一篇");
    expect(next.state.visible).toBe(true);
  });
  test("別的板、沒看過列表、清單上找不到這篇 ⇒ 不出現", () => {
    let t = makeCore();
    t.show(PAGE());
    t.read("Gossiping", "alice", "[閒聊] 第一篇");
    expect(t.next.state.visible).toBe(false);

    t = makeCore();
    t.read("C_Chat", "alice", "[閒聊] 第一篇");
    expect(t.next.state.visible).toBe(false);

    t = makeCore();
    t.show(PAGE());
    t.read("C_Chat", "dave", "[閒聊] 不在清單上");
    expect(t.next.state.visible).toBe(false);
  });
  // 錄製檔：Android 板 48405，列表「[請益] Pokemon GO一直更新失敗無法安裝」、檔頭「[請益] Pokemon
  // GO一直更新」。PTT 的 T（bbs.c edit_title）只改 .DIR、不改文章檔頭 ⇒ 主題永遠比不上。
  test("改過標題的文章（列表≠檔頭）從列表游標進 ⇒ 照樣出現下一篇", () => {
    const { next, show, read } = makeCore();
    show(PAGE()); // 游標在 102（bob）
    read("C_Chat", "bob", "[問題] 第二");
    expect(next.state.visible).toBe(true);
    expect(next.state.entry.num).toBe(104);
  });
  test("看過列表之後在文章裡換到別篇（原生鍵，沒經過列表）⇒ 舊游標不可信，主題又對不上 ⇒ 不出現", () => {
    const { next, show, read } = makeCore();
    show(PAGE());
    read("C_Chat", "bob", "[問題] 第二");
    read("C_Chat", "bob", "[問題] 我的另一篇");
    expect(next.state.visible).toBe(false);
  });
  test("第一篇沒讀到文末就換篇，第二篇讀到底 ⇒ 仍認得出游標不可信", () => {
    const { next, easyReading, show, read } = makeCore();
    show(PAGE());
    easyReading.easyReadingReachedPageEnd = false;
    read("C_Chat", "bob", "[問題] 第二");
    easyReading.easyReadingReachedPageEnd = true;
    read("C_Chat", "bob", "[問題] 我的另一篇");
    expect(next.state.visible).toBe(false);
  });
  test("回到列表 ⇒ 收起", () => {
    const { next, show, read } = makeCore();
    show(PAGE());
    read("C_Chat", "alice", "[閒聊] 第一篇");
    show(PAGE());
    expect(next.state.visible).toBe(false);
  });
  test("pref 關 ⇒ 不出現", () => {
    prefOverride.enableNextArticleCard = false;
    try {
      const { next, show, read } = makeCore();
      show(PAGE());
      read("C_Chat", "alice", "[閒聊] 第一篇");
      expect(next.state.visible).toBe(false);
    } finally {
      delete prefOverride.enableNextArticleCard;
    }
  });
});

describe("NextArticle：點卡片換文", () => {
  test("走 startNum(板, 下一篇的編號)；落地是那一篇 ⇒ 沒有提示", () => {
    const { next, show, read, starts, hints } = makeCore();
    show(PAGE());
    read("C_Chat", "alice", "[閒聊] 第一篇");
    expect(next.open()).toBe(true);
    expect(starts).toEqual([expect.objectContaining({ board: "C_Chat", num: 102 })]);
    expect(next.state.pending).toBe(true);
    // 途中經過列表（游標停在 102）。
    show(PAGE());
    expect(next.state.visible).toBe(false);
    read("C_Chat", "bob", "[問題] 第二篇");
    starts[0].onEnd({ ok: true });
    expect(next.state.pending).toBe(false);
    expect(hints).toEqual([]);
    // 換過去之後：卡片換成再下一篇。
    read("C_Chat", "bob", "[問題] 第二篇");
    expect(next.state.entry.num).toBe(104);
  });
  test("落地不是卡片上那篇（列表變了）⇒ 錯誤級提示，不再送任何鍵", () => {
    const { next, show, read, starts, hints } = makeCore();
    show(PAGE());
    read("C_Chat", "alice", "[閒聊] 第一篇");
    next.open();
    read("C_Chat", "eve", "[閒聊] 別篇");
    starts[0].onEnd({ ok: true });
    expect(hints).toEqual([expect.objectContaining({ level: HINT_ERROR })]);
    expect(starts).toHaveLength(1);
  });
  // 錄製檔：Browsers 板 24967 → 24968，列表「[-GC-] YOUTUBE影片會瞬間卡頓(更新GPU驅動)」、檔頭
  // 「[-GC-] YOUTUBE影片會瞬間卡頓」：開對了卻跳「不是卡片上那篇」。
  test("下一篇改過標題（列表≠檔頭）：途中列表游標停的那列就是卡片那篇 ⇒ 沒有提示，接著出現再下一篇", () => {
    const { next, show, read, starts, hints } = makeCore();
    show(PAGE());
    read("C_Chat", "alice", "[閒聊] 第一篇");
    next.open();
    // 途中經過列表：<編號>⏎ 之後游標停在 102。
    show(PAGE());
    read("C_Chat", "bob", "[問題] 第二");
    starts[0].onEnd({ ok: true });
    expect(hints).toEqual([]);
    read("C_Chat", "bob", "[問題] 第二");
    expect(next.state).toMatchObject({ visible: true, entry: expect.objectContaining({ num: 104 }) });
  });
  test("途中列表上 102 已經換成別篇（列表變了）⇒ 錯誤級提示", () => {
    const { next, show, read, starts, hints } = makeCore();
    show(PAGE());
    read("C_Chat", "alice", "[閒聊] 第一篇");
    next.open();
    show(listScreen([listRow(101, "alice", "[閒聊] 第一篇"), listRow(102, "bob", "[問題] 別的", { cursor: true })]));
    read("C_Chat", "bob", "[問題] 別的");
    starts[0].onEnd({ ok: true });
    expect(hints).toEqual([expect.objectContaining({ level: HINT_ERROR })]);
  });
  test("落地主題對不上、途中也沒看到列表 ⇒ 錯誤級提示（不猜）", () => {
    const { next, show, read, starts, hints } = makeCore();
    show(PAGE());
    read("C_Chat", "alice", "[閒聊] 第一篇");
    next.open();
    read("C_Chat", "bob", "[問題] 第二");
    starts[0].onEnd({ ok: true });
    expect(hints).toEqual([expect.objectContaining({ level: HINT_ERROR })]);
  });
  test("失敗 ⇒ 清掉開啟中", () => {
    const { next, show, read, starts } = makeCore();
    show(PAGE());
    read("C_Chat", "alice", "[閒聊] 第一篇");
    next.open();
    starts[0].onEnd({ ok: false });
    expect(next.state.pending).toBe(false);
  });
  test("線路忙、換文途中、沒出現 ⇒ 不送", () => {
    const t = makeCore();
    expect(t.next.open()).toBe(false);
    t.show(PAGE());
    t.read("C_Chat", "alice", "[閒聊] 第一篇");
    t.busyQueue(true);
    expect(t.next.open()).toBe(false);
    t.busyQueue(false);
    expect(t.next.open()).toBe(true);
    expect(t.next.open()).toBe(false);
    expect(t.starts).toHaveLength(1);
  });
  test("startNum 拒絕 ⇒ 不留開啟中", () => {
    const t = makeCore();
    t.core.aidNavigation.startNum = () => false;
    t.show(PAGE());
    t.read("C_Chat", "alice", "[閒聊] 第一篇");
    expect(t.next.open()).toBe(false);
    expect(t.next.state.pending).toBe(false);
  });
  test("看門狗：結束回呼一直沒來 ⇒ 清掉開啟中", () => {
    vi.useFakeTimers();
    try {
      const t = makeCore();
      t.show(PAGE());
      t.read("C_Chat", "alice", "[閒聊] 第一篇");
      t.next.open();
      vi.advanceTimersByTime(45000);
      expect(t.next.state.pending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── 搜尋結果／文摘 ─────────────────────────────────────────────────────────
// C_Chat 搜標題「史萊姆」，從結果開第 317 篇、讀到文末，
// 卡片沒出現（舊版只認完整列表的快照）。原生「看完按空白」在搜尋結果裡是結果的下一筆
// （read.c READ_NEXT 的 crs_ln + 1 走的是子列表的 remap），編號也是結果自己的空間。
describe("NextArticle：搜尋結果裡的下一篇", () => {
  const SEARCH = (rows = null) =>
    listScreen(
      rows || [
        listRow(316, "lity3426", "[26秋] 史萊姆邊吃邊開會 02"),
        listRow(317, "hanx5566", "[閒聊] 持續狩獵史萊姆300年 10月最終卷", { cursor: true }),
        listRow(318, "defenser", "[26秋] 轉生史萊姆 五期 03", { push: "12" }),
      ],
      { caption: SELECT_CAPTION }
    );
  const READ_317 = (t) => t.read("C_Chat", "hanx5566", "[閒聊] 持續狩獵史萊姆300年 10月最終卷");

  test("從搜尋結果進的文章讀到文末 ⇒ 卡片是結果的下一筆", () => {
    const t = makeCore();
    t.show(PAGE()); // 搜尋前看過完整列表：那一份的編號不能拿來用
    t.show(SEARCH());
    READ_317(t);
    expect(t.next.state.visible).toBe(true);
    expect(t.next.state.entry).toMatchObject({ num: 318, author: "defenser", title: "[26秋] 轉生史萊姆 五期 03" });
  });

  test("點卡片走 startSubNum（不是 startNum）；verify 只認游標那列是卡片上那篇", () => {
    const t = makeCore();
    t.show(SEARCH());
    READ_317(t);
    expect(t.next.open()).toBe(true);
    expect(t.starts).toEqual([]);
    expect(t.subStarts).toEqual([expect.objectContaining({ board: "C_Chat", num: 318 })]);
    const { verify, onEnd } = t.subStarts[0];
    expect(verify(listRow(318, "defenser", "[26秋] 轉生史萊姆 五期 03", { cursor: true }))).toBe(true);
    expect(verify(listRow(318, "someone", "[26秋] 轉生史萊姆 五期 03", { cursor: true }))).toBe(false);
    expect(verify(listRow(318, "defenser", "[閒聊] 別篇", { cursor: true }))).toBe(false);
    expect(verify(listRow(319, "defenser", "[26秋] 轉生史萊姆 五期 03", { cursor: true }))).toBe(false);
    expect(verify(DELETED_ROW(318))).toBe(false);
    // 落地：卡片那篇 ⇒ 沒有提示，接著（結果還有下一筆的話）再出現。
    t.read("C_Chat", "defenser", "[26秋] 轉生史萊姆 五期 03");
    onEnd({ ok: true });
    expect(t.hints).toEqual([]);
    expect(t.next.state.pending).toBe(false);
  });

  test("結果的最後一筆（下面是空列）⇒ 終點卡「已無下一篇」，不送鍵", () => {
    const t = makeCore();
    t.show(SEARCH());
    t.read("C_Chat", "defenser", "[26秋] 轉生史萊姆 五期 03");
    expect(t.next.state).toMatchObject({ visible: true, entry: null, end: "last" });
    expect(t.next.open()).toBe(false);
    expect(t.subStarts).toEqual([]);
  });

  test("回過完整列表之後再從那裡開文 ⇒ 用完整列表的快照（搜尋結果的那一份丟掉）", () => {
    const t = makeCore();
    t.show(SEARCH());
    t.show(PAGE());
    t.read("C_Chat", "alice", "[閒聊] 第一篇");
    expect(t.next.state.entry.num).toBe(102);
    t.next.open();
    expect(t.starts).toHaveLength(1);
    expect(t.subStarts).toEqual([]);
  });

  test("換了搜尋條件（同一個編號變成別篇）⇒ 舊結果整份丟掉，不拿舊的下一筆", () => {
    const t = makeCore();
    t.show(SEARCH());
    // 增加條件後的結果：317 還在（游標）、318 沒看過；316 換成別篇。
    t.show(
      SEARCH([
        listRow(316, "other", "[問題] 別的條件"),
        listRow(317, "hanx5566", "[閒聊] 持續狩獵史萊姆300年 10月最終卷", { cursor: true }),
      ])
    );
    READ_317(t);
    // 新結果到 317 就結束（下面是空列）：不拿舊結果的 318。
    expect(t.next.state).toMatchObject({ entry: null, end: "last" });
    expect(t.next.open()).toBe(false);
    expect(t.subStarts).toEqual([]);
  });
});

describe("mergeSubSnapshot／sameListEntry", () => {
  const page = (rows) =>
    listPageOf(listScreen(rows, { caption: SELECT_CAPTION }).rowTexts, null);
  test("同一份結果的不同頁 ⇒ 併起來；推文數變了、被刪了都不算換條件", () => {
    const a = page([listRow(1, "alice", "[閒聊] a"), listRow(2, "bob", "[問題] b")]);
    const b = page([listRow(2, "bob", "[問題] b", { push: " 9" }), listRow(3, "carol", "[閒聊] c")]);
    expect(mergeSubSnapshot(mergeSubSnapshot(null, a), b).entries.map((e) => e.num)).toEqual([1, 2, 3]);
    const c = page([DELETED_ROW(1), listRow(4, "dave", "[閒聊] d")]);
    expect(mergeSubSnapshot(mergeSubSnapshot(null, a), c).entries.map((e) => e.num)).toEqual([1, 2, 4]);
  });
  test("同一號不同篇 ⇒ 只留新的一頁；別的板 ⇒ 換掉", () => {
    const a = page([listRow(1, "alice", "[閒聊] a"), listRow(2, "bob", "[問題] b")]);
    const b = page([listRow(2, "eve", "[問題] x"), listRow(3, "carol", "[閒聊] c")]);
    expect(mergeSubSnapshot(mergeSubSnapshot(null, a), b).entries.map((e) => e.num)).toEqual([2, 3]);
  });
  test("sameListEntry：作者不分大小寫＋主題（截斷的 … 也算）", () => {
    expect(sameListEntry({ author: "Bob", subject: "[問題] 第二篇" }, { author: "bob", subject: "[問題] 第二…" })).toBe(true);
    expect(sameListEntry({ author: "bob", subject: "[問題] 第二篇" }, { author: "bob", subject: "[問題] 第三篇" })).toBe(false);
    expect(sameListEntry({ author: "bob", subject: null }, { author: "bob", subject: null })).toBe(false);
    expect(sameListEntry(null, { author: "bob", subject: "x" })).toBe(false);
  });
});

// ── 同主題上一篇／下一篇（P28）──────────────────────────────────────────────
describe("sameSubjectEntryFrom：同主題（read.c#thread RELATE_NEXT／PREV 的快照版）", () => {
  const E = (num, subject, o = {}) => ({ num, subject, ...o });
  const entries = [
    E(1, "[閒聊] A"),
    E(2, "[問題] B"),
    E(3, "[閒聊] A", { deleted: true }),
    E(4, "[閒聊] A"),
    E(6, "[閒聊] A"),
  ];
  test("往後找主題相同的第一篇，被刪的跳過", () => {
    expect(sameSubjectEntryFrom(entries, 1, 1).num).toBe(4);
  });
  test("往前找", () => {
    expect(sameSubjectEntryFrom(entries, 4, -1).num).toBe(1);
  });
  test("中間缺號（那一列沒看過，可能就是同主題）⇒ 停手", () => {
    expect(sameSubjectEntryFrom(entries, 4, 1)).toBeNull();
    expect(sameSubjectEntryFrom(entries, 6, -1)).toBeNull();
  });
  test("列表主題被截斷（…）也算同主題", () => {
    expect(sameSubjectEntryFrom([E(1, "[閒聊] 很長的標題"), E(2, "[閒聊] 很長…")], 1, 1).num).toBe(2);
  });
  test("黑名單擋的跳過；這篇自己不在快照、沒有主題 ⇒ null", () => {
    const withText = [
      E(1, "[閒聊] A", { text: listRow(1, "alice", "[閒聊] A") }),
      E(2, "[閒聊] A", { text: listRow(2, "bob", "Re: [閒聊] A") }),
      E(3, "[閒聊] A", { text: listRow(3, "carol", "Re: [閒聊] A") }),
    ];
    expect(sameSubjectEntryFrom(withText, 1, 1, { blacklist: parseBlacklist("bob") }).num).toBe(3);
    expect(sameSubjectEntryFrom(entries, 5, 1)).toBeNull();
    expect(sameSubjectEntryFrom([E(1, null), E(2, null)], 1, 1)).toBeNull();
  });
});

describe("NextArticle：同主題上一篇／下一篇", () => {
  afterEach(() => {
    delete prefOverride.nextArticleSameSubject;
  });
  test("預設開；跟「下一篇」不同篇才列", () => {
    expect(DEFAULT_PREFS.nextArticleSameSubject).toBe(true);
    const { next, show, read } = makeCore();
    show(PAGE());
    read("C_Chat", "alice", "[閒聊] 第一篇");
    expect(next.state.entry.num).toBe(102);
    expect(next.state.threadNext).toMatchObject({ num: 104, author: "carol" });
    expect(next.state.threadPrev).toBeNull();
  });
  test("同主題下一篇正好就是下一篇 ⇒ 不重複列；回頭看得到原文 ⇒ 同主題上一篇", () => {
    const { next, show, read } = makeCore();
    show(PAGE());
    read("C_Chat", "carol", "Re: [閒聊] 第一篇");
    expect(next.state.threadNext).toBeNull();
    expect(next.state.threadPrev).toMatchObject({ num: 101, author: "alice" });
  });
  test("終點卡（沒有下一篇）也照樣列同主題上一篇", () => {
    const { next, show, read } = makeCore();
    show(PAGE());
    read("C_Chat", "carol", "Re: [閒聊] 第一篇");
    expect(next.state.entry).toBeNull();
    expect(next.state.end).toBe("last");
    expect(next.state.threadPrev.num).toBe(101);
  });
  test("子開關關掉 ⇒ 不列", () => {
    prefOverride.nextArticleSameSubject = false;
    const { next, show, read } = makeCore();
    show(PAGE());
    read("C_Chat", "alice", "[閒聊] 第一篇");
    expect(next.state.entry.num).toBe(102);
    expect(next.state.threadNext).toBeNull();
  });
  test("點同主題下一篇 ⇒ startNum(板, 那篇的編號)，落地比對也比那篇", () => {
    const { next, show, read, starts, hints } = makeCore();
    show(PAGE());
    read("C_Chat", "alice", "[閒聊] 第一篇");
    expect(next.open(next.state.threadNext)).toBe(true);
    expect(starts).toEqual([expect.objectContaining({ board: "C_Chat", num: 104 })]);
    read("C_Chat", "carol", "Re: [閒聊] 第一篇");
    starts[0].onEnd({ ok: true });
    expect(hints).toEqual([]);
    // 落在 104 ⇒ 回頭的同主題上一篇是 101。
    read("C_Chat", "carol", "Re: [閒聊] 第一篇");
    expect(next.state.threadPrev.num).toBe(101);
  });
  test("不是卡片上列的那篇 ⇒ 不送", () => {
    const { next, show, read, starts } = makeCore();
    show(PAGE());
    read("C_Chat", "alice", "[閒聊] 第一篇");
    expect(next.open({ num: 103, author: "x", title: "y" })).toBe(false);
    expect(starts).toEqual([]);
  });
});
