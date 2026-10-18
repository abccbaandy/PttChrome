// @unit-env browser
// real-input: tests/e2e/offline/split_reader.offline.spec.js
//   （page.mouse；本檔手捏事件只測分支邏輯，見 tests/unit/e2e_real_input.test.js）
// 寬螢幕雙欄閱讀的左欄（src/components/SplitReader）。鎖：
//  1. 只照 splitReader.state 畫：不可見就不畫；條目、目前這篇、開啟中、未讀、已刪除、推文數；
//  2. 點條目 → openNum，「收起」→ setCollapsed(true)，把手 → setCollapsed(false)；
//  3. mousedown preventDefault（不搶 #t 焦點）、滑鼠事件不外洩到 window；
//  4. #splitReader 被 App 的滑鼠入口認得（isSplitReaderTarget），滾輪才不會變成翻頁；
//  5. 正在讀的那篇捲進左欄的視野。
import { render, fireEvent, act } from "@testing-library/react";
import { SplitReader } from "../../src/components/SplitReader";
import { isSplitReaderTarget, SPLIT_READER_ID } from "../../src/js/split_reader";
import { setupI18n, i18n } from "../../src/js/i18n";

beforeAll(() => {
  setupI18n();
});

const entry = (num, extra) => ({
  num,
  title: "[閒聊] 第 " + num + " 篇",
  author: "user" + num,
  date: "9/01",
  recommend: "",
  deleted: false,
  unread: false,
  ...extra,
});

function fakeSplit(state) {
  const listeners = new Set();
  const split = {
    state: {
      visible: true,
      board: "Test",
      entries: [entry(1), entry(2)],
      currentNum: null,
      pendingNum: null,
      width: 200,
      collapsed: false,
      ...state,
    },
    onChange(fn) {
      listeners.add(fn);
      fn(split.state);
      return () => listeners.delete(fn);
    },
    push(patch) {
      split.state = { ...split.state, ...patch };
      listeners.forEach((fn) => fn(split.state));
    },
    openNum: vi.fn(),
    setCollapsed: vi.fn(),
  };
  return split;
}

const root = () => document.getElementById(SPLIT_READER_ID);
const q = (sel) => document.querySelector(sel);

test("不可見就不畫；可見時照 state 畫（寬度、看板、條目）", () => {
  const split = fakeSplit({ visible: false });
  render(<SplitReader pttchrome={{ splitReader: split }} />);
  expect(root()).toBeNull();
  act(() => split.push({ visible: true }));
  expect(root().style.width).toBe("200px");
  expect(q("[data-split-board]").textContent).toBe("Test");
  expect([...document.querySelectorAll("[data-split-num]")].map((b) => b.getAttribute("data-split-num"))).toEqual([
    "1",
    "2",
  ]);
  act(() => split.push({ visible: false }));
  expect(root()).toBeNull();
});

test("目前這篇、開啟中、未讀、已刪除（點不下去）、推文數", () => {
  const split = fakeSplit({
    entries: [entry(1, { unread: true, recommend: "爆" }), entry(2, { deleted: true }), entry(3, { recommend: "12" })],
    currentNum: 3,
    pendingNum: 1,
  });
  render(<SplitReader pttchrome={{ splitReader: split }} />);
  const b = (n) => q('[data-split-num="' + n + '"]');
  expect(b(3).hasAttribute("data-current")).toBe(true);
  expect(b(1).hasAttribute("data-pending")).toBe(true);
  expect(b(1).textContent).toContain(i18n("split_opening"));
  expect(b(1).hasAttribute("data-unread")).toBe(true);
  expect(b(1).querySelector('[data-tone="hot"]').textContent).toBe("爆");
  expect(b(3).querySelector('[data-tone="many"]').textContent).toBe("12");
  expect(b(2).disabled).toBe(true);
  fireEvent.click(b(1));
  expect(split.openNum).toHaveBeenCalledWith(1);
});

test("收起 → setCollapsed(true)；收起時只畫把手，把手 → setCollapsed(false)", () => {
  const split = fakeSplit({});
  render(<SplitReader pttchrome={{ splitReader: split }} />);
  fireEvent.click(q("[data-split-collapse]"));
  expect(split.setCollapsed).toHaveBeenCalledWith(true);
  act(() => split.push({ collapsed: true }));
  expect(q("[data-split-list]")).toBeNull();
  fireEvent.click(q("[data-split-expand]"));
  expect(split.setCollapsed).toHaveBeenLastCalledWith(false);
});

test("mousedown 不搶焦點、滑鼠事件不外洩到 window", () => {
  const split = fakeSplit({});
  render(<SplitReader pttchrome={{ splitReader: split }} />);
  const seen = [];
  const spy = (e) => seen.push(e.type);
  for (const t of ["mousedown", "mouseup", "click"]) window.addEventListener(t, spy);
  try {
    const item = q("[data-split-num]");
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    item.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    fireEvent.mouseUp(item);
    fireEvent.click(item);
    const bg = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    root().dispatchEvent(bg);
    expect(bg.defaultPrevented).toBe(true);
    expect(seen).toEqual([]);
  } finally {
    for (const t of ["mousedown", "mouseup", "click"]) window.removeEventListener(t, spy);
  }
});

test("isSplitReaderTarget：左欄裡的節點才算", () => {
  render(<SplitReader pttchrome={{ splitReader: fakeSplit({}) }} />);
  expect(isSplitReaderTarget(q("[data-split-num]"))).toBe(true);
  expect(isSplitReaderTarget(document.body)).toBe(false);
  expect(isSplitReaderTarget(null)).toBe(false);
});

test("正在讀的那篇捲進左欄的視野（不在視野內才捲）", () => {
  const entries = Array.from({ length: 80 }, (_, i) => entry(i + 1));
  const split = fakeSplit({ entries, currentNum: 1 });
  render(<SplitReader pttchrome={{ splitReader: split }} />);
  const list = q("[data-split-list]");
  expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
  expect(list.scrollTop).toBe(0);
  act(() => split.push({ currentNum: 70 }));
  const el = q('[data-split-num="70"]');
  const lr = list.getBoundingClientRect();
  const er = el.getBoundingClientRect();
  expect(er.top).toBeGreaterThanOrEqual(lr.top);
  expect(er.bottom).toBeLessThanOrEqual(lr.bottom);
});
