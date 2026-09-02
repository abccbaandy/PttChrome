// 看板列表平滑捲動的**累積與視窗組裝**（term_view.accumulateBoardListLines /
// buildBoardListWindowLines）。直接用 stub buf 呼叫真的 prototype 方法 —— 這兩支
// 完全不碰 DOM（渲染由 render/screen.js 接手，另有 board_list_render.test.js）。
//
// 三件一壞就靜默錯畫的事：
//   1. 編號當 key、整列覆蓋 ⇒ 重繪的最新未讀 `ˇ`／標記 `D` 取代舊快照；
//   2. 存進緩衝的列必須是**乾淨的原生列**（server 畫的游標 `>` 要用 %7d 蓋回去），
//      游標由 render 端自己畫在正確的那一列；
//   3. header/footer 只在「長得像乾淨看板列表」的活幀更新快取。
import { TermView } from "../../src/js/term_view";

const pad7 = (n) => String(n).padStart(7, " ");
const brdRow = (num, name, unread = "  ") =>
  pad7(num) + " " + unread + String(name).padEnd(13, " ") + "綜合 測試看板";
const HOTKEY = "[←][q]回上層 [→][r]閱讀 [↑↓]選擇 [PgUp][PgDn]翻頁";
const HEADER = "   編號   看  板       類別   中   文   敘   述";
const FOOT = "  選擇看板    (a)增加看板 (s)進入已知板名 (y)列出全部 (v/V)已讀/未讀";

function chRow(text, cols = 80) {
  const row = [];
  for (const c of text.padEnd(cols))
    row.push({ ch: c, isLeadByte: false, resetAttr() {} });
  return row;
}

// 一整幀（24 列）：header 3 + body 20 + footer。
function screenTexts({ startNum = 1, count = 20, cursorRow = -1 } = {}) {
  const texts = ["【看板列表】 批踢踢實業坊", HOTKEY, HEADER];
  for (let i = 0; i < 20; ++i)
    texts.push(i < count ? brdRow(startNum + i, "B" + (startNum + i)) : "");
  texts.push(FOOT);
  // server 的游標：半形 `>` 蓋掉 %7d 的第一格（前置空白）
  if (cursorRow >= 0) texts[cursorRow] = ">" + texts[cursorRow].slice(1);
  return texts;
}

function fakeView(texts, session) {
  return {
    buf: {
      rows: texts.length,
      cols: 80,
      cur_y: 3,
      lines: texts.map((t) => chRow(t)),
      brdListLines: [],
      brdListLineNums: [],
      getRowText(r) {
        return texts[r];
      },
    },
    bbscore: { activeListSession: () => session },
    _brdNumMap: null,
    accumulateBoardListLines: TermView.prototype.accumulateBoardListLines,
    buildBoardListWindowLines: TermView.prototype.buildBoardListWindowLines,
    resetBoardListAccumulation: TermView.prototype.resetBoardListAccumulation,
    _blankBoardListRow: TermView.prototype._blankBoardListRow,
  };
}

function fakeSession(view) {
  return {
    _cursorPos: 0,
    evictPivot: () => null,
    prunePivot: () => null,
    noteEvicted: vi.fn(),
    getListView() {
      const len = (view.buf.brdListLineNums || []).length;
      if (!len) return null;
      return {
        seq: Array.from({ length: len }, (_, i) => i),
        cursorAbs: this._cursorPos,
        cursorPos: this._cursorPos,
      };
    },
  };
}

const textOf = (row) =>
  row
    .map((c) => c.ch)
    .join("")
    .trimEnd();

describe("accumulateBoardListLines", () => {
  test("一頁 20 列進緩衝，編號升冪且與列平行", () => {
    const v = fakeView(screenTexts({ startNum: 21 }));
    v.bbscore = { activeListSession: () => fakeSession(v) };
    v.accumulateBoardListLines();
    expect(v.buf.brdListLineNums).toHaveLength(20);
    expect(v.buf.brdListLineNums[0]).toBe(21);
    expect(v.buf.brdListLineNums[19]).toBe(40);
    expect(textOf(v.buf.brdListLines[0])).toContain("B21");
  });

  test("短清單：body 尾端的空白列不進緩衝", () => {
    const v = fakeView(screenTexts({ count: 4 }));
    v.bbscore = { activeListSession: () => fakeSession(v) };
    v.accumulateBoardListLines();
    expect(v.buf.brdListLineNums).toEqual([1, 2, 3, 4]);
  });

  test("REGRESSION：server 的游標 `>` 必須被 %7d 蓋回去（存的是乾淨列）", () => {
    // 存著 `>` 的話，捲動時那一列會在畫面上多出一個假游標（真游標由 render 端
    // 依 selection 畫在別的列上）。
    const v = fakeView(screenTexts({ cursorRow: 5 }));
    v.bbscore = { activeListSession: () => fakeSession(v) };
    v.accumulateBoardListLines();
    const stored = textOf(v.buf.brdListLines[2]); // row5 → 第 3 列
    expect(stored.startsWith(">")).toBe(false);
    expect(stored.slice(0, 7)).toBe(pad7(3));
  });

  test("跨頁累積：兩頁接起來，編號連續且零重疊（分頁對齊）", () => {
    const v = fakeView(screenTexts({ startNum: 1 }));
    const s = fakeSession(v);
    v.bbscore = { activeListSession: () => s };
    v.accumulateBoardListLines();
    // 第二頁：換掉 stub 的畫面文字再累積一次（真實路徑是 server 重畫 body）
    const page2 = screenTexts({ startNum: 21 });
    v.buf.lines = page2.map((t) => chRow(t));
    v.buf.getRowText = (r) => page2[r];
    v.accumulateBoardListLines();
    expect(v.buf.brdListLineNums).toHaveLength(40);
    expect(v.buf.brdListLineNums[0]).toBe(1);
    expect(v.buf.brdListLineNums[39]).toBe(40);
  });

  test("同一頁重畫：整列覆蓋，未讀標記換成最新的（不新增重複列）", () => {
    const v = fakeView(screenTexts({ count: 3 }));
    const s = fakeSession(v);
    v.bbscore = { activeListSession: () => s };
    v.accumulateBoardListLines();
    const again = ["【看板列表】", HOTKEY, HEADER];
    again.push(brdRow(1, "B1", " ˇ")); // 這次有未讀
    again.push(brdRow(2, "B2"));
    again.push(brdRow(3, "B3"));
    for (let i = 3; i < 20; ++i) again.push("");
    again.push(FOOT);
    v.buf.lines = again.map((t) => chRow(t));
    v.buf.getRowText = (r) => again[r];
    v.accumulateBoardListLines();
    expect(v.buf.brdListLineNums).toEqual([1, 2, 3]);
    expect(textOf(v.buf.brdListLines[0])).toContain("ˇ");
  });

  test("footer 被 prompt 蓋掉的幀不得污染快取（視窗會畫出半條 footer）", () => {
    const v = fakeView(screenTexts());
    v.bbscore = { activeListSession: () => fakeSession(v) };
    v.accumulateBoardListLines();
    const good = v._brdFooterRow;
    const prompted = screenTexts();
    prompted[23] = " 跳至第幾項: 12";
    v.buf.lines = prompted.map((t) => chRow(t));
    v.buf.getRowText = (r) => prompted[r];
    v.accumulateBoardListLines();
    expect(v._brdFooterRow).toBe(good);
  });
});

describe("buildBoardListWindowLines", () => {
  function built({ count = 25, cursorPos = 0 } = {}) {
    // 兩頁累積成 25 列（一頁 20 ＋ 一頁 5）
    const v = fakeView(screenTexts({ startNum: 1 }));
    const s = fakeSession(v);
    s._cursorPos = cursorPos;
    v.bbscore = { activeListSession: () => s };
    v.accumulateBoardListLines();
    if (count > 20) {
      const page2 = screenTexts({ startNum: 21, count: count - 20 });
      v.buf.lines = page2.map((t) => chRow(t));
      v.buf.getRowText = (r) => page2[r];
      v.accumulateBoardListLines();
    }
    return { v, lines: v.buildBoardListWindowLines() };
  }

  test("header 3 列 ＋ 整段序列 ＋ footer（body 不再是 20 列切片）", () => {
    const { lines } = built({ count: 25 });
    expect(lines).toHaveLength(3 + 25 + 1);
    expect(textOf(lines[0])).toContain("【看板列表】");
    expect(textOf(lines[2])).toContain("編號");
    expect(textOf(lines[lines.length - 1])).toContain("選擇看板");
  });

  test("游標畫在選取那一列（半形 `>`），並記下它的渲染列號給游標底色用", () => {
    const { v, lines } = built({ count: 25, cursorPos: 7 });
    expect(textOf(lines[3 + 7]).startsWith(">")).toBe(true);
    expect(v._listCursorRow).toBe(3 + 7);
    // 其餘列不得帶游標
    expect(textOf(lines[3 + 6]).startsWith(">")).toBe(false);
  });

  test("短清單補 blank 列到 body 高度（維持 24 列外觀、不產生額外可捲距離）", () => {
    const v = fakeView(screenTexts({ count: 4 }));
    v.bbscore = { activeListSession: () => fakeSession(v) };
    v.accumulateBoardListLines();
    const lines = v.buildBoardListWindowLines();
    expect(lines).toHaveLength(3 + 20 + 1);
    expect(textOf(lines[3 + 4])).toBe(""); // 補的空白列
    expect(textOf(lines[lines.length - 1])).toContain("選擇看板");
  });

  test("快取或緩衝還沒建立時回 null（呼叫端會退回原生鏡像）", () => {
    const v = fakeView(screenTexts());
    v.bbscore = { activeListSession: () => fakeSession(v) };
    expect(v.buildBoardListWindowLines()).toBeNull();
  });

  test("resetBoardListAccumulation 之後回到「什麼都沒有」", () => {
    const { v } = built({ count: 25 });
    v.resetBoardListAccumulation();
    expect(v.buildBoardListWindowLines()).toBeNull();
  });
});
