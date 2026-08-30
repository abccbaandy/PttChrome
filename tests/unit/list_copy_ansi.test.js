// 「複製為 ANSI」取到的必須是**畫面上那一份 lines**，不是 server 的真實 24 列。
//
// 壞掉的行為（改成原生捲動前就已存在）：`App.doCopyAnsi` 只在文章好讀
// （pageState 3）才把 `buf.pageLines` 傳給 `buf.getText`，其餘一律讓 getText 讀
// `buf.lines`。但列表好讀模式畫的是**自己組的虛擬視窗**（term_view 的
// `_listWindowLines`），兩者列數與內容都不對應：
//   - 內容錯：選 row 3 複製到的是 server 真實畫面的第 3 列，不是畫面上那一列。
//   - 直接爆：平滑捲動的 overscan 列 data-row 就是 24，`buf.lines[24]` 是
//     undefined ⇒ `term_buf.js` 的 `text[colEnd-1].isLeadByte` TypeError。
//     全序列渲染後 body 的 data-row 會到 3+N（最大 ~303），必炸。
//
// 修法＝`term_view._renderScreenLines`（七條 render 分支唯一的 choke point）記下
// 這一幀實際交給 <Screen> 的 lines，doCopyAnsi 一律用它。`data-row` 的定義本來
// 就是「傳給 Screen 的 lines index」，所以這是唯一與選取座標對齊的來源。
import { App } from "../../src/js/pttchrome";
import { TermBuf } from "../../src/js/term_buf";
import { AnsiParser } from "../../src/js/ansi_parser";
import { loadBig5Tables } from "./helpers/load_big5_tables";

loadBig5Tables();

const feed = (buf, s) => new AnsiParser(buf).feed(s);

// row/col 都是 0-based；ANSI 的 CUP 是 1-based。
const at = (row, col, text) =>
  "\x1b[" + (row + 1) + ";" + (col + 1) + "H" + text;

function makeBuf() {
  const buf = new TermBuf(80, 24);
  buf.setView({
    charset: "UTF-8",
    update() {},
    updateCursorPos() {},
    refreshCursorVisibility() {},
    blinkOn: false,
  });
  buf.useMouseBrowsing = false;
  feed(buf, at(0, 0, "SERVER-ROW0"));
  feed(buf, at(3, 0, "SERVER-ROW3"));
  feed(buf, at(7, 0, "VIRTUAL-A"));
  feed(buf, at(8, 0, "VIRTUAL-B"));
  return buf;
}

// 列表好讀畫的那一份：前 24 列是視窗切片（這裡把 row3 換成別的內容以便分辨），
// 再多一列（index 24）＝ server 的 buf.lines 根本沒有的位置。
function renderedLines(buf) {
  const out = buf.lines.slice();
  out[3] = buf.lines[7];
  out.push(buf.lines[8]);
  return out;
}

function makeApp(buf, lines) {
  const app = Object.create(App.prototype);
  app.buf = buf;
  app.view = { useEasyReadingMode: false, _renderedLines: lines };
  app.doCopy = vi.fn();
  return app;
}

const copied = (app) => app.doCopy.mock.calls[0][0];

describe("doCopyAnsi 取用的 lines", () => {
  test("data-row 超出 server 的 24 列（overscan／全序列 body）不得 throw", () => {
    const buf = makeBuf();
    const app = makeApp(buf, renderedLines(buf));
    app.lastSelection = { start: { row: 24, col: 0 }, end: { row: 24, col: 9 } };

    expect(() => app.doCopyAnsi()).not.toThrow();
    expect(copied(app)).toContain("VIRTUAL-B");
  });

  test("row 落在 24 列內時，取的也是畫面那一份而不是 server 真實畫面", () => {
    const buf = makeBuf();
    const app = makeApp(buf, renderedLines(buf));
    app.lastSelection = { start: { row: 3, col: 0 }, end: { row: 3, col: 9 } };

    app.doCopyAnsi();
    expect(copied(app)).toContain("VIRTUAL-A");
    expect(copied(app)).not.toContain("SERVER-ROW3");
  });

  test("跨列選取也走同一份 lines", () => {
    const buf = makeBuf();
    const app = makeApp(buf, renderedLines(buf));
    app.lastSelection = { start: { row: 3, col: 0 }, end: { row: 24, col: 9 } };

    expect(() => app.doCopyAnsi()).not.toThrow();
    const text = copied(app);
    expect(text).toContain("VIRTUAL-A");
    expect(text).toContain("VIRTUAL-B");
  });

  test("還沒 render 過（_renderedLines 未設）→ 退回 buf.lines，不回歸原生模式", () => {
    const buf = makeBuf();
    const app = makeApp(buf, null);
    app.lastSelection = { start: { row: 0, col: 0 }, end: { row: 0, col: 11 } };

    app.doCopyAnsi();
    expect(copied(app)).toContain("SERVER-ROW0");
  });
});
