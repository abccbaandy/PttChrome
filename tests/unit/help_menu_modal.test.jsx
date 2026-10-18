// @unit-env browser
// 說明選單好讀的外殼（src/components/HelpMenu）。控制器是真的（js/help_menu.js），送出口換成
// 陣列；畫面由 noteScreen 直餵實錄的兩頁。守的是使用者的操作：
//   - 兩頁的指令一次列出來（桌機 Modal／手機 bottom sheet 都是）；
//   - 點一下＝執行那一項（送 Home → PgDn → ↓… → Enter）；
//   - 鍵盤：↓ 移動、Enter 執行、q 離開；「原生畫面」收起彈窗；
//   - 開著＝modal（setModalOpen("helpMenu")），收起就解除。
// real-input: tests/e2e/offline/help_menu.offline.spec.js
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import HelpMenu from "../../src/components/HelpMenu";
import { setupI18n, i18n } from "../../src/js/i18n";
import {
  HelpMenuController,
  parseHelpMenuScreen,
  KEY_HOME,
  KEY_PGDN,
  KEY_DOWN,
} from "../../src/js/help_menu";
import { HELP_FAV_PAGE1, HELP_FAV_PAGE2 } from "./fixtures/help_menu_rows";

beforeAll(() => {
  setupI18n();
});

function setup({ mobile = false } = {}) {
  const sent = [];
  const modal = new Map();
  const pttchrome = {
    setModalOpen: (source, open) => modal.set(source, open),
    registerSheetDismiss: () => () => {},
  };
  pttchrome.helpMenu = new HelpMenuController(pttchrome, null, {
    send: (b) => sent.push(b),
    enabled: () => true,
  });
  render(
    <MantineProvider>
      <HelpMenu pttchrome={pttchrome} mobile={mobile} />
    </MantineProvider>,
  );
  const feed = (rows) =>
    act(() => pttchrome.helpMenu.noteScreen(parseHelpMenuScreen(rows)));
  return { pttchrome, sent, modal, feed };
}

const items = () => Array.from(document.querySelectorAll("[data-help-item]"));
// Modal／Drawer 開關有過場：內容掛上與卸下都是非同步的。
const waitItems = (n) => waitFor(() => expect(items()).toHaveLength(n));

test.each([false, true])("兩頁合併列出、點第 2 頁的項目就執行（mobile=%s）", async (mobile) => {
  const { sent, feed } = setup({ mobile });
  feed(HELP_FAV_PAGE1);
  await waitItems(25);
  expect(document.querySelector("[data-help-loading]")).not.toBeNull();
  feed(HELP_FAV_PAGE2);
  await waitItems(35);
  expect(document.querySelector("[data-help-loading]")).toBeNull();
  const target = items().find((el) => el.textContent.includes("線上使用者"));
  sent.length = 0;
  fireEvent.click(target);
  expect(sent).toEqual([KEY_HOME + KEY_PGDN + KEY_DOWN.repeat(8) + "\r"]);
  await waitItems(0);
});

test("標題帶 caption；鍵名逐一畫成按鍵", async () => {
  const { feed } = setup();
  feed(HELP_FAV_PAGE1);
  await waitItems(25);
  expect(
    screen.getByText(i18n("helpMenu_titleWith").replace("{0}", "我的最愛")),
  ).toBeTruthy();
  const first = items()[0];
  expect(Array.from(first.querySelectorAll("kbd")).map((k) => k.textContent)).toEqual(["h", "H"]);
});

test("桌機鍵盤：↓↓ Enter 執行第 3 項", async () => {
  const a = setup();
  a.feed(HELP_FAV_PAGE1);
  await waitItems(25);
  a.sent.length = 0;
  const list = document.querySelector("[data-help-menu-list]");
  fireEvent.keyDown(list, { key: "ArrowDown" });
  fireEvent.keyDown(list, { key: "ArrowDown" });
  expect(items()[2].hasAttribute("data-active")).toBe(true);
  fireEvent.keyDown(list, { key: "Enter" });
  expect(a.sent).toEqual([KEY_HOME + KEY_DOWN.repeat(2) + "\r"]);
});

test("q 離開；開著＝modal，收起就解除", async () => {
  const { sent, modal, feed } = setup();
  feed(HELP_FAV_PAGE1);
  await waitItems(25);
  expect(modal.get("helpMenu")).toBe(true);
  sent.length = 0;
  fireEvent.keyDown(document.querySelector("[data-help-menu-list]"), { key: "q" });
  expect(sent).toEqual(["q"]);
  expect(modal.get("helpMenu")).toBe(false);
});

test("「原生畫面」收起彈窗，不送離開鍵", async () => {
  const { sent, feed } = setup();
  feed(HELP_FAV_PAGE1);
  await waitItems(25);
  sent.length = 0;
  fireEvent.click(document.querySelector("[data-help-native]"));
  await waitItems(0);
  // 第 1 頁時已送出補頁的 PgDn ⇒ Home 回第 1 頁；不送 q
  expect(sent).toEqual([KEY_HOME]);
});

test("小天使按鈕只在 footer 有 (h)小天使 時出現", async () => {
  const { sent, feed } = setup();
  const noAngel = HELP_FAV_PAGE1.map((r, i) =>
    i === HELP_FAV_PAGE1.length - 1 ? r.replace(" (h)小天使", "") : r,
  );
  feed(noAngel);
  await waitItems(25);
  expect(document.querySelector("[data-help-angel]")).toBeNull();
  // 離開再重開（有小天使）
  feed([]);
  await waitItems(0);
  feed(HELP_FAV_PAGE1);
  await waitFor(() => expect(document.querySelector("[data-help-angel]")).not.toBeNull());
  sent.length = 0;
  fireEvent.click(document.querySelector("[data-help-angel]"));
  expect(sent).toEqual(["h"]);
});
