// 「關於」分頁的 i18n 字串內嵌連結：replaceI18n 回傳陣列，裡面的 <Anchor>
// 必須有 key，否則一開設定頁就噴 React「unique key」警告（Tabs keepMounted
// ⇒ 不用點開「關於」也會渲染）。
//
// React 的 key 警告以歸因元件去重 ⇒ 三個字串只噴兩次；光看 console 會漏掉第三處，
// 所以另外直接檢查三個字串的回傳值。
import { isValidElement } from "react";
import { render } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import {
  PrefModal,
  ABOUT_LINKS,
  replaceI18n,
} from "../../src/components/ContextMenu/PrefModal";
import { setupI18n } from "../../src/js/i18n";

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

window.matchMedia =
  window.matchMedia ||
  (() => ({
    matches: false,
    media: "",
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
window.ResizeObserver =
  window.ResizeObserver ||
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
window.scrollTo = window.scrollTo || (() => {});

beforeAll(() => {
  setupI18n();
});

const ABOUT_IDS = [
  "about_description",
  "about_version_current",
  "about_version_original",
];

test("開設定頁不噴 unique key 警告", () => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    render(
      <MantineProvider>
        <PrefModal
          show
          onSave={() => {}}
          onReset={() => {}}
          debugMode={false}
          onDebugModeChange={() => {}}
        />
      </MantineProvider>,
    );
    const keyWarnings = spy.mock.calls.filter((args) =>
      args.some((a) => String(a).includes('unique "key" prop')),
    );
    expect(keyWarnings).toEqual([]);
  } finally {
    spy.mockRestore();
  }
});

test.each(ABOUT_IDS)("%s 的每個 element 片段都有 key", (id) => {
  const parts = replaceI18n(id, ABOUT_LINKS);
  const elements = parts.filter(isValidElement);
  // 三個字串都含連結佔位符；0 個 element 代表字串或 split 規則變了，這條測試會失效。
  expect(elements.length).toBeGreaterThan(0);
  elements.forEach((el) => expect(el.key).not.toBeNull());
  // 同一陣列內 key 不可重複。
  const keys = elements.map((el) => el.key);
  expect(new Set(keys).size).toBe(keys.length);
});
