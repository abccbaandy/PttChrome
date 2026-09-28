// 手機按鍵列（src/components/MobileKeypad）。鎖三件事：
//  1. 送鍵走 view.sendKeyAsUser（鍵盤同一條分派），不是裸送 byte；
//  2. mousedown 被 preventDefault（按鍵不可以把焦點從 #t 搶走 ⇒ 軟鍵盤收起）；
//  3. 滑鼠事件不外洩到 window（App 的滑鼠入口會把它當成點終端機）。
import { render, screen, fireEvent, act } from "@testing-library/react";
import { MobileKeypad } from "../../src/components/MobileKeypad";

function makeCore({ mobile = true } = {}) {
  const listeners = new Set();
  const core = {
    mobile,
    softKeyboard: false,
    view: { sendKeyAsUser: vi.fn() },
    toggleSoftKeyboard: vi.fn(() => {
      core.softKeyboard = !core.softKeyboard;
      return core.softKeyboard;
    }),
    onMobileChange: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit: (m, kb = false) => {
      core.mobile = m;
      core.softKeyboard = kb;
      listeners.forEach((fn) => fn(m, kb));
    },
  };
  return core;
}

const byKey = (k) => document.querySelector(`[data-key="${k}"]`);

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
