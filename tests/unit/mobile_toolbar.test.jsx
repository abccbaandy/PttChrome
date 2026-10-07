// @unit-env browser
// real-input: tests/e2e/offline/mobile_toolbar.offline.spec.js
//   （touchscreen.tap；本檔手捏事件只測分支邏輯，見 tests/unit/e2e_real_input.test.js）
// 手機底部工具列（src/components/MobileToolbar）。鎖：
//  1. 按鈕依畫面顯示（推＝文章裡；搜尋＝列表）——資料來自 App.onScreenContextChange；
//  2. 送鍵走 view.sendKeyAsUser（鍵盤同一條分派），不是裸送 byte；
//  3. mousedown 被 preventDefault（不搶 #t 焦點）、滑鼠事件不外洩到 window；
//  4. 工具列高度 ＝ MOBILE_TOOLBAR_PX（終端機可用高度扣的就是它）。
import { render, fireEvent, act } from "@testing-library/react";
import { MobileToolbar, LOGOUT_CONFIRM_MS } from "../../src/components/MobileToolbar";
import { MOBILE_TOOLBAR_PX } from "../../src/js/mobile_layout";
import { setupI18n } from "../../src/js/i18n";
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
const renderBar = (core, props = {}) =>
  render(<MobileToolbar pttchrome={core} {...props} />);

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

describe("更多", () => {
  test("選取模式：呼叫 setMobileSelectMode", () => {
    const core = makeCore();
    renderBar(core);
    fireEvent.click(byKey("__more"));
    expect(byKey("__select").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(byKey("__select"));
    expect(core.setMobileSelectMode).toHaveBeenCalledWith(true);
  });

  test("設定：交給 onOpenSettings", () => {
    const onOpenSettings = vi.fn();
    renderBar(makeCore(), { onOpenSettings });
    fireEvent.click(byKey("__more"));
    fireEvent.click(byKey("__settings"));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  test("登出要二次確認；確認才呼叫 startLogout", () => {
    const core = makeCore();
    renderBar(core);
    fireEvent.click(byKey("__more"));
    fireEvent.click(byKey("__logout"));
    expect(core.startLogout).not.toHaveBeenCalled();
    fireEvent.click(byKey("__logoutYes"));
    expect(core.startLogout).toHaveBeenCalledTimes(1);
  });

  test("登出確認沒動作會自己收回（防口袋誤觸）", () => {
    vi.useFakeTimers();
    try {
      const core = makeCore();
      renderBar(core);
      fireEvent.click(byKey("__more"));
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

  test("工具列與彈出選單的 mousedown／mouseup／click 不外洩到 window", () => {
    renderBar(makeCore({ context: { push: false, search: ["title"] } }));
    fireEvent.click(byKey("__more"));
    const seen = [];
    const spy = (e) => seen.push(e.type);
    for (const t of ["mousedown", "mouseup", "click"]) window.addEventListener(t, spy);
    try {
      for (const k of ["__search", "__settings"])
        for (const t of ["mousedown", "mouseup", "click"])
          byKey(k)?.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }));
    } finally {
      for (const t of ["mousedown", "mouseup", "click"]) window.removeEventListener(t, spy);
    }
    expect(seen).toEqual([]);
  });
});
