// @unit-env browser
// App.pusherClickRangeOf：推文可點區（issue #56）由 DOM 讀欄位。點擊（mouse_click）
// 與指標（onMouse_move）共用這一支。
//
// 合併推文塊（同作者連推一則一行，懸掛縮排）的欄位位置與原生逐列相同 ⇒ 內容結尾
// 要**逐行**比照：data-pusher-end 是逐行清單，行號取**指標 y 所在的那一行**。
// 回歸：
//   1. 合併塊曾不帶終點欄位 ⇒ 終點「推文內容結尾」在合併塊失效、整行右側都吃掉翻頁。
//   2. 行號不能用事件目標判：非末行的內容後面沒有補空白字元，點在內容右側空白處時
//      目標是外層容器（不是那一行的 bbsline）。
// real-input: tests/e2e/offline/mouse.offline.spec.js
import { App } from "../../src/js/pttchrome";

function makeApp({ clickRange = true, serverReport = false, start = "content", end = "content" } = {}) {
  const app = Object.create(App.prototype);
  app.mouseGates = () => ({ clickRange, serverReport });
  app.view = { mousePushClickStart: start, mousePushClickEnd: end };
  return app;
}

// 結構同 golden article_easy_reading.html 的 .mergedCommentBlock：每則一個 bbsline，
// 後面緊跟該行的預覽插槽 div。previewHeight > 0 模擬插槽撐開（自動開圖）。
function mergedBlock(ends, { previewHeight = 0 } = {}) {
  const host = document.createElement("div");
  host.className = "mergedCommentBlock";
  host.style.cssText = "font: 16px monospace; width: 800px";
  const row = document.createElement("span");
  row.setAttribute("type", "bbsrow");
  row.style.display = "block";
  row.setAttribute("data-pusher", "aaa");
  row.setAttribute("data-pusher-col", "8");
  row.setAttribute("data-pusher-end", ends);
  row.setAttribute("data-pusher-date-end", "26");
  const wrap = document.createElement("div");
  const lines = ends.split(",").map((_, i) => {
    const line = document.createElement("span");
    line.setAttribute("data-type", "bbsline");
    line.textContent = "line" + i;
    wrap.appendChild(line);
    const slot = document.createElement("div");
    slot.style.height = previewHeight + "px";
    wrap.appendChild(slot);
    return { line, slot };
  });
  row.appendChild(wrap);
  host.appendChild(row);
  document.body.appendChild(host);
  const midY = (el) => {
    const r = el.getBoundingClientRect();
    return (r.top + r.bottom) / 2;
  };
  return { row, lines, midY };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("App.pusherClickRangeOf", () => {
  test("合併塊：內容結尾取指標所在那一行", () => {
    const { lines, midY } = mergedBlock("13,10,14");
    const app = makeApp();
    const at = (i) => app.pusherClickRangeOf(lines[i].line, midY(lines[i].line));
    expect(at(0)).toEqual({ start: 8, end: 13 });
    expect(at(1)).toEqual({ start: 8, end: 10 });
    expect(at(2)).toEqual({ start: 8, end: 14 });
  });

  test("合併塊：點在第 2 行內容右側空白（目標是外層容器）仍取第 2 行", () => {
    const { row, lines, midY } = mergedBlock("13,10,14");
    expect(makeApp().pusherClickRangeOf(row, midY(lines[1].line))).toEqual({
      start: 8,
      end: 10,
    });
  });

  test("合併塊：終點＝日期 ⇒ 每一行都到全塊共用的日期欄", () => {
    const { lines, midY } = mergedBlock("13,10,14");
    const app = makeApp({ end: "date" });
    lines.forEach(({ line }) =>
      expect(app.pusherClickRangeOf(line, midY(line))).toEqual({ start: 8, end: 26 }),
    );
  });

  test("合併塊：y 落在行間的預覽插槽 ⇒ 不是推文文字（null，交回區域決策）", () => {
    const { row, lines, midY } = mergedBlock("13,10", { previewHeight: 60 });
    expect(makeApp().pusherClickRangeOf(row, midY(lines[0].slot))).toBeNull();
  });

  test("單列推文：單值，不看行號", () => {
    const { lines } = mergedBlock("16");
    expect(makeApp().pusherClickRangeOf(lines[0].line, -999)).toEqual({ start: 8, end: 16 });
  });

  test("不在推文列 ⇒ null；交給 server ⇒ null；範圍不生效 ⇒ 整列", () => {
    const { lines, midY } = mergedBlock("13,10");
    const y = midY(lines[0].line);
    expect(makeApp().pusherClickRangeOf(document.body, y)).toBeNull();
    expect(makeApp({ serverReport: true }).pusherClickRangeOf(lines[0].line, y)).toBeNull();
    expect(makeApp({ clickRange: false }).pusherClickRangeOf(lines[0].line, y)).toEqual({
      start: 0,
      end: Infinity,
    });
  });
});
