// @unit-env browser
// real-input: tests/e2e/offline/mobile_app_bar.offline.spec.js
//   （touchscreen.tap；本檔手捏事件只測分支邏輯，見 tests/unit/e2e_real_input.test.js）
// 手機頂部 App Bar（src/components/MobileAppBar）。鎖：
//  1. 只在手機模式渲染；標題跟 App.onScreenContextChange 的 appBar 走；
//  2. 沒有返回鍵（返回交給系統手勢，history_back_guard）；
//  3. mousedown preventDefault（不搶 #t 焦點）、滑鼠事件不外洩到 window；
//  4. 高度 ＝ MOBILE_APPBAR_PX（終端機列數扣的就是它）。
import { render, fireEvent, act } from "@testing-library/react";
import { MobileAppBar } from "../../src/components/MobileAppBar";
import { MOBILE_APPBAR_PX } from "../../src/js/mobile_layout";
import { setupI18n, i18n } from "../../src/js/i18n";
import appBarCss from "../../src/components/MobileAppBar/MobileAppBar.css?raw";

beforeAll(() => {
  setupI18n();
});

function makeCore({ mobile = true, appBar } = {}) {
  const listeners = new Set();
  const ctxListeners = new Set();
  let ctx = { push: false, search: [], appBar: appBar || { kind: "menu", title: "主功能表", subtitle: "", newMail: false } };
  return {
    mobile,
    onMobileChange: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    onScreenContextChange: (fn) => {
      ctxListeners.add(fn);
      fn(ctx);
      return () => ctxListeners.delete(fn);
    },
    emit(m) {
      this.mobile = m;
      listeners.forEach((fn) => fn(m));
    },
    setAppBar(next) {
      ctx = { ...ctx, appBar: next };
      ctxListeners.forEach((fn) => fn(ctx));
    },
  };
}

const bar = () => document.getElementById("mobileAppBar");

test("非手機不渲染；mobile 變化時跟著出現／消失", () => {
  const core = makeCore({ mobile: false });
  render(<MobileAppBar pttchrome={core} />);
  expect(bar()).toBeNull();
  act(() => core.emit(true));
  expect(bar()).not.toBeNull();
  act(() => core.emit(false));
  expect(bar()).toBeNull();
});

test("標題／副標／新信件跟著畫面走；空標題顯示預設名", () => {
  const core = makeCore();
  render(<MobileAppBar pttchrome={core} />);
  expect(bar().querySelector('[data-key="__title"]').textContent).toBe("主功能表");
  expect(bar().querySelector('[data-key="__subtitle"]')).toBeNull();
  act(() => core.setAppBar({ kind: "article", title: "[問卦] 測試", subtitle: "Gossiping", newMail: false }));
  expect(bar().dataset.kind).toBe("article");
  expect(bar().querySelector('[data-key="__title"]').textContent).toBe("[問卦] 測試");
  expect(bar().querySelector('[data-key="__subtitle"]').textContent).toBe("Gossiping");
  act(() => core.setAppBar({ kind: "menu", title: "", subtitle: "", newMail: true }));
  expect(bar().querySelector('[data-key="__title"]').textContent).toBe(i18n("mobileAppBar_defaultTitle"));
  expect(bar().querySelector('[data-key="__newMail"]')).not.toBeNull();
});

test("沒有任何按鈕（不放返回鍵：返回交給系統手勢）", () => {
  render(<MobileAppBar pttchrome={makeCore()} />);
  expect(bar().querySelectorAll("button")).toHaveLength(0);
});

test("mousedown 被 preventDefault；mousedown／mouseup／click 不外洩到 window", () => {
  render(<MobileAppBar pttchrome={makeCore()} />);
  const leaked = vi.fn();
  window.addEventListener("mousedown", leaked);
  window.addEventListener("mouseup", leaked);
  window.addEventListener("click", leaked);
  try {
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    bar().dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    fireEvent.mouseUp(bar());
    fireEvent.click(bar());
    expect(leaked).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("mousedown", leaked);
    window.removeEventListener("mouseup", leaked);
    window.removeEventListener("click", leaked);
  }
});

test("CSS 高度 ＝ MOBILE_APPBAR_PX（終端機列數扣的就是它）", () => {
  const style = document.createElement("style");
  style.textContent = appBarCss;
  document.head.appendChild(style);
  try {
    render(<MobileAppBar pttchrome={makeCore()} />);
    expect(bar().getBoundingClientRect().height).toBe(MOBILE_APPBAR_PX);
    expect(getComputedStyle(bar()).position).toBe("fixed");
  } finally {
    style.remove();
  }
});
