// 好讀累積：pmore 狀態列沒有行號的頁（override_msg 警告／oldstatusbar）。
//
// pmore.c#mf_display_footer：文章某頁含 `ESC *s` 這類依讀者展開的碼
// （mf_display_handle_esc_star → PMORE_MSG_WARN_FAKEUSERINFO）或移位碼
// （PMORE_MSG_WARN_MOVECMD）時，part2「目前顯示: 第 S~E 行」整段換成警告字串，
// 每次畫到那一頁都一樣。修前 parseStatusRow 失配 ⇒ 這一頁被當成非文章幀 skip，
// 下一頁再被判成掉頁（gap）——那頁的內容永遠接不上。
//
// 用真的 TermView.prototype.accumulatePageLines ＋真的 parseStatusRow／去重函式，
// 以 pmore 的分頁形狀（PageDown：S' == E，末頁被 maxdisps 夾住）逐幀餵。
import { TermView } from "../../src/js/term_view";
import { rowToText } from "../../src/js/comment_parse";

const ROWS = 24;
const CONTENT = ROWS - 1;
const TOTAL = 111;
const LAST_START = TOTAL - CONTENT + 1;
const FAKE_USERINFO = " ▲此頁內容會依閱讀者不同,原文未必有您的資料 ";

const cells = (text) => {
  const row = [];
  for (let i = 0; i < 80; ++i) row.push({ ch: text[i] || " ", isLeadByte: false });
  return row;
};

function statusText(start, end, override) {
  const pct = end >= TOTAL ? 100 : Math.floor((end * 100) / TOTAL);
  const page = Math.floor((start - 1) / (ROWS - 2)) + 1;
  const part1 = `  瀏覽 第 ${page}/5 頁 (${String(pct).padStart(3)}%) `;
  const part2 = override ? FAKE_USERINFO : ` 目前顯示: 第 ${start}~${end} 行`;
  return part1 + part2 + " (h)說明 (←/q)離開 ";
}

function screen(start, override) {
  const s = Math.min(start, LAST_START);
  const e = Math.min(s + CONTENT - 1, TOTAL);
  const texts = [];
  for (let l = s; l < s + CONTENT; ++l) texts.push(l <= TOTAL ? `article line ${l}` : "");
  texts.push(statusText(s, e, override));
  return texts;
}

function makeView() {
  const view = Object.create(TermView.prototype);
  view.buf = {
    rows: ROWS,
    cols: 80,
    cur_y: ROWS - 1,
    cur_x: 79,
    lines: [],
    pageLines: [],
    prevPageState: 0,
    easyReadingPendingReset: false,
    getRowText(r) {
      return rowToText(this.lines[r]);
    },
  };
  view.mainContainer = null;
  view._accEndRow = null;
  view._lastAccumulatedSig = null;
  view._articleInstanceId = 0;
  view._mirrorStatusRowToFooter = () => {};
  return view;
}

function paint(view, start, override) {
  view.buf.lines = screen(start, override).map(cells);
  view.accumulatePageLines();
  view.buf.prevPageState = 3;
}

const texts = (view) => view.buf.pageLines.map((r) => rowToText(r).replace(/\s+$/, ""));
const expected = () => Array.from({ length: TOTAL }, (_, i) => `article line ${i + 1}`);

// 依 PageDown 的起點序列讀完整篇；overridePages＝哪幾頁（0 起算）狀態列是警告。
function readAll(view, overridePages) {
  const starts = [1];
  for (let s = CONTENT; s < LAST_START; s += CONTENT - 1) starts.push(s);
  starts.push(LAST_START);
  starts.forEach((s, i) => paint(view, s, overridePages.includes(i)));
  return starts.length;
}

describe("狀態列沒有行號的頁也要接進累積頁", () => {
  test("中段一頁是警告狀態列：整篇一行不少、一行不重複", () => {
    const view = makeView();
    readAll(view, [2]);
    expect(view.buf.easyReadingGapDetected).toBeFalsy();
    expect(texts(view)).toEqual(expected());
  });

  test("連續兩頁都是警告：仍完整，且簽章逐頁不同", () => {
    const view = makeView();
    const sigs = [];
    const starts = [1];
    for (let s = CONTENT; s < LAST_START; s += CONTENT - 1) starts.push(s);
    starts.push(LAST_START);
    starts.forEach((s, i) => {
      paint(view, s, i === 1 || i === 2);
      sigs.push(view._lastAccumulatedSig);
    });
    expect(texts(view)).toEqual(expected());
    expect(new Set(sigs).size).toBe(sigs.length);
  });

  test("第一頁就是警告（ESC *s 常放在開頭）：照樣從第一行開始累積", () => {
    const view = makeView();
    readAll(view, [0]);
    expect(texts(view)).toEqual(expected());
  });

  test("警告頁之後行號追蹤接回：下一張有行號的頁把 _accEndRow 設回它的 E", () => {
    const view = makeView();
    paint(view, 1, false);
    paint(view, CONTENT, true);
    expect(view._accEndRow).toBeNull();
    paint(view, CONTENT * 2 - 1, false);
    expect(view._accEndRow).toBe(CONTENT * 2 - 1 + CONTENT - 1);
  });
});
