// @unit-env browser
// 選取 → { row, col }（term_view.countCol／getSelectionColRow）。消費端：右鍵「複製為 ANSI」
// （App.doCopyAnsi）與輸入小幫手的上色（編輯器裡依選取範圍送 ESC[H＋方向鍵把游標移過去）。
//
// 端點不一定落在文字節點上：真 Chromium 三連擊選一整列時，結尾是「下一列外層元素、offset 0」
// ——不在任何 bbsline 裡。以前一律回 { row: 0, col: 0 } ⇒ 複製為 ANSI 抄到空字串、上色把游標
// 移到第 0 列再送色碼。元素端點的 offset 是子節點索引，也不能當字元位移用。
import { userEvent } from "vitest/browser";
import mainCss from "../../src/css/main.css?raw";
import { mountScreen, unmountAll } from "./helpers/mount_screen";
import { row, seg } from "./helpers/screen_fixtures";
import { TermView, selectionPointOutsideRow } from "../../src/js/term_view";

let style;
beforeAll(() => {
  style = document.createElement("style");
  style.textContent = mainCss;
  document.head.appendChild(style);
});
afterAll(() => style.remove());
afterEach(() => {
  window.getSelection().removeAllRanges();
  unmountAll();
});

const view = {
  componentScreen: null,
  getRowLineElement: TermView.prototype.getRowLineElement,
  countCol: TermView.prototype.countCol,
};
const colRow = () => TermView.prototype.getSelectionColRow.call(view);

const threeRows = () =>
  mountScreen({
    lines: [row(seg("FIRST ROW")), row(seg("SECOND ROW")), row(seg("THIRD ROW"))],
  });

test("三連擊選一整列：結尾＝下一列開頭，不是第 0 列", async () => {
  const s = threeRows();
  await userEvent.tripleClick(s.container.querySelector('[data-row="1"]'));
  expect(colRow()).toEqual({ start: { row: 1, col: 0 }, end: { row: 2, col: 0 } });
});

test("元素端點的 offset 是子節點索引：停在第 pos 個子節點之前", () => {
  const s = threeRows();
  const line = s.container.querySelector('[data-row="1"]');
  const r = document.createRange();
  r.setStart(line, 0);
  r.setEnd(line, line.childNodes.length);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  const { start, end } = colRow();
  expect(start).toEqual({ row: 1, col: 0 });
  expect(end).toEqual({ row: 1, col: line.textContent.length });
});

test("列外端點後面沒有列：取前面最後一列的行尾", () => {
  const s = threeRows();
  const third = s.container.querySelector('[data-row="2"]');
  const parent = third.parentNode;
  const at = Array.prototype.indexOf.call(parent.childNodes, third) + 1;
  expect(selectionPointOutsideRow(parent, at)).toEqual({
    row: 2,
    col: third.textContent.length,
  });
});
