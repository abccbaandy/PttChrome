// 設定頁「一般」的終端機提示音開關。
//
// **預設開**：PTT 送 BEL 本來就是終端機該出聲的時候，而且 bell.js 有節流，連發也
// 不會變成噪音。真正的發聲規則守在 tests/unit/bell.test.js、解析層的接線守在
// tests/unit/term_buf_bell.test.js，這裡只守「設定頁上有這個開關、關得掉、存得下去」。
//
// 樣板沿用 pref_modal_context_menu.test.jsx（Mantine Tabs 預設 keepMounted ⇒ 一律
// 先切分頁、再從該 panel 內部找，不能全域 querySelector）。
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

describe("設定頁：一般 → 終端機提示音", () => {
  test("開關在一般分頁上，且預設開啟", () => {
    const panel = openGeneralTab();
    expect(field(panel, "enableBell")).toBeChecked();
    expect(DEFAULT_PREFS.enableBell).toBe(true);
  });

  test("關掉 → 關閉對話框時存下去", () => {
    const onSave = vi.fn();
    const panel = openGeneralTab({}, onSave);
    fireEvent.click(field(panel, "enableBell"));
    closeModal();

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toMatchObject({ enableBell: false });
    const stored = JSON.parse(window.localStorage.getItem(PREF_KEY)).values;
    expect(stored.enableBell).toBe(false);
  });

  test("既有的關閉狀態會被讀回來（不是永遠畫成開）", () => {
    const panel = openGeneralTab({ enableBell: false });
    expect(field(panel, "enableBell")).not.toBeChecked();
  });
});
