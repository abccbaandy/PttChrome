// @unit-env browser
// 下一篇卡片的故障停用（src/js/next_article.js、docs/feature-isolation.md；架構 review A6）。
// 症狀：卡片的 settle 監聽者出錯時沒登記停用 ⇒ 每一幀照樣再試、再丟；換文途中出錯，遮罩
// 一直蓋著原生畫面等「好讀接手」，而接手的判斷就住在出錯的那條監聽者裡 ⇒ 永遠蓋著（要等
// VEIL_RELEASE_MAX_MS 逾時）。這裡鎖：
//   1. 出錯 ⇒ 卡片、遮罩收起；點擊／往下拉這些入口叫不回來、不送換文。
//   2. 換文途中出錯 ⇒ 遮罩馬上拿掉；aid_navigation 之後叫 done 時閱讀紀錄照常收尾、遮罩不再蓋回去。
//   3. 新連線（enableAllListeners）恢復。
// real-input: tests/e2e/offline/next_article.offline.spec.js
import { Event, setListenerErrorPolicy } from "../../src/js/event";
import { NextArticle, NEXT_ARTICLE_ID, NEXT_ARTICLE_VEIL_ID } from "../../src/js/next_article";
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

function Bus() {}
Event.mixin(Bus.prototype, { isolate: true });

let host;
let prev;
beforeAll(() => setupI18n());
afterEach(() => {
  if (prev) setListenerErrorPolicy(prev);
  prev = null;
  if (host) host.remove();
  for (const el of document.querySelectorAll("#" + NEXT_ARTICLE_VEIL_ID)) el.remove();
});

function setup() {
  prev = setListenerErrorPolicy({ strict: false, onError: () => {} });
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
  main.append(screenRoot);
  host.appendChild(main);

  const ctl = { frame: listScreen(), boom: false };
  const bus = new Bus();
  Object.assign(bus, {
    rows: ROWS,
    cols: 80,
    cur_y: 3,
    pageLines: [],
    getRowText: (r) => {
      if (ctl.boom) throw new Error("boom");
      return ctl.frame.t[r];
    },
    isLiveScreenNow: () => false,
  });
  Object.defineProperty(bus, "pageState", { get: () => ctl.frame.pageState });
  const starts = [];
  const ends = [];
  const core = {
    easyReading: { _enabled: true, _functionMode: false, _reverse: null, easyReadingReachedPageEnd: true },
    buf: bus,
    view: { mainDisplay: main, screenRoot, chh: 20, _articleBoard: null, currentLineIndex: () => 40 },
    commandQueue: { idle: true },
    readingRecord: { begin: (f) => ({ f }), end: (bm, outcome) => ends.push(outcome) },
    aidNavigation: {
      startNum(board, num, onEnd) {
        starts.push({ board, num, onEnd });
        return true;
      },
    },
  };
  const next = new NextArticle(core);
  const settle = () => bus.dispatchEvent({ type: "screenSettled" });
  settle();
  ctl.frame = articleScreen();
  bus.pageLines = [[]];
  Object.assign(core.view, { _articleBoard: "C_Chat", _articleAuthor: "alice", _articleTitle: "[閒聊] 第一篇" });
  settle();
  return { core, next, bus, ctl, settle, starts, ends };
}

const card = () => document.getElementById(NEXT_ARTICLE_ID);
const veil = () => document.getElementById(NEXT_ARTICLE_VEIL_ID);

test("出錯 ⇒ 卡片收起；點卡片、往下拉都叫不回來、不送換文；新連線恢復", () => {
  const { next, bus, ctl, settle, starts } = setup();
  expect(next.state.visible).toBe(true);
  ctl.boom = true;
  settle();
  ctl.boom = false;
  expect(next.state.visible).toBe(false);
  expect(card().hidden).toBe(true);
  settle(); // 停用後不再接 settle
  expect(next.state.visible).toBe(false);
  next.setPull("armed", 1);
  expect(next.state.pull).toBe(null);
  expect(next.open()).toBe(false);
  card().dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(starts).toEqual([]);
  bus.enableAllListeners();
  settle();
  expect(next.state.visible).toBe(true);
});

test("換文途中出錯 ⇒ 遮罩馬上拿掉；之後 done 照常收閱讀紀錄、遮罩不再蓋回去", async () => {
  const { core, next, ctl, settle, starts, ends } = setup();
  card().dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(starts).toHaveLength(1);
  expect(veil().hidden).toBe(false);
  core.easyReading._functionMode = true; // aid_navigation 途中：好讀鏡像原生
  ctl.boom = true;
  settle();
  ctl.boom = false;
  expect(veil().hidden).toBe(true);
  expect(next.state.visible).toBe(false);
  expect(next.state.pending).toBe(false);
  starts[0].onEnd({ ok: true });
  expect(ends).toEqual(["done"]);
  await new Promise((r) => requestAnimationFrame(() => r()));
  expect(veil().hidden).toBe(true);
  expect(next._veilWait).toBe(null);
});
