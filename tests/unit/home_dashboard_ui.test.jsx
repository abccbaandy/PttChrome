// @unit-env browser
// real-input: tests/e2e/offline/home_dashboard.offline.spec.js
//   （page.mouse／keyboard；本檔手捏事件只測分支邏輯，見 tests/unit/e2e_real_input.test.js）
// 首頁儀表板的外殼（src/components/HomeDashboard）。鎖：
//  1. 只照 homeDashboard.state 畫：不可見就不畫；卡片、未讀標記、狀態文字、新信、最近看板；
//  2. 點卡片／最近看板 → openBoard，「原生主選單」→ dismiss，「更新」→ fetchFavorites，新信 → openMail；
//  3. mousedown preventDefault（不搶 #t 焦點 ⇒ 打字照常送 PTT）、滑鼠事件不外洩到 window；
//  4. #homeDashboard 被 App 的滑鼠入口認得（isHomeDashboardTarget），滾輪才不會變成翻頁。
import { render, fireEvent, act } from "@testing-library/react";
import { HomeDashboard } from "../../src/components/HomeDashboard";
import { isHomeDashboardTarget, HOME_DASHBOARD_ID } from "../../src/js/home_dashboard";
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
    fetchFavorites: vi.fn(),
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
  expect(home.fetchFavorites).toHaveBeenCalled();
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
