// @unit-env browser
// 設定頁的窄螢幕版型（PrefModal.jsx PREF_NARROW_QUERY）：全螢幕＋頂端橫向分頁。
// 寬版的 160px 左欄在手機上會把內容擠到只剩一半（使用者回報「右邊內容頁很難閱讀」）。
// 真版面：Mantine 與 PrefModal 的 CSS 以 ?raw 注入（Vitest 預設不處理 CSS import），
// 視窗大小用 vitest/browser 的 page.viewport 真的改。
import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { page } from "vitest/browser";
import mantineCss from "@mantine/core/styles.css?raw";
import prefModalCss from "../../src/components/ContextMenu/PrefModal.css?raw";
import { PrefModal } from "../../src/components/ContextMenu/PrefModal";
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

const openModal = () =>
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

const content = () => document.querySelector(".PrefModal");
const rightCol = () => document.querySelector(".PrefModal__Grid__Col--right");

describe("設定頁：窄螢幕（手機直向）", () => {
  test("全螢幕、分頁改橫向在頂端、內容佔滿全寬", async () => {
    await page.viewport(390, 800);
    openModal();
    const c = await vi.waitFor(() => {
      const el = content();
      if (!el) throw new Error("modal not mounted");
      return el;
    });
    expect(c.classList.contains("PrefModal--narrow")).toBe(true);
    expect(c.getBoundingClientRect().width).toBeGreaterThanOrEqual(388);
    expect(screen.getByRole("tablist").getAttribute("aria-orientation")).toBe(
      "horizontal",
    );
    // 舊版右欄在這個寬度只剩 ~200px。
    expect(rightCol().getBoundingClientRect().width).toBeGreaterThanOrEqual(
      390 * 0.9,
    );
    // 分頁列在內容上方，不是左邊。
    const tabs = screen.getByRole("tablist").getBoundingClientRect();
    expect(tabs.bottom).toBeLessThanOrEqual(rightCol().getBoundingClientRect().top + 1);
  });

  test("「重設」移到內容區最底", async () => {
    await page.viewport(390, 800);
    openModal();
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
