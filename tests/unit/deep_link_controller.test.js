// Unit tests for DeepLinkController (src/js/deep_link_controller.js): 決定
// 「什麼時候可以跳」與「用哪個入口跳」。AidNavigation 用假物件（它自己的序列
// 已經在 aid_navigation.test.js 驗過了），這裡守的是排程行為。

import { DeepLinkController } from "../../src/js/deep_link_controller";

const TARGET = { board: "Gossiping", aid: "1gIeu-3A" };
const MAIN_MENU_ROW0 = "【主功能表】 (0)離開 (1)資訊 (2)聊天";
// 文章 pager 的末列（string_util.parseStatusRow 認得的形狀）
const STATUS_ROW =
  "  瀏覽 第 1/2 頁 ( 45%)  目前顯示: 第 1~23 行  (y)回應(X%)推文(h)說明(←)離開 ";

function makeHarness({
  connectState = 1,
  startedEasyReading = false,
  lastRow = "",
  // 閱讀位置：錨點記的是行索引 = scrollTop / chh
  scrollTop = null,
  chh = 20
} = {}) {
  const listeners = {};
  const termBuf = {
    startedEasyReading,
    rows: 24,
    cols: 80,
    row0: "",
    lastRow,
    getRowText(row) {
      if (row === 0) return this.row0;
      return row === 23 ? this.lastRow : "";
    },
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    }
  };
  const nav = {
    active: false,
    startCalls: [],
    externalCalls: [],
    // queryPostAid / reopenAfterPostInfo 的假版本：把 handler 收起來，由 test
    // 決定 PTT「回答」了什麼（真實序列已在 aid_navigation.test.js 驗過）。
    queries: [],
    reopenArgs: [],
    queryPostAid(handlers) {
      this.queries.push(handlers);
    },
    reopenAfterPostInfo(lineIndex) {
      this.reopenArgs.push(lineIndex);
    },
    // start() 沒有回傳值，成功與否由 active 表達（真實行為）
    start(aid, board) {
      this.startCalls.push({ aid, board });
      this.active = true;
    },
    startExternal(aid, board) {
      this.externalCalls.push({ aid, board });
      if (this.active) return false;
      this.active = true;
      return true;
    }
  };
  const autoLogin = { stopCalls: 0, stop() { this.stopCalls++; } };
  const easyReading = {
    functionModeCalls: 0,
    // 忠實模擬真實副作用：_enterFunctionMode 結尾的 termBuf.notify() 是**同步**的
    // （term_buf.js 的 changed 分支直接呼叫 view.update()），而 term_view.redraw 的
    // functionMode 分支第一件事就是 mainDisplay.scrollTop = 0（24 列原生畫面本來就
    // 該從頂端顯示）。沒有這一行，任何「先進 functionMode 才讀捲動位置」的順序錯誤
    // 在這裡都測不出來 —— 下面那條 REGRESSION 曾因此是假綠燈。
    _enterFunctionMode() {
      this.functionModeCalls++;
      if (view.mainDisplay) view.mainDisplay.scrollTop = 0;
    }
  };
  const hints = [];
  const handoffNotices = [];
  const view = {
    flashListHint: msg => hints.push(msg),
    notifyDeepLinkHandoff: t => handoffNotices.push(t),
    mainDisplay: scrollTop == null ? null : { scrollTop },
    chh
  };
  const core = { connectState, aidNavigation: nav, autoLogin, easyReading };
  const ctl = new DeepLinkController(core, view, termBuf);
  const settle = () => (listeners.screenSettled || []).forEach(fn => fn());
  const arriveAtMainMenu = () => {
    termBuf.row0 = MAIN_MENU_ROW0;
    settle();
  };
  return {
    ctl, core, nav, autoLogin, easyReading, termBuf, view, hints, handoffNotices,
    settle, arriveAtMainMenu
  };
}

describe("未登入", () => {
  test("連結先到 → 暫存，什麼都不跳，並告訴使用者", () => {
    const h = makeHarness();
    expect(h.ctl.request(TARGET)).toBe("pending");
    expect(h.nav.startCalls).toEqual([]);
    expect(h.nav.externalCalls).toEqual([]);
    expect(h.hints.some(m => m.includes("登入後將跳至 #1gIeu-3A"))).toBe(true);
  });

  test("登入完成（畫面出現主功能表）→ 自動跳", () => {
    const h = makeHarness();
    h.ctl.request(TARGET);
    h.arriveAtMainMenu();
    expect(h.nav.externalCalls).toEqual([
      { aid: "1gIeu-3A", board: "Gossiping" }
    ]);
    expect(h.ctl.hasPending()).toBe(false);
  });

  test("只跳一次：主功能表再次 settle 不會重跳", () => {
    const h = makeHarness();
    h.ctl.request(TARGET);
    h.arriveAtMainMenu();
    h.nav.active = false;
    h.arriveAtMainMenu();
    expect(h.nav.externalCalls).toHaveLength(1);
  });

  test("登入前的其他畫面（帳號 prompt 等）settle 不觸發", () => {
    const h = makeHarness();
    h.ctl.request(TARGET);
    h.termBuf.row0 = "請輸入代號，或以 guest 參觀，或以 new 註冊:";
    h.settle();
    expect(h.nav.externalCalls).toEqual([]);
    expect(h.ctl.hasPending()).toBe(true);
  });

  test("後到的連結覆蓋先到的（只留最後一個）", () => {
    const h = makeHarness();
    h.ctl.request(TARGET);
    h.ctl.request({ board: "movie", aid: "2AbCdEf0" });
    h.arriveAtMainMenu();
    expect(h.nav.externalCalls).toEqual([{ aid: "2AbCdEf0", board: "movie" }]);
  });

  test("尚未連上線（connectState 0）→ 一樣先收著", () => {
    const h = makeHarness({ connectState: 0 });
    expect(h.ctl.request(TARGET)).toBe("pending");
    h.core.connectState = 1;
    h.arriveAtMainMenu();
    expect(h.nav.externalCalls).toHaveLength(1);
  });
});

describe("已登入", () => {
  test("在主功能表：立刻跳，走 startExternal（沒有原文可回）", () => {
    const h = makeHarness();
    h.arriveAtMainMenu();
    expect(h.ctl.request(TARGET)).toBe("navigating");
    expect(h.nav.externalCalls).toHaveLength(1);
    expect(h.nav.startCalls).toEqual([]);
  });

  test("正在看文章：走 start()，這樣跳完才有「← 返回原文」", () => {
    const h = makeHarness({ startedEasyReading: true });
    h.arriveAtMainMenu();
    h.termBuf.row0 = "作者  someone (某人)  看板  movie";
    expect(h.ctl.request(TARGET)).toBe("navigating");
    expect(h.nav.startCalls).toEqual([{ aid: "1gIeu-3A", board: "Gossiping" }]);
    expect(h.nav.externalCalls).toEqual([]);
  });

  test("跳轉派工前先關掉 AutoLogin 的輪詢", () => {
    // AutoLogin 的「看到請按任意鍵就送空白」分支會踩進板畫面，打亂
    // CommandQueue 正在等的那一幀。
    const h = makeHarness();
    h.arriveAtMainMenu();
    h.ctl.request(TARGET);
    expect(h.autoLogin.stopCalls).toBe(1);
  });

  test("已有跳轉在跑 → 收著，下一次 settle 再試", () => {
    const h = makeHarness();
    h.arriveAtMainMenu();
    h.nav.active = true;
    expect(h.ctl.request(TARGET)).toBe("pending");
    expect(h.nav.externalCalls).toEqual([]);
    h.nav.active = false;
    h.settle();
    expect(h.nav.externalCalls).toHaveLength(1);
  });

  test("派工失敗（startExternal 回 false）→ 目標放回去，不會被吃掉", () => {
    const h = makeHarness();
    h.arriveAtMainMenu();
    h.ctl.request(TARGET);
    h.nav.externalCalls.length = 0;
    // 模擬「settle 當下 nav 剛好忙起來」：_canNavigate 過了但 dispatch 失敗
    h.ctl.request({ board: "movie", aid: "2AbCdEf0" }); // active 仍為 true → pending
    expect(h.ctl.hasPending()).toBe(true);
  });
});

describe("斷線", () => {
  test("reset 清掉待跳目標與登入狀態", () => {
    const h = makeHarness();
    h.arriveAtMainMenu();
    h.nav.active = true;
    h.ctl.request(TARGET);
    expect(h.ctl.hasPending()).toBe(true);
    h.ctl.reset();
    expect(h.ctl.hasPending()).toBe(false);
    // 登入狀態也一起清掉：重連後回到登入畫面，之前的主功能表不算數
    h.nav.active = false;
    h.termBuf.row0 = "作者  someone";
    h.settle();
    expect(h.ctl.request(TARGET)).toBe("pending");
  });
});

describe("複製本篇連結", () => {
  const BASE = "https://example.github.io/pttchrome/";

  // controller 只透過這兩個 seam 碰瀏覽器，測試裡換掉即可。
  function withClipboard(ctl, impl) {
    const written = [];
    ctl._locationHref = () => BASE;
    ctl._clipboard = () => ({
      writeText: text => {
        written.push(text);
        return impl ? impl(text) : Promise.resolve();
      }
    });
    return written;
  }

  test("在文章裡：Q 問出 AID → 組出正規連結 → 進剪貼簿，並關掉資訊框", async () => {
    const h = makeHarness({ lastRow: STATUS_ROW });
    const written = withClipboard(h.ctl);
    expect(h.ctl.copyCurrentPostLink()).toBe(true);
    expect(h.nav.queries).toHaveLength(1);
    h.nav.queries[0].onDone({ aid: "1gIeu-3A", board: "movie" });
    expect(written).toEqual([BASE + "#movie/1gIeu-3A"]);
    // 回原處永遠要走，否則使用者被丟在 Q 之後的文章列表上
    expect(h.nav.reopenArgs).toHaveLength(1);
    await Promise.resolve();
    expect(h.hints.some(m => m.includes("已複製"))).toBe(true);
  });

  test("REGRESSION：複製完必須回到原本那篇，並帶回閱讀位置", () => {
    // mbbsd/bbs.c:2375-2377：Q 的回應是 view_postinfo(...) 之後 return
    // FULLUPDATE ⇒ pttbbs 一定把畫面換成文章列表。實測 2026-08-16：複製完就
    // 跳出該篇。回原處由 reopenAfterPostInfo 負責（關框 → Enter）。
    const h = makeHarness({ lastRow: STATUS_ROW, scrollTop: 240, chh: 20 });
    withClipboard(h.ctl);
    h.ctl.copyCurrentPostLink();
    h.nav.queries[0].onDone({ aid: "1gIeu-3A", board: "movie" });
    expect(h.nav.reopenArgs).toEqual([12]); // 240 / 20
  });

  test("REGRESSION：閱讀位置必須在 _enterFunctionMode **之前**擷取", () => {
    // ORDER INVARIANT（與 aid_navigation.start() 同一條）：_enterFunctionMode 會同步
    // 把 mainDisplay.scrollTop 歸零，順序反過來讀到的永遠是 0 ⇒ _enqueueReopen 的
    // `if (lineIndex …)` falsy ⇒ 複製完雖然回到原篇，卻停在第一行。
    // 實測 2026-08-16：「複製連結會跳出文章，只是單純再按一次 Enter 進來」。
    const h = makeHarness({ lastRow: STATUS_ROW, scrollTop: 240, chh: 20 });
    withClipboard(h.ctl);
    h.ctl.copyCurrentPostLink();
    // 前提成立：確實進了 functionMode，畫面也確實被歸零了
    expect(h.easyReading.functionModeCalls).toBe(1);
    expect(h.view.mainDisplay.scrollTop).toBe(0);
    // 但帶回去的必須是歸零**之前**的第 12 行
    h.nav.queries[0].onDone({ aid: "1gIeu-3A", board: "movie" });
    expect(h.nav.reopenArgs).toEqual([12]);
  });

  test("按 Q 前先進 functionMode（停掉好讀的累積／翻頁）", () => {
    const h = makeHarness({ lastRow: STATUS_ROW });
    withClipboard(h.ctl);
    h.ctl.copyCurrentPostLink();
    expect(h.easyReading.functionModeCalls).toBe(1);
  });

  test("不在文章畫面時不進 functionMode（根本沒按 Q）", () => {
    const h = makeHarness({ lastRow: "" });
    h.ctl.copyCurrentPostLink();
    expect(h.easyReading.functionModeCalls).toBe(0);
  });

  test("不在文章畫面（末列不是 pager 狀態列）→ 不按 Q，直接說明", () => {
    const h = makeHarness({ lastRow: "" });
    expect(h.ctl.copyCurrentPostLink()).toBe(false);
    expect(h.nav.queries).toEqual([]);
    expect(h.hints.some(m => m.includes("請在文章內"))).toBe(true);
  });

  test("問不出看板（站內信／精華區，pttbbs 印「不明」）→ 不產生連結，但仍回原處", () => {
    const h = makeHarness({ lastRow: STATUS_ROW });
    const written = withClipboard(h.ctl);
    h.ctl.copyCurrentPostLink();
    h.nav.queries[0].onDone({ aid: "1gIeu-3A", board: null });
    expect(written).toEqual([]);
    expect(h.nav.reopenArgs).toHaveLength(1);
    expect(h.hints.some(m => m.includes("無法產生連結"))).toBe(true);
  });

  test("這篇根本沒有 AID → onDone(null) 也要回原處", () => {
    const h = makeHarness({ lastRow: STATUS_ROW });
    withClipboard(h.ctl);
    h.ctl.copyCurrentPostLink();
    h.nav.queries[0].onDone(null);
    expect(h.nav.reopenArgs).toHaveLength(1);
    expect(h.hints.some(m => m.includes("無法產生連結"))).toBe(true);
  });

  test("剪貼簿被擋 → 退而把連結顯示出來，讓使用者自己複製", async () => {
    const h = makeHarness({ lastRow: STATUS_ROW });
    withClipboard(h.ctl, () => Promise.reject(new Error("NotAllowedError")));
    h.ctl.copyCurrentPostLink();
    h.nav.queries[0].onDone({ aid: "1gIeu-3A", board: "movie" });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.hints.some(m => m.includes(BASE + "#movie/1gIeu-3A"))).toBe(true);
  });

  test("跳轉進行中不搶 queue", () => {
    const h = makeHarness({ lastRow: STATUS_ROW });
    h.nav.active = true;
    expect(h.ctl.copyCurrentPostLink()).toBe(false);
    expect(h.nav.queries).toEqual([]);
  });

  test("沒連線就不做", () => {
    const h = makeHarness({ connectState: 2, lastRow: STATUS_ROW });
    expect(h.ctl.copyCurrentPostLink()).toBe(false);
    expect(h.nav.queries).toEqual([]);
  });
});

// 外部連結一定開新分頁，交接是唯一「使用者的眼睛在別的分頁」的情境 —— 這個分頁
// 不出聲的話，跳轉等於靜默發生（實測回報：分頁本身沒有任何反應，得自己翻分頁找）。
describe("跨分頁接手時的通知", () => {
  test("接手（source: handoff）→ 通知使用者", () => {
    const h = makeHarness();
    h.arriveAtMainMenu();
    h.ctl.request(TARGET, { source: "handoff" });
    expect(h.handoffNotices).toEqual([TARGET]);
  });

  test("REGRESSION：還沒登入（走 _hold）也要通知 —— 落地可能永遠不會發生", () => {
    // 接手的分頁若尚未登入，目標會被收著等登入。使用者得先知道有東西在等他，
    // 不然他永遠不會切過來、也就永遠不會登入。
    const h = makeHarness();
    expect(h.ctl.request(TARGET, { source: "handoff" })).toBe("pending");
    expect(h.handoffNotices).toEqual([TARGET]);
  });

  test("使用者自己在這個分頁開的連結不通知（通知他自己剛做的事只是噪音）", () => {
    const h = makeHarness();
    h.arriveAtMainMenu();
    h.ctl.request(TARGET);
    h.ctl.request({ board: "movie", aid: "2AbCdEf0" }, { source: "hashchange" });
    expect(h.handoffNotices).toEqual([]);
  });

  test("壞目標不通知", () => {
    const h = makeHarness();
    h.ctl.request({ board: "Gossiping" }, { source: "handoff" });
    expect(h.handoffNotices).toEqual([]);
  });

  test("view 沒有 notifyDeepLinkHandoff（舊 view／測試替身）不能炸", () => {
    const h = makeHarness();
    delete h.view.notifyDeepLinkHandoff;
    expect(() => h.ctl.request(TARGET, { source: "handoff" })).not.toThrow();
  });
});

describe("壞輸入", () => {
  test("null / 缺欄位 → 不收也不跳", () => {
    const h = makeHarness();
    h.arriveAtMainMenu();
    expect(h.ctl.request(null)).toBeNull();
    expect(h.ctl.request({ board: "Gossiping" })).toBeNull();
    expect(h.ctl.request({ aid: "1gIeu-3A" })).toBeNull();
    expect(h.nav.externalCalls).toEqual([]);
    expect(h.ctl.hasPending()).toBe(false);
  });
});
