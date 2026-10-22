// @unit-env browser
// 「下一篇」標題卡的位置（src/js/next_article.js、docs/next-article.md「卡片的位置」），真版面＋
// main.css 真樣式：
//   1. 推文很少的文章：PTT 畫面把文章後面剩下的列畫成空白，卡片要往上蓋住這段空白，不用捲就
//      看得到（28 列內容＋10 列空白，卡片排在空白後面要捲）；
//   2. 底部常駐推文列（fixed，疊在 .main 最下面）＋好讀 footer：捲到底時卡片要在它們上面，
//      不能被蓋住（舊版：推文列壓在卡片上）；
//   3. 不蓋字：卡片頂端永遠在最後一列有內容的列下面（有底色的空白列也算內容）。
// 卡片開關固定為開：真瀏覽器的 localStorage 跟同一個 worker 的其他測試共用，讀真 prefs
// 會因執行順序時紅時綠。
vi.mock("../../src/js/pref_storage", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, readEffectivePrefs: () => ({ ...real.readEffectivePrefs(), enableNextArticleCard: true }) };
});
import mainCss from "../../src/css/main.css?raw";
import { NextArticle, NEXT_ARTICLE_ID, trailingBlankPx } from "../../src/js/next_article";
import { trailingPx } from "../../src/js/reading_record";
import { COMMENT_BAR_HEIGHT, commentBarGeometry } from "../../src/js/comment_bar";
import { setupI18n } from "../../src/js/i18n";

const ROWS = 24;
const ROW_PX = 20;
const VIEW_ROWS = 20;

function listRow(num, author, title) {
  return String(num).padStart(7) + "    " + " 9/01 " + author.padEnd(13) + "□ " + title;
}
function listScreen() {
  const t = Array.from({ length: ROWS }, () => "");
  t[0] = "【板主:someone】                  看板《C_Chat》";
  t[3] = listRow(101, "alice", "[閒聊] 第一篇");
  t[4] = listRow(102, "bob", "[問題] 第二篇");
  t[ROWS - 1] = " 文章選讀  (y)回應(X)推文(^X)轉錄 (=[]<>)相關主題(/?a)找標題/作者 (b)進板畫面 ";
  return { t, pageState: 2 };
}
function articleScreen() {
  const t = Array.from({ length: ROWS }, () => "");
  t[ROWS - 1] = "  瀏覽 第 1/1 頁 (100%)  目前顯示: 第 01~20 行  (y)回應(X%)推文(h)說明(←)離開 ";
  return { t, pageState: 3 };
}

// 一列＝好讀實際畫出來的結構（offline e2e 量到的）：bbsrow ＞ div ＞ bbsline ＞ span ＞ 色段
// （q{fg} b{bg}），bbsline 後面跟一個空的 div（預覽的位置）。
function row(i, text, bg = 0) {
  const outer = document.createElement("span");
  outer.setAttribute("type", "bbsrow");
  outer.setAttribute("srow", String(i));
  const wrap = document.createElement("div");
  const line = document.createElement("span");
  line.setAttribute("data-type", "bbsline");
  line.setAttribute("data-row", String(i));
  const inner = document.createElement("span");
  const seg = document.createElement("span");
  seg.className = "q7 b" + bg;
  seg.textContent = text;
  inner.appendChild(seg);
  line.appendChild(inner);
  wrap.append(line, document.createElement("div"));
  outer.appendChild(wrap);
  return outer;
}

let style;
let host;
beforeAll(() => {
  setupI18n();
  style = document.createElement("style");
  style.textContent = mainCss;
  document.head.appendChild(style);
});
afterAll(() => style.remove());
afterEach(() => {
  if (host) host.remove();
  document.documentElement.classList.remove("commentBarShown");
});

// lines：累積頁每一列的文字（"" ＝ 空白列）；bgRows：有底色的列號。
// floatTools：#mainContainer 最後面掛浮動工具（render/screen.js 把它跟列放在一起，main.css
// position: fixed 釘在視窗上，不在文章的流裡）。
function setup(lines, { bar = true, bgRows = [], mobile = false, floatTools = false } = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  const main = document.createElement("div");
  main.className = "main";
  main.style.cssText = `height:${VIEW_ROWS * ROW_PX}px;overflow-y:auto;font-size:${ROW_PX}px;width:800px`;
  const screenRoot = document.createElement("div");
  screenRoot.id = "screenRoot";
  const mc = document.createElement("div");
  mc.id = "mainContainer";
  lines.forEach((text, i) => mc.appendChild(row(i, text || "    ", bgRows.includes(i) ? 4 : 0)));
  if (floatTools) {
    const tools = document.createElement("div");
    tools.className = "floatTools";
    tools.style.cssText = "top:10px;right:10px;width:36px;height:36px";
    mc.appendChild(tools);
  }
  // term_view.accumulatePageLines：給好讀 footer 的 1em。
  mc.style.paddingBottom = "1em";
  screenRoot.appendChild(mc);
  main.appendChild(screenRoot);
  // 好讀 footer：.main 的兄弟、margin-top:-(1em+10px) 疊在格線最後一列（main.css）。
  const footer = document.createElement("div");
  footer.id = "easyReadingLastRow";
  footer.style.cssText = `display:block;font-size:${ROW_PX}px`;
  footer.appendChild(document.createElement("span"));
  host.append(main, footer);

  // 底部推文列（components/CommentBar）：累積頁尾端多留列高（main.css html.commentBarShown）。
  const barListeners = new Set();
  // mobile：footer 收起、底部導覽列（view.keyboardInset）蓋住 .main 最下面 25px（手機的 .main
  // 因列高取整延伸到導覽列後面）。
  if (mobile) footer.style.display = "none";
  const mainRect = main.getBoundingClientRect();
  const keyboardInset = mobile ? Math.round(window.innerHeight - (mainRect.bottom - 25)) : 0;
  // 推文列的位置照產品算（commentBarGeometry）。
  const barBottom = () =>
    commentBarGeometry({
      mainRect: main.getBoundingClientRect(),
      footerHeight: mobile ? 0 : footer.getBoundingClientRect().height,
      innerHeight: window.innerHeight,
      bottomInset: keyboardInset,
    }).bottom;
  const commentBar = {
    state: { visible: bar, bottom: barBottom() },
    onChange(fn) {
      barListeners.add(fn);
      fn(this.state);
      return () => barListeners.delete(fn);
    },
    set(visible) {
      this.state = { visible, bottom: barBottom() };
      document.documentElement.classList.toggle("commentBarShown", visible);
      for (const fn of barListeners) fn(this.state);
    },
  };
  document.documentElement.classList.toggle("commentBarShown", bar);
  document.documentElement.style.setProperty("--comment-bar-h", COMMENT_BAR_HEIGHT + "px");

  let frame = listScreen();
  let settled = null;
  const core = {
    easyReading: { _enabled: true, _functionMode: false, _reverse: null, easyReadingReachedPageEnd: true },
    buf: {
      rows: ROWS,
      cols: 80,
      cur_y: 3,
      pageLines: lines.map(() => []),
      get pageState() {
        return frame.pageState;
      },
      getRowText: (r) => frame.t[r],
      addEventListener: (name, fn) => name === "screenSettled" && (settled = fn),
    },
    view: {
      mainDisplay: main,
      screenRoot,
      mainContainer: mc,
      lastRowDiv: footer,
      keyboardInset,
      chh: ROW_PX,
      _articleBoard: null,
    },
    commentBar,
    commandQueue: { idle: true },
    aidNavigation: { startNum: () => true },
  };
  const next = new NextArticle(core);
  settled();
  frame = articleScreen();
  Object.assign(core.view, { _articleBoard: "C_Chat", _articleAuthor: "alice", _articleTitle: "[閒聊] 第一篇" });
  settled();
  const card = document.getElementById(NEXT_ARTICLE_ID);
  expect(next.state.visible).toBe(true);
  expect(card.hidden).toBe(false);
  return { core, next, main, mc, footer, card, commentBar, keyboardInset };
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
const content = (n) => Array.from({ length: n }, (_, i) => "第 " + (i + 1) + " 列內容");

// .main 可見範圍裡沒被 footer／推文列／底部導覽列蓋住的下緣。
function clearBottom({ main, footer, commentBar, keyboardInset }) {
  if (commentBar.state.visible) return window.innerHeight - commentBar.state.bottom - COMMENT_BAR_HEIGHT;
  const footerH = footer.style.display === "none" ? 0 : footer.getBoundingClientRect().height;
  return Math.min(main.getBoundingClientRect().bottom - footerH, window.innerHeight - keyboardInset);
}

test("推文很少（內容 8 列＋PTT 補的 12 列空白）⇒ 不用捲就看得到整張卡片", async () => {
  const s = setup([...content(8), ...Array(12).fill("")]);
  await nextFrame();
  expect(s.main.scrollTop).toBe(0);
  const r = s.card.getBoundingClientRect();
  expect(r.bottom).toBeLessThanOrEqual(clearBottom(s));
  // 不蓋字：卡片在最後一列內容的下面。
  expect(r.top).toBeGreaterThanOrEqual(s.mc.children[7].getBoundingClientRect().bottom);
  // 卡片整個縮進空白裡 ⇒ 不再多撐出捲動高度，「捲到文末了沒」的扣除量也不為負。
  expect(s.main.scrollHeight).toBe(s.mc.getBoundingClientRect().height);
  expect(trailingPx(s.core.view)).toBe(0);
});

test("長文章捲到底 ⇒ 卡片在推文列與 footer 的上面，不被蓋住", async () => {
  const s = setup(content(40));
  await nextFrame();
  s.main.scrollTop = s.main.scrollHeight;
  const r = s.card.getBoundingClientRect();
  expect(r.bottom).toBeLessThanOrEqual(clearBottom(s));
  expect(r.top).toBeGreaterThanOrEqual(s.mc.children[39].getBoundingClientRect().bottom);
});

test("推文列收起／出現 ⇒ 卡片的下緣跟著讓位", async () => {
  const s = setup(content(40), { bar: false });
  await nextFrame();
  s.commentBar.set(true);
  await nextFrame();
  s.main.scrollTop = s.main.scrollHeight;
  expect(s.card.getBoundingClientRect().bottom).toBeLessThanOrEqual(clearBottom(s));
});

// e2e mobile_bottom_overlay：手機的 .main 延伸到底部導覽列後面幾 px，推文列跟著讓位之後，
// 卡片也要讓到推文列上面（只扣固定的列高會差那幾 px）。
test("手機：.main 延伸到導覽列後面 ⇒ 捲到底卡片仍在推文列與導覽列上面", async () => {
  for (const bar of [true, false]) {
    const s = setup(content(40), { bar, mobile: true });
    await nextFrame();
    s.main.scrollTop = s.main.scrollHeight;
    expect(s.card.getBoundingClientRect().bottom).toBeLessThanOrEqual(clearBottom(s) + 0.5);
    host.remove();
  }
});

test("有底色的空白列算內容：卡片不蓋在它上面", async () => {
  const s = setup([...content(5), "", ...Array(14).fill("")], { bgRows: [5] });
  await nextFrame();
  expect(s.card.getBoundingClientRect().top).toBeGreaterThanOrEqual(s.mc.children[5].getBoundingClientRect().bottom);
});

// 有圖說的文章 #mainContainer 最後面是浮動工具（合併圖說），
// 它釘在視窗上方，被當成「最後一個有內容的節點」⇒ 卡片被往上拉到文章中間。
test("#mainContainer 尾端的浮動工具（position: fixed）不算內容：卡片仍接在最後一列內容下面", async () => {
  const s = setup([...content(8), ...Array(12).fill("")], { floatTools: true });
  await nextFrame();
  expect(s.card.getBoundingClientRect().top).toBeGreaterThanOrEqual(s.mc.children[7].getBoundingClientRect().bottom);
  expect(s.card.getBoundingClientRect().bottom).toBeLessThanOrEqual(clearBottom(s));
  host.remove();
  const l = setup(content(40), { floatTools: true });
  await nextFrame();
  l.main.scrollTop = l.main.scrollHeight;
  expect(l.card.getBoundingClientRect().top).toBeGreaterThanOrEqual(l.mc.children[39].getBoundingClientRect().bottom);
});

test("trailingBlankPx：從最後一列有內容的列量到 #mainContainer 下緣（含 paddingBottom）", () => {
  const s = setup([...content(3), "", ""], { bar: false });
  // 2 列空白＋1em paddingBottom。
  expect(trailingBlankPx(s.mc)).toBeCloseTo(3 * ROW_PX, 0);
  expect(trailingBlankPx(null)).toBe(0);
});
