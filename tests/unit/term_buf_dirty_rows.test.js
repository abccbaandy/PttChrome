// lineChangeds 是不是真的「這一幀哪幾列變了」。
//
// 背景：TermChar.needUpdate 從 fork 來的第一天起就只設 true、從來不清（sticky），
// 所以 updateCharAttr 每次 notify 都會把「歷史上被寫過的每一列」重新標成 dirty
// ⇒ lineChangeds 恆等於全部列 ⇒ term_view.redraw 裡那行逐列 continue 幾乎永不
// 生效，逐列 patch 也就無從談起。2026-08 把 needUpdate 改成消費完就清。
//
// 這一組測試守兩個方向，缺一不可：
//   1. 不得漏報 —— 內容變了的列一定要在 dirty 集合裡。漏一列的症狀是「畫面某一列
//      永久停在舊內容，重進畫面才好」，而且只在特定 escape 序列下發生 ⇒ 用真
//      cassette 位元組逐步重放、對每一列算內容簽章來守。
//   2. 真的收斂 —— 至少要有「只有少數列變髒」的幀，否則整條優化是 no-op。
//
// 用真 TermBuf + AnsiParser + 真 Big5 表（同 term_buf_settle_snapshot.test.js）。
import fs from "fs";
import path from "path";
import { TermBuf } from "../../src/js/term_buf";
import { TermView } from "../../src/js/term_view";
import { AnsiParser } from "../../src/js/ansi_parser";
import { loadBig5Tables, decodeRecv } from "./helpers/load_big5_tables";

const cassettePath = (name) =>
  path.join(__dirname, "..", "e2e", "cassettes", name);
const load = (name) => JSON.parse(fs.readFileSync(cassettePath(name), "utf8"));

// view stub 的 update() 就是 term_view.redraw 的 dirty 迴圈：把 lineChangeds
// 讀成一份 changedRows 再清成 false。清除點只有 redraw，這裡要一模一樣。
function makeBuf(cols, rows) {
  const frames = [];
  const buf = new TermBuf(cols, rows);
  buf.setView({
    update() {
      const changed = [];
      for (let r = 0; r < buf.rows; ++r) {
        if (buf.lineChangeds[r] === false) continue;
        changed.push(r);
        buf.lineChangeds[r] = false;
      }
      frames.push(changed);
    },
    updateCursorPos() {},
    refreshCursorVisibility() {},
    blinkOn: false,
  });
  buf.useMouseBrowsing = false;
  return { buf, frames };
}

// 一列的「渲染輸入」簽章：渲染鏈與逐列標註讀得到的每一個欄位。任何一項變了卻沒
// 被標 dirty，就是漏報。
function rowSig(line) {
  let s = "";
  for (let i = 0; i < line.length; ++i) {
    const c = line[i];
    s +=
      c.ch +
      "|" +
      c.fg +
      "," +
      c.bg +
      "," +
      (c.bright ? 1 : 0) +
      (c.invert ? 1 : 0) +
      (c.blink ? 1 : 0) +
      (c.underLine ? 1 : 0) +
      (c.isLeadByte ? 1 : 0) +
      (c.startOfURL ? 1 : 0) +
      (c.endOfURL ? 1 : 0) +
      (c.partOfURL ? 1 : 0) +
      "|" +
      c.fullurl +
      ";";
  }
  return s;
}

const allSigs = (buf) => buf.lines.map(rowSig);

const settle = () => vi.advanceTimersByTime(300);

describe("lineChangeds 是 per-frame 的 dirty 集合", () => {
  beforeAll(() => {
    loadBig5Tables();
  });
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("同一畫面再 notify 一次，dirty 集合必須是空的", () => {
    const cassette = load("cchat-list.json");
    const { buf, frames } = makeBuf(cassette.cols, cassette.rows);
    new AnsiParser(buf).feed(decodeRecv(cassette.steps[0].recv));
    settle();
    expect(frames.length).toBeGreaterThan(0);

    // 沒有餵任何新位元組，只是再跑一次 changed 分支。
    buf.changed = true;
    buf.notify();

    expect(frames[frames.length - 1]).toEqual([]);
  });

  test("dirty 旗標不得漏報：內容變了的列一定在 dirty 集合裡", () => {
    const cassette = load("cchat-list-nav.json");
    const { buf, frames } = makeBuf(cassette.cols, cassette.rows);
    const parser = new AnsiParser(buf);

    let before = allSigs(buf);
    let seen = 0;
    for (const step of cassette.steps) {
      if (!step.recv) continue;
      parser.feed(decodeRecv(step.recv));
      settle();

      const dirty = new Set();
      for (; seen < frames.length; ++seen)
        for (const r of frames[seen]) dirty.add(r);

      const after = allSigs(buf);
      const missed = [];
      for (let r = 0; r < after.length; ++r)
        if (after[r] !== before[r] && !dirty.has(r)) missed.push(r);
      expect(missed).toEqual([]);
      before = after;
    }
  });

  test("dirty 真的收斂：至少有一幀只動到不到半個畫面", () => {
    const cassette = load("cchat-list-nav.json");
    const { buf, frames } = makeBuf(cassette.cols, cassette.rows);
    const parser = new AnsiParser(buf);
    for (const step of cassette.steps) {
      if (!step.recv) continue;
      parser.feed(decodeRecv(step.recv));
      settle();
    }
    const partial = frames.filter(
      (f) => f.length > 0 && f.length < buf.rows / 2,
    );
    expect(partial.length).toBeGreaterThan(0);
  });

  test("本地強制重繪（lineChangeds.fill(true)）不會被 updateCharAttr 吃掉", () => {
    // easy_reading._forceRepaint / list_session._forceRedraw 的做法。清除點只有
    // redraw，所以在 updateCharAttr 裡順手清 lineChangeds 會靜默廢掉它們。
    const cassette = load("cchat-list.json");
    const { buf, frames } = makeBuf(cassette.cols, cassette.rows);
    new AnsiParser(buf).feed(decodeRecv(cassette.steps[0].recv));
    settle();

    buf.lineChangeds.fill(true);
    buf.changed = true;
    buf.notify();

    const last = frames[frames.length - 1];
    expect(last.length).toBe(buf.rows);
  });

  test("URL 旗標不因為少掃一輪而消失", () => {
    const cassette = load("test-xmen.json");
    const { buf } = makeBuf(cassette.cols, cassette.rows);
    const parser = new AnsiParser(buf);
    for (const step of cassette.steps) {
      if (step.recv) parser.feed(decodeRecv(step.recv));
      settle();
      if (buf.lines.some((l) => l.some((c) => c.fullurl))) break;
    }
    const withUrl = allSigs(buf);
    expect(buf.lines.some((l) => l.some((c) => c.fullurl))).toBe(true);

    buf.changed = true;
    buf.notify();

    expect(allSigs(buf)).toEqual(withUrl);
  });

  test("resize 之後全列 dirty", () => {
    const { buf, frames } = makeBuf(80, 24);
    buf.changed = true;
    buf.notify();
    frames.length = 0;

    buf.resize(80, 30);
    buf.changed = true;
    buf.notify();

    expect(frames[frames.length - 1].length).toBe(30);
  });
});

describe("零 dirty 幀（去 sticky 之後才可達）", () => {
  // insertLine 的 cur_y >= scrollEnd 分支、clear(param) 的 param 不在 {0,1,2}，
  // 都會設 changed = true 卻不動任何一格。那種幀跳過 render 是對的，但 redraw
  // 尾巴那兩行副作用不可以跟著被跳掉。
  function fakeView(buf) {
    const v = Object.create(TermView.prototype);
    v.buf = buf;
    v.useEasyReadingMode = false;
    v.enablePicPreview = false;
    v.componentScreen = { setCursorHighlight() {} };
    v.applyCursorHighlight = vi.fn();
    v._renderScreenLines = vi.fn();
    v.hideEasyReadingOverlays = vi.fn();
    v.hideEasyReadingOverlaysKeepPage = vi.fn();
    v.mainDisplay = { scrollTop: 0 };
    return v;
  }

  test("零 dirty 幀仍然要更新 prevPageState 並套用游標底色", () => {
    // 漏掉 prevPageState 的症狀：好讀的 decideAccumulateBranch 讀到過期值 ⇒ 從
    // 文章中段重建 pageLines，上面已經讀過的內容整段消失。
    const buf = new TermBuf(80, 24);
    buf.lineChangeds.fill(false);
    buf.pageState = 3;
    buf.prevPageState = 2;
    const v = fakeView(buf);

    v.redraw(false);

    expect(v._renderScreenLines).not.toHaveBeenCalled();
    expect(v.applyCursorHighlight).toHaveBeenCalled();
    expect(buf.prevPageState).toBe(3);
  });

  test("componentScreen 還沒建出來時不會炸", () => {
    const buf = new TermBuf(80, 24);
    buf.lineChangeds.fill(false);
    const v = fakeView(buf);
    v.componentScreen = undefined;
    expect(() => v.redraw(false)).not.toThrow();
  });
});

// 全形字的 lead byte 被半形字蓋掉時，被孤立的 trail cell 也要重畫。
//
// 這一組存在的理由是「證明某段程式碼不需要」：updateCharAttr 從 2014 起帶著一段
//   } else if (ch.isleadbyte && (col+1) < cols) { line[col+1].needUpdate = true; }
// 的 else-if，欄位名大小寫打錯（正確是 isLeadByte，全 repo 僅該處小寫）⇒ 條件恆為
// undefined、分支從未執行過。刪它之前要先釘住：同一個保證其實是 puts() 在寫入當下
// 就給了（`if (ch2.isLeadByte) line[this.cur_x].needUpdate = true`），所以刪掉不會
// 少任何東西。
describe("覆蓋全形字的 lead byte", () => {
  beforeAll(() => {
    loadBig5Tables();
  });
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("puts() 當下就把 trail cell 標成 needUpdate，該列下一幀重畫", () => {
    const { buf, frames } = makeBuf(80, 24);
    buf.gotoPos(0, 0);
    buf.puts("\xa4\xa4"); // Big5「中」
    settle();
    expect(buf.lines[0][0].isLeadByte).toBe(true);
    const framesBefore = frames.length;

    // 只蓋掉 lead byte，trail cell 一個位元組都沒被寫到。
    buf.gotoPos(0, 0);
    buf.puts("A");
    // 同步斷言：不必等 update pass，puts() 自己就標好了。
    expect(buf.lines[0][1].needUpdate).toBe(true);

    settle();
    const dirty = new Set();
    for (let i = framesBefore; i < frames.length; ++i)
      for (const r of frames[i]) dirty.add(r);
    expect(dirty.has(0)).toBe(true);
  });
});
