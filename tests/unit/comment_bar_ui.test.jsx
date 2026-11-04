// @unit-env browser
// real-input: tests/e2e/offline/comment_bar.offline.spec.js
//   （page.keyboard／page.mouse；本檔手捏事件只測分支邏輯，見 tests/unit/e2e_real_input.test.js）
// 好讀文章底部常駐推文列（src/components/CommentBar）。鎖：
//  1. 只照 commentBar.state 畫：不可見就不畫，位置用 state 的 left／width／bottom；
//  2. Enter 送出（IME 組字中的 Enter 不算）→ openQuickPush({text, type})，接手才清空；
//  3. 輸入框聚焦 ⇒ modal 來源 "commentBar"，離開／列收起 ⇒ 解除；
//  4. 按鍵與滑鼠事件不外洩到 window（App 的鍵盤／滑鼠入口都在 window）；
//  5. html.commentBarShown 跟著可見與否切（累積頁尾端才會多留空白）；
//  6. 長推文看得到全文：打字中輸入框長高（上限 COMMENT_BAR_MAX_LINES 行），手機改上下兩層
//     讓輸入框吃滿寬；沒在打字縮回單行；實際列高回報給 bar 並寫進 --comment-bar-h。
import { render, fireEvent, act } from "@testing-library/react";
import { CommentBar } from "../../src/components/CommentBar";
import {
  isCommentBarTarget,
  COMMENT_BAR_ID,
  COMMENT_BAR_HEIGHT,
  COMMENT_BAR_MAX_LINES,
} from "../../src/js/comment_bar";
import { setupI18n, i18n } from "../../src/js/i18n";
import { loadBig5Tables } from "./helpers/load_big5_tables";

beforeAll(() => {
  setupI18n();
  loadBig5Tables();
});

function fakeBar(state) {
  const listeners = new Set();
  return {
    state: { visible: true, left: 12, width: 640, bottom: 30, mobile: false, focusN: 0, ...state },
    collapse: vi.fn(),
    setHeight: vi.fn(function (h) {
      this.emit({ height: Math.max(COMMENT_BAR_HEIGHT, Math.round(h)) });
    }),
    maxBytes: () => 37,
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
  document.documentElement.style.removeProperty("--comment-bar-h");
});

const LONG = "這是一則很長很長的推文".repeat(6); // 66 個全形字：桌機寬度也要好幾行
const HUGE = LONG.repeat(4);
const h = (el) => el.getBoundingClientRect().height;

describe("CommentBar UI", () => {
  test("計數：空的不顯示；一則放得下 ⇒「剩 N 字」；放不下 ⇒「會分成 N 則」", () => {
    const { root, input } = setup({ counter: true });
    const counter = () => root().querySelector("[data-comment-counter]");
    expect(counter()).toBeNull();
    fireEvent.change(input(), { target: { value: "推推" } });
    expect(counter().textContent).toBe(i18n("commentBar_remaining").replace("{0}", "16"));
    fireEvent.change(input(), { target: { value: "a".repeat(38) } });
    expect(counter().textContent).toBe(i18n("commentBar_segments").replace("{0}", "2"));
    expect(counter().classList.contains("commentBarCounter--split")).toBe(true);
  });

  test("計數關掉（state.counter false）⇒ 不顯示", () => {
    const { root, input } = setup({ counter: false });
    fireEvent.change(input(), { target: { value: "推推" } });
    expect(root().querySelector("[data-comment-counter]")).toBeNull();
  });

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

  test("預填（回覆這則）⇒ 換類型、填字、聚焦且游標在最後；之後改字不會被同一個請求蓋回去", async () => {
    const { root, input, bar } = setup();
    act(() => bar.emit({ prefill: { type: "arrow", text: "abc ", n: 1 } }));
    expect(input().value).toBe("abc ");
    expect(root().querySelector('[data-comment-type="arrow"]').getAttribute("aria-checked")).toBe("true");
    await act(() => new Promise((r) => requestAnimationFrame(() => r())));
    expect(document.activeElement).toBe(input());
    expect(input().selectionStart).toBe(4);
    fireEvent.change(input(), { target: { value: "abc 同意" } });
    act(() => bar.emit({ left: 20 }));
    expect(input().value).toBe("abc 同意");
    act(() => bar.emit({ prefill: { type: "arrow", text: "xyz ", n: 2 } }));
    expect(input().value).toBe("xyz ");
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

  test("展開請求（focusN 遞增）⇒ 聚焦輸入框", async () => {
    const { input, bar } = setup({ folded: true, expanded: true, mobile: true });
    expect(document.activeElement).not.toBe(input());
    act(() => bar.emit({ focusN: 1 }));
    await act(() => new Promise((r) => requestAnimationFrame(() => r())));
    expect(document.activeElement).toBe(input());
  });

  test("收合模式展開中：離開輸入框 ⇒ 收回；常駐模式 blur 不收", () => {
    const folded = setup({ folded: true, expanded: true, mobile: true });
    expect(folded.root().classList.contains("commentBar--unfolded")).toBe(true);
    fireEvent.focus(folded.input());
    fireEvent.blur(folded.input());
    expect(folded.bar.collapse).toHaveBeenCalledTimes(1);
    folded.unmount();
    const pinned = setup({ mobile: true });
    expect(pinned.root().classList.contains("commentBar--unfolded")).toBe(false);
    fireEvent.focus(pinned.input());
    fireEvent.blur(pinned.input());
    expect(pinned.bar.collapse).not.toHaveBeenCalled();
  });

  test("收合模式展開中：送出（接手）⇒ 輸入框 blur ⇒ 收回", () => {
    const { input, bar } = setup({ folded: true, expanded: true, mobile: true });
    input().focus();
    fireEvent.change(input(), { target: { value: "推推" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(bar.collapse).toHaveBeenCalled();
  });

  test("收合模式展開中：鍵盤出現過、之後收起（--vv-kb-inset 歸零）⇒ 收回", () => {
    const vv = window.visualViewport;
    const root = document.documentElement;
    const { bar } = setup({ folded: true, expanded: true, mobile: true });
    try {
      // 鍵盤還沒升起（inset 0）不算收起。
      root.style.setProperty("--vv-kb-inset", "0px");
      vv.dispatchEvent(new Event("resize"));
      expect(bar.collapse).not.toHaveBeenCalled();
      root.style.setProperty("--vv-kb-inset", "300px");
      vv.dispatchEvent(new Event("resize"));
      expect(bar.collapse).not.toHaveBeenCalled();
      root.style.setProperty("--vv-kb-inset", "0px");
      vv.dispatchEvent(new Event("resize"));
      expect(bar.collapse).toHaveBeenCalledTimes(1);
    } finally {
      root.style.removeProperty("--vv-kb-inset");
    }
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

// 症狀：推文列只有一行，長推文打到後面前面就捲出框外，看不到自己打了什麼（手機尤其短：
// 推／噓／→＋計數＋送出把輸入框擠到剩十來個字寬）。
describe("CommentBar：長推文看得到全文", () => {
  test("打字中輸入框跟著內容長高、整段看得到；離開輸入框縮回單行", () => {
    const { root, input } = setup({ counter: true });
    act(() => input().focus());
    fireEvent.change(input(), { target: { value: LONG } });
    expect(h(input())).toBeGreaterThan(30);
    expect(input().scrollHeight).toBeLessThanOrEqual(input().clientHeight);
    expect(h(root())).toBeGreaterThan(COMMENT_BAR_HEIGHT);
    // 列釘著下緣往上長：bottom 沒變。
    expect(root().style.bottom).toContain("30px");
    act(() => input().blur());
    expect(h(input())).toBe(30);
    expect(h(root())).toBe(COMMENT_BAR_HEIGHT);
  });

  test(`超過 ${COMMENT_BAR_MAX_LINES} 行 ⇒ 停在 ${COMMENT_BAR_MAX_LINES} 行高，框內捲`, () => {
    const { input } = setup();
    act(() => input().focus());
    fireEvent.change(input(), { target: { value: HUGE } });
    const lh = parseFloat(getComputedStyle(input()).lineHeight);
    expect(h(input())).toBeCloseTo(lh * COMMENT_BAR_MAX_LINES + 8 + 2, 0);
    expect(input().scrollHeight).toBeGreaterThan(input().clientHeight);
    expect(getComputedStyle(input()).overflowY).toBe("auto");
  });

  test("手機打字中：上下兩層，輸入框吃滿寬、在推噓鈕與送出鈕上面；沒在打字＝單行原樣", () => {
    const { root, input } = setup({ mobile: true, width: 412 });
    const send = () => root().querySelector("[data-comment-send]");
    const types = () => root().querySelector(".commentBarTypes");
    // 沒在打字：同一列。
    expect(root().classList.contains("commentBar--stacked")).toBe(false);
    expect(h(root())).toBe(COMMENT_BAR_HEIGHT);
    act(() => input().focus());
    expect(root().classList.contains("commentBar--stacked")).toBe(true);
    const r = root().getBoundingClientRect();
    const ir = input().getBoundingClientRect();
    expect(ir.width).toBeGreaterThan(r.width - 20);
    expect(ir.bottom).toBeLessThanOrEqual(send().getBoundingClientRect().top);
    expect(ir.bottom).toBeLessThanOrEqual(types().getBoundingClientRect().top);
    // 送出鈕在列內、靠右。
    expect(send().getBoundingClientRect().right).toBeLessThanOrEqual(r.right);
    expect(send().getBoundingClientRect().right).toBeGreaterThan(r.right - 20);
    fireEvent.change(input(), { target: { value: LONG } });
    expect(input().scrollHeight).toBeLessThanOrEqual(input().clientHeight);
    act(() => input().blur());
    expect(root().classList.contains("commentBar--stacked")).toBe(false);
    expect(h(root())).toBe(COMMENT_BAR_HEIGHT);
  });

  test("手機收合展開中：焦點還沒到就先排成兩層（不會聚焦那一幀才跳）", () => {
    const { root } = setup({ folded: true, expanded: true, mobile: true });
    expect(root().classList.contains("commentBar--stacked")).toBe(true);
  });

  test("貼上的換行換成空白（推文一則一行，不變成分段斷點）；Enter 照樣送出不換行", () => {
    const { input, pttchrome } = setup();
    fireEvent.change(input(), { target: { value: "第一行\n第二行\r\n第三行" } });
    expect(input().value).toBe("第一行 第二行 第三行");
    const ev = fireEvent.keyDown(input(), { key: "Enter", shiftKey: true });
    expect(ev).toBe(false); // preventDefault：不插入換行
    expect(pttchrome.openQuickPush).toHaveBeenCalledWith({ text: "第一行 第二行 第三行", type: "push" });
  });

  test("列長高 ⇒ 實際高度回報給 bar.setHeight，--comment-bar-h 跟著；收起 ⇒ 回到單行高", async () => {
    const { input, bar } = setup();
    const varH = () => document.documentElement.style.getPropertyValue("--comment-bar-h");
    await vi.waitFor(() => expect(varH()).toBe(COMMENT_BAR_HEIGHT + "px"));
    act(() => input().focus());
    fireEvent.change(input(), { target: { value: LONG } });
    const grown = Math.round(h(document.getElementById(COMMENT_BAR_ID)));
    expect(grown).toBeGreaterThan(COMMENT_BAR_HEIGHT);
    await vi.waitFor(() => expect(bar.state.height).toBe(grown));
    expect(varH()).toBe(grown + "px");
    act(() => bar.emit({ visible: false }));
    expect(bar.setHeight).toHaveBeenLastCalledWith(COMMENT_BAR_HEIGHT);
  });
});
