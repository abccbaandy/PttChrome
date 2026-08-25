// 設定頁「一般 → 右鍵選單」區塊：兩個小幫手的顯示開關。
//
// 這兩項**預設關**（enableInputHelper / enableLiveArticleHelper）—— 它們是小眾
// 功能，卻長年佔著每個人的右鍵選單。選單端的 gating 守在
// tests/unit/dropdown_menu_preview.test.jsx，這裡只守「設定頁改得到、存得下去」。
//
// 樣板沿用 pref_modal_mouse_tab.test.jsx（Mantine Tabs 預設 keepMounted ⇒ 一律先
// 切分頁、再從該 panel 內部找，不能全域 querySelector）。
import { render, screen, fireEvent } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { PrefModal } from "../../src/components/ContextMenu/PrefModal";
import { setupI18n, i18n } from "../../src/js/i18n";
import { DEFAULT_PREFS } from "../../src/js/pref_storage";

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

const openGeneralTab = (prefs = {}, onSave = () => {}) => {
  window.localStorage.setItem(
    PREF_KEY,
    JSON.stringify({ values: { ...DEFAULT_PREFS, ...prefs } }),
  );
  render(
    <MantineProvider>
      <PrefModal
        show
        onSave={onSave}
        onReset={() => {}}
        debugMode={false}
        onDebugModeChange={() => {}}
      />
    </MantineProvider>,
  );
  const tab = screen.getByRole("tab", { name: i18n("options_general") });
  fireEvent.click(tab);
  return document.getElementById(tab.getAttribute("aria-controls"));
};

// 設定是「關閉時才寫入」。
const closeModal = () =>
  fireEvent.click(screen.getByRole("button", { name: "Close" }));

const field = (panel, name) => panel.querySelector(`[name="${name}"]`);

beforeAll(() => setupI18n());
beforeEach(() => window.localStorage.clear());

describe("設定頁：一般 → 右鍵選單", () => {
  test("兩個開關都在一般分頁上，且預設關閉", () => {
    const panel = openGeneralTab();
    expect(panel.textContent).toContain(i18n("options_contextMenu"));
    expect(field(panel, "enableInputHelper")).not.toBeChecked();
    expect(field(panel, "enableLiveArticleHelper")).not.toBeChecked();
    expect(DEFAULT_PREFS.enableInputHelper).toBe(false);
    expect(DEFAULT_PREFS.enableLiveArticleHelper).toBe(false);
  });

  test("勾起來 → 關閉對話框時兩個值都存下去", () => {
    const onSave = vi.fn();
    const panel = openGeneralTab({}, onSave);
    fireEvent.click(field(panel, "enableInputHelper"));
    fireEvent.click(field(panel, "enableLiveArticleHelper"));
    closeModal();

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toMatchObject({
      enableInputHelper: true,
      enableLiveArticleHelper: true,
    });
    const stored = JSON.parse(window.localStorage.getItem(PREF_KEY)).values;
    expect(stored.enableInputHelper).toBe(true);
    expect(stored.enableLiveArticleHelper).toBe(true);
  });

  test("既有的開啟狀態會被讀回來（不是永遠畫成關）", () => {
    const panel = openGeneralTab({ enableInputHelper: true });
    expect(field(panel, "enableInputHelper")).toBeChecked();
    expect(field(panel, "enableLiveArticleHelper")).not.toBeChecked();
  });

  // 長推文一鍵發送與上面兩個相反：**預設開**（不點就不會作用，而 PTT 本來就沒有
  // 「一次推一長串」的辦法），所以這裡守的是「預設值沒被改掉、關得起來」。
  test("長推文開關預設開啟", () => {
    const panel = openGeneralTab();
    expect(field(panel, "enableLongPush")).toBeChecked();
    expect(DEFAULT_PREFS.enableLongPush).toBe(true);
  });

  test("取消勾選 → 關閉對話框時存成 false", () => {
    const onSave = vi.fn();
    const panel = openGeneralTab({}, onSave);
    fireEvent.click(field(panel, "enableLongPush"));
    closeModal();

    expect(onSave.mock.calls[0][0]).toMatchObject({ enableLongPush: false });
    const stored = JSON.parse(window.localStorage.getItem(PREF_KEY)).values;
    expect(stored.enableLongPush).toBe(false);
  });
});
