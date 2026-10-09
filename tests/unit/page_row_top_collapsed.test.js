// @unit-env browser
// term_view.pageRowTop 遇到手機收起來的列（render/collapsed_row.js，display:none）。
// 症狀（若退回）：好讀文章檔頭的分隔線被收起後 offsetTop 讀到 0 ⇒ AID 回跳／閱讀位置
// 還原（scroll_restore 的 targetTop）把文章拉回頂端。規則：跳過看不到的列，取下一列。
import { TermView } from "../../src/js/term_view";

function mount() {
  const disp = document.createElement("div");
  disp.style.cssText = "position:relative;height:100px;overflow-y:auto";
  const mc = document.createElement("div");
  disp.appendChild(mc);
  const mk = (r, hidden) => {
    const n = document.createElement("span");
    n.setAttribute("type", "bbsrow");
    n.setAttribute("srow", String(r));
    n.style.cssText = hidden ? "display:none" : "display:block;height:20px";
    mc.appendChild(n);
  };
  mk(0);
  mk(1);
  mk(2);
  mk(3, true); // 檔頭分隔線（收起）
  mk(4);
  document.body.appendChild(disp);
  const view = Object.create(TermView.prototype);
  view.mainDisplay = disp;
  view.mainContainer = mc;
  view.buf = { pageLines: new Array(5), rows: 24 };
  return { view, disp };
}

test("收起的列 ⇒ 取下一個看得到的列頂端，不是 0", () => {
  const { view, disp } = mount();
  try {
    expect(view.pageRowTop(2)).toBe(40);
    expect(view.pageRowTop(3)).toBe(60);
  } finally {
    disp.remove();
  }
});
