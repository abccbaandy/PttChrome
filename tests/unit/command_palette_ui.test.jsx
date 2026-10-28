// @unit-env browser
// 指令面板（components/ContextMenu/CommandPalette.jsx ＋ ContextMenu 整合）。
//
// 守的行為：
//  1. pttchrome.openCommandPalette 掛載後回 true、算 modal；pref 關掉回 false（快捷鍵不吞）；
//  2. ↑↓／Enter 執行選到的那一項，點一下也行；
//  3. 每一類都接到既有入口：貼網址 → deepLinkController.request、動作 → 該功能的 start、
//     設定項 → 開設定頁並跳到那一項、安全模式 → 存回偏好；
//  4. 清單框高度固定：項目數一直變時輸入框不跳。
import { render, act, fireEvent, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import ContextMenu from "../../src/components/ContextMenu";
import { setupI18n } from "../../src/js/i18n";
import { DEFAULT_PREFS, readValuesWithDefault } from "../../src/js/pref_storage";
import { aidToFn } from "../../src/js/aid_codec";

vi.mock("../../src/js/pref_sync", () => ({
  savePrefs: vi.fn(),
  signIn: vi.fn(() => Promise.resolve()),
  signOut: vi.fn(() => Promise.resolve()),
  onAuthState: vi.fn(() => () => {}),
}));

vi.mock("../../src/js/prompt_api", () => ({
  promptApiAvailability: () => Promise.resolve("available"),
  ensurePromptApiModel: vi.fn(() => Promise.resolve("available")),
  destroyPromptApi: vi.fn(),
}));

const PREF_KEY = "pttchrome.pref.v1";
const AID = "1gU3xHKD";

const makePttchrome = () => ({
  buf: { pageState: 3, rows: 24, cols: 80, getRowText: () => "" },
  view: { flashListHint: vi.fn(), useEasyReadingMode: false },
  aidNavigation: { active: false, canGoBack: () => true, back: vi.fn() },
  deepLinkController: {
    request: vi.fn(() => "navigating"),
    copyCurrentPostLink: vi.fn(),
  },
  screenRefresh: { target: () => ({ kind: "article" }), refresh: vi.fn(() => true) },
  unreadJump: { available: () => false, start: vi.fn() },
  markAllRead: { available: () => false, start: vi.fn() },
  commandQueue: { enqueue: vi.fn() },
  searchInFlight: false,
  longPush: { start: vi.fn(), cancel: vi.fn(), disarm: vi.fn() },
  imageUpload: { setInsertTarget: vi.fn(), clearInsertTarget: vi.fn() },
  setModalOpen: vi.fn(),
  onValuesPrefChange: vi.fn(),
  switchToEasyReadingMode: vi.fn(),
  onDisableLiveHelperModalState: vi.fn(),
  onDebugRecordDownloaded: () => () => {},
  contextMenuShown: false,
  openCommandPalette: function noop() {},
});

const mount = (pttchrome, prefs = {}) => {
  document.body.innerHTML = '<div id="BBSWindow"></div>';
  window.localStorage.setItem(
    PREF_KEY,
    JSON.stringify({ values: { ...DEFAULT_PREFS, ...prefs } }),
  );
  return render(
    <MantineProvider>
      <ContextMenu pttchrome={pttchrome} />
    </MantineProvider>,
  );
};

const openPalette = (pttchrome) => {
  let opened;
  act(() => {
    opened = pttchrome.openCommandPalette();
  });
  return opened;
};

const input = () => document.querySelector('input[name="commandPaletteQuery"]');
const itemIds = () =>
  [...document.querySelectorAll("[data-palette-item]")].map((n) => n.getAttribute("data-palette-item"));
const type = (text) => fireEvent.change(input(), { target: { value: text } });
const key = (k) => fireEvent.keyDown(input(), { key: k });

beforeAll(() => setupI18n());
beforeEach(() => window.localStorage.clear());

test("掛載後接手（回 true）、算 modal", async () => {
  const pttchrome = makePttchrome();
  mount(pttchrome);
  expect(openPalette(pttchrome)).toBe(true);
  await waitFor(() => expect(input()).not.toBeNull());
  expect(pttchrome.setModalOpen).toHaveBeenLastCalledWith("contextMenu", true);
});

test("pref 關 ⇒ 回 false，不開（快捷鍵交還）", () => {
  const pttchrome = makePttchrome();
  mount(pttchrome, { enableCommandPalette: false });
  expect(openPalette(pttchrome)).toBe(false);
  expect(input()).toBeNull();
});

test("空輸入列出這一刻能用的動作；不能用的不列", async () => {
  const pttchrome = makePttchrome();
  mount(pttchrome);
  openPalette(pttchrome);
  await waitFor(() => expect(input()).not.toBeNull());
  const ids = itemIds();
  expect(ids).toEqual(
    expect.arrayContaining(["action:refresh", "action:copyLink", "action:back", "action:settings"]),
  );
  expect(ids).not.toContain("action:unreadJump");
  expect(ids).not.toContain("action:markAllRead");
});

test("貼文章網址 + Enter ⇒ deepLinkController.request，面板關掉", async () => {
  const pttchrome = makePttchrome();
  mount(pttchrome);
  openPalette(pttchrome);
  await waitFor(() => expect(input()).not.toBeNull());
  type(`https://www.ptt.cc/bbs/Gossiping/${aidToFn(AID)}.html`);
  expect(itemIds()[0]).toBe("article");
  key("Enter");
  expect(pttchrome.deepLinkController.request).toHaveBeenCalledWith({ board: "Gossiping", aid: AID });
  await waitFor(() => expect(pttchrome.setModalOpen).toHaveBeenLastCalledWith("contextMenu", false));
});

// 最近讀過的項目跟首頁儀表板同一條（recentArticles.open：接著上次讀到的地方、落地不閃
// 「已跳至」），不是直接 deep link。
test("最近讀過的文章 + Enter ⇒ recentArticles.open，不直接 deep link", async () => {
  const pttchrome = makePttchrome();
  const entry = { board: "Gossiping", aid: AID, title: "[問卦] 一", at: 1 };
  pttchrome.recentArticles = {
    state: { recent: [entry], later: [] },
    open: vi.fn(() => true),
    toggleLater: vi.fn(),
    onChange: () => () => {},
  };
  mount(pttchrome);
  openPalette(pttchrome);
  await waitFor(() => expect(input()).not.toBeNull());
  type("問卦");
  expect(itemIds()[0]).toBe("recent:gossiping/" + AID);
  key("Enter");
  expect(pttchrome.recentArticles.open).toHaveBeenCalledWith({ board: "Gossiping", aid: AID });
  expect(pttchrome.deepLinkController.request).not.toHaveBeenCalled();
});

test("↓ 移到下一項再 Enter；點一下也能執行", async () => {
  const pttchrome = makePttchrome();
  mount(pttchrome);
  openPalette(pttchrome);
  await waitFor(() => expect(input()).not.toBeNull());
  type("重新整理");
  expect(itemIds()[0]).toBe("action:refresh");
  key("Enter");
  expect(pttchrome.screenRefresh.refresh).toHaveBeenCalledWith("palette");

  openPalette(pttchrome);
  await waitFor(() => expect(input()).not.toBeNull());
  const first = itemIds()[0];
  const second = itemIds()[1];
  key("ArrowDown");
  expect(document.querySelector(`[data-palette-item="${second}"]`)).toHaveAttribute("aria-selected", "true");
  expect(document.querySelector(`[data-palette-item="${first}"]`)).toHaveAttribute("aria-selected", "false");
  fireEvent.click(document.querySelector('[data-palette-item="action:back"]'));
  expect(pttchrome.aidNavigation.back).toHaveBeenCalledTimes(1);
});

// 主功能表（能選看板）＋首頁儀表板的現成資料 ⇒ 空白時先列最近／最愛的看板。
const atMainMenu = (pttchrome) => {
  pttchrome.buf = { pageState: 0, rows: 24, cols: 80, getRowText: (r) => (r === 0 ? "【主功能表】" : "") };
  pttchrome.homeDashboard = {
    quickBoards: () => ({ recent: ["C_Chat", "Stock"], favorites: [{ name: "Baseball", desc: "棒球" }] }),
  };
  return pttchrome;
};

test("最近／最愛的看板：空白時排最前，↓ Enter 前往剛剛的板", async () => {
  const pttchrome = atMainMenu(makePttchrome());
  mount(pttchrome);
  openPalette(pttchrome);
  await waitFor(() => expect(input()).not.toBeNull());
  expect(itemIds().slice(0, 3)).toEqual(["quick:c_chat", "quick:stock", "quick:baseball"]);
  const fav = document.querySelector('[data-palette-item="quick:baseball"]');
  expect(fav.textContent).toContain("Baseball");
  expect(fav.textContent).toContain("棒球");
  key("ArrowDown");
  key("Enter");
  await waitFor(() => expect(pttchrome.commandQueue.enqueue).toHaveBeenCalled());
  // 跟打板名一樣走看板搜尋的送出：第一步開 s prompt，板名記進搜尋紀錄（search_history）。
  expect(pttchrome.commandQueue.enqueue.mock.calls[0][0]).toMatchObject({ keys: "s", kind: "search-open" });
  const stored = Object.keys(window.localStorage).map((k) => window.localStorage.getItem(k)).join("\n");
  expect(stored).toContain("Stock");
  expect(stored).not.toContain("C_Chat");
});

test("最近／最愛的看板：開關關掉就不列", async () => {
  const pttchrome = atMainMenu(makePttchrome());
  mount(pttchrome, { paletteQuickBoards: false });
  openPalette(pttchrome);
  await waitFor(() => expect(input()).not.toBeNull());
  expect(itemIds().some((id) => id.startsWith("quick:"))).toBe(false);
});

test("設定項 ⇒ 開設定頁並跳到那一項", async () => {
  const pttchrome = makePttchrome();
  mount(pttchrome);
  openPalette(pttchrome);
  await waitFor(() => expect(input()).not.toBeNull());
  type("安全模式");
  const node = document.querySelector('[data-palette-item="setting:nativeSafeMode"]');
  expect(node).not.toBeNull();
  fireEvent.click(node);
  await waitFor(() =>
    expect(document.querySelector('[data-pref-anchor="nativeSafeMode"]')).toHaveClass(
      "PrefModal__Anchor--flash",
    ),
  );
});

test("安全模式 ⇒ 存回偏好並重新套用", async () => {
  const pttchrome = makePttchrome();
  mount(pttchrome);
  openPalette(pttchrome);
  await waitFor(() => expect(input()).not.toBeNull());
  type("safe mode");
  fireEvent.click(document.querySelector('[data-palette-item="action:safeModeOn"]'));
  expect(readValuesWithDefault().nativeSafeMode).toBe(true);
  expect(pttchrome.onValuesPrefChange).toHaveBeenCalledWith(
    expect.objectContaining({ nativeSafeMode: true }),
  );
});

test("清單框高度固定：項目數變了框高不變", async () => {
  const pttchrome = makePttchrome();
  mount(pttchrome);
  openPalette(pttchrome);
  await waitFor(() => expect(input()).not.toBeNull());
  const list = document.querySelector("#commandPaletteList");
  const h0 = list.getBoundingClientRect().height;
  type("zzzz-nothing-matches");
  expect(document.querySelector("[data-palette-empty]")).not.toBeNull();
  expect(list.getBoundingClientRect().height).toBe(h0);
  expect(h0).toBeGreaterThan(100);
});
