// @unit-env browser
// real-input: tests/e2e/offline/mobile_reflow.offline.spec.js
//   （長按選單的觸控事件在 e2e 走既有豁免；本檔只測外殼與項目清單）
// 手機長按選單＝bottom sheet（ContextMenu/ContextSheet.jsx）。鎖：
//  1. 項目清單與桌機 Mantine Menu 同一份（context_menu_entries.js）：同樣的條件出現同樣的項目；
//  2. 點項目走同一個 handler（onMenuSelect 帶 key）；反灰項目不能點；
//  3. 開著＝modal（具名來源），收起時撤銷。
import { render, fireEvent, act } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { ContextSheet } from "../../src/components/ContextMenu/ContextSheet";
import { buildContextMenuEntries } from "../../src/components/ContextMenu/context_menu_entries";
import { setupI18n } from "../../src/js/i18n";

beforeAll(() => setupI18n());

const PROPS = {
  open: true,
  normalEnabled: true,
  selEnabled: false,
  urlEnabled: false,
  authorBlacklistId: "someone",
  authorBlacklistExists: false,
  markReadTarget: { num: 1 },
  longPushEnabled: true,
  articleLinkEnabled: true,
  previews: { copyArticleLink: "https://example/#Test/1abcDEFG" },
};

function setup(over = {}) {
  const sources = new Set();
  const pttchrome = {
    setModalOpen: vi.fn((s, on) => (on ? sources.add(s) : sources.delete(s))),
    registerSheetDismiss: () => () => {},
  };
  const handlers = {
    onHide: vi.fn(),
    onMenuSelect: vi.fn(),
    onTitleBlacklistClick: vi.fn(),
    onLongPushClick: vi.fn(),
    onInputHelperClick: vi.fn(),
    onLiveArticleHelperClick: vi.fn(),
    onSettingsClick: vi.fn(),
    onQuickSearchSelect: vi.fn(),
  };
  const props = { ...PROPS, ...handlers, ...over, pttchrome };
  const r = render(
    <MantineProvider>
      <ContextSheet {...props} />
    </MantineProvider>,
  );
  return { ...r, props, sources, handlers };
}

const items = () =>
  Array.from(document.querySelectorAll('[data-sheet="context"] [data-cmenu]'));

test("項目與桌機選單同一份清單、同一個順序", async () => {
  const { props } = setup();
  await vi.waitFor(() => expect(items().length).toBeGreaterThan(0));
  const want = buildContextMenuEntries(props)
    .filter((e) => e.type === "item")
    .map((e) => e.key);
  expect(items().map((n) => n.getAttribute("data-cmenu"))).toEqual(want);
  // 複製類的第二行預覽照畫
  const link = document.querySelector('[data-cmenu="copyArticleLink"]');
  expect(link.textContent).toContain("https://example/#Test/1abcDEFG");
});

test("點項目走同一個 handler；反灰項目不能點", async () => {
  const { handlers } = setup({ authorBlacklistExists: true });
  await vi.waitFor(() => expect(items().length).toBeGreaterThan(0));
  const black = document.querySelector('[data-cmenu="addAuthorBlacklist"]');
  expect(black.disabled).toBe(true);
  fireEvent.click(document.querySelector('[data-cmenu="markReadUnread"]'));
  expect(handlers.onMenuSelect).toHaveBeenCalledWith("markReadUnread", expect.anything());
  fireEvent.click(document.querySelector('[data-cmenu="longPush"]'));
  expect(handlers.onLongPushClick).toHaveBeenCalledTimes(1);
});

test("開著＝modal（具名來源），收起即撤銷", async () => {
  const { sources, rerender, props } = setup();
  expect(sources.size).toBe(1);
  act(() =>
    rerender(
      <MantineProvider>
        <ContextSheet {...props} open={false} />
      </MantineProvider>,
    ),
  );
  expect(sources.size).toBe(0);
});

// 長按 sheet 項目（「前已讀後未讀」…）不可叫出原生選字框；搜尋 sheet 的輸入框照常可選。
test("sheet 項目不可選字，輸入框例外", async () => {
  setup();
  await vi.waitFor(() => expect(items().length).toBeGreaterThan(0));
  const item = document.querySelector('[data-cmenu="markReadUnread"]');
  expect(getComputedStyle(item).userSelect).toBe("none");
  const sheet = document.querySelector('[data-sheet="context"]');
  const input = document.createElement("input");
  sheet.appendChild(input);
  expect(getComputedStyle(input).userSelect).not.toBe("none");
  input.remove();
});
