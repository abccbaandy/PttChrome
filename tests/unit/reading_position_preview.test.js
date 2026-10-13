// @unit-env browser
// 閱讀位置的採樣（term_view.currentLineIndex）與還原（easy_reading._advanceScrollRestore
// → term_view.pageRowTop）在「視窗上方有行內預覽」時必須以 srow 節點為準。
// 症狀（若退回，ptt-debug-20261013-005651）：格線版面用 scrollTop/chh 採樣，把上方
// 連結卡／圖片佔位盒的高度算成列數 ⇒ AID 跳轉返回後落點往下偏 30 多列；還原端用
// lineIndex*chh 又不認預覽高度、也沒先把閉塊照常渲染，落點再偏一次。
import { TermView } from "../../src/js/term_view";
import { EasyReading } from "../../src/js/easy_reading";
import { CHUNK_CLASS, CHUNK_NEAR_CLASS } from "../../src/render/screen_chunk";

const CHH = 20;
const ROWS = 200;
const PREVIEW_ROW = 3; // 這一列底下掛一個 300px 的行內預覽
const PREVIEW_H = 300;

function mount({ chunked = false } = {}) {
  const disp = document.createElement("div");
  disp.style.cssText = "position:relative;height:400px;overflow-y:auto";
  const mc = document.createElement("div");
  disp.appendChild(mc);
  let parent = mc;
  for (let r = 0; r < ROWS; ++r) {
    if (chunked && r % 100 === 0) {
      parent = document.createElement("div");
      parent.className = CHUNK_CLASS;
      mc.appendChild(parent);
    }
    const row = document.createElement("span");
    row.setAttribute("type", "bbsrow");
    row.setAttribute("srow", String(r));
    row.style.cssText = "display:block";
    const line = document.createElement("span");
    line.style.cssText = `display:block;height:${CHH}px`;
    row.appendChild(line);
    if (r === PREVIEW_ROW) {
      const slot = document.createElement("div");
      slot.style.cssText = `height:${PREVIEW_H}px`;
      row.appendChild(slot);
    }
    parent.appendChild(row);
  }
  document.body.appendChild(disp);
  const view = Object.create(TermView.prototype);
  view.mainDisplay = disp;
  view.mainContainer = mc;
  view.chh = CHH;
  view.reflow = false;
  view.buf = { pageLines: new Array(ROWS), rows: 24 };
  const rowTop = (r) => mc.querySelector(`[srow="${r}"]`).offsetTop;
  return { view, disp, mc, rowTop };
}

describe("格線版面、視窗上方有行內預覽", () => {
  test("採樣：視窗頂端那一列的 srow，不是 scrollTop/chh", () => {
    const { view, disp, rowTop } = mount();
    try {
      disp.scrollTop = rowTop(30);
      expect(disp.scrollTop).toBe(30 * CHH + PREVIEW_H);
      expect(view.currentLineIndex()).toBe(30);
    } finally {
      disp.remove();
    }
  });

  test("還原：捲到該列節點的頂端，不是 lineIndex*chh", () => {
    const { view, disp, rowTop } = mount();
    try {
      const er = Object.create(EasyReading.prototype);
      er._view = view;
      er.easyReadingReachedPageEnd = false;
      er.requestScrollRestore(30);
      er._advanceScrollRestore();
      expect(er._pendingScrollRestore).toBe(null);
      expect(disp.scrollTop).toBe(rowTop(30));
    } finally {
      disp.remove();
    }
  });

  test("來回一趟：離開時在哪一列，回來就在哪一列", () => {
    const { view, disp, rowTop } = mount();
    try {
      disp.scrollTop = rowTop(57);
      const lineIndex = view.currentLineIndex();
      disp.scrollTop = 0; // 離開文章、重讀
      const er = Object.create(EasyReading.prototype);
      er._view = view;
      er.easyReadingReachedPageEnd = false;
      er.requestScrollRestore(lineIndex);
      er._advanceScrollRestore();
      expect(disp.scrollTop).toBe(rowTop(57));
    } finally {
      disp.remove();
    }
  });
});

// ptt-debug-20261013-213914：掛圖的那一列（文字＋圖）是一個 bbsrow 節點。停在圖中間
// 離開，只記 srow 的話還原會貼齊列頂 ⇒ 往上偏「離開時已捲進圖裡的那段」（實錄 220px）。
describe("視窗頂端落在掛圖那一列的中間", () => {
  function restoreTo(view, lineIndex) {
    const er = Object.create(EasyReading.prototype);
    er._view = view;
    er.easyReadingReachedPageEnd = false;
    er.requestScrollRestore(lineIndex);
    er._advanceScrollRestore();
    return er;
  }

  test("來回一趟：回到圖裡的同一處，不是貼齊列頂", () => {
    const { view, disp, rowTop } = mount();
    try {
      const at = rowTop(PREVIEW_ROW) + CHH + 220;
      disp.scrollTop = at;
      const lineIndex = view.currentLineIndex();
      expect(Math.floor(lineIndex)).toBe(PREVIEW_ROW);
      disp.scrollTop = 0;
      const er = restoreTo(view, lineIndex);
      expect(er._pendingScrollRestore).toBe(null);
      expect(Math.abs(disp.scrollTop - at)).toBeLessThanOrEqual(1);
    } finally {
      disp.remove();
    }
  });

  test("最頂端（第 0 列）停在圖中間也算有位置，不被當成「在頂端」略過", () => {
    const { view, disp, mc } = mount();
    try {
      mc.querySelector('[srow="0"]').firstChild.style.height = `${CHH + 400}px`;
      disp.scrollTop = 200;
      const lineIndex = view.currentLineIndex();
      expect(lineIndex).toBeGreaterThan(0);
      expect(lineIndex).toBeLessThan(1);
      disp.scrollTop = 0;
      restoreTo(view, lineIndex);
      expect(Math.abs(disp.scrollTop - 200)).toBeLessThanOrEqual(1);
    } finally {
      disp.remove();
    }
  });

  test("還原時那張圖以不同高度佔位：落在圖的同一個比例處", () => {
    const { view, disp, mc, rowTop } = mount();
    try {
      const row = mc.querySelector(`[srow="${PREVIEW_ROW}"]`);
      const h0 = row.offsetHeight;
      disp.scrollTop = rowTop(PREVIEW_ROW) + h0 / 2;
      const lineIndex = view.currentLineIndex();
      disp.scrollTop = 0;
      row.lastChild.style.height = `${PREVIEW_H * 2}px`;
      restoreTo(view, lineIndex);
      const h1 = row.offsetHeight;
      expect(Math.abs(disp.scrollTop - (rowTop(PREVIEW_ROW) + h1 / 2))).toBeLessThanOrEqual(1);
    } finally {
      disp.remove();
    }
  });
});

test("長頁分塊：量目標列之前先讓它所在的塊照常渲染（不以估計高度量）", () => {
  const { view, disp, mc } = mount({ chunked: true });
  try {
    const chunks = mc.querySelectorAll("." + CHUNK_CLASS);
    expect(chunks.length).toBe(2);
    view.pageRowTop(150);
    expect(chunks[1].classList.contains(CHUNK_NEAR_CLASS)).toBe(true);
  } finally {
    disp.remove();
  }
});
