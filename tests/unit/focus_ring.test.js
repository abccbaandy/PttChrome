// @unit-env browser
// real-input: tests/e2e/offline/mobile_sheet.offline.spec.js
//   （真觸控 tap 打開 sheet／設定、真 Tab；本檔手捏事件只測分支）
// 焦點框只在鍵盤操作時畫（src/js/focus_ring.js）。鎖：
//  1. 最後一次輸入是指標 ⇒ <html data-input-modality="pointer">，鍵盤 ⇒ "keyboard"；
//  2. pointer 時 :focus-visible 的元素沒有 outline（main.css），keyboard 時照畫；
//  3. 卸載後屬性拿掉。
import { installFocusRing, MODALITY_ATTR } from "../../src/js/focus_ring";
import "../../src/css/main.css";

let uninstall = null;
afterEach(() => {
  if (uninstall) uninstall();
  uninstall = null;
  document.body.innerHTML = "";
});

const modality = () => document.documentElement.getAttribute(MODALITY_ATTR);
const pointerDown = (el) =>
  el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
const keyDown = (el) =>
  el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Tab" }));

test("指標／鍵盤輪流：屬性跟著最後一次輸入", () => {
  uninstall = installFocusRing(document);
  document.body.innerHTML = '<button id="b">x</button>';
  const b = document.getElementById("b");
  pointerDown(b);
  expect(modality()).toBe("pointer");
  keyDown(b);
  expect(modality()).toBe("keyboard");
  pointerDown(b);
  expect(modality()).toBe("pointer");
  uninstall();
  uninstall = null;
  expect(modality()).toBe(null);
});

test("文字輸入框 → 程式搬焦點到按鈕（繼承 :focus-visible）：pointer 時沒有 outline", () => {
  uninstall = installFocusRing(document);
  document.body.innerHTML =
    '<input id="t" type="text"><button id="b" class="mantine-focus-auto">x</button>';
  const t = document.getElementById("t");
  const b = document.getElementById("b");
  t.focus();
  b.focus();
  expect(b.matches(":focus-visible")).toBe(true);

  keyDown(b);
  expect(getComputedStyle(b).outlineStyle).not.toBe("none");
  pointerDown(b);
  expect(getComputedStyle(b).outlineStyle).toBe("none");
});
