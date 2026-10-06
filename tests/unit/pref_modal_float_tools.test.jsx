// @unit-env browser
// 設定頁「增強」分頁的浮動鈕開關（圖文並排／開燈）：預設開、關得掉、存得下去。
// 關掉之後浮層的行為守在 lights_on_render.test.js／merge_image_caption_render.test.js。
// 樣板沿用 pref_modal_bell.test.jsx。
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
const KEYS = ["showMergeCaptionButton", "showLightsOnButton"];

const openEnhanceTab = (prefs = {}, onSave = () => {}) => {
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
  const tab = screen.getByRole("tab", { name: i18n("options_enhance") });
  fireEvent.click(tab);
  return document.getElementById(tab.getAttribute("aria-controls"));
};

const closeModal = () =>
  fireEvent.click(screen.getByRole("button", { name: "Close" }));

const field = (panel, name) => panel.querySelector(`[name="${name}"]`);

beforeAll(() => setupI18n());
beforeEach(() => window.localStorage.clear());

describe("設定頁：增強 → 浮動鈕開關", () => {
  test.each(KEYS)("%s 在增強分頁上，且預設開啟", (key) => {
    const panel = openEnhanceTab();
    expect(field(panel, key)).toBeChecked();
    expect(DEFAULT_PREFS[key]).toBe(true);
  });

  test.each(KEYS)("%s 關掉 → 關閉對話框時存下去", (key) => {
    const onSave = vi.fn();
    const panel = openEnhanceTab({}, onSave);
    fireEvent.click(field(panel, key));
    closeModal();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toMatchObject({ [key]: false });
    const stored = JSON.parse(window.localStorage.getItem(PREF_KEY)).values;
    expect(stored[key]).toBe(false);
  });

  test.each(KEYS)("%s 既有的關閉狀態會被讀回來", (key) => {
    const panel = openEnhanceTab({ [key]: false });
    expect(field(panel, key)).not.toBeChecked();
  });
});
