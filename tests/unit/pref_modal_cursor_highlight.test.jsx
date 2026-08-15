// 設定面板「游標底色」區塊的 UI 契約（2026-08-15 從「滑鼠瀏覽」拆出）。
// 三個 pref 共用一條渲染管線：滑鼠停留開關、鍵盤游標開關（新，預設開）、共用顏色。
// 顏色色票曾是**完全無效**的設定（選什麼畫面都是綠的），這裡守住它至少有寫進 pref。
import { render, screen, fireEvent } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { PrefModal } from "../../src/components/ContextMenu/PrefModal";
import { setupI18n, i18n } from "../../src/js/i18n";
import { DEFAULT_PREFS, readValuesWithDefault } from "../../src/js/pref_storage";

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

// 「一般」分頁是預設分頁，開啟即是。
const openModal = (prefs = {}) => {
  window.localStorage.setItem(
    PREF_KEY,
    JSON.stringify({ values: { ...DEFAULT_PREFS, ...prefs } }),
  );
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
};

// 設定是「關閉時才寫入」，讀 localStorage 前要先關掉對話框。
const closeModal = () =>
  fireEvent.click(screen.getByRole("button", { name: "Close" }));

const box = (name) => document.querySelector(`[name="${name}"]`);
const swatch = (i) =>
  document.querySelector(`.PrefModal__HighlightColors .b${i}`);

beforeAll(() => setupI18n());
beforeEach(() => window.localStorage.clear());

describe("設定頁：游標底色", () => {
  test("獨立成一個「游標底色」區塊（不再埋在滑鼠瀏覽裡）", () => {
    openModal();
    expect(screen.getByText(i18n("options_cursorHighlight"))).toBeTruthy();
  });

  test("鍵盤游標底色預設開啟", () => {
    openModal();
    expect(box("keyboardCursorHighlight")).toBeChecked();
    expect(DEFAULT_PREFS.keyboardCursorHighlight).toBe(true);
  });

  test("取消鍵盤游標底色 → 寫進 pref", () => {
    openModal();
    fireEvent.click(box("keyboardCursorHighlight"));
    closeModal();
    expect(readValuesWithDefault().keyboardCursorHighlight).toBe(false);
  });

  test("滑鼠停留底色與鍵盤游標底色各自獨立", () => {
    openModal({ keyboardCursorHighlight: false });
    expect(box("mouseBrowsingHighlight")).toBeChecked();
    expect(box("keyboardCursorHighlight")).not.toBeChecked();
  });

  test("點色票 → 共用顏色寫進 mouseBrowsingHighlightColor", () => {
    openModal();
    fireEvent.click(swatch(6));
    closeModal();
    expect(readValuesWithDefault().mouseBrowsingHighlightColor).toBe(6);
  });
});
