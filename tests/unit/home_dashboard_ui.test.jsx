// @unit-env browser
// real-input: tests/e2e/offline/home_dashboard.offline.spec.js
//   （page.mouse／keyboard；本檔手捏事件只測分支邏輯，見 tests/unit/e2e_real_input.test.js）
// 首頁儀表板的外殼（src/components/HomeDashboard）。鎖：
//  1. 只照 homeDashboard.state 畫：不可見就不畫；卡片、未讀標記、狀態文字、新信、最近看板；
//  2. 點卡片／最近看板 → openBoard，「原生主選單」→ dismiss，「更新」→ fetchFavorites，新信 → openMail；
//  3. mousedown preventDefault（不搶 #t 焦點 ⇒ 打字照常送 PTT）、滑鼠事件不外洩到 window；
//  4. #homeDashboard 被 App 的滑鼠入口認得（isHomeDashboardTarget），滾輪才不會變成翻頁；
//  5. 捲動位置是閱讀紀錄的 home 紀錄：點看板離開、回來時捲回同一張卡片（真版面量）。
import { render, fireEvent, act } from "@testing-library/react";
import { HomeDashboard } from "../../src/components/HomeDashboard";
import {
  isHomeDashboardTarget,
  HOME_DASHBOARD_ID,
  HomeDashboard as HomeController,
  homeAnchorOf,
  applyHomeAnchor,
} from "../../src/js/home_dashboard";
import { recordFor } from "../../src/js/reading_record";
import { setupI18n, i18n } from "../../src/js/i18n";

beforeAll(() => {
  setupI18n();
});

function fakeHome(state) {
  const listeners = new Set();
  const home = {
    state: {
      visible: true,
      fetching: false,
      boards: null,
      savedAt: null,
      recents: [],
      newMail: false,
      ...state,
    },
    onChange(fn) {
      listeners.add(fn);
      fn(home.state);
      return () => listeners.delete(fn);
    },
    push(patch) {
      home.state = { ...home.state, ...patch };
      listeners.forEach((fn) => fn(home.state));
    },
    openBoard: vi.fn(),
    openMail: vi.fn(),
    dismiss: vi.fn(),
    refresh: vi.fn(),
    applyPendingViewport: vi.fn(),
  };
  return home;
}

const root = () => document.getElementById(HOME_DASHBOARD_ID);
const q = (sel) => document.querySelector(sel);

test("不可見就不畫；可見時跟著 state 更新", () => {
  const home = fakeHome({ visible: false });
  render(<HomeDashboard pttchrome={{ homeDashboard: home }} />);
  expect(root()).toBeNull();
  act(() => home.push({ visible: true }));
  expect(root()).not.toBeNull();
  expect(q("[data-home-not-loaded]")).not.toBeNull();
  act(() => home.push({ visible: false }));
  expect(root()).toBeNull();
});

test("卡片：板名、敘述、未讀標記；點卡片 → openBoard", () => {
  const home = fakeHome({
    boards: [
      { name: "C_Chat", desc: "[希洽] 閒聊", unread: true },
      { name: "Stock", desc: "", unread: false },
    ],
    savedAt: new Date(2026, 9, 18, 9, 5).getTime(),
  });
  render(<HomeDashboard pttchrome={{ homeDashboard: home }} />);
  const cards = document.querySelectorAll("[data-home-board]");
  expect([...cards].map((c) => c.getAttribute("data-home-board"))).toEqual(["C_Chat", "Stock"]);
  expect(cards[0].hasAttribute("data-unread")).toBe(true);
  expect(cards[0].textContent).toContain(i18n("home_unread"));
  expect(cards[1].hasAttribute("data-unread")).toBe(false);
  expect(q("[data-home-status]").textContent).toContain("09:05");
  fireEvent.click(cards[0]);
  expect(home.openBoard).toHaveBeenCalledWith("C_Chat");
});

test("抓過但是空的 ⇒ 空清單提示；更新中 ⇒ 狀態文字、更新鈕反灰", () => {
  const home = fakeHome({ boards: [], fetching: true });
  render(<HomeDashboard pttchrome={{ homeDashboard: home }} />);
  expect(root().textContent).toContain(i18n("home_noFavorites"));
  expect(q("[data-home-status]").textContent).toBe(i18n("home_updating"));
  expect(q("[data-home-refresh]").disabled).toBe(true);
});

test("按鈕接到控制器：原生主選單、更新、新信、最近看板", () => {
  const home = fakeHome({ newMail: true, recents: ["Gossiping"] });
  render(<HomeDashboard pttchrome={{ homeDashboard: home }} />);
  fireEvent.click(q("[data-home-refresh]"));
  expect(home.refresh).toHaveBeenCalledWith("button");
  fireEvent.click(q("[data-home-mail]"));
  expect(home.openMail).toHaveBeenCalled();
  fireEvent.click(q('[data-home-recent="Gossiping"]'));
  expect(home.openBoard).toHaveBeenCalledWith("Gossiping");
  fireEvent.click(q("[data-home-native]"));
  expect(home.dismiss).toHaveBeenCalled();
});

test("mousedown 不搶焦點、滑鼠事件不外洩到 window", () => {
  const home = fakeHome({ boards: [{ name: "C_Chat", desc: "", unread: false }] });
  render(<HomeDashboard pttchrome={{ homeDashboard: home }} />);
  const seen = [];
  const spy = (e) => seen.push(e.type);
  for (const t of ["mousedown", "mouseup", "click"]) window.addEventListener(t, spy);
  try {
    const card = q("[data-home-board]");
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    card.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    fireEvent.mouseUp(card);
    fireEvent.click(card);
    // 面板空白處也一樣（點空白不是點終端機）。
    const bg = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    root().dispatchEvent(bg);
    expect(bg.defaultPrevented).toBe(true);
    expect(seen).toEqual([]);
  } finally {
    for (const t of ["mousedown", "mouseup", "click"]) window.removeEventListener(t, spy);
  }
});

test("isHomeDashboardTarget：面板裡的節點才算", () => {
  const home = fakeHome({ boards: [{ name: "C_Chat", desc: "", unread: false }] });
  render(<HomeDashboard pttchrome={{ homeDashboard: home }} />);
  expect(isHomeDashboardTarget(q("[data-home-board]"))).toBe(true);
  expect(isHomeDashboardTarget(document.body)).toBe(false);
  expect(isHomeDashboardTarget(null)).toBe(false);
});

test("手機：讓開 App Bar 與底部工具列，不顯示桌機打字提示", () => {
  const home = fakeHome({});
  render(<HomeDashboard pttchrome={{ homeDashboard: home, mobile: true }} />);
  expect(root().hasAttribute("data-mobile")).toBe(true);
  expect(root().textContent).not.toContain(i18n("home_hint"));
  const rect = root().getBoundingClientRect();
  expect(rect.top).toBeGreaterThanOrEqual(48);
  expect(window.innerHeight - rect.bottom).toBeGreaterThanOrEqual(48);
});

test("手機：不畫大標題與「原生主選單」（都在 App Bar）；有新信才留一行放「開信箱」", () => {
  const home = fakeHome({});
  const { unmount } = render(<HomeDashboard pttchrome={{ homeDashboard: home, mobile: true }} />);
  expect(root().querySelector(".homeTitle")).toBeNull();
  expect(root().querySelector("[data-home-native]")).toBeNull();
  expect(root().querySelector(".homeHeader")).toBeNull();
  unmount();
  render(<HomeDashboard pttchrome={{ homeDashboard: fakeHome({ newMail: true }), mobile: true }} />);
  expect(root().querySelector(".homeHeader [data-home-mail]")).not.toBeNull();
  expect(root().querySelector(".homeTitle")).toBeNull();
});

// ── 閱讀紀錄：真控制器＋真版面 ─────────────────────────────────────────────────
const ROWS = 24;
function menuFrame() {
  const rowTexts = Array.from({ length: ROWS }, () => "");
  rowTexts[0] = "【主功能表】     批踢踢實業坊";
  rowTexts[13] = " ".repeat(20) + "> (F)avorite     【 我 的 最愛 】";
  rowTexts[ROWS - 1] = " 主選單   10/9 週五 13:31 | someone ";
  return rowTexts;
}
function listFrame() {
  const rowTexts = Array.from({ length: ROWS }, () => "");
  rowTexts[0] = "【板主:someone】                  看板《Board30》";
  rowTexts[ROWS - 1] = " 文章選讀  (y)回應(X)推文(^X)轉錄 ";
  return rowTexts;
}
function realHome() {
  let rows = menuFrame();
  let settled = null;
  const core = {
    conn: { isConnected: true },
    buf: {
      rows: ROWS,
      cols: 80,
      cur_x: 20,
      cur_y: 13,
      pageState: 1,
      getRowText: (r) => rows[r],
      isCursorOnInputField: () => false,
      addEventListener: (name, fn) => (settled = fn),
    },
    view: { flashListHint: () => {} },
    commandQueue: { enqueue: () => {}, idle: true },
  };
  const home = new HomeController(core);
  core.homeDashboard = home;
  // 抓過了（TTL 內不自動抓）。
  home._state.fetchedAt = Date.now();
  const show = (r) => act(() => {
    rows = r;
    settled();
  });
  return { core, home, show };
}
const manyBoards = (from, to) => {
  const out = [];
  for (let n = from; n <= to; ++n) out.push({ name: "Board" + n, desc: "看板 " + n, unread: n % 3 === 0 });
  return out;
};
const cardTop = (name) =>
  q('[data-home-board="' + name + '"]').getBoundingClientRect().top - root().getBoundingClientRect().top;

test("閱讀紀錄：捲到中段點看板 → 離開 → 回來時捲回同一張卡片（清單前面多了也一樣）", () => {
  const { home, show } = realHome();
  act(() => home._set({ boards: manyBoards(1, 300) }));
  render(<HomeDashboard pttchrome={{ homeDashboard: home }} />);
  show(menuFrame());
  const el = root();
  expect(el.scrollHeight).toBeGreaterThan(el.clientHeight * 2);
  el.scrollTop = q('[data-home-board="Board90"]').offsetTop - 7;
  const before = homeAnchorOf(el);
  expect(before.key).toMatch(/^board:Board/);
  const anchorName = before.key.slice("board:".length);
  const offset = cardTop(anchorName);

  // 點看板：submitSearch 領的 'board-search' 書籤（這裡直接走閱讀紀錄，送鍵在 home_dashboard.test）。
  const bm = recordFor(home._core).begin("board-search");
  show(listFrame());
  expect(root()).toBeNull();
  recordFor(home._core).end(bm, "done");
  // 不在首頁時清單被換掉（例如別處更新了最愛）：前面多了 12 個板。
  act(() => home._set({ boards: manyBoards(-11, 300) }));
  show(menuFrame());
  expect(root()).not.toBeNull();
  expect(Math.abs(cardTop(anchorName) - offset)).toBeLessThanOrEqual(1);
  expect(home._pendingViewport).toBeNull();
});

test("閱讀紀錄：那張卡片不在了 ⇒ 不動（認不出就不還原）；沒捲過 ⇒ 回頂端", () => {
  const { home, show } = realHome();
  act(() => home._set({ boards: manyBoards(1, 300) }));
  render(<HomeDashboard pttchrome={{ homeDashboard: home }} />);
  show(menuFrame());
  const el = root();
  expect(applyHomeAnchor(el, { kind: "home", key: "board:NoSuch", offset: 0, scrollTop: 500 })).toBe(false);
  expect(el.scrollTop).toBe(0);
  el.scrollTop = 200;
  expect(applyHomeAnchor(el, { kind: "home", key: null, offset: 0, scrollTop: 0 })).toBe(true);
  expect(el.scrollTop).toBe(0);
  expect(homeAnchorOf(el)).toEqual({ kind: "home", key: null, offset: 0, scrollTop: 0 });
});
