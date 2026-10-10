// @unit-env browser
// real-input: tests/e2e/offline/aid_back_ui.offline.spec.js
//   （page.click／touchscreen.tap；本檔手捏事件只測分支邏輯，見 tests/unit/e2e_real_input.test.js）
// AID「返回原文」按鈕（src/components/AidBackButton ＋ term_view 的 aidBack 狀態）。鎖：
//  1. term_view.showBackButton／hideBackButton 只改狀態並通知訂閱者（aid_navigation 的投影入口不變）；
//  2. 元件跟著狀態出現／消失，文字帶標籤，點擊呼叫 onClick；
//  3. mousedown preventDefault（不搶 #t 焦點）、滑鼠事件不外洩到 window（App 的滑鼠入口）；
//  4. 位置：上緣置中；手機讓開 App Bar。舊版在左下角＝手機被底部工具列蓋掉、桌機疊在 PTT 狀態列上。
import { render, fireEvent, act } from "@testing-library/react";
import { AidBackButton } from "../../src/components/AidBackButton";
import { TermView } from "../../src/js/term_view";
import { MOBILE_APPBAR_PX } from "../../src/js/mobile_layout";
import { setupI18n, i18n } from "../../src/js/i18n";
import css from "../../src/components/AidBackButton/AidBackButton.css?raw";

beforeAll(() => {
  setupI18n();
});

function makeView() {
  return Object.create(TermView.prototype);
}

const btn = () => document.getElementById("aidBackButton");

test("term_view：show／hide 只改 aidBack 並通知；hide 在沒顯示時不重複通知", () => {
  const view = makeView();
  const seen = [];
  const off = view.onAidBackChange((b) => seen.push(b && b.label));
  const cb = () => {};
  view.showBackButton("C_Chat 第 353218 篇", cb);
  expect(view.aidBack).toEqual({ label: "C_Chat 第 353218 篇", onClick: cb });
  view.hideBackButton();
  view.hideBackButton();
  expect(view.aidBack).toBeNull();
  expect(seen).toEqual(["C_Chat 第 353218 篇", null]);
  off();
  view.showBackButton("", cb);
  expect(seen).toHaveLength(2);
});

test("元件跟著狀態出現／消失；有標籤顯示標籤、沒有就顯示預設文字", () => {
  const view = makeView();
  render(<AidBackButton pttchrome={{ view }} />);
  expect(btn()).toBeNull();
  act(() => view.showBackButton("C_Chat 第 353218 篇", () => {}));
  expect(btn().textContent).toContain("353218");
  act(() => view.showBackButton("", () => {}));
  expect(btn().textContent).toBe(i18n("aidBack_default"));
  act(() => view.hideBackButton());
  expect(btn()).toBeNull();
});

test("訂閱前就已經在顯示（元件晚掛上）也畫得出來", () => {
  const view = makeView();
  view.showBackButton("X", () => {});
  render(<AidBackButton pttchrome={{ view }} />);
  expect(btn()).not.toBeNull();
});

test("點擊呼叫 onClick；mousedown preventDefault；滑鼠事件不外洩到 window", () => {
  const view = makeView();
  const onClick = vi.fn();
  view.showBackButton("X", onClick);
  render(<AidBackButton pttchrome={{ view }} />);
  const leaked = vi.fn();
  window.addEventListener("mousedown", leaked);
  window.addEventListener("mouseup", leaked);
  window.addEventListener("click", leaked);
  try {
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    btn().dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    fireEvent.mouseUp(btn());
    fireEvent.click(btn());
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(leaked).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("mousedown", leaked);
    window.removeEventListener("mouseup", leaked);
    window.removeEventListener("click", leaked);
  }
  // App.checkClass 的白名單（滑鼠瀏覽不把它當終端機區域）
  expect(btn().className).toContain("nomouse_command");
});

test("位置：桌機貼上緣置中；手機在 App Bar 下方（不在底部工具列那一帶）", () => {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
  const view = makeView();
  view.showBackButton("C_Chat 第 353218 篇", () => {});
  try {
    render(<AidBackButton pttchrome={{ view }} />);
    const r = btn().getBoundingClientRect();
    expect(getComputedStyle(btn()).position).toBe("fixed");
    expect(getComputedStyle(btn()).pointerEvents).toBe("auto");
    expect(r.top).toBeLessThan(40);
    expect(Math.abs((r.left + r.right) / 2 - window.innerWidth / 2)).toBeLessThan(1);

    document.body.classList.add("mobile-layout");
    const m = btn().getBoundingClientRect();
    expect(m.top).toBeGreaterThanOrEqual(MOBILE_APPBAR_PX);
    expect(m.bottom).toBeLessThan(window.innerHeight / 2);
  } finally {
    document.body.classList.remove("mobile-layout");
    style.remove();
  }
});
