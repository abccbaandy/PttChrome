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
    const at = (i) => app.pusherClickRangeOf(lines[i].line, 0, midY(lines[i].line));
    expect(at(0)).toEqual({ start: 8, end: 13 });
    expect(at(1)).toEqual({ start: 8, end: 10 });
    expect(at(2)).toEqual({ start: 8, end: 14 });
  });

  test("合併塊：點在第 2 行內容右側空白（目標是外層容器）仍取第 2 行", () => {
    const { row, lines, midY } = mergedBlock("13,10,14");
    expect(makeApp().pusherClickRangeOf(row, 0, midY(lines[1].line))).toEqual({
      start: 8,
      end: 10,
    });
  });

  test("合併塊：終點＝日期 ⇒ 每一行都到全塊共用的日期欄", () => {
    const { lines, midY } = mergedBlock("13,10,14");
    const app = makeApp({ end: "date" });
    lines.forEach(({ line }) =>
      expect(app.pusherClickRangeOf(line, 0, midY(line))).toEqual({ start: 8, end: 26 }),
    );
  });

  test("合併塊：y 落在行間的預覽插槽 ⇒ 不是推文文字（null，交回區域決策）", () => {
    const { row, lines, midY } = mergedBlock("13,10", { previewHeight: 60 });
    expect(makeApp().pusherClickRangeOf(row, 0, midY(lines[0].slot))).toBeNull();
  });

  test("單列推文：單值，不看行號", () => {
    const { lines } = mergedBlock("16");
    expect(makeApp().pusherClickRangeOf(lines[0].line, 0, -999)).toEqual({ start: 8, end: 16 });
  });

  // 回歸 3：推文區塊行距（main.css .commentSpacing）塊內是 line-height，inline 行的
  // rect 只有字高 ⇒ 行與行之間的 leading 曾落在每一行之外 ⇒ null ⇒ 翻頁。
  test("合併塊：行距（line-height 的 leading）算該行，不是行外", () => {
    const { row, lines } = mergedBlock("13,10,14");
    row.style.lineHeight = "40px";
    const r0 = lines[0].line.getBoundingClientRect();
    const r1 = lines[1].line.getBoundingClientRect();
    expect(r1.top - r0.bottom).toBeGreaterThan(4); // 前提：真的有空隙
    const app = makeApp();
    expect(app.pusherClickRangeOf(row, 0, r0.bottom + 1)).toEqual({ start: 8, end: 13 });
    expect(app.pusherClickRangeOf(row, 0, r1.top - 1)).toEqual({ start: 8, end: 10 });
  });

  // 回歸 4：推文區塊**之間**的行距是推文元素的 margin-top，不屬於任何推文元素 ⇒
  // 指標在那裡時事件目標是 #mainContainer 本身，曾直接 null ⇒ 兩則推文中間冒出
  // 一條翻頁帶。空隙跟著最近的那一列走：是推文就是推文、是內文就照內文。
  describe("推文區塊之間的行距（#mainContainer 的 margin 空隙）", () => {
    const GAP = 12;
    function page() {
      const c = document.createElement("div");
      c.id = "mainContainer";
      c.style.cssText = "font: 16px monospace; width: 800px; padding-bottom: 40px";
      const mk = (pusher, end, gap) => {
        const r = document.createElement("span");
        r.setAttribute("type", "bbsrow");
        r.style.display = "block";
        if (gap) r.style.marginTop = GAP + "px";
        if (pusher) {
          r.setAttribute("data-pusher", pusher);
          r.setAttribute("data-pusher-col", "8");
          r.setAttribute("data-pusher-end", end);
          r.setAttribute("data-pusher-date-end", "26");
        }
        r.textContent = pusher ? "推 " + pusher : "內文";
        c.appendChild(r);
        return r;
      };
      const a = mk("aaa", "13", false);
      const b = mk("bbb", "15", true);
      const text = mk(null, null, false);
      const d = mk("ddd", "17", true);
      document.body.appendChild(c);
      const app = makeApp();
      app.view.mainContainer = c;
      const x = c.getBoundingClientRect().left + 40;
      const at = (y) => {
        // 前提：這一點真的是空隙（事件目標＝容器本身）。
        expect(document.elementFromPoint(x, y)).toBe(c);
        return app.pusherClickRangeOf(c, x, y);
      };
      const rect = (el) => el.getBoundingClientRect();
      return { a, b, text, d, at, rect };
    }

    test("兩則推文之間：靠哪一則就算哪一則", () => {
      const { a, b, at, rect } = page();
      expect(at(rect(a).bottom + 2)).toEqual({ start: 8, end: 13 });
      expect(at(rect(b).top - 2)).toEqual({ start: 8, end: 15 });
    });

    test("內文與推文之間：靠內文那半照內文（null），靠推文那半算推文", () => {
      const { text, d, at, rect } = page();
      expect(at(rect(text).bottom + 2)).toBeNull();
      expect(at(rect(d).top - 2)).toEqual({ start: 8, end: 17 });
    });

    test("不是推文行距的空白（容器 padding）⇒ null", () => {
      const { d, at, rect } = page();
      expect(at(rect(d).bottom + 3)).toBeNull();
    });
  });

  test("不在推文列 ⇒ null；交給 server ⇒ null；範圍不生效 ⇒ 整列", () => {
    const { lines, midY } = mergedBlock("13,10");
    const y = midY(lines[0].line);
    expect(makeApp().pusherClickRangeOf(document.body, 0, y)).toBeNull();
    expect(makeApp({ serverReport: true }).pusherClickRangeOf(lines[0].line, 0, y)).toBeNull();
    expect(makeApp({ clickRange: false }).pusherClickRangeOf(lines[0].line, 0, y)).toEqual({
      start: 0,
      end: Infinity,
    });
  });
});
