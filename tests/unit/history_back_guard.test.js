// 瀏覽器「上一頁」→ 左方向鍵的 history sentinel（src/js/history_back_guard.js）。
// 假 window 即可：這一層只碰 history/addEventListener。
import {
  installHistoryBackGuard,
  DOUBLE_BACK_MS,
  ESCAPE_HINT,
} from "../../src/js/history_back_guard";

function makeWin() {
  const listeners = {};
  return {
    pushed: [],
    went: [],
    history: {
      pushState(state) {
        this._w.pushed.push(state);
      },
      go(n) {
        this._w.went.push(n);
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
}

function setup({ backButton = 1, sent = true } = {}) {
  const win = makeWin();
  win.history._w = win;
  const hints = [];
  const keys = [];
  const app = {
    mouseGates: () => ({ backButton }),
    sendNavKeyAsUser: (k) => {
      keys.push(k);
      return sent;
    },
    view: { flashListHint: (m) => hints.push(m) },
  };
  let clock = 1000;
  const guard = installHistoryBackGuard(app, win, { now: () => clock });
  return {
    win,
    app,
    hints,
    keys,
    guard,
    tick: (ms) => {
      clock += ms;
    },
    activate: () => win.fire("pointerdown", {}),
    back: (state) => win.fire("popstate", { state: state ?? null }),
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
    const t = setup({ backButton: 0 });
    t.activate();
    expect(t.win.pushed).toHaveLength(0);
  });

  test("pref 後來才打開 ⇒ 下一次使用者動作補疊", () => {
    let backButton = 0;
    const win = makeWin();
    win.history._w = win;
    const app = {
      mouseGates: () => ({ backButton }),
      sendNavKeyAsUser: () => true,
      view: { flashListHint: () => {} },
    };
    installHistoryBackGuard(app, win);
    win.fire("pointerdown", {});
    expect(win.pushed).toHaveLength(0);
    backButton = 1;
    win.fire("pointerdown", {});
    expect(win.pushed).toHaveLength(1);
  });
});

describe("back 的攔截", () => {
  test("穿過 sentinel ⇒ 補回一層 + 送左方向鍵", () => {
    const t = setup();
    t.activate();
    t.back();
    expect(t.keys).toEqual(["ArrowLeft"]);
    expect(t.win.pushed).toHaveLength(2); // 原本那層 + 補回來的
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

  test("落在 sentinel 上的 popstate（按了下一頁）不算一次 back", () => {
    const t = setup();
    t.activate();
    t.back({ pttchromeBackGuard: 1 });
    expect(t.keys).toHaveLength(0);
  });

  test("沒疊過 sentinel 時不攔（pref 關著就是原生行為）", () => {
    const t = setup({ backButton: 0 });
    t.activate();
    t.back();
    expect(t.keys).toHaveLength(0);
    expect(t.win.pushed).toHaveLength(0);
  });

  test("中途把 pref 關掉 ⇒ 這一次 back 放行，不補 sentinel", () => {
    let backButton = 1;
    const win = makeWin();
    win.history._w = win;
    const keys = [];
    const app = {
      mouseGates: () => ({ backButton }),
      sendNavKeyAsUser: (k) => (keys.push(k), true),
      view: { flashListHint: () => {} },
    };
    installHistoryBackGuard(app, win);
    win.fire("pointerdown", {});
    backButton = 0;
    win.fire("popstate", { state: null });
    expect(keys).toHaveLength(0);
    expect(win.pushed).toHaveLength(1);
  });
});

describe("離站逃生門（連按兩次）", () => {
  test("800ms 內第二次 back 放行離站", () => {
    const t = setup();
    t.activate();
    t.back();
    t.tick(DOUBLE_BACK_MS - 1);
    t.back();
    expect(t.win.went).toEqual([-1]);
    expect(t.keys).toEqual(["ArrowLeft"]); // 第二次不再送鍵
  });

  test("超過 800ms 就是兩次獨立的退出，不會意外離站", () => {
    const t = setup();
    t.activate();
    t.back();
    t.tick(DOUBLE_BACK_MS + 1);
    t.back();
    expect(t.win.went).toHaveLength(0);
    expect(t.keys).toEqual(["ArrowLeft", "ArrowLeft"]);
  });
});

test("uninstall 拆得乾淨（listener 不殘留）", () => {
  const t = setup();
  t.guard.uninstall();
  expect(t.win.count("popstate")).toBe(0);
  expect(t.win.count("pointerdown")).toBe(0);
  expect(t.win.count("keydown")).toBe(0);
});
