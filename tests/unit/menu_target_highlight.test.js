// @unit-env browser
// 右鍵／長按選單開著時標出選中的那篇文章（js/menu_target_highlight.js）。鎖：
//  1. 由 event.target 找到文章列（桌機 buildRow、手機 buildListCard），非文章列 ⇒ null；
//  2. 只有那一列被標（computed style 真的變了），其他列不變；清掉後全部恢復；
//  3. 那一列換成別篇（標題不符）⇒ 不標，不會指到錯的文章；
//  4. 不寫入列節點本身（outerHTML 不變 ⇒ 不打斷 screen.js 的節點沿用比對）；
//  5. 標題含引號／反斜線也不會讓規則失效；
//  6. 只畫外框，不閃爍（開關 highlightMenuTarget 的 e2e 在 list_mark_read.offline.spec.js）。
import { buildRow } from "../../src/render/row";
import { buildListCard } from "../../src/render/list_card";
import { listRow, row as charsRow, seg } from "./helpers/screen_fixtures";
import {
  menuTargetFromElement,
  menuTargetSelector,
  menuTargetCss,
  setMenuTargetHighlight,
} from "../../src/js/menu_target_highlight";

let container;

function mount(nodes) {
  container = document.createElement("div");
  container.id = "mainContainer";
  for (const n of nodes) container.appendChild(n);
  document.body.appendChild(container);
}

afterEach(() => {
  setMenuTargetHighlight(null);
  if (container) container.remove();
  container = null;
});

const marked = (node) => getComputedStyle(node).boxShadow.includes("168, 199, 250");

function listRows(titles) {
  return titles.map(
    (title, i) =>
      buildRow({
        chars: listRow("someone", title),
        row: i + 3,
        forceWidth: 20,
        listAuthor: "someone",
        listTitle: title,
      }).node,
  );
}

test("桌機列表：只標選中那一列，清掉後恢復", () => {
  const nodes = listRows(["[問卦] 第一篇", "[問卦] 第二篇", "[問卦] 第三篇"]);
  mount(nodes);
  const before = nodes[1].outerHTML;
  const t = menuTargetFromElement(nodes[1].querySelector('[data-type="bbsline"]'));
  expect(t).toEqual({ row: 4, author: "someone", title: "[問卦] 第二篇" });

  setMenuTargetHighlight(t);
  expect(nodes.map(marked)).toEqual([false, true, false]);
  expect(nodes[1].outerHTML).toBe(before);

  setMenuTargetHighlight(null);
  expect(nodes.map(marked)).toEqual([false, false, false]);
});

// 使用者要求：直接框起來，不閃爍、不疊底色。
test("只畫外框：沒有動畫、沒有疊色", () => {
  const nodes = listRows(["[問卦] 一篇"]);
  mount(nodes);
  setMenuTargetHighlight(menuTargetFromElement(nodes[0]));
  expect(marked(nodes[0])).toBe(true);
  const css = menuTargetCss({ row: 3, author: "a", title: "b" });
  expect(css).not.toMatch(/animation|@keyframes|::after|background/);
  expect(getComputedStyle(nodes[0], "::after").content).toBe("none");
});

test("手機卡片也標得到", () => {
  const node = buildListCard({
    chars: listRow("someone", "□ [心得] 卡片"),
    row: 5,
    kind: "article",
    forceWidth: 16,
    listAuthor: "someone",
    listTitle: "[心得] 卡片",
  }).node;
  mount([node]);
  setMenuTargetHighlight(menuTargetFromElement(node.querySelector(".listCardTitle")));
  expect(marked(node)).toBe(true);
});

test("同一列換成別篇 ⇒ 不標", () => {
  const nodes = listRows(["[問卦] 舊的"]);
  mount(nodes);
  const t = menuTargetFromElement(nodes[0]);
  container.replaceChildren(...listRows(["[問卦] 新的"]));
  setMenuTargetHighlight({ ...t, row: 3 });
  expect(marked(container.firstChild)).toBe(false);
});

test("非文章列 ⇒ null", () => {
  const node = buildRow({ chars: charsRow(seg("一般內文")), row: 0, forceWidth: 20 }).node;
  mount([node]);
  expect(menuTargetFromElement(node.querySelector('[data-type="bbsline"]'))).toBe(null);
  expect(menuTargetSelector(null)).toBe("");
});

test('標題含 " 與 \\ 照樣標得到', () => {
  const title = 'Re: [問卦] 有"引號"與\\反斜線';
  const nodes = listRows([title]);
  mount(nodes);
  setMenuTargetHighlight(menuTargetFromElement(nodes[0]));
  expect(marked(nodes[0])).toBe(true);
});
