// @unit-env browser
// real-input: tests/e2e/offline/article_tools.offline.spec.js
//   （page.mouse；本檔手捏事件只測分支邏輯，見 tests/unit/e2e_real_input.test.js）
// 文章工具側欄（src/components/ArticleTools）。鎖：
//  1. 只照 articleTools.state 畫：不可見就不畫；AID、統計、推文者（原PO、選中）、圖片數；
//  2. 點推文者 → selectUser，點一則推文／縮圖 → jumpTo(row)，複製 → copyUrl／copyAid，
//     收起 → setCollapsed(true)，把手 → setCollapsed(false)；
//  3. 縮圖候選依序試，全部失敗整格收掉；
//  4. mousedown preventDefault（不搶 #t 焦點）、滑鼠事件不外洩到 window；
//  5. #articleTools 被 App 的滑鼠入口認得（isArticleToolsTarget），滾輪才不會變成翻頁。
import { render, fireEvent, act } from "@testing-library/react";
import { ArticleTools } from "../../src/components/ArticleTools";
import { isArticleToolsTarget, ARTICLE_TOOLS_ID } from "../../src/js/article_tools";
import { setupI18n, i18n } from "../../src/js/i18n";

beforeAll(() => {
  setupI18n();
});

function fakeTools(state) {
  const listeners = new Set();
  const tools = {
    state: {
      visible: true,
      width: 220,
      collapsed: false,
      board: "Test",
      aid: "1gU3wwNZ",
      url: "https://www.ptt.cc/bbs/Test/M.1786265274.A.5E3.html",
      author: "alice",
      stats: { push: 3, boo: 1, arrow: 2, modern: 0 },
      users: [
        { user: "bob", count: 3, op: false },
        { user: "alice", count: 1, op: true },
      ],
      images: [
        { url: "https://example.com/a.jpg", row: 4, thumbs: [GIF + "#a1", GIF + "#a2"] },
        { url: "https://example.com/b.jpg", row: 9, thumbs: [GIF + "#b"] },
      ],
      selectedUser: null,
      selectedComments: [],
      ...state,
    },
    onChange(fn) {
      listeners.add(fn);
      fn(tools.state);
      return () => listeners.delete(fn);
    },
    push(patch) {
      tools.state = { ...tools.state, ...patch };
      listeners.forEach((fn) => fn(tools.state));
    },
    selectUser: vi.fn(),
    jumpTo: vi.fn(),
    copyUrl: vi.fn(),
    copyAid: vi.fn(),
    setCollapsed: vi.fn(),
  };
  return tools;
}

// 合法的 1×1 gif：自己不會觸發 error，分支只由 fireEvent.error 推進（不跟真的載入失敗搶）。
const GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

const root = () => document.getElementById(ARTICLE_TOOLS_ID);
const q = (sel) => document.querySelector(sel);

test("不可見就不畫；可見時照 state 畫（寬度、AID、統計、推文者）", () => {
  const tools = fakeTools({ visible: false });
  render(<ArticleTools pttchrome={{ articleTools: tools }} />);
  expect(root()).toBeNull();
  act(() => tools.push({ visible: true }));
  expect(root().style.width).toBe("220px");
  expect(q("[data-tools-info]").textContent).toContain("#1gU3wwNZ");
  expect(q('[data-kind="push"]').textContent).toContain("3");
  expect(q('[data-kind="boo"]').textContent).toContain("1");
  expect(q('[data-kind="arrow"]').textContent).toContain("2");
  expect(q('[data-kind="modern"]')).toBeNull();
  expect(q('[data-tools-user="alice"]').hasAttribute("data-op")).toBe(true);
  expect(q('[data-tools-user="alice"]').textContent).toContain(i18n("tools_op"));
  expect(q('[data-tools-user="bob"]').hasAttribute("data-op")).toBe(false);
  act(() => tools.push({ visible: false }));
  expect(root()).toBeNull();
});

test("沒有 AID ⇒ 不畫複製區；有新格式推文 ⇒ 另列", () => {
  const tools = fakeTools({ aid: null, url: null, stats: { push: 0, boo: 0, arrow: 0, modern: 5 } });
  render(<ArticleTools pttchrome={{ articleTools: tools }} />);
  expect(q("[data-tools-info]")).toBeNull();
  expect(q('[data-kind="modern"]').textContent).toContain("5");
});

test("點推文者 → selectUser；選中後列出他的推文，點一則 → jumpTo(row)", () => {
  const tools = fakeTools({});
  render(<ArticleTools pttchrome={{ articleTools: tools }} />);
  fireEvent.click(q('[data-tools-user="bob"]'));
  expect(tools.selectUser).toHaveBeenCalledWith("bob");
  expect(q("[data-tools-comments]")).toBeNull();
  act(() =>
    tools.push({
      selectedUser: "bob",
      selectedComments: [
        { row: 12, type: "推", user: "bob", content: "第一" },
        { row: 15, type: "→", user: "bob", content: "" },
      ],
    })
  );
  expect(q('[data-tools-user="bob"]').hasAttribute("data-selected")).toBe(true);
  expect(q('[data-tools-comment="12"]').textContent).toBe("第一");
  expect(q('[data-tools-comment="15"]').textContent).toBe("…");
  fireEvent.click(q('[data-tools-comment="15"]'));
  expect(tools.jumpTo).toHaveBeenCalledWith(15);
});

test("複製網址／AID", () => {
  const tools = fakeTools({});
  render(<ArticleTools pttchrome={{ articleTools: tools }} />);
  fireEvent.click(q("[data-tools-copy-url]"));
  fireEvent.click(q("[data-tools-copy-aid]"));
  expect(tools.copyUrl).toHaveBeenCalledTimes(1);
  expect(tools.copyAid).toHaveBeenCalledTimes(1);
});

test("圖片牆預設收著（不下載）；展開才畫縮圖，點縮圖 → jumpTo(row)", () => {
  const tools = fakeTools({});
  render(<ArticleTools pttchrome={{ articleTools: tools }} />);
  const toggle = q("[data-tools-images-toggle]");
  expect(toggle.textContent).toContain("2");
  expect(q("[data-tools-images]")).toBeNull();
  expect(document.querySelectorAll("#" + ARTICLE_TOOLS_ID + " img")).toHaveLength(0);
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(q('[data-tools-image="9"]'));
  expect(tools.jumpTo).toHaveBeenCalledWith(9);
});

test("縮圖候選依序試，全部失敗 ⇒ 整格收掉", () => {
  const tools = fakeTools({});
  render(<ArticleTools pttchrome={{ articleTools: tools }} />);
  fireEvent.click(q("[data-tools-images-toggle]"));
  const img = () => q('[data-tools-image="4"] img');
  expect(img().getAttribute("src")).toBe(GIF + "#a1");
  fireEvent.error(img());
  expect(img().getAttribute("src")).toBe(GIF + "#a2");
  fireEvent.error(img());
  expect(q('[data-tools-image="4"]')).toBeNull();
  expect(q('[data-tools-image="9"]')).not.toBeNull();
});

test("收起 → setCollapsed(true)；收起時只畫把手，把手 → setCollapsed(false)", () => {
  const tools = fakeTools({});
  render(<ArticleTools pttchrome={{ articleTools: tools }} />);
  fireEvent.click(q("[data-tools-collapse]"));
  expect(tools.setCollapsed).toHaveBeenCalledWith(true);
  act(() => tools.push({ collapsed: true }));
  expect(q("[data-tools-stats]")).toBeNull();
  fireEvent.click(q("[data-tools-expand]"));
  expect(tools.setCollapsed).toHaveBeenLastCalledWith(false);
});

test("mousedown 不搶焦點、滑鼠事件不外洩到 window", () => {
  render(<ArticleTools pttchrome={{ articleTools: fakeTools({}) }} />);
  const seen = [];
  const spy = (e) => seen.push(e.type);
  for (const t of ["mousedown", "mouseup", "click"]) window.addEventListener(t, spy);
  try {
    const btn = q('[data-tools-user="bob"]');
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    btn.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    fireEvent.mouseUp(btn);
    fireEvent.click(btn);
    const bg = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    root().dispatchEvent(bg);
    expect(bg.defaultPrevented).toBe(true);
    expect(seen).toEqual([]);
  } finally {
    for (const t of ["mousedown", "mouseup", "click"]) window.removeEventListener(t, spy);
  }
});

test("isArticleToolsTarget：側欄裡的節點才算", () => {
  render(<ArticleTools pttchrome={{ articleTools: fakeTools({}) }} />);
  expect(isArticleToolsTarget(q('[data-tools-user="bob"]'))).toBe(true);
  expect(isArticleToolsTarget(document.body)).toBe(false);
  expect(isArticleToolsTarget(null)).toBe(false);
});
