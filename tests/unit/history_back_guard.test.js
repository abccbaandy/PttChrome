// 瀏覽器「返回」→ 左方向鍵的 history sentinel（src/js/history_back_guard.js）。
// 假 window 即可：這一層只碰 history / navigation / addEventListener。
//
// 這支鎖的核心是 **sentinel 補回來的方式**：觸控板返回手勢不是 user activation，
// 所以在 popstate handler 裡 pushState 出來的 entry 會被 Chrome 的 History
// Manipulation Intervention 標成可跳過 ⇒ 下一次手勢完全 no-op（實機症狀：滑一次
// 就失效，要點一下畫面才能再滑）。必須用 traversal（history.forward()）走回既有
// 的那一層。
import {
  installHistoryBackGuard,
  DOUBLE_BACK_MS,
  RESTORE_CHECK_MS,
  ESCAPE_HINT,
} from "../../src/js/history_back_guard";

function makeWin() {
  const listeners = {};
  const w = {
    // 呼叫序列（['push', state] / ['forward'] / ['go', n]）—— 「補回來用的是哪一種」
    // 是本功能的核心不變量，所以記順序而不是只記次數。
    calls: [],
    pushed: [],
    went: [],
    history: {
      state: null,
      pushState(state) {
        w.calls.push(["push", state]);
        w.pushed.push(state);
        w.history.state = state;
      },
      forward() {
        w.calls.push(["forward"]);
      },
      go(n) {
        w.calls.push(["go", n]);
        w.went.push(n);
      },
    },
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
    },
    count(type) {
      return (listeners[type] || []).length;
    },
    fire(type, e) {
      (listeners[type] || []).slice().forEach((fn) => fn(e));
    },
  };
  return w;
}

function setup({ backNav = 1, sent = true, navigation = null } = {}) {
  const win = makeWin();
  if (navigation) win.navigation = navigation;
  const hints = [];
  const keys = [];
  const app = {
    mouseGates: () => ({ backNav }),
    sendNavKeyAsUser: (k) => {
      keys.push(k);
      return sent;
    },
    view: { flashListHint: (m) => hints.push(m) },
  };
  let clock = 1000;
  // 補回 sentinel 的保險檢查是 setTimeout ⇒ 手動排乾，測試才不必等真時間。
  const timers = [];
  const guard = installHistoryBackGuard(app, win, {
    now: () => clock,
    setTimeout: (fn) => timers.push(fn),
  });
  return {
    win,
    app,
    hints,
    keys,
    guard,
    timers,
    // forward() 成功走回 sentinel 的樣子：state 回到那一層，再讓保險檢查跑完。
    settleForward: (id) => {
      win.history.state = { pttchromeBackGuard: id ?? 1 };
      win.fire("popstate", { state: win.history.state });
      timers.splice(0).forEach((fn) => fn());
    },
    // forward() 沒把我們帶回 sentinel（stack 被別人動過）的樣子。
    settleForwardLost: () => {
      win.history.state = null;
      timers.splice(0).forEach((fn) => fn());
    },
    tick: (ms) => {
      clock += ms;
    },
    activate: () => win.fire("pointerdown", {}),
    back: (state) => win.fire("popstate", { state: state ?? null }),
  };
}

// 假的 Navigation API：只需要 index 差算得出來。
function makeNavigation({ currentIndex = 1, canGoForward = true } = {}) {
  const navListeners = [];
  return {
    canGoForward,
    currentEntry: { index: currentIndex },
    addEventListener: (t, fn) => t === "navigate" && navListeners.push(fn),
    removeEventListener: (t, fn) => {
      const i = navListeners.indexOf(fn);
      if (i >= 0) navListeners.splice(i, 1);
    },
    traverseTo(index) {
      navListeners
        .slice()
        .forEach((fn) =>
          fn({ navigationType: "traverse", destination: { index } })
        );
    },
  };
}

describe("sentinel 的疊法", () => {
  test("沒有 user activation 之前不疊 —— Chrome 會跳過那種 entry 而直接離站", () => {
    const t = setup();
    expect(t.win.pushed).toHaveLength(0);
    t.activate();
    expect(t.win.pushed).toEqual([{ pttchromeBackGuard: 1 }]);
  });

  test("鍵盤也算 user activation", () => {
    const t = setup();
    t.win.fire("keydown", {});
    expect(t.win.pushed).toHaveLength(1);
  });

  test("重複的 activation 不會疊第二層", () => {
    const t = setup();
    t.activate();
    t.activate();
    t.activate();
    expect(t.win.pushed).toHaveLength(1);
  });

  test("pref 關閉時完全不疊（疊了卻不攔＝使用者要按兩次才離得開）", () => {
    const t = setup({ backNav: 0 });
    t.activate();
    expect(t.win.pushed).toHaveLength(0);
  });

  test("pref 後來才打開 ⇒ 下一次使用者動作補疊", () => {
    let backNav = 0;
    const win = makeWin();
    const app = {
      mouseGates: () => ({ backNav }),
      sendNavKeyAsUser: () => true,
      view: { flashListHint: () => {} },
    };
    installHistoryBackGuard(app, win);
    win.fire("pointerdown", {});
    expect(win.pushed).toHaveLength(0);
    backNav = 1;
    win.fire("pointerdown", {});
    expect(win.pushed).toHaveLength(1);
  });
});

describe("back 的攔截", () => {
  test("穿過 sentinel ⇒ 送左方向鍵 + 用 traversal 補回", () => {
    const t = setup();
    t.activate();
    t.back();
    expect(t.keys).toEqual(["ArrowLeft"]);
    expect(t.win.calls).toEqual([["push", { pttchromeBackGuard: 1 }], ["forward"]]);
    expect(t.win.went).toHaveLength(0); // 沒有離站
  });

  test("送得出去就不吵（畫面自己會退出文章）", () => {
    const t = setup();
    t.activate();
    t.back();
    expect(t.hints).toHaveLength(0);
  });

  test("守門擋下（例如 PTT 開著輸入框）時要提示怎麼離站，不可無聲吞掉", () => {
    const t = setup({ sent: false });
    t.activate();
    t.back();
    expect(t.hints).toEqual([ESCAPE_HINT]);
  });

  test("落回自己站著的那一層（按了下一頁）不算一次 back", () => {
    const t = setup();
    t.activate();
    t.back({ pttchromeBackGuard: 1 });
    expect(t.keys).toHaveLength(0);
  });

  test("沒疊過 sentinel 時不攔（pref 關著就是原生行為）", () => {
    const t = setup({ backNav: 0 });
    t.activate();
    t.back();
    expect(t.keys).toHaveLength(0);
    expect(t.win.pushed).toHaveLength(0);
  });

  test("中途把 pref 關掉 ⇒ 這一次 back 放行，不補 sentinel", () => {
    let backNav = 1;
    const win = makeWin();
    const keys = [];
    const app = {
      mouseGates: () => ({ backNav }),
      sendNavKeyAsUser: (k) => (keys.push(k), true),
      view: { flashListHint: () => {} },
    };
    installHistoryBackGuard(app, win);
    win.fire("pointerdown", {});
    backNav = 0;
    win.fire("popstate", { state: null });
    expect(keys).toHaveLength(0);
    expect(win.calls).toEqual([["push", { pttchromeBackGuard: 1 }]]);
  });
});

// F11：本次改版的核心。手勢本身不是 user activation ⇒ handler 裡 pushState 出來
// 的 entry 會被 intervention 跳過，第二次手勢就完全沒反應。
describe("連續返回（intervention 回歸鎖）", () => {
  test("第二次 back 一樣接得住，而且全程只 pushState 過一次", () => {
    const t = setup();
    t.activate();
    t.back();
    t.settleForward(1);
    t.tick(50);
    t.back();
    expect(t.keys).toEqual(["ArrowLeft", "ArrowLeft"]);
    expect(t.win.calls.filter((c) => c[0] === "push")).toHaveLength(1);
    expect(t.win.calls.filter((c) => c[0] === "forward")).toHaveLength(2);
  });

  test("連續 10 次都接得住（傳一次 activation 用到底）", () => {
    const t = setup();
    t.activate();
    for (let i = 0; i < 10; ++i) {
      t.back();
      t.settleForward(1);
      t.tick(50);
    }
    expect(t.keys).toHaveLength(10);
    expect(t.win.calls.filter((c) => c[0] === "push")).toHaveLength(1);
  });

  test("forward 沒回到 sentinel（stack 被動過）⇒ 保險補一層，下一次 back 才不會離站", () => {
    const t = setup();
    t.activate();
    t.back();
    t.settleForwardLost();
    expect(t.win.calls.filter((c) => c[0] === "push")).toHaveLength(2);
    t.tick(50);
    t.back();
    expect(t.keys).toEqual(["ArrowLeft", "ArrowLeft"]);
  });

  test("沒有 forward entry 可走（canGoForward false）⇒ 退回 pushState", () => {
    const t = setup({ navigation: makeNavigation({ canGoForward: false }) });
    t.activate();
    t.back();
    expect(t.win.calls).toEqual([
      ["push", { pttchromeBackGuard: 1 }],
      ["push", { pttchromeBackGuard: 2 }],
    ]);
  });
});

// F12：stack 裡可能有舊的 sentinel 殘骸（deep link 的 replaceState、使用者手動
// 操作）。用布林判斷會把「退到一層舊 sentinel 上」誤判成「沒有往外退」。
describe("sentinel 的唯一 id", () => {
  test("退到別的（舊的）sentinel 上仍然算一次往外退", () => {
    const t = setup();
    t.activate(); // myId = 1
    t.back({ pttchromeBackGuard: 99 });
    expect(t.keys).toEqual(["ArrowLeft"]);
  });

  test("認過新的那一層之後，再落回它就不算 back", () => {
    const t = setup();
    t.activate();
    t.back({ pttchromeBackGuard: 99 });
    t.settleForward(99);
    t.back({ pttchromeBackGuard: 99 });
    expect(t.keys).toEqual(["ArrowLeft"]);
  });
});

describe("離站逃生門（只有我們用不到的 back 才算）", () => {
  test("送得出去的 back 不算逃生門的一次 —— 連退兩層不可以把使用者丟出站", () => {
    const t = setup();
    t.activate();
    t.back();
    t.settleForward(1);
    t.tick(50); // 遠小於 DOUBLE_BACK_MS
    t.back();
    expect(t.keys).toEqual(["ArrowLeft", "ArrowLeft"]);
    expect(t.win.went).toHaveLength(0); // 還在站上
    expect(t.win.calls.filter((c) => c[0] === "forward")).toHaveLength(2);
  });

  test("送不出去時第二次放行：不補 sentinel ⇒ 下一次 back 自然離站", () => {
    const t = setup({ sent: false });
    t.activate();
    t.back();
    t.settleForward(1);
    t.tick(DOUBLE_BACK_MS - 1);
    t.back();
    // 放行＝什麼都不做（停在 E0）。**不可以 history.go(-1)**：開新分頁直接進站
    // 時 E0 前面根本沒有 entry，go(-1) 是靜默無效。
    expect(t.win.went).toHaveLength(0);
    expect(t.win.calls.filter((c) => c[0] === "forward")).toHaveLength(1);
    expect(t.hints).toEqual([ESCAPE_HINT]); // 第二次不再提示
  });

  test("放行之後真的不再攔（下一次 popstate 什麼都不做）", () => {
    const t = setup({ sent: false });
    t.activate();
    t.back();
    t.settleForward(1);
    t.tick(10);
    t.back(); // 放行
    t.win.calls.length = 0;
    t.back();
    expect(t.win.calls).toHaveLength(0);
    expect(t.hints).toHaveLength(1);
  });

  test("超過 800ms 就是兩次獨立的擋下，不會意外離站", () => {
    const t = setup({ sent: false });
    t.activate();
    t.back();
    t.settleForward(1);
    t.tick(DOUBLE_BACK_MS + 1);
    t.back();
    expect(t.win.calls.filter((c) => c[0] === "forward")).toHaveLength(2);
    expect(t.hints).toEqual([ESCAPE_HINT, ESCAPE_HINT]);
  });

  test("中間夾一次成功送出 ⇒ 計數重置，再一次擋下只是第一次", () => {
    const t = setup({ sent: false });
    t.activate();
    t.back(); // 擋下（計數 = 1）
    t.settleForward(1);
    t.app.sendNavKeyAsUser = () => true;
    t.tick(10);
    t.back(); // 送出去了 ⇒ 重置
    t.settleForward(1);
    t.app.sendNavKeyAsUser = () => false;
    t.tick(10);
    t.back(); // 又被擋下，但這是「第一次」
    expect(t.win.calls.filter((c) => c[0] === "forward")).toHaveLength(3);
  });
});

// F7：長按上一頁的下拉選單可以一次跳好幾層。單看 popstate 分不出退幾層。
describe("多階返回放行", () => {
  test("一次跳好幾層（delta < -1）不接管、不補 sentinel", () => {
    const nav = makeNavigation({ currentIndex: 5 });
    const t = setup({ navigation: nav });
    t.activate();
    nav.traverseTo(1); // delta = -4
    t.back();
    expect(t.keys).toHaveLength(0);
    expect(t.win.calls.filter((c) => c[0] === "forward")).toHaveLength(0);
  });

  test("退一層（delta === -1）照常接管", () => {
    const nav = makeNavigation({ currentIndex: 1 });
    const t = setup({ navigation: nav });
    t.activate();
    nav.traverseTo(0);
    t.back();
    expect(t.keys).toEqual(["ArrowLeft"]);
  });

  test("放行只作用一次，下一次返回照常接管", () => {
    const nav = makeNavigation({ currentIndex: 5 });
    const t = setup({ navigation: nav });
    t.activate();
    nav.traverseTo(1);
    t.back(); // 放行（armed 歸零）
    t.win.fire("pointerdown", {}); // 使用者又動了 ⇒ 重新疊
    nav.traverseTo(4);
    t.back();
    expect(t.keys).toEqual(["ArrowLeft"]);
  });

  test("push/replace 之類的 navigate 事件不影響（只認 traverse）", () => {
    const nav = makeNavigation({ currentIndex: 5 });
    const t = setup({ navigation: nav });
    t.activate();
    t.win.navigation.addEventListener; // noop，保持 API 形狀
    nav.traverseTo(1);
    // 上面設了 passThrough；再送一個非 traverse 不該把它清掉也不該再設一次
    t.back();
    expect(t.keys).toHaveLength(0);
  });
});

test("保險檢查用的是注入的 setTimeout，不會漏排（RESTORE_CHECK_MS 有值）", () => {
  expect(RESTORE_CHECK_MS).toBeGreaterThan(0);
});

test("uninstall 拆得乾淨（listener 不殘留）", () => {
  const nav = makeNavigation();
  const t = setup({ navigation: nav });
  t.guard.uninstall();
  expect(t.win.count("popstate")).toBe(0);
  expect(t.win.count("pointerdown")).toBe(0);
  expect(t.win.count("keydown")).toBe(0);
});
