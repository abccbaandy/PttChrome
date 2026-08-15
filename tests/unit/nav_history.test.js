// Unit tests for nav_history.js — the AID-jump back stack (pure logic).
//
// The invariants under guard are the ones that decide whether "back" sends the
// user to the RIGHT article: a failed run must never push or pop, and anything
// we did not drive must clear the whole stack rather than leave a stale anchor.

import { NavHistory, chooseAnchor } from "../../src/js/nav_history";

describe("chooseAnchor 優先序", () => {
  const list = { board: "C_Chat", num: 353218, subject: "[閒聊] 測試標題" };

  test("1. landed（本篇自己就是上次 AID 跳來的）勝過一切", () => {
    const a = chooseAnchor({
      landed: { board: "Android", aid: "1gIeu-3A" },
      list: list,
      articleBoard: "Gossiping",
      targetBoard: "movie"
    });
    expect(a.kind).toBe("aid");
    expect(a.board).toBe("Android");
    expect(a.aid).toBe("1gIeu-3A");
  });

  test("2. 沒有 landed 就用列表序號，且帶上 subject 供落地驗證", () => {
    const a = chooseAnchor({ landed: null, list: list, articleBoard: "C_Chat" });
    expect(a.kind).toBe("num");
    expect(a.num).toBe(353218);
    expect(a.subject).toBe("[閒聊] 測試標題");
  });

  test("3. 只有看板名 → board 錨點（靠 pttbbs getkeep 的游標記憶）", () => {
    const a = chooseAnchor({ articleBoard: "Gossiping", targetBoard: "movie" });
    expect(a.kind).toBe("board");
    expect(a.board).toBe("Gossiping");
  });

  test("board 錨點在「原板 == 目標板」時作廢：#aid 會覆寫該板的 getkeep 游標", () => {
    expect(chooseAnchor({ articleBoard: "movie", targetBoard: "MOVIE" })).toBe(
      null
    );
  });

  test("站內信（無看板、無列表錨點）→ null，不可返回", () => {
    expect(chooseAnchor({ articleBoard: null, list: null })).toBe(null);
  });

  test("REGRESSION 列表丟了板名（原生插曲，例如按 Q 開文章資訊）→ 用文章 header 的看板遞補", () => {
    // live 實測 2026-08-13：按 Q 會讓 list session 走一次 _enterFunctionMode，
    // _boardName 被清掉且回列表時不會重新 seed（_selectedNum 還在）。若這裡要求
    // list.board 必須有值，最常見的「從列表開文再點 AID」就拿不到序號錨點。
    const a = chooseAnchor({
      list: { board: null, num: 352292, subject: "[公告] 板規" },
      articleBoard: "C_Chat",
      targetBoard: "Gossiping"
    });
    expect(a.kind).toBe("num");
    expect(a.board).toBe("C_Chat");
    expect(a.num).toBe(352292);
  });

  test("列表與文章都給不出看板名（站內信）→ 沒有錨點", () => {
    expect(
      chooseAnchor({ list: { board: null, num: 5 }, articleBoard: null })
    ).toBe(null);
  });

  test("列表錨點缺序號時不算數，退到 board 級", () => {
    const a = chooseAnchor({
      list: { board: "C_Chat", num: null },
      articleBoard: "C_Chat",
      targetBoard: "movie"
    });
    expect(a.kind).toBe("board");
  });

  test("捲動位置（行索引）一併記進錨點", () => {
    const a = chooseAnchor({ list: list, lineIndex: 42 });
    expect(a.lineIndex).toBe(42);
  });
});

describe("NavHistory 兩段式 commit", () => {
  const origin = { kind: "num", board: "C_Chat", num: 1, subject: "s" };
  const target = { board: "Android", aid: "1gIeu-3A" };

  test("beginJump → commitJump：push 原位置，landed 記住目標", () => {
    const h = new NavHistory();
    expect(h.canGoBack()).toBe(false);
    h.beginJump(origin, target);
    // 尚未落地：位置未知，不可返回
    expect(h.canGoBack()).toBe(false);
    h.commitJump();
    expect(h.canGoBack()).toBe(true);
    expect(h.depth()).toBe(1);
    expect(h.landed()).toEqual({ board: "Android", aid: "1gIeu-3A" });
  });

  test("跳文失敗（abort）絕不入 stack", () => {
    const h = new NavHistory();
    h.beginJump(origin, target);
    h.abort();
    expect(h.depth()).toBe(0);
    expect(h.canGoBack()).toBe(false);
    expect(h.landed()).toBe(null);
  });

  test("origin 為 null（站內信）仍可跳，只是不可返回", () => {
    const h = new NavHistory();
    h.beginJump(null, target);
    h.commitJump();
    expect(h.depth()).toBe(0);
    expect(h.canGoBack()).toBe(false);
    // 但 landed 有記：從這裡再跳一次就有 aid 錨點可用
    expect(h.landed()).toEqual({ board: "Android", aid: "1gIeu-3A" });
  });

  test("beginBack 期間 canGoBack 為 false（防重入），commitBack 才 pop", () => {
    const h = new NavHistory();
    h.beginJump(origin, target);
    h.commitJump();
    const entry = h.beginBack();
    expect(entry).toEqual(origin);
    expect(h.canGoBack()).toBe(false);
    expect(h.depth()).toBe(1); // 還沒 pop
    expect(h.commitBack()).toEqual(origin);
    expect(h.depth()).toBe(0);
  });

  test("返回失敗（abort）是整個清空，不是把那層留著重試", () => {
    const h = new NavHistory();
    h.beginJump(origin, target);
    h.commitJump();
    h.beginJump({ kind: "aid", board: "Android", aid: "1gIeu-3A" }, {
      board: "movie",
      aid: "2AbCdEf0"
    });
    h.commitJump();
    expect(h.depth()).toBe(2);
    h.beginBack();
    h.abort();
    expect(h.depth()).toBe(0);
    expect(h.canGoBack()).toBe(false);
  });

  test("stack 空時 beginBack 回 null 且不產生 pending", () => {
    const h = new NavHistory();
    expect(h.beginBack()).toBe(null);
    // pending 沒被設起來，所以後續的 jump 照常運作
    h.beginJump(origin, target);
    h.commitJump();
    expect(h.canGoBack()).toBe(true);
  });

  test("commitBack 後 landed 只在 aid 錨點成立（num/board 回不出 AID 身分）", () => {
    const h = new NavHistory();
    h.beginJump(origin, target); // origin 是 num 錨點
    h.commitJump();
    h.beginBack();
    h.commitBack();
    expect(h.landed()).toBe(null);

    const h2 = new NavHistory();
    h2.beginJump({ kind: "aid", board: "C_Chat", aid: "1gKF7GO4" }, target);
    h2.commitJump();
    h2.beginBack();
    h2.commitBack();
    expect(h2.landed()).toEqual({ board: "C_Chat", aid: "1gKF7GO4" });
  });

  test("連跳兩層 → 逐層返回，順序正確", () => {
    const h = new NavHistory();
    const a = { kind: "num", board: "A", num: 1 };
    const b = { kind: "aid", board: "B", aid: "1gIeu-3A" };
    h.beginJump(a, { board: "B", aid: "1gIeu-3A" });
    h.commitJump();
    h.beginJump(b, { board: "C", aid: "2AbCdEf0" });
    h.commitJump();
    expect(h.depth()).toBe(2);
    h.beginBack();
    expect(h.commitBack()).toEqual(b);
    h.beginBack();
    expect(h.commitBack()).toEqual(a);
    expect(h.canGoBack()).toBe(false);
  });

  test("invalidate（使用者自己離開文章／切板／斷線）清空全部", () => {
    const h = new NavHistory();
    h.beginJump(origin, target);
    h.commitJump();
    h.invalidate();
    expect(h.depth()).toBe(0);
    expect(h.landed()).toBe(null);
  });

  test("超過 max 時丟掉最舊的一層", () => {
    const h = new NavHistory({ max: 2 });
    for (let i = 1; i <= 3; ++i) {
      h.beginJump({ kind: "num", board: "B", num: i }, { board: "B", aid: "x" });
      h.commitJump();
    }
    expect(h.depth()).toBe(2);
    h.beginBack();
    expect(h.commitBack().num).toBe(3);
    h.beginBack();
    expect(h.commitBack().num).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// upgradePendingOriginAid：離開文章前先用 Q 向 server 問到本篇自己的 AID，把在途
// 的 origin 錨點升級成 aid 級。這是「/ 搜尋後回不去」的修法核心——序號會因為
// MODE_SELECT 的獨立序號空間而失效，AID 不會（mbbsd/read.c:661-665）。
// ---------------------------------------------------------------------------
describe("NavHistory.upgradePendingOriginAid", () => {
  const target = { board: "movie", aid: "2AbCdEf0" };

  test("num 錨點升級成 aid，且保留 num/subject/lineIndex 當備援", () => {
    const h = new NavHistory();
    h.beginJump(
      {
        kind: "num",
        board: "C_Chat",
        num: 3,
        subject: "[閒聊] 原本那篇",
        lineIndex: 42,
        label: "C_Chat 第 3 篇"
      },
      target
    );
    h.upgradePendingOriginAid("C_Chat", "1gIeu-3A");
    h.commitJump();

    const entry = h.peek();
    expect(entry.kind).toBe("aid");
    expect(entry.aid).toBe("1gIeu-3A");
    expect(entry.board).toBe("C_Chat");
    // 置底文的 # 搜尋會失手（read.c:404 FIXME）→ 備援不可丟
    expect(entry.num).toBe(3);
    expect(entry.subject).toBe("[閒聊] 原本那篇");
    expect(entry.lineIndex).toBe(42);
    expect(entry.label).toBe("#1gIeu-3A");
  });

  test("origin 原本是 null（同板跳轉／站內信）→ 直接建出 aid 錨點，返回鈕才會出現", () => {
    const h = new NavHistory();
    h.beginJump(null, target);
    h.upgradePendingOriginAid("C_Chat", "1gIeu-3A");
    h.commitJump();
    expect(h.canGoBack()).toBe(true);
    expect(h.peek()).toMatchObject({
      kind: "aid",
      board: "C_Chat",
      aid: "1gIeu-3A"
    });
  });

  test("board 為 null 時沿用原錨點的板名（資訊框沒印出板名）", () => {
    const h = new NavHistory();
    h.beginJump({ kind: "num", board: "C_Chat", num: 3 }, target);
    h.upgradePendingOriginAid(null, "1gIeu-3A");
    h.commitJump();
    expect(h.peek()).toMatchObject({ kind: "aid", board: "C_Chat" });
  });

  test("完全沒有板名可用 → 不升級（寧可維持原錨點，也不猜看板）", () => {
    const h = new NavHistory();
    h.beginJump(null, target);
    h.upgradePendingOriginAid(null, "1gIeu-3A");
    h.commitJump();
    expect(h.canGoBack()).toBe(false);
  });

  test("沒有在途 jump（back run／已 commit）時不生效", () => {
    const h = new NavHistory();
    h.beginJump({ kind: "num", board: "C_Chat", num: 3 }, target);
    h.commitJump();
    h.beginBack();
    h.upgradePendingOriginAid("C_Chat", "1gIeu-3A");
    expect(h.commitBack()).toMatchObject({ kind: "num", num: 3 });
  });
});
