// 設定面板「游標所在列」區塊的 UI 契約（2026-08-15 從「滑鼠瀏覽」拆出，
// 2026-08-26 加入樣式層）。分兩層：
//   來源層（哪一列）  滑鼠停留開關（住「滑鼠」分頁）、鍵盤游標開關
//   樣式層（畫什麼）  整列提亮（預設開）、整列上底色（預設關）＋底色顏色
// 顏色色票曾是**完全無效**的設定（選什麼畫面都是綠的），這裡守住它至少有寫進 pref；
// 現在還要守住「底色關掉時色票整排失效」（顏色只對底色樣式有意義）。
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

// 「一般」分頁是預設分頁，開啟即是。**滑鼠停留底色已搬到「滑鼠」分頁**（2026-08
// 滑鼠功能重新設計），這裡只剩鍵盤游標開關與兩者共用的顏色色票。
//
// 陷阱：Mantine Tabs 預設 keepMounted，非作用分頁仍在 DOM ⇒ 用
// document.querySelector 抓得到別的分頁的欄位、測試會綠著卻語意錯。要驗「在哪個
// 分頁」一律先 getByRole("tab") 切過去（見 tests/unit/pref_modal_mouse_tab.test.jsx）。
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
  test("獨立成一個「游標所在列」區塊（不再埋在滑鼠瀏覽裡）", () => {
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

  test("滑鼠停留底色與鍵盤游標底色各自獨立（前者現在住在「滑鼠」分頁）", () => {
    openModal({ keyboardCursorHighlight: false });
    expect(box("mouseBrowsingHighlight")).toBeChecked();
    expect(box("keyboardCursorHighlight")).not.toBeChecked();
  });

  test("「一般」分頁只留鍵盤那條與色票，滑鼠那條不在這一頁", () => {
    openModal();
    const general = screen
      .getByRole("tab", { name: i18n("options_general") })
      .getAttribute("aria-controls");
    const panel = document.getElementById(general);
    expect(panel.querySelector('[name="keyboardCursorHighlight"]')).toBeTruthy();
    expect(panel.querySelector(".PrefModal__HighlightColors")).toBeTruthy();
    expect(panel.querySelector('[name="mouseBrowsingHighlight"]')).toBeNull();
  });

  test("點色票 → 共用顏色寫進 mouseBrowsingHighlightColor", () => {
    openModal({ cursorRowBackground: true });
    fireEvent.click(swatch(6));
    closeModal();
    expect(readValuesWithDefault().mouseBrowsingHighlightColor).toBe(6);
  });

  // ---- 樣式層 ----

  test("整列提亮預設開、整列上底色預設關", () => {
    openModal();
    expect(box("cursorRowBrighten")).toBeChecked();
    expect(box("cursorRowBackground")).not.toBeChecked();
    expect(DEFAULT_PREFS.cursorRowBrighten).toBe(true);
    expect(DEFAULT_PREFS.cursorRowBackground).toBe(false);
  });

  test("兩個樣式可以同時開（不是二選一）", () => {
    openModal();
    fireEvent.click(box("cursorRowBackground"));
    closeModal();
    const v = readValuesWithDefault();
    expect(v.cursorRowBrighten).toBe(true);
    expect(v.cursorRowBackground).toBe(true);
  });

  test("取消整列提亮 → 寫進 pref", () => {
    openModal();
    fireEvent.click(box("cursorRowBrighten"));
    closeModal();
    expect(readValuesWithDefault().cursorRowBrighten).toBe(false);
  });

  test("底色關著時色票整排標成失效（顏色只對底色樣式有意義）", () => {
    openModal();
    const row = document.querySelector(".PrefModal__HighlightColors");
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.style.pointerEvents).toBe("none");
  });

  test("勾起底色 → 色票立刻可用", () => {
    openModal({ cursorRowBackground: true });
    const row = document.querySelector(".PrefModal__HighlightColors");
    expect(row.getAttribute("aria-disabled")).toBe("false");
    expect(row.style.pointerEvents).toBe("");
  });

  test("兩個樣式都在「一般」分頁（與來源層的鍵盤開關同一區）", () => {
    openModal();
    const general = screen
      .getByRole("tab", { name: i18n("options_general") })
      .getAttribute("aria-controls");
    const panel = document.getElementById(general);
    expect(panel.querySelector('[name="cursorRowBrighten"]')).toBeTruthy();
    expect(panel.querySelector('[name="cursorRowBackground"]')).toBeTruthy();
  });
});
