// @unit-env browser
// 讀完接著讀下一篇的標題卡 DOM（src/js/next_article.js）：住在 .main 裡 #screenRoot 後面（不寫
// #mainContainer）、點擊不外洩到 App 在 window 的滑鼠入口、「捲到文末了沒」扣掉卡片的高度
// （reading_record.trailingPx）。
// real-input: tests/e2e/offline/next_article.offline.spec.js
import {
  NextArticle,
  NEXT_ARTICLE_ID,
  NEXT_ARTICLE_VEIL_ID,
  NEXT_THREAD_ROW_ID,
  isNextArticleTarget,
} from "../../src/js/next_article";
import { ReadingRecord, trailingPx } from "../../src/js/reading_record";
import { setupI18n, i18n } from "../../src/js/i18n";

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
afterEach(() => {
  if (host) host.remove();
  // 遮罩掛在 body（不在 host 裡），每個 NextArticle 一份。
  for (const el of document.querySelectorAll("#" + NEXT_ARTICLE_VEIL_ID)) el.remove();
});

const READ_ALICE = { _articleBoard: "C_Chat", _articleAuthor: "alice", _articleTitle: "[閒聊] 第一篇" };

function setup(read = READ_ALICE, list = listScreen()) {
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

  let frame = list;
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
  Object.assign(core.view, read);
  settled();
  return { core, next, main, screenRoot, mc, starts, settled };
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// ── 沒有下一篇：終點卡 ─────────────────────────────────────────────────────
test("最後一篇 ⇒ 卡片寫「已無下一篇」、標成不能點；點了不送鍵", () => {
  const { starts } = setup({ _articleBoard: "C_Chat", _articleAuthor: "bob", _articleTitle: "[問題] 第二篇" });
  const el = document.getElementById(NEXT_ARTICLE_ID);
  expect(el.hidden).toBe(false);
  expect(el.getAttribute("data-end")).toBe("last");
  expect(el.getAttribute("aria-disabled")).toBe("true");
  expect(el.querySelector(".nextArticleTitle").textContent).toBe(i18n("next_article_last"));
  el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(starts).toEqual([]);
  expect(document.getElementById(NEXT_ARTICLE_VEIL_ID)).toBeNull();
});

test("終點卡之後讀到有下一篇的文章 ⇒ 卡片換回一般樣子", () => {
  const { core, next } = setup({ _articleBoard: "C_Chat", _articleAuthor: "bob", _articleTitle: "[問題] 第二篇" });
  Object.assign(core.view, READ_ALICE);
  next._onSettled();
  const el = document.getElementById(NEXT_ARTICLE_ID);
  expect(el.hasAttribute("data-end")).toBe(false);
  expect(el.hasAttribute("aria-disabled")).toBe(false);
  expect(el.textContent).toContain("[問題] 第二篇");
});

// ── 換文遮罩：換文途中不閃原生畫面 ─────────────────────────────────────────
// 使用者回報：開下一篇的過程會短暫切回原生（aid_navigation 讓好讀進 functionMode 鏡像原生）。
test("點卡片 ⇒ 在 start 之前就蓋上遮罩：對齊 .main、不在 #mainContainer／.main 裡、寫著下一篇", () => {
  const { core, main, mc } = setup();
  let veilAtStart = null;
  core.aidNavigation.startNum = () => {
    const v = document.getElementById(NEXT_ARTICLE_VEIL_ID);
    veilAtStart = !!v && !v.hidden;
    return true;
  };
  document.getElementById(NEXT_ARTICLE_ID).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(veilAtStart).toBe(true);
  const veil = document.getElementById(NEXT_ARTICLE_VEIL_ID);
  expect(veil.parentNode).toBe(document.body);
  expect(main.contains(veil)).toBe(false);
  expect(mc.contains(veil)).toBe(false);
  const r = main.getBoundingClientRect();
  expect(parseFloat(veil.style.top)).toBeCloseTo(r.top);
  expect(parseFloat(veil.style.left)).toBeCloseTo(r.left);
  expect(parseFloat(veil.style.width)).toBeCloseTo(r.width);
  expect(parseFloat(veil.style.height)).toBeCloseTo(r.height);
  expect(veil.textContent).toContain("[問題] 第二篇");
  expect(isNextArticleTarget(veil.firstChild)).toBe(true);
});

test("換文失敗 ⇒ 遮罩馬上拿掉（看得到 PTT 給的原生畫面）", () => {
  const { starts } = setup();
  document.getElementById(NEXT_ARTICLE_ID).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const veil = document.getElementById(NEXT_ARTICLE_VEIL_ID);
  expect(veil.hidden).toBe(false);
  starts[0].onEnd({ ok: false });
  expect(veil.hidden).toBe(true);
});

test("start 沒接（線路忙等）⇒ 遮罩不留", () => {
  const { core } = setup();
  core.aidNavigation.startNum = () => false;
  document.getElementById(NEXT_ARTICLE_ID).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(document.getElementById(NEXT_ARTICLE_VEIL_ID).hidden).toBe(true);
});

test("換文成功 ⇒ 等好讀接手新文章才淡出（還在鏡像原生就繼續蓋著）", async () => {
  const { core, starts, settled } = setup();
  document.getElementById(NEXT_ARTICLE_ID).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const veil = document.getElementById(NEXT_ARTICLE_VEIL_ID);
  core.easyReading._functionMode = true; // 落地那一刻好讀還沒接手
  starts[0].onEnd({ ok: true });
  await nextFrame();
  await nextFrame();
  expect(veil.hidden).toBe(false);
  expect(veil.hasAttribute("data-leaving")).toBe(false);
  core.easyReading._functionMode = false; // 下一次 settle：好讀畫好新文章
  core.easyReading.easyReadingReachedPageEnd = false;
  settled();
  await nextFrame();
  await nextFrame();
  expect(veil.hasAttribute("data-leaving")).toBe(true);
  await sleep(400);
  expect(veil.hidden).toBe(true);
});

test("遮罩上的滑鼠事件不外洩到 window、不搶焦點", () => {
  setup();
  document.getElementById(NEXT_ARTICLE_ID).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const veil = document.getElementById(NEXT_ARTICLE_VEIL_ID);
  const seen = [];
  const spy = (e) => seen.push(e.type);
  for (const t of ["mousedown", "mouseup", "click"]) window.addEventListener(t, spy);
  try {
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    veil.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    veil.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    veil.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  } finally {
    for (const t of ["mousedown", "mouseup", "click"]) window.removeEventListener(t, spy);
  }
  expect(seen).toEqual([]);
});

// ── 同主題上一篇／下一篇（P28）──────────────────────────────────────────────
function threadList() {
  const l = listScreen();
  l.t[5] = listRow(103, "carol", "Re: [閒聊] 第一篇");
  return l;
}

test("同主題那一列：卡片後面、.main 裡、不進 #mainContainer；點了送那篇的編號、不外洩", () => {
  const { main, mc, starts, next } = setup(READ_ALICE, threadList());
  const card = document.getElementById(NEXT_ARTICLE_ID);
  const row = document.getElementById(NEXT_THREAD_ROW_ID);
  expect(row).not.toBeNull();
  expect(row.parentNode).toBe(main);
  expect(card.nextSibling).toBe(row);
  expect(mc.contains(row)).toBe(false);
  expect(row.hidden).toBe(false);
  expect(card.hasAttribute("data-thread")).toBe(true);
  const nextBtn = row.querySelector('[data-dir="next"]');
  const prevBtn = row.querySelector('[data-dir="prev"]');
  expect(prevBtn.hidden).toBe(true);
  expect(nextBtn.hidden).toBe(false);
  expect(nextBtn.textContent).toContain(i18n("next_article_thread_next"));
  expect(nextBtn.textContent).toContain("Re: [閒聊] 第一篇");
  expect(isNextArticleTarget(nextBtn.firstChild)).toBe(true);

  const seen = [];
  const spy = (e) => seen.push(e.type);
  for (const t of ["mousedown", "mouseup", "click"]) window.addEventListener(t, spy);
  try {
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    nextBtn.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    nextBtn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    nextBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  } finally {
    for (const t of ["mousedown", "mouseup", "click"]) window.removeEventListener(t, spy);
  }
  expect(seen).toEqual([]);
  expect(starts).toEqual([expect.objectContaining({ board: "C_Chat", num: 103 })]);
  expect(next.state.pending).toBe(true);
  expect(nextBtn.hasAttribute("data-pending")).toBe(true);
});

test("「捲到文末了沒」連同主題那一列一起扣（trailingPx）", () => {
  const { core } = setup(READ_ALICE, threadList());
  const card = document.getElementById(NEXT_ARTICLE_ID);
  const row = document.getElementById(NEXT_THREAD_ROW_ID);
  const outer = (n) => {
    const cs = getComputedStyle(n);
    return n.offsetHeight + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom);
  };
  expect(row.offsetHeight).toBeGreaterThan(0);
  expect(trailingPx(core.view)).toBeCloseTo(Math.max(0, outer(card) + outer(row)), 0);
});

test("沒有同主題的文章 ⇒ 那一列不出現、卡片不標 data-thread", () => {
  setup();
  const row = document.getElementById(NEXT_THREAD_ROW_ID);
  expect(row === null || row.hidden).toBe(true);
  expect(document.getElementById(NEXT_ARTICLE_ID).hasAttribute("data-thread")).toBe(false);
});
