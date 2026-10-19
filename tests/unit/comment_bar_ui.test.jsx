// @unit-env browser
// real-input: tests/e2e/offline/comment_bar.offline.spec.js
//   （page.keyboard／page.mouse；本檔手捏事件只測分支邏輯，見 tests/unit/e2e_real_input.test.js）
// 好讀文章底部常駐推文列（src/components/CommentBar）。鎖：
//  1. 只照 commentBar.state 畫：不可見就不畫，位置用 state 的 left／width／bottom；
//  2. Enter 送出（IME 組字中的 Enter 不算）→ openQuickPush({text, type})，接手才清空；
//  3. 輸入框聚焦 ⇒ modal 來源 "commentBar"，離開／列收起 ⇒ 解除；
//  4. 按鍵與滑鼠事件不外洩到 window（App 的鍵盤／滑鼠入口都在 window）；
//  5. html.commentBarShown 跟著可見與否切（累積頁尾端才會多留空白）。
import { render, fireEvent, act } from "@testing-library/react";
import { CommentBar } from "../../src/components/CommentBar";
import { isCommentBarTarget, COMMENT_BAR_ID } from "../../src/js/comment_bar";
import { setupI18n } from "../../src/js/i18n";

beforeAll(() => {
  setupI18n();
});

function fakeBar(state) {
  const listeners = new Set();
  return {
    state: { visible: true, left: 12, width: 640, bottom: 30, mobile: false, ...state },
    onChange(fn) {
      listeners.add(fn);
      fn(this.state);
      return () => listeners.delete(fn);
    },
    emit(patch) {
      this.state = { ...this.state, ...patch };
      listeners.forEach((fn) => fn(this.state));
    },
  };
}

function setup(state, quickResult = true) {
  const bar = fakeBar(state);
  const pttchrome = {
    commentBar: bar,
    setModalOpen: vi.fn(),
    openQuickPush: vi.fn(() => quickResult),
  };
  const utils = render(<CommentBar pttchrome={pttchrome} />);
  const root = () => document.getElementById(COMMENT_BAR_ID);
  const input = () => root().querySelector('[name="commentBarText"]');
  return { ...utils, bar, pttchrome, root, input };
}

afterEach(() => {
  document.documentElement.classList.remove("commentBarShown");
});

describe("CommentBar UI", () => {
  test("不可見 ⇒ 不畫，也不留空白", () => {
    const { root } = setup({ visible: false });
    expect(root()).toBeNull();
    expect(document.documentElement.classList.contains("commentBarShown")).toBe(false);
  });

  test("可見 ⇒ 照 state 定位，html 掛上 commentBarShown；收起就拿掉", () => {
    const { root, bar } = setup();
    const el = root();
    expect(el.style.left).toBe("12px");
    expect(el.style.width).toBe("640px");
    expect(el.style.bottom).toContain("30px");
    expect(document.documentElement.classList.contains("commentBarShown")).toBe(true);
    act(() => bar.emit({ visible: false }));
    expect(root()).toBeNull();
    expect(document.documentElement.classList.contains("commentBarShown")).toBe(false);
  });

  test("選類型＋Enter ⇒ openQuickPush({text, type})；接手後清空、類型回到推", () => {
    const { root, input, pttchrome } = setup();
    fireEvent.click(root().querySelector('[data-comment-type="boo"]'));
    fireEvent.change(input(), { target: { value: "不推" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(pttchrome.openQuickPush).toHaveBeenCalledWith({ text: "不推", type: "boo" });
    expect(input().value).toBe("");
    expect(root().querySelector('[data-comment-type="push"]').getAttribute("aria-checked")).toBe("true");
  });

  test("沒接手（回 false）⇒ 字留著", () => {
    const { input, pttchrome } = setup({}, false);
    fireEvent.change(input(), { target: { value: "推推" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(pttchrome.openQuickPush).toHaveBeenCalled();
    expect(input().value).toBe("推推");
  });

  test("IME 組字中的 Enter 是選字，不送出；空白不送出、送出鈕停用", () => {
    const { root, input, pttchrome } = setup();
    expect(root().querySelector("[data-comment-send]").disabled).toBe(true);
    fireEvent.change(input(), { target: { value: "   " } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(pttchrome.openQuickPush).not.toHaveBeenCalled();
    fireEvent.change(input(), { target: { value: "推" } });
    fireEvent.keyDown(input(), { key: "Enter", isComposing: true });
    expect(pttchrome.openQuickPush).not.toHaveBeenCalled();
    fireEvent.click(root().querySelector("[data-comment-send]"));
    expect(pttchrome.openQuickPush).toHaveBeenCalledWith({ text: "推", type: "push" });
  });

  test("聚焦 ⇒ modal 來源 commentBar 開；blur ⇒ 關；列收起 ⇒ 也關", () => {
    const { input, bar, pttchrome } = setup();
    fireEvent.focus(input());
    expect(pttchrome.setModalOpen).toHaveBeenLastCalledWith("commentBar", true);
    fireEvent.blur(input());
    expect(pttchrome.setModalOpen).toHaveBeenLastCalledWith("commentBar", false);
    fireEvent.focus(input());
    act(() => bar.emit({ visible: false }));
    expect(pttchrome.setModalOpen).toHaveBeenLastCalledWith("commentBar", false);
  });

  test("按鍵與滑鼠事件不外洩到 window；列被 App 的滑鼠入口認得", () => {
    const { root, input } = setup();
    const seen = [];
    const spy = (e) => seen.push(e.type);
    for (const t of ["keydown", "mousedown", "mouseup", "click"]) window.addEventListener(t, spy);
    try {
      fireEvent.keyDown(input(), { key: "a" });
      fireEvent.mouseDown(input());
      fireEvent.mouseUp(input());
      fireEvent.click(root().querySelector('[data-comment-type="arrow"]'));
    } finally {
      for (const t of ["keydown", "mousedown", "mouseup", "click"]) window.removeEventListener(t, spy);
    }
    expect(seen).toEqual([]);
    expect(isCommentBarTarget(input())).toBe(true);
    expect(isCommentBarTarget(document.body)).toBe(false);
  });
});
