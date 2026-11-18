// @unit-env browser
// real-input: tests/e2e/offline/quote_collapse.offline.spec.js
// 長引言收起的畫法（P106，render/quote_fold.js）。真瀏覽器量的事實：
//   - Selection.toString 不含 hidden="until-found"（content-visibility:hidden）裡的字 ⇒ 複製前要暫時打開；
//   - 打開、讀完、放回在同一個 task 裡完成，放回後還是收著。
// 端到端（真滑鼠選取＋Ctrl+C、點「展開引言」）在 tests/e2e/offline/quote_collapse.offline.spec.js。
import {
  buildQuoteFold,
  buildQuoteSkipHead,
  revealQuoteFold,
  unfoldSelection,
  quoteCopyText,
  QUOTE_FOLD_SELECTOR,
} from "../../src/render/quote_fold";

const row = (text) => {
  const s = document.createElement("span");
  s.setAttribute("type", "bbsrow");
  s.style.display = "block";
  s.textContent = text;
  return s;
};

function mount() {
  const root = document.createElement("div");
  root.id = "mainContainerTest";
  root.appendChild(row("回文開頭"));
  const onExpand = vi.fn();
  root.appendChild(buildQuoteSkipHead(row(": 第二行"), 1, 2, "k0", onExpand));
  root.appendChild(buildQuoteFold(row(": 收起的第三行"), "k0", onExpand));
  root.appendChild(buildQuoteFold(row(": 收起的第四行"), "k0", onExpand));
  root.appendChild(row("回文結尾"));
  document.body.appendChild(root);
  return { root, onExpand };
}

function selectAll(root) {
  const sel = window.getSelection();
  sel.removeAllRanges();
  const r = document.createRange();
  r.selectNodeContents(root);
  sel.addRange(r);
  return sel;
}

describe("quote_fold", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    window.getSelection().removeAllRanges();
  });

  test("收起的列在 DOM 裡、hidden=until-found、不佔高度", () => {
    const { root } = mount();
    const folds = root.querySelectorAll(QUOTE_FOLD_SELECTOR);
    expect(folds).toHaveLength(2);
    for (const f of folds) expect(f.getBoundingClientRect().height).toBe(0);
  });

  test("前提：瀏覽器的 toString 不含收起的字（所以才要 unfoldSelection）", () => {
    const { root } = mount();
    expect(selectAll(root).toString()).not.toContain("收起的第三行");
  });

  test("unfoldSelection：打開選取碰到的收起列、讀得到；放回後仍收著，下一個 task 整段展開", async () => {
    const { root, onExpand } = mount();
    const sel = selectAll(root);
    const restore = unfoldSelection(sel, root);
    const text = sel.toString();
    restore();
    expect(text).toContain("收起的第三行");
    expect(text).toContain("收起的第四行");
    expect(root.querySelectorAll(QUOTE_FOLD_SELECTOR)).toHaveLength(2);
    await new Promise((r) => setTimeout(r, 0));
    expect(onExpand).toHaveBeenCalledWith("k0", expect.anything());
  });

  test("quoteCopyText（系統複製）：碰到收起段給全文；沒碰到回 null（照原生）", () => {
    const { root } = mount();
    expect(quoteCopyText(selectAll(root), root)).toContain("收起的第四行");
    const sel = window.getSelection();
    sel.removeAllRanges();
    const r = document.createRange();
    r.selectNodeContents(root.lastChild);
    sel.addRange(r);
    expect(quoteCopyText(sel, root)).toBeNull();
  });

  test("選取沒碰到收起段 ⇒ 一列都不打開", () => {
    const { root } = mount();
    const sel = window.getSelection();
    sel.removeAllRanges();
    const r = document.createRange();
    r.selectNodeContents(root.firstChild);
    sel.addRange(r);
    const restore = unfoldSelection(sel, root);
    expect(root.querySelectorAll(QUOTE_FOLD_SELECTOR)).toHaveLength(2);
    restore();
  });

  test("revealQuoteFold（手機找字）：打開那一列，下一個 task 整段展開（key）", async () => {
    const { root, onExpand } = mount();
    const target = root.querySelectorAll(QUOTE_FOLD_SELECTOR)[0].firstChild;
    expect(revealQuoteFold(target)).toBe(true);
    expect(target.closest(QUOTE_FOLD_SELECTOR)).toBeNull();
    expect(onExpand).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 0));
    expect(onExpand).toHaveBeenCalledWith("k0", target.parentNode);
    expect(revealQuoteFold(root.firstChild)).toBe(false);
  });

  test("展開鈕：不是 bbsrow、寫還有幾行、點了帶 key 與鈕本身", () => {
    const { root, onExpand } = mount();
    const btn = root.querySelector(".quoteSkip");
    expect(btn.hasAttribute("type")).toBe(false);
    expect(btn.textContent).toMatch(/2/);
    btn.click();
    expect(onExpand).toHaveBeenCalledWith("k0", btn);
    expect(btn.parentNode.__quoteRow).toBe(1);
  });
});
