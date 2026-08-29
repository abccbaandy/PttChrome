// 設定面板「滑鼠」分頁的 UI 契約（2026-08 整套滑鼠功能重新設計）。
//
// 守住三件事：
//  (1) 四個功能都在同一個分頁上（改版前散在「一般」分頁底部，且右鍵選單另有一個
//      不寫回 pref 的「滑鼠瀏覽」開關，兩個入口兩種持久性）；
//  (2) 總開關關掉時**每一個子項都 disabled** —— 總開關要真的管得住全部；
//  (3) 中鍵／滾輪的選項值域與 mouse_regions/pttchrome 的分派表對齊（Select 用
//      index 當 value，錯一格就是送錯鍵）。
//
// Mantine Tabs 預設 keepMounted：非作用分頁仍在 DOM，所以要驗「在哪個分頁」一律
// 先切分頁再從該 panel 裡面找，不能用 document.querySelector 全域抓。
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

// 切到「滑鼠」分頁並回傳該分頁的 panel 元素。
const openMouseTab = (prefs) => {
  openModal(prefs);
  const tab = screen.getByRole("tab", { name: i18n("options_mouse") });
  fireEvent.click(tab);
  return document.getElementById(tab.getAttribute("aria-controls"));
};

// 設定是「關閉時才寫入」，讀 localStorage 前要先關掉對話框。
const closeModal = () =>
  fireEvent.click(screen.getByRole("button", { name: "Close" }));

const field = (panel, name) => panel.querySelector(`[name="${name}"]`);

// Mantine Select 的選項清單掛在 portal 上、且**所有** Select 的選項都已 mount，
// 所以要用 input 的 aria-controls 找到自己的那份 listbox，不能全域抓 role=option。
const optionsOf = (input) => {
  fireEvent.click(input);
  const list = document.getElementById(input.getAttribute("aria-controls"));
  return [...list.querySelectorAll("[role='option']")].map((el) => el.textContent);
};

const selectsIn = (panel) =>
  [...panel.querySelectorAll("input[aria-haspopup='listbox']")];

beforeAll(() => setupI18n());
beforeEach(() => window.localStorage.clear());

describe("設定頁：滑鼠分頁", () => {
  test("滑鼠功能都在這一頁上", () => {
    const panel = openMouseTab();
    [
      "useMouseBrowsing",
      "mouseBrowsingHighlight",
      "mouseLeftClick",
      "mouseMisclickGuard",
      "mouseFunctionKeys",
      "mouseWheelSmoothScroll",
    ].forEach((name) => expect(field(panel, name)).toBeTruthy());
    // Mantine Select 的 input 沒有 name，用 legend 驗欄位在場。
    expect(panel.textContent).toContain(i18n("options_mouseMiddleClick"));
    expect(panel.textContent).toContain(i18n("options_mouseWheel"));
  });

  test("預設值：總開關開、移動底色開、左鍵開、防誤觸開、中鍵關、滾輪上下頁", () => {
    const panel = openMouseTab();
    expect(field(panel, "useMouseBrowsing")).toBeChecked();
    expect(field(panel, "mouseBrowsingHighlight")).toBeChecked();
    expect(field(panel, "mouseLeftClick")).toBeChecked();
    expect(field(panel, "mouseMisclickGuard")).toBeChecked();
    expect(field(panel, "mouseFunctionKeys")).toBeChecked();
    expect(DEFAULT_PREFS.mouseMisclickGuard).toBe(true);
    expect(DEFAULT_PREFS.mouseFunctionKeys).toBe(true);
    expect(DEFAULT_PREFS.useMouseBrowsing).toBe(true);
    expect(DEFAULT_PREFS.mouseMiddleClick).toBe(0);
    expect(DEFAULT_PREFS.mouseWheel).toBe(1);
    // 平滑捲動預設開（新 key ⇒ 既有使用者也吃得到這個預設）
    expect(field(panel, "mouseWheelSmoothScroll")).toBeChecked();
    expect(DEFAULT_PREFS.mouseWheelSmoothScroll).toBe(true);
  });

  test("總開關關閉 → 每一個子項都 disabled（含中鍵與滾輪）", () => {
    const panel = openMouseTab({ useMouseBrowsing: false });
    expect(field(panel, "mouseBrowsingHighlight")).toBeDisabled();
    expect(field(panel, "mouseWheelSmoothScroll")).toBeDisabled();
    expect(field(panel, "mouseLeftClick")).toBeDisabled();
    expect(field(panel, "mouseMisclickGuard")).toBeDisabled();
    expect(field(panel, "mouseFunctionKeys")).toBeDisabled();
    panel
      .querySelectorAll("input[readonly], input[aria-haspopup='listbox']")
      .forEach((el) => expect(el).toBeDisabled());
  });

  test("總開關開啟時子項可操作", () => {
    const panel = openMouseTab();
    expect(field(panel, "mouseBrowsingHighlight")).not.toBeDisabled();
    expect(field(panel, "mouseLeftClick")).not.toBeDisabled();
  });

  test("取消左鍵操作 → 寫進 pref", () => {
    const panel = openMouseTab();
    fireEvent.click(field(panel, "mouseLeftClick"));
    closeModal();
    expect(readValuesWithDefault().mouseLeftClick).toBe(false);
  });

  test("關掉防誤觸 → 寫進 pref", () => {
    const panel = openMouseTab();
    fireEvent.click(field(panel, "mouseMisclickGuard"));
    closeModal();
    expect(readValuesWithDefault().mouseMisclickGuard).toBe(false);
  });

  test("關掉功能鍵可點 → 寫進 pref", () => {
    const panel = openMouseTab();
    fireEvent.click(field(panel, "mouseFunctionKeys"));
    closeModal();
    expect(readValuesWithDefault().mouseFunctionKeys).toBe(false);
  });

  test("關掉總開關 → 寫進 pref（子項的值原樣保留，重開就回到先前的組合）", () => {
    const panel = openMouseTab();
    fireEvent.click(field(panel, "useMouseBrowsing"));
    closeModal();
    const v = readValuesWithDefault();
    expect(v.useMouseBrowsing).toBe(false);
    expect(v.mouseLeftClick).toBe(true);
    expect(v.mouseWheel).toBe(1);
  });

  test("中鍵是三選一：關閉／貼上／左方向鍵（沒有 Enter）", () => {
    const panel = openMouseTab();
    expect(optionsOf(selectsIn(panel)[0])).toEqual([
      i18n("options_none"),
      i18n("options_doPaste"),
      i18n("options_leftKey"),
    ]);
  });

  test("滾輪是二選一：關閉／上下頁", () => {
    const panel = openMouseTab();
    const selects = selectsIn(panel);
    expect(optionsOf(selects[selects.length - 1])).toEqual([
      i18n("options_none"),
      i18n("options_pageUpDown"),
    ]);
  });

  test("滾輪關閉時「平滑捲動」也 disabled（它是滾輪的子行為）", () => {
    const panel = openMouseTab({ mouseWheel: 0 });
    expect(field(panel, "mouseWheelSmoothScroll")).toBeDisabled();
  });

  test("關掉平滑捲動 → 寫進 pref（回到一次一頁）", () => {
    const panel = openMouseTab();
    fireEvent.click(field(panel, "mouseWheelSmoothScroll"));
    closeModal();
    expect(readValuesWithDefault().mouseWheelSmoothScroll).toBe(false);
  });

  test("舊的「按住右鍵＋滾輪」「按住左鍵＋滾輪」兩組設定已不存在", () => {
    const panel = openMouseTab();
    ["mouseWheelFunction1", "mouseWheelFunction2", "mouseWheelFunction3"].forEach(
      (name) => expect(field(panel, name)).toBeNull(),
    );
  });
});
