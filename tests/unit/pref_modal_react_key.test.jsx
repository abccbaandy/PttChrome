// @unit-env browser
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
  fillPlaceholders,
} from "../../src/components/ContextMenu/PrefModal";
import { setupI18n } from "../../src/js/i18n";
import { zh_TW as zh } from "../../src/js/zh_TW_messages";
import { en_US as en } from "../../src/js/en_US_messages";

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


beforeAll(() => {
  setupI18n();
});

const ABOUT_IDS = [
  "about_description",
  "about_version_current",
  "about_version_upstream",
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

// 中文字串的佔位符兩側緊貼全形標點（「#a#（#b#」）：舊版 split 用 \S+ 會把兩個佔位符
// 吃成一個找不到的 key ⇒ 畫面上露出 `#link_…#` 原文、連結消失。兩語系都要驗。
test.each([
  ["zh_TW", zh],
  ["en_US", en],
])("%s：關於頁每個佔位符都換成連結，不露出 # 原文", (_name, table) => {
  ABOUT_IDS.forEach((id) => {
    const message = table[id].message;
    const placeholders = message.match(/#\w+#/g) || [];
    expect(placeholders.length).toBeGreaterThan(0);
    placeholders.forEach((p) =>
      expect(ABOUT_LINKS).toHaveProperty(p.slice(1, -1)),
    );
    const parts = fillPlaceholders(message, ABOUT_LINKS);
    expect(parts.filter(isValidElement)).toHaveLength(placeholders.length);
    parts
      .filter((p) => typeof p === "string")
      .forEach((text) => expect(text).not.toMatch(/#\w+#/));
  });
});

// fork 的「關於」曾整段照抄上游，「此版本」連到 robertabcd ⇒ 鎖住此版本指向本 fork。
test("「此版本」連到本 fork，上游另列一條", () => {
  const hrefs = (id) =>
    replaceI18n(id, ABOUT_LINKS)
      .filter(isValidElement)
      .map((el) => el.props.href);
  expect(hrefs("about_version_current")).toContain(
    "https://github.com/abccbaandy/PttChrome",
  );
  expect(hrefs("about_version_current").join(" ")).not.toMatch(/robertabcd/);
  expect(hrefs("about_version_upstream")).toContain(
    "https://github.com/robertabcd/PttChrome",
  );
});
