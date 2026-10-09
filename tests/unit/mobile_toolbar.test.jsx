// @unit-env browser
// real-input: tests/e2e/offline/mobile_toolbar.offline.spec.js
//   （touchscreen.tap；本檔手捏事件只測分支邏輯，見 tests/unit/e2e_real_input.test.js）
// 手機底部工具列（src/components/MobileToolbar）。鎖：
//  1. 按鈕依畫面顯示（推＝文章裡；搜尋＝列表）——資料來自 App.onScreenContextChange；
//  2. 送鍵走 view.sendKeyAsUser（鍵盤同一條分派），不是裸送 byte；
//  3. mousedown 被 preventDefault（不搶 #t 焦點）、滑鼠事件不外洩到 window；
//  4. 工具列高度 ＝ MOBILE_TOOLBAR_PX（終端機可用高度扣的就是它）。
import { render, fireEvent, act } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MobileToolbar, LOGOUT_CONFIRM_MS, HAPTIC_MS } from "../../src/components/MobileToolbar";
import { MOBILE_TOOLBAR_PX } from "../../src/js/mobile_layout";
import { setupI18n, i18n } from "../../src/js/i18n";
import toolbarCss from "../../src/components/MobileToolbar/MobileToolbar.css?raw";

beforeAll(() => {
  setupI18n();
});

function makeCore({ mobile = true, context } = {}) {
  const listeners = new Set();
  const ctxListeners = new Set();
  let ctx = context || { push: false, search: [] };
  const core = {
    mobile,
    softKeyboard: false,
    mobileSelectMode: false,
    mobileCtrlArmed: false,
    view: { sendKeyAsUser: vi.fn() },
    startLogout: vi.fn(() => true),
    setMobileKeysPanelInset: vi.fn(),
    setMobileSelectMode: vi.fn((on) => {
      core.mobileSelectMode = !!on;
      return core.mobileSelectMode;
    }),
    setMobileCtrlArmed: vi.fn((on) => {
      core.mobileCtrlArmed = !!on;
      return core.mobileCtrlArmed;
    }),
    toggleSoftKeyboard: vi.fn(() => {
      core.softKeyboard = !core.softKeyboard;
      return core.softKeyboard;
    }),
    onMobileChange: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    onScreenContextChange: (fn) => {
      ctxListeners.add(fn);
      fn(ctx);
      return () => ctxListeners.delete(fn);
    },
    emit: (m, kb = false, sel = false, c = false) => {
      core.mobile = m;
      listeners.forEach((fn) => fn(m, kb, sel, c));
    },
    setContext: (next) => {
      ctx = next;
      ctxListeners.forEach((fn) => fn(next));
    },
  };
  return core;
}

const byKey = (k) => document.querySelector(`[data-key="${k}"]`);
// 「更多」是 Mantine Drawer：內容在 transition 開始後才掛上、結束後才卸下（非同步）。
const openMore = async () => {
  fireEvent.click(byKey("__more"));
  await vi.waitFor(() => expect(byKey("__select")).not.toBeNull());
};
const sheetClosed = () => vi.waitFor(() => expect(byKey("__select")).toBeNull());
// 「更多」是 Mantine Drawer（components/MobileSheet）⇒ 要 MantineProvider。
const renderBar = (core, props = {}) =>
  render(
    <MantineProvider>
      <MobileToolbar pttchrome={core} {...props} />
    </MantineProvider>,
  );

describe("顯示", () => {
  test("非手機不渲染；mobile 變化時跟著出現／消失", () => {
    const core = makeCore({ mobile: false });
    renderBar(core);
    expect(document.getElementById("mobileToolbar")).toBeNull();
    act(() => core.emit(true));
    expect(document.getElementById("mobileToolbar")).not.toBeNull();
    act(() => core.emit(false));
    expect(document.getElementById("mobileToolbar")).toBeNull();
  });

  test("modal 開著時隱藏", () => {
    renderBar(makeCore(), { hidden: true });
    expect(document.getElementById("mobileToolbar")).toBeNull();
  });

  test("按鍵、更多常駐；推只在文章、搜尋只在列表", () => {
    const core = makeCore();
    renderBar(core);
    expect(byKey("__keys")).not.toBeNull();
    expect(byKey("__more")).not.toBeNull();
    expect(byKey("X")).toBeNull();
    expect(byKey("__search")).toBeNull();
    act(() => core.setContext({ push: true, search: [] }));
    expect(byKey("X")).not.toBeNull();
    expect(byKey("__search")).toBeNull();
    act(() => core.setContext({ push: false, search: ["title", "author", "push", "board"] }));
    expect(byKey("X")).toBeNull();
    expect(byKey("__search")).not.toBeNull();
  });

  test("工具列高度與 MOBILE_TOOLBAR_PX 一致（終端機可用高度扣的就是它）", () => {
    const m = /\.mobileToolbarBar\s*\{[^}]*?\bheight:\s*(\d+)px/.exec(toolbarCss);
    expect(m && Number(m[1])).toBe(MOBILE_TOOLBAR_PX);
  });
});

describe("推／搜尋", () => {
  test("推送 X（走 sendKeyAsUser，跟實體鍵盤同一條分派 ⇒ 預設開長推文）", () => {
    const core = makeCore({ context: { push: true, search: [] } });
    renderBar(core);
    fireEvent.click(byKey("X"));
    expect(core.view.sendKeyAsUser).toHaveBeenCalledWith("X");
  });

  // 使用者定案：不要子選單，直接開彈窗（種類在彈窗上方切）。
  test("搜尋直接開彈窗：文章列表預設標題，不出現子選單", () => {
    const core = makeCore({ context: { push: false, search: ["title", "author", "push", "board"] } });
    const onOpenSearch = vi.fn();
    renderBar(core, { onOpenSearch });
    fireEvent.click(byKey("__search"));
    expect(onOpenSearch).toHaveBeenCalledWith("title");
    expect(document.querySelector('[data-panel="search"]')).toBeNull();
    expect(document.querySelector('[data-key^="__search_"]')).toBeNull();
  });

  test("看板列表／主功能表：預設看板", () => {
    const core = makeCore({ context: { push: false, search: ["board"] } });
    const onOpenSearch = vi.fn();
    renderBar(core, { onOpenSearch });
    fireEvent.click(byKey("__search"));
    expect(onOpenSearch).toHaveBeenCalledWith("board");
  });

  test("按搜尋會收掉開著的按鍵面板", () => {
    const core = makeCore({ context: { push: false, search: ["title"] } });
    renderBar(core, { onOpenSearch: vi.fn() });
    fireEvent.click(byKey("__keys"));
    expect(byKey("PageDown")).not.toBeNull();
    fireEvent.click(byKey("__search"));
    expect(byKey("PageDown")).toBeNull();
  });
});

describe("依畫面的動作（文章／信件／文章列表）", () => {
  const ARTICLE = { push: true, reply: true, mail: false, share: true, threadNav: true, post: false, search: [] };

  test("文章：推／回文／分享，回文送 y（pager_common_cmds）", () => {
    const core = makeCore({ context: ARTICLE });
    renderBar(core);
    expect(["X", "__reply", "__share", "__keys", "__more"].every((k) => byKey(k))).toBe(true);
    expect(byKey("__post")).toBeNull();
    expect(byKey("__reply").textContent).toBe(i18n("mobileToolbar_reply"));
    fireEvent.click(byKey("__reply"));
    expect(core.view.sendKeyAsUser).toHaveBeenLastCalledWith("y");
  });

  test("信件 pager：只有回信（label 換成回信），沒有推／分享", () => {
    renderBar(makeCore({ context: { ...ARTICLE, push: false, share: false, threadNav: false, mail: true } }));
    expect(byKey("__reply").textContent).toBe(i18n("mobileToolbar_replyMail"));
    expect(byKey("X")).toBeNull();
    expect(byKey("__share")).toBeNull();
  });

  test("分享：同步呼叫 deepLinkController.shareCurrentPostLink（帶 App Bar 標題）", () => {
    const core = makeCore({
      context: { ...ARTICLE, appBar: { kind: "article", title: "[問卦] 測試", subtitle: "", newMail: false } },
    });
    core.deepLinkController = { shareCurrentPostLink: vi.fn(() => true) };
    renderBar(core);
    fireEvent.click(byKey("__share"));
    expect(core.deepLinkController.shareCurrentPostLink).toHaveBeenCalledWith("[問卦] 測試");
  });

  test("文章列表：發文送 Ctrl+P（Alt remap，繞過瀏覽器的列印）", () => {
    const core = makeCore({ context: { push: false, search: ["title"], post: true } });
    renderBar(core);
    fireEvent.click(byKey("__post"));
    expect(core.view.sendKeyAsUser).toHaveBeenLastCalledWith("p", { altKey: true });
  });

  test("更多：文章導覽只在文章出現，送 [ ] = b f 並收起 sheet", async () => {
    const core = makeCore({ context: ARTICLE });
    renderBar(core);
    for (const k of ["[", "]", "=", "b", "f"]) {
      await openMore();
      fireEvent.click(byKey(k));
      await sheetClosed();
    }
    expect(core.view.sendKeyAsUser.mock.calls.map((c) => c[0])).toEqual(["[", "]", "=", "b", "f"]);
    act(() => core.setContext({ push: false, search: [] }));
    await openMore();
    expect(byKey("__threadNav")).toBeNull();
  });

  test("按下有觸覺回饋（navigator.vibrate 短震）", () => {
    const vibrate = vi.fn(() => true);
    const orig = Object.getOwnPropertyDescriptor(Navigator.prototype, "vibrate");
    Object.defineProperty(navigator, "vibrate", { configurable: true, value: vibrate });
    try {
      renderBar(makeCore({ context: ARTICLE }));
      fireEvent.click(byKey("__reply"));
      expect(vibrate).toHaveBeenCalledWith(HAPTIC_MS);
    } finally {
      delete navigator.vibrate;
      if (orig) Object.defineProperty(Navigator.prototype, "vibrate", orig);
    }
  });

  test("每個按鈕都有 icon＋文字 label", () => {
    renderBar(makeCore({ context: ARTICLE }));
    for (const btn of document.querySelectorAll(".mobileToolbarBtn")) {
      expect(btn.querySelector("svg")).not.toBeNull();
      expect(btn.querySelector(".mobileToolbarLabel").textContent.length).toBeGreaterThan(0);
    }
  });
});

describe("按鍵面板", () => {
  test("預設收起，按「按鍵」展開，按鍵走 sendKeyAsUser", () => {
    const core = makeCore();
    renderBar(core);
    expect(byKey("PageDown")).toBeNull();
    fireEvent.click(byKey("__keys"));
    for (const k of ["PageDown", "ArrowLeft", "Escape", "Tab", "Delete"]) fireEvent.click(byKey(k));
    expect(core.view.sendKeyAsUser.mock.calls.map((c) => c[0])).toEqual([
      "PageDown",
      "ArrowLeft",
      "Escape",
      "Tab",
      "Delete",
    ]);
    fireEvent.click(byKey("__keys"));
    expect(byKey("PageDown")).toBeNull();
  });

  test("展開時把面板高度回報給 App（終端機排在面板上方），收起回 0", () => {
    const core = makeCore();
    renderBar(core);
    fireEvent.click(byKey("__keys"));
    const last = () => core.setMobileKeysPanelInset.mock.calls.at(-1)[0];
    expect(last()).toBeGreaterThan(0);
    fireEvent.click(byKey("__keys"));
    expect(last()).toBe(0);
  });

  test("鍵盤鈕呼叫 toggleSoftKeyboard；App 自己歸零時亮燈跟著熄", () => {
    const core = makeCore();
    renderBar(core);
    fireEvent.click(byKey("__keys"));
    fireEvent.click(byKey("__keyboard"));
    expect(core.toggleSoftKeyboard).toHaveBeenCalledTimes(1);
    expect(byKey("__keyboard").getAttribute("aria-pressed")).toBe("true");
    act(() => core.emit(true, false));
    expect(byKey("__keyboard").getAttribute("aria-pressed")).toBe("false");
  });

  test("Ctrl：切 App 的黏滯狀態，用掉之後（App 通知）亮燈熄", () => {
    const core = makeCore();
    renderBar(core);
    fireEvent.click(byKey("__keys"));
    fireEvent.click(byKey("__ctrl"));
    expect(core.setMobileCtrlArmed).toHaveBeenCalledWith(true);
    expect(byKey("__ctrl").getAttribute("aria-pressed")).toBe("true");
    act(() => core.emit(true, false, false, false));
    expect(byKey("__ctrl").getAttribute("aria-pressed")).toBe("false");
    expect(core.view.sendKeyAsUser).not.toHaveBeenCalled();
  });
});

describe("更多（bottom sheet）", () => {
  test("選取模式：呼叫 setMobileSelectMode", async () => {
    const core = makeCore();
    renderBar(core);
    await openMore();
    expect(byKey("__select").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(byKey("__select"));
    expect(core.setMobileSelectMode).toHaveBeenCalledWith(true);
  });

  test("設定：交給 onOpenSettings", async () => {
    const onOpenSettings = vi.fn();
    renderBar(makeCore(), { onOpenSettings });
    await openMore();
    fireEvent.click(byKey("__settings"));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  test("登出要二次確認；確認才呼叫 startLogout", async () => {
    const core = makeCore();
    renderBar(core);
    await openMore();
    fireEvent.click(byKey("__logout"));
    expect(core.startLogout).not.toHaveBeenCalled();
    fireEvent.click(byKey("__logoutYes"));
    expect(core.startLogout).toHaveBeenCalledTimes(1);
  });

  // sheet 開著＝modal（遮罩點下去的 click 會到 window 上的 App 滑鼠入口，靠 modalShown
  // 早退）；系統返回＝收起（向 App 登記關閉函式，history_back_guard 先問它）。
  test("開著時以具名來源設 modal、登記系統返回；收起時兩者都撤銷", async () => {
    const core = makeCore();
    const sources = new Set();
    core.setModalOpen = vi.fn((s, on) => (on ? sources.add(s) : sources.delete(s)));
    const dismissers = [];
    core.registerSheetDismiss = vi.fn((fn) => {
      dismissers.push(fn);
      return () => dismissers.splice(dismissers.indexOf(fn), 1);
    });
    renderBar(core);
    expect(sources.size).toBe(0);
    await openMore();
    expect(sources.size).toBe(1);
    expect(dismissers).toHaveLength(1);
    act(() => dismissers[0]()); // 系統返回
    await sheetClosed();
    expect(sources.size).toBe(0);
    expect(dismissers).toHaveLength(0);
  });

  test("登出確認沒動作會自己收回（防口袋誤觸）", async () => {
    const core = makeCore();
    renderBar(core);
    await openMore();
    vi.useFakeTimers();
    try {
      fireEvent.click(byKey("__logout"));
      expect(byKey("__logoutYes")).not.toBeNull();
      act(() => vi.advanceTimersByTime(LOGOUT_CONFIRM_MS + 10));
      expect(byKey("__logoutYes")).toBeNull();
      expect(byKey("__logout")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("焦點與事件邊界", () => {
  test("mousedown 被 preventDefault（不搶 #t 焦點）", () => {
    renderBar(makeCore());
    const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    byKey("__keys").dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  // 「更多」sheet 在 portal 裡、不在這道攔截內：它開著算 modal，App 的滑鼠入口靠
  // modalShown 早退（見上面「更多（bottom sheet）」的 modal 測試）。
  test("工具列與按鍵面板的 mousedown／mouseup／click 不外洩到 window", () => {
    renderBar(makeCore({ context: { push: false, search: ["title"] } }));
    fireEvent.click(byKey("__keys"));
    const seen = [];
    const spy = (e) => seen.push(e.type);
    for (const t of ["mousedown", "mouseup", "click"]) window.addEventListener(t, spy);
    try {
      for (const k of ["__search", "PageDown"])
        for (const t of ["mousedown", "mouseup", "click"])
          byKey(k).dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }));
    } finally {
      for (const t of ["mousedown", "mouseup", "click"]) window.removeEventListener(t, spy);
    }
    expect(seen).toEqual([]);
  });
});
