// @unit-env browser
// 設定頁的窄螢幕版型（PrefModal.jsx PREF_NARROW_QUERY）：全螢幕＋分類清單（像 Android 系統
// 設定：先列分類、各附一行說明，點進去才是設定，返回回清單）。
// 寬版的 160px 左欄在手機上會把內容擠到只剩一半（使用者回報「右邊內容頁很難閱讀」）；
// 橫向分頁列有 10 個分頁，後面幾個一開始看不到。
// 真版面：Mantine 與 PrefModal 的 CSS 以 ?raw 注入（Vitest 預設不處理 CSS import），
// 視窗大小用 vitest/browser 的 page.viewport 真的改。
import { render, screen, fireEvent, act } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { page } from "vitest/browser";
import mantineCss from "@mantine/core/styles.css?raw";
import prefModalCss from "../../src/components/ContextMenu/PrefModal.css?raw";
import { PrefModal, PREF_CATEGORIES } from "../../src/components/ContextMenu/PrefModal";
import { setupI18n, i18n } from "../../src/js/i18n";

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

let style;
beforeAll(() => {
  setupI18n();
  style = document.createElement("style");
  style.textContent = mantineCss + "\n" + prefModalCss;
  document.head.appendChild(style);
});
afterAll(() => style.remove());
beforeEach(() => window.localStorage.clear());
// 還原 vitest.config.mjs 的預設視窗，別讓後面的測試吃到手機尺寸。
afterEach(() => page.viewport(1024, 768));

const openModal = (props = {}) =>
  render(
    <MantineProvider>
      <PrefModal
        show
        onSave={() => {}}
        onReset={() => {}}
        debugMode={false}
        onDebugModeChange={() => {}}
        {...props}
      />
    </MantineProvider>,
  );
const category = (v) => document.querySelector(`[data-pref-category="${v}"]`);
const backBtn = () => document.querySelector("[data-pref-category-back]");

const content = () => document.querySelector(".PrefModal");
const rightCol = () => document.querySelector(".PrefModal__Grid__Col--right");

describe("設定頁：窄螢幕（手機直向）", () => {
  const mounted = () =>
    vi.waitFor(() => {
      const el = content();
      if (!el) throw new Error("modal not mounted");
      return el;
    });

  test("全螢幕、先列分類清單（每個分類都有一行說明），設定內容不畫、沒有橫向分頁列", async () => {
    await page.viewport(390, 800);
    openModal();
    const c = await mounted();
    expect(c.classList.contains("PrefModal--narrow")).toBe(true);
    expect(c.getBoundingClientRect().width).toBeGreaterThanOrEqual(388);
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(PREF_CATEGORIES).toHaveLength(11);
    for (const cat of PREF_CATEGORIES) {
      const el = category(cat.value);
      expect(el, cat.value).not.toBeNull();
      expect(el.textContent).toContain(i18n(cat.labelKey));
      const desc = i18n(cat.descKey);
      expect(typeof desc === "string" && desc.length > 0 && desc !== cat.descKey, cat.descKey).toBe(true);
      expect(el.textContent).toContain(desc);
    }
    // 清單直向排、整欄可捲（舊版橫向分頁列後半段一開始看不到）。
    const first = category("general").getBoundingClientRect();
    const second = category("mouse").getBoundingClientRect();
    expect(second.top).toBeGreaterThanOrEqual(first.bottom - 1);
    expect(Math.abs(second.left - first.left)).toBeLessThan(1);
    const left = document.querySelector(".PrefModal__Grid__Col--left");
    expect(getComputedStyle(left).overflowY).toBe("auto");
    expect(getComputedStyle(rightCol()).display).toBe("none");
  });

  test("點分類 ⇒ 該分類的設定佔滿全寬，上方「‹ 分類名」；按它回清單", async () => {
    await page.viewport(390, 800);
    openModal();
    await mounted();
    fireEvent.click(category("enhance"));
    expect(category("enhance")).toBeNull();
    expect(backBtn().textContent).toContain(i18n("options_enhance"));
    expect(rightCol().getBoundingClientRect().width).toBeGreaterThanOrEqual(390 * 0.9);
    const showLights = document.querySelector('input[name="showLightsOnButton"]');
    expect(showLights.getBoundingClientRect().height).toBeGreaterThan(0);
    // 返回列在內容上方。
    expect(backBtn().getBoundingClientRect().bottom).toBeLessThanOrEqual(
      rightCol().getBoundingClientRect().top + 1,
    );
    fireEvent.click(backBtn());
    expect(category("enhance")).not.toBeNull();
    expect(getComputedStyle(rightCol()).display).toBe("none");
  });

  test("系統返回：在分類裡才登記，觸發＝回清單、解除登記", async () => {
    await page.viewport(390, 800);
    const handlers = [];
    const off = vi.fn();
    const registerBack = vi.fn((fn) => {
      handlers.push(fn);
      return off;
    });
    openModal({ registerBack });
    await mounted();
    expect(registerBack).not.toHaveBeenCalled();
    fireEvent.click(category("mouse"));
    expect(registerBack).toHaveBeenCalledTimes(1);
    act(() => handlers[0]());
    expect(category("mouse")).not.toBeNull();
    expect(off).toHaveBeenCalledTimes(1);
  });

  test("指令面板跳到某個設定項 ⇒ 直接進那個分類，不停在清單", async () => {
    await page.viewport(390, 800);
    openModal({ jumpTarget: { tab: "mouse", key: "useMouseBrowsing", n: 1 } });
    await mounted();
    await vi.waitFor(() => expect(backBtn()).not.toBeNull());
    expect(backBtn().textContent).toContain(i18n("options_mouse"));
  });

  test("「重設」移到內容區最底", async () => {
    await page.viewport(390, 800);
    openModal();
    await mounted();
    fireEvent.click(category("general"));
    const reset = await vi.waitFor(() =>
      screen.getByRole("button", { name: i18n("options_reset") }),
    );
    expect(rightCol().contains(reset)).toBe(true);
  });
});

describe("設定頁：寬螢幕維持原版型", () => {
  test("左欄垂直分頁、非全螢幕", async () => {
    await page.viewport(1024, 768);
    openModal();
    const c = await vi.waitFor(() => {
      const el = content();
      if (!el) throw new Error("modal not mounted");
      return el;
    });
    expect(c.classList.contains("PrefModal--narrow")).toBe(false);
    expect(screen.getByRole("tablist").getAttribute("aria-orientation")).toBe(
      "vertical",
    );
    const reset = screen.getByRole("button", { name: i18n("options_reset") });
    expect(rightCol().contains(reset)).toBe(false);
  });
});
