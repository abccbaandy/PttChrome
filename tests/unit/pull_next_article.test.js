// @unit-env browser
// 手機「讀到文末再往上拉 ⇒ 開下一篇」（src/js/pull_next_article.js、docs/next-article.md）：
// 只在下一篇卡片顯示中＋捲動容器已在底部時起手；拉過門檻才算、放手才開；拉的途中卡片的字
// 跟著變（next_article.setPull）。觸控事件在這裡手捏（測分支），真觸控見 real-input 那支。
// real-input: tests/e2e/offline/mobile_next_article.offline.spec.js
import { installPullNextArticle, atScrollBottom } from "../../src/js/pull_next_article";
import { NextArticle, NEXT_ARTICLE_ID } from "../../src/js/next_article";
import { PULL_THRESHOLD_PX, PULL_RESISTANCE } from "../../src/js/pull_refresh";
import { setupI18n, i18n } from "../../src/js/i18n";

const ROWS = 24;
const listRow = (num, author, title) =>
  String(num).padStart(7) + "    " + " 9/01 " + author.padEnd(13) + "□ " + title;

let host;
beforeAll(() => setupI18n());
afterEach(() => host && host.remove());

// mcHeight：內容高（.main 高 200px）。短於視窗 ⇒ 一開始就在底部。
function setup({ mcHeight = 100, mobile = true } = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  const main = document.createElement("div");
  main.className = "main";
  main.style.cssText = "height:200px;overflow-y:auto;font-size:20px";
  const screenRoot = document.createElement("div");
  const mc = document.createElement("div");
  mc.style.height = mcHeight + "px";
  screenRoot.appendChild(mc);
  main.append(screenRoot);
  host.appendChild(main);

  const list = Array.from({ length: ROWS }, () => "");
  list[0] = "【板主:someone】                  看板《C_Chat》";
  list[3] = listRow(101, "alice", "[閒聊] 第一篇");
  list[4] = listRow(102, "bob", "[問題] 第二篇");
  list[ROWS - 1] = " 文章選讀  (y)回應(X)推文(^X)轉錄 (=[]<>)相關主題(/?a)找標題/作者 (b)進板畫面 ";
  const article = Array.from({ length: ROWS }, () => "");
  article[ROWS - 1] = "  瀏覽 第 3/3 頁 (100%)  目前顯示: 第 45~66 行  (y)回應(X%)推文(h)說明(←)離開 ";
  let frame = { t: list, pageState: 2 };
  let settled = null;
  const starts = [];
  const core = {
    mobile,
    mobileSelectMode: false,
    modalShown: false,
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
  core.nextArticle = new NextArticle(core);
  settled();
  frame = { t: article, pageState: 3 };
  core.buf.pageLines = [[]];
  Object.assign(core.view, { _articleBoard: "C_Chat", _articleAuthor: "alice", _articleTitle: "[閒聊] 第一篇" });
  settled();

  const handlers = {};
  const doc = { addEventListener: (type, fn) => (handlers[type] = fn), removeEventListener() {} };
  installPullNextArticle(core, doc);
  const card = document.getElementById(NEXT_ARTICLE_ID);
  const fire = (type, y, target = mc) =>
    handlers[type]({ target, touches: y == null ? [] : [{ clientX: 50, clientY: y }] });
  // 手指從 y0 往上走 dist px（分幾步，同真的 touchmove）。
  const drag = (dist, { release = true, y0 = 180, target = mc } = {}) => {
    fire("touchstart", y0, target);
    for (let i = 1; i <= 4; ++i) fire("touchmove", y0 - (dist * i) / 4, target);
    if (release) fire("touchend", null, target);
  };
  return { core, main, mc, card, starts, fire, drag };
}

const ARM = PULL_THRESHOLD_PX / PULL_RESISTANCE;

test("在底部往上拉過門檻、放手 ⇒ 開下一篇；途中卡片顯示「放開開啟」", () => {
  const { card, starts, drag, fire } = setup();
  expect(card.hidden).toBe(false);
  drag(ARM + 10, { release: false });
  expect(card.getAttribute("data-pull")).toBe("armed");
  expect(card.querySelector(".nextArticleLabel").textContent).toBe(i18n("next_article_release"));
  expect(starts).toEqual([]);
  fire("touchend", null);
  expect(starts).toEqual([expect.objectContaining({ board: "C_Chat", num: 102 })]);
  expect(card.hasAttribute("data-pull")).toBe(false);
});

test("沒拉過門檻就放手 ⇒ 不開，卡片的字回原樣", () => {
  const { card, starts, drag, fire } = setup();
  drag(ARM - 20, { release: false });
  expect(card.getAttribute("data-pull")).toBe("pull");
  expect(card.querySelector(".nextArticleLabel").textContent).toBe(i18n("next_article_pull"));
  fire("touchend", null);
  expect(starts).toEqual([]);
  expect(card.hasAttribute("data-pull")).toBe(false);
  expect(card.querySelector(".nextArticleLabel").textContent).toBe(i18n("next_article_label"));
});

test("拉過門檻又拉回去 ⇒ 不開", () => {
  const { starts, fire } = setup();
  fire("touchstart", 300);
  fire("touchmove", 300 - ARM - 10);
  fire("touchmove", 310);
  fire("touchend", null);
  expect(starts).toEqual([]);
});

test("還沒捲到底 ⇒ 不起手（往上拉只是捲動）", () => {
  const { main, starts, drag, card } = setup({ mcHeight: 2000 });
  main.scrollTop = 0;
  expect(atScrollBottom(main)).toBe(false);
  drag(ARM + 10);
  expect(starts).toEqual([]);
  expect(card.hasAttribute("data-pull")).toBe(false);
});

test("捲到底了才算（內容比視窗長）", () => {
  const { main, starts, drag } = setup({ mcHeight: 2000 });
  main.scrollTop = main.scrollHeight;
  expect(atScrollBottom(main)).toBe(true);
  drag(ARM + 10);
  expect(starts.length).toBe(1);
});

test("桌機（不是手機版面）⇒ 不起手", () => {
  const { starts, drag } = setup({ mobile: false });
  drag(ARM + 10);
  expect(starts).toEqual([]);
});

test("往下拉、或從卡片本身起手 ⇒ 不算（卡片走 click）", () => {
  const { starts, drag, card } = setup();
  drag(-(ARM + 10));
  drag(ARM + 10, { target: card });
  expect(starts).toEqual([]);
});

test("卡片沒顯示（不在文末）⇒ 不起手", () => {
  const { core, starts, drag } = setup();
  core.easyReading.easyReadingReachedPageEnd = false;
  core.nextArticle._onSettled();
  drag(ARM + 10);
  expect(starts).toEqual([]);
});
