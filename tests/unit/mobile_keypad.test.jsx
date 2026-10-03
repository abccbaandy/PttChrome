// @unit-env browser
// real-input: tests/e2e/offline/mobile_keypad.offline.spec.js
//   （真滑鼠拖曳／touchscreen.tap；本檔手捏事件只測分支邏輯，見 tests/unit/e2e_real_input.test.js）
// 手機按鍵列（src/components/MobileKeypad）。鎖三件事：
//  1. 送鍵走 view.sendKeyAsUser（鍵盤同一條分派），不是裸送 byte；
//  2. mousedown 被 preventDefault（按鍵不可以把焦點從 #t 搶走 ⇒ 軟鍵盤收起）；
//  3. 滑鼠事件不外洩到 window（App 的滑鼠入口會把它當成點終端機）。
import { render, screen, fireEvent, act } from "@testing-library/react";
import { MobileKeypad, LOGOUT_CONFIRM_MS } from "../../src/components/MobileKeypad";
import { KEYPAD_POS_STORAGE_KEY } from "../../src/js/mobile_layout";

function makeCore({ mobile = true } = {}) {
  const listeners = new Set();
  const core = {
    mobile,
    softKeyboard: false,
    mobileSelectMode: false,
    view: { sendKeyAsUser: vi.fn() },
    startLogout: vi.fn(() => true),
    setMobileSelectMode: vi.fn((on) => {
      core.mobileSelectMode = !!on;
      return core.mobileSelectMode;
    }),
    toggleSoftKeyboard: vi.fn(() => {
      core.softKeyboard = !core.softKeyboard;
      return core.softKeyboard;
    }),
    onMobileChange: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit: (m, kb = false, sel = false) => {
      core.mobile = m;
      core.softKeyboard = kb;
      core.mobileSelectMode = sel;
      listeners.forEach((fn) => fn(m, kb, sel));
    },
  };
  return core;
}

const byKey = (k) => document.querySelector(`[data-key="${k}"]`);

beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch (e) {
    // jsdom 一定有；保險
  }
});

describe("MobileKeypad", () => {
  test("非手機不渲染；mobile 變化時跟著出現／消失", () => {
    const core = makeCore({ mobile: false });
    render(<MobileKeypad pttchrome={core} />);
    expect(document.getElementById("mobileKeypad")).toBeNull();
    act(() => core.emit(true));
    expect(document.getElementById("mobileKeypad")).not.toBeNull();
    act(() => core.emit(false));
    expect(document.getElementById("mobileKeypad")).toBeNull();
  });

  test("modal 開著時隱藏", () => {
    render(<MobileKeypad pttchrome={makeCore()} hidden />);
    expect(document.getElementById("mobileKeypad")).toBeNull();
  });

  test("預設收合成一顆按鈕，點開後才有按鍵", () => {
    render(<MobileKeypad pttchrome={makeCore()} />);
    expect(byKey("PageDown")).toBeNull();
    fireEvent.click(byKey("__open"));
    expect(byKey("PageDown")).not.toBeNull();
    fireEvent.click(byKey("__close"));
    expect(byKey("PageDown")).toBeNull();
  });

  test("按鍵走 view.sendKeyAsUser", () => {
    const core = makeCore();
    render(<MobileKeypad pttchrome={core} />);
    fireEvent.click(byKey("__open"));
    fireEvent.click(byKey("PageDown"));
    fireEvent.click(byKey("ArrowLeft"));
    fireEvent.click(byKey("End"));
    expect(core.view.sendKeyAsUser.mock.calls.map((c) => c[0])).toEqual([
      "PageDown",
      "ArrowLeft",
      "End",
    ]);
  });

  test("鍵盤鈕呼叫 toggleSoftKeyboard 並反映狀態", () => {
    const core = makeCore();
    render(<MobileKeypad pttchrome={core} />);
    fireEvent.click(byKey("__open"));
    fireEvent.click(byKey("__keyboard"));
    expect(core.toggleSoftKeyboard).toHaveBeenCalledTimes(1);
    expect(byKey("__keyboard").getAttribute("aria-pressed")).toBe("true");
    expect(core.view.sendKeyAsUser).not.toHaveBeenCalled();
  });

  test("App 自己把鍵盤狀態歸零（返回鍵收起）⇒ 鍵盤鈕亮燈跟著熄", () => {
    const core = makeCore();
    render(<MobileKeypad pttchrome={core} />);
    fireEvent.click(byKey("__open"));
    fireEvent.click(byKey("__keyboard"));
    expect(byKey("__keyboard").getAttribute("aria-pressed")).toBe("true");
    act(() => core.emit(true, false));
    expect(byKey("__keyboard").getAttribute("aria-pressed")).toBe("false");
  });

  test("mousedown 被 preventDefault（不搶 #t 焦點）", () => {
    render(<MobileKeypad pttchrome={makeCore()} />);
    fireEvent.click(byKey("__open"));
    const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    byKey("PageDown").dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  test("mousedown／mouseup／click 不外洩到 window", () => {
    render(<MobileKeypad pttchrome={makeCore()} />);
    fireEvent.click(byKey("__open"));
    const seen = [];
    const spy = (e) => seen.push(e.type);
    for (const t of ["mousedown", "mouseup", "click"]) window.addEventListener(t, spy);
    try {
      for (const t of ["mousedown", "mouseup", "click"])
        byKey("ArrowDown").dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }));
    } finally {
      for (const t of ["mousedown", "mouseup", "click"]) window.removeEventListener(t, spy);
    }
    expect(seen).toEqual([]);
  });
});

describe("第三列：推文／選取模式／登出", () => {
  test("推文鍵送 X（走 sendKeyAsUser，跟實體鍵盤按 X 同一條分派）", () => {
    const core = makeCore();
    render(<MobileKeypad pttchrome={core} />);
    fireEvent.click(byKey("__open"));
    fireEvent.click(byKey("X"));
    expect(core.view.sendKeyAsUser).toHaveBeenCalledWith("X");
  });

  test("選取模式開關：呼叫 setMobileSelectMode，亮燈跟著 App 狀態", () => {
    const core = makeCore();
    render(<MobileKeypad pttchrome={core} />);
    fireEvent.click(byKey("__open"));
    expect(byKey("__select").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(byKey("__select"));
    expect(core.setMobileSelectMode).toHaveBeenCalledWith(true);
    expect(byKey("__select").getAttribute("aria-pressed")).toBe("true");
    act(() => core.emit(true, false, false));
    expect(byKey("__select").getAttribute("aria-pressed")).toBe("false");
    expect(core.view.sendKeyAsUser).not.toHaveBeenCalled();
  });

  test("登出要兩段：第一下只出確認，✓ 才呼叫 startLogout", () => {
    const core = makeCore();
    render(<MobileKeypad pttchrome={core} />);
    fireEvent.click(byKey("__open"));
    fireEvent.click(byKey("__logout"));
    expect(core.startLogout).not.toHaveBeenCalled();
    expect(byKey("__logoutAsk")).not.toBeNull();
    fireEvent.click(byKey("__logoutYes"));
    expect(core.startLogout).toHaveBeenCalledTimes(1);
    expect(byKey("__logout")).not.toBeNull();
  });

  test("登出確認按 ✕ ⇒ 取消，不登出", () => {
    const core = makeCore();
    render(<MobileKeypad pttchrome={core} />);
    fireEvent.click(byKey("__open"));
    fireEvent.click(byKey("__logout"));
    fireEvent.click(byKey("__logoutNo"));
    expect(core.startLogout).not.toHaveBeenCalled();
    expect(byKey("__logout")).not.toBeNull();
  });

  test("登出確認放著不動 ⇒ 自動收回（防口袋誤觸）", () => {
    vi.useFakeTimers();
    try {
      const core = makeCore();
      render(<MobileKeypad pttchrome={core} />);
      fireEvent.click(byKey("__open"));
      fireEvent.click(byKey("__logout"));
      act(() => vi.advanceTimersByTime(LOGOUT_CONFIRM_MS + 10));
      expect(byKey("__logoutYes")).toBeNull();
      expect(core.startLogout).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("浮動拖曳", () => {
  const drag = (node, dx, dy) => {
    fireEvent.pointerDown(node, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(node, { pointerId: 1, clientX: 100 + dx, clientY: 100 + dy });
    fireEvent.pointerUp(node, { pointerId: 1, clientX: 100 + dx, clientY: 100 + dy });
  };
  const root = () => document.getElementById("mobileKeypad");

  test("拖把手 ⇒ 位置改變並存進 localStorage（不是 prefs）", () => {
    render(<MobileKeypad pttchrome={makeCore()} />);
    fireEvent.click(byKey("__open"));
    drag(byKey("__drag"), -50, -60);
    expect(root().style.right).toBe("58px");
    expect(root().style.bottom).toContain("68px");
    expect(JSON.parse(window.localStorage.getItem(KEYPAD_POS_STORAGE_KEY))).toEqual({
      right: 58,
      bottom: 68,
    });
  });

  test("重新掛載沿用存下的位置", () => {
    window.localStorage.setItem(KEYPAD_POS_STORAGE_KEY, JSON.stringify({ right: 40, bottom: 90 }));
    render(<MobileKeypad pttchrome={makeCore()} />);
    expect(root().style.right).toBe("40px");
  });

  test("收合圓鈕：小位移仍是點擊（展開），拖過就不展開", () => {
    render(<MobileKeypad pttchrome={makeCore()} />);
    drag(byKey("__open"), 3, 2);
    fireEvent.click(byKey("__open"));
    expect(byKey("PageDown")).not.toBeNull();
    fireEvent.click(byKey("__close"));
    drag(byKey("__open"), -40, -40);
    fireEvent.click(byKey("__open"));
    expect(byKey("PageDown")).toBeNull();
  });
});
