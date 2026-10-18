// @unit-env browser
// 設定頁「一般」最上面的安全模式（全部用原生）。
//
// 守三件事：開關在、打開時被它蓋掉的各項畫成 disabled（使用者看得出為什麼不能改）、
// 而且**各項自己的值原封不動存回去**（關掉安全模式要回到原本的設定）。
// 讀取端真的被蓋掉守在 tests/unit/native_safe_mode.test.js。
// 樣板沿用 pref_modal_bell.test.jsx。
import { render, screen, fireEvent } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { PrefModal } from "../../src/components/ContextMenu/PrefModal";
import { setupI18n, i18n } from "../../src/js/i18n";
import { DEFAULT_PREFS, NATIVE_SAFE_MODE_KEYS } from "../../src/js/pref_storage";

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

const closeModal = () =>
  fireEvent.click(screen.getByRole("button", { name: "Close" }));

const field = (panel, name) => panel.querySelector(`[name="${name}"]`);

beforeAll(() => setupI18n());
beforeEach(() => window.localStorage.clear());

describe("設定頁：安全模式（全部用原生）", () => {
  test("在一般分頁、預設關，被蓋掉的各項都可以改", () => {
    const panel = openGeneralTab();
    expect(field(panel, "nativeSafeMode")).not.toBeChecked();
    for (const key of NATIVE_SAFE_MODE_KEYS) {
      expect(field(panel, key), key).not.toBeNull();
      expect(field(panel, key), key).toBeEnabled();
    }
  });

  test("打開 ⇒ 各項變 disabled，但勾選狀態照舊；存回去的也是原值", () => {
    const onSave = vi.fn();
    const panel = openGeneralTab({}, onSave);
    fireEvent.click(field(panel, "nativeSafeMode"));
    for (const key of NATIVE_SAFE_MODE_KEYS) {
      expect(field(panel, key), key).toBeDisabled();
      expect(field(panel, key), key).toBeChecked();
    }
    closeModal();

    const stored = JSON.parse(window.localStorage.getItem(PREF_KEY)).values;
    expect(stored.nativeSafeMode).toBe(true);
    for (const key of NATIVE_SAFE_MODE_KEYS) expect(stored[key], key).toBe(true);
    expect(onSave.mock.calls[0][0]).toMatchObject({ nativeSafeMode: true });
  });
});
