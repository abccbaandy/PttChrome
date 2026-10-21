// @unit-env browser
// 桌機「讀到文末、停一下、再往下捲 ⇒ 開下一篇」（src/js/pull_next_article.js#installWheelNextArticle、
// docs/next-article.md）：只在下一篇卡片顯示中＋游標底下的 .main 捲到底時累積；捲到底那一串不算、
// 要停一下；累積途中卡片字樣與進度條跟著變。wheel 事件在這裡手捏（測分支，時間戳要可控），
// 真滾輪見 real-input 那支。
// real-input: tests/e2e/offline/next_article.offline.spec.js
import { installWheelNextArticle, WHEEL_GESTURE_GAP_MS, WHEEL_IDLE_RESET_MS, WHEEL_THRESHOLD_PX } from "../../src/js/pull_next_article";
import { NextArticle, NEXT_ARTICLE_ID, NEXT_ARTICLE_VEIL_ID } from "../../src/js/next_article";
import { setupI18n, i18n } from "../../src/js/i18n";

const ROWS = 24;
const listRow = (num, author, title) =>
  String(num).padStart(7) + "    " + " 9/01 " + author.padEnd(13) + "□ " + title;

let host;
let uninstall;
beforeAll(() => setupI18n());
afterEach(() => {
  if (uninstall) uninstall();
  uninstall = null;
  if (host) host.remove();
  for (const el of document.querySelectorAll("#" + NEXT_ARTICLE_VEIL_ID)) el.remove();
  vi.useRealTimers();
});

function setup({ mcHeight = 100, author = "alice", title = "[閒聊] 第一篇" } = {}) {
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
  const outside = document.createElement("div");
  host.append(main, outside);

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
      active: false,
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
  Object.assign(core.view, { _articleBoard: "C_Chat", _articleAuthor: author, _articleTitle: title });
  settled();

  const handlers = {};
  const target = { addEventListener: (type, fn) => (handlers[type] = fn), removeEventListener() {} };
  uninstall = installWheelNextArticle(core, target);
  const card = document.getElementById(NEXT_ARTICLE_ID);
  let now = 10000;
  // 一格 wheel：dt＝距上一格的 ms。
  const wheel = (dy, { dt = 60, on = mc, dx = 0 } = {}) => {
    now += dt;
    handlers.wheel({ target: on, deltaY: dy, deltaX: dx, deltaMode: 0, timeStamp: now, ctrlKey: false });
  };
  const scroll = (el) => handlers.scroll({ target: el });
  return { core, main, mc, outside, card, starts, wheel, scroll };
}

const NOTCHES = Math.ceil(WHEEL_THRESHOLD_PX / 100);

test("停在文末、新的一串往下捲過門檻 ⇒ 開下一篇；途中卡片寫「繼續往下捲」＋進度條", () => {
  const { card, starts, wheel } = setup();
  wheel(100, { dt: 1000 });
  expect(card.getAttribute("data-pull")).toBe("wheel");
  expect(card.querySelector(".nextArticleLabel").textContent).toBe(i18n("next_article_wheel"));
  expect(Number(card.style.getPropertyValue("--next-pull"))).toBeCloseTo(100 / WHEEL_THRESHOLD_PX, 2);
  for (let i = 1; i < NOTCHES; i++) wheel(100);
  expect(starts).toEqual([expect.objectContaining({ board: "C_Chat", num: 102 })]);
  expect(card.hasAttribute("data-pull")).toBe(false);
  expect(card.hasAttribute("data-pending")).toBe(true);
});

test("一路捲到底的那一串（含慣性）不開；停一下再捲才開", () => {
  const { main, card, starts, wheel, scroll } = setup({ mcHeight: 2000 });
  main.scrollTop = 0;
  scroll(main);
  wheel(100, { dt: 1000 });
  main.scrollTop = main.scrollHeight; // 捲到底了
  scroll(main);
  for (let i = 0; i < 40; i++) wheel(40, { dt: 16 }); // 慣性尾巴
  expect(starts).toEqual([]);
  expect(card.hasAttribute("data-pull")).toBe(false);
  for (let i = 0; i < NOTCHES; i++) wheel(100, { dt: i === 0 ? WHEEL_GESTURE_GAP_MS : 60 });
  expect(starts).toHaveLength(1);
});

test("這一下之前捲動位置已經變了（合成器先捲到底）⇒ 不算起手在底部", () => {
  const { main, starts, wheel, scroll } = setup({ mcHeight: 2000 });
  main.scrollTop = 500;
  scroll(main);
  main.scrollTop = main.scrollHeight; // 沒有 scroll 事件就到底了（合成器先捲）
  for (let i = 0; i < NOTCHES + 2; i++) wheel(100, { dt: i === 0 ? 1000 : 60 });
  expect(starts).toEqual([]);
});

test("停住不捲 ⇒ 卡片字樣還原", () => {
  vi.useFakeTimers();
  const { card, wheel } = setup();
  wheel(100, { dt: 1000 });
  expect(card.getAttribute("data-pull")).toBe("wheel");
  vi.advanceTimersByTime(WHEEL_IDLE_RESET_MS + 10);
  expect(card.hasAttribute("data-pull")).toBe(false);
  expect(card.querySelector(".nextArticleLabel").textContent).toBe(i18n("next_article_label"));
});

test("往上捲 ⇒ 取消", () => {
  const { card, starts, wheel } = setup();
  wheel(100, { dt: 1000 });
  wheel(100);
  wheel(-50);
  expect(card.hasAttribute("data-pull")).toBe(false);
  for (let i = 0; i < NOTCHES - 1; i++) wheel(100);
  expect(starts).toEqual([]);
});

test("不在 .main 上、水平、有對話框、AID 跳文中 ⇒ 不累積", () => {
  const { core, outside, starts, wheel } = setup();
  for (let i = 0; i < NOTCHES + 1; i++) wheel(100, { dt: i === 0 ? 1000 : 60, on: outside });
  for (let i = 0; i < NOTCHES + 1; i++) wheel(10, { dt: i === 0 ? 1000 : 60, dx: 200 });
  core.modalShown = true;
  for (let i = 0; i < NOTCHES + 1; i++) wheel(100, { dt: i === 0 ? 1000 : 60 });
  core.modalShown = false;
  core.aidNavigation.active = true;
  for (let i = 0; i < NOTCHES + 1; i++) wheel(100, { dt: i === 0 ? 1000 : 60 });
  expect(starts).toEqual([]);
});

test("終點卡（沒有下一篇）⇒ 不接", () => {
  const { card, starts, wheel } = setup({ author: "bob", title: "[問題] 第二篇" });
  expect(card.getAttribute("data-end")).toBe("last");
  for (let i = 0; i < NOTCHES + 1; i++) wheel(100, { dt: i === 0 ? 1000 : 60 });
  expect(card.hasAttribute("data-pull")).toBe(false);
  expect(starts).toEqual([]);
});
