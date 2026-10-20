// @unit-env browser
// 讀完接著讀下一篇的標題卡 DOM（src/js/next_article.js）：住在 .main 裡 #screenRoot 後面（不寫
// #mainContainer）、點擊不外洩到 App 在 window 的滑鼠入口、「捲到文末了沒」扣掉卡片的高度
// （reading_record.trailingPx）。
// real-input: tests/e2e/offline/next_article.offline.spec.js
import { NextArticle, NEXT_ARTICLE_ID, isNextArticleTarget } from "../../src/js/next_article";
import { ReadingRecord, trailingPx } from "../../src/js/reading_record";
import { setupI18n } from "../../src/js/i18n";

const ROWS = 24;
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
  t[ROWS - 1] = "  瀏覽 第 3/3 頁 (100%)  目前顯示: 第 45~66 行  (y)回應(X%)推文(h)說明(←)離開 ";
  return { t, pageState: 3 };
}

let host;
beforeAll(() => setupI18n());
afterEach(() => host && host.remove());

function setup() {
  host = document.createElement("div");
  document.body.appendChild(host);
  const main = document.createElement("div");
  main.className = "main";
  main.style.cssText = "height:200px;overflow-y:auto;font-size:20px";
  const screenRoot = document.createElement("div");
  screenRoot.id = "screenRoot";
  const mc = document.createElement("div");
  mc.id = "mainContainer";
  mc.style.height = "1000px";
  screenRoot.appendChild(mc);
  const cursor = document.createElement("div");
  cursor.id = "cursor";
  main.append(screenRoot, cursor);
  host.appendChild(main);

  let frame = listScreen();
  let settled = null;
  const starts = [];
  const core = {
    easyReading: { _enabled: true, _functionMode: false, _reverse: null, easyReadingReachedPageEnd: true },
    buf: {
      rows: ROWS,
      cols: 80,
      cur_y: 3,
      pageLines: [],
      get pageState() {
        return frame.pageState;
      },
      getRowText: (r) => frame.t[r],
      addEventListener: (name, fn) => name === "screenSettled" && (settled = fn),
    },
    view: { mainDisplay: main, screenRoot, chh: 20, _articleBoard: null, currentLineIndex: () => 40 },
    commandQueue: { idle: true },
    aidNavigation: {
      startNum(board, num, onEnd) {
        starts.push({ board, num, onEnd });
        return true;
      },
    },
  };
  const next = new NextArticle(core);
  settled();
  frame = articleScreen();
  core.buf.pageLines = [[]];
  Object.assign(core.view, { _articleBoard: "C_Chat", _articleAuthor: "alice", _articleTitle: "[閒聊] 第一篇" });
  settled();
  return { core, next, main, screenRoot, mc, starts };
}

test("卡片放在 .main 裡 #screenRoot 後面，不進 #mainContainer；內容取自快照", () => {
  const { next, main, screenRoot, mc } = setup();
  expect(next.state.visible).toBe(true);
  const el = document.getElementById(NEXT_ARTICLE_ID);
  expect(el.parentNode).toBe(main);
  expect(screenRoot.nextSibling).toBe(el);
  expect(mc.contains(el)).toBe(false);
  expect(el.hidden).toBe(false);
  expect(el.textContent).toContain("[問題] 第二篇");
  expect(el.textContent).toContain("bob");
  expect(isNextArticleTarget(el.lastChild)).toBe(true);
});

test("點卡片：送 startNum、滑鼠事件不外洩到 window、不搶焦點", () => {
  const { starts } = setup();
  const el = document.getElementById(NEXT_ARTICLE_ID);
  const seen = [];
  const spy = (e) => seen.push(e.type);
  for (const t of ["mousedown", "mouseup", "click"]) window.addEventListener(t, spy);
  try {
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    el.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  } finally {
    for (const t of ["mousedown", "mouseup", "click"]) window.removeEventListener(t, spy);
  }
  expect(seen).toEqual([]);
  expect(starts).toEqual([expect.objectContaining({ board: "C_Chat", num: 102 })]);
  expect(el.hasAttribute("data-pending")).toBe(true);
});

test("離開文章 ⇒ 卡片藏起來", () => {
  const { core, next } = setup();
  core.easyReading.easyReadingReachedPageEnd = false;
  next._onSettled();
  expect(document.getElementById(NEXT_ARTICLE_ID).hidden).toBe(true);
});

test("捲到最後一則推文（卡片還在視窗下面）也算在文末", () => {
  const { core, main } = setup();
  const el = document.getElementById(NEXT_ARTICLE_ID);
  el.style.margin = "30px 0 40px";
  el.style.height = "60px";
  expect(trailingPx(core.view)).toBe(130);
  // 內容 1000px、視窗 200px ⇒ 最後一則推文在 800 就捲到了，卡片在下面。
  main.scrollTop = 800;
  expect(new ReadingRecord(core).current().article.atBottom).toBe(true);
  main.scrollTop = 600;
  expect(new ReadingRecord(core).current().article.atBottom).toBe(false);
  el.hidden = true;
  expect(trailingPx(core.view)).toBe(0);
});
