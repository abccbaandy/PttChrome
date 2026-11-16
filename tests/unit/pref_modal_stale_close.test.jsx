// @unit-env browser
// 設定頁開著的期間，別處（另一個分頁、雲端同步、右鍵加黑名單）改了設定；關閉設定頁時
// 不可以把打開那一刻的整份表單寫回去蓋掉那些改動（也不可以把舊值上傳到雲端）。
// 純合併邏輯守在 tests/unit/pref_merge.test.js，這裡守接線。
import { render, screen, fireEvent } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { PrefModal } from "../../src/components/ContextMenu/PrefModal";
import { setupI18n, i18n } from "../../src/js/i18n";
import { DEFAULT_PREFS } from "../../src/js/pref_storage";
import * as prefSync from "../../src/js/pref_sync";

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
const store = (values) =>
  window.localStorage.setItem(PREF_KEY, JSON.stringify({ values }));
const stored = () => JSON.parse(window.localStorage.getItem(PREF_KEY)).values;

const open = (onSave) => {
  render(
    <MantineProvider>
      <PrefModal show onSave={onSave} onReset={() => {}} debugMode={false} onDebugModeChange={() => {}} />
    </MantineProvider>,
  );
  const tab = screen.getByRole("tab", { name: i18n("options_general") });
  fireEvent.click(tab);
  return document.getElementById(tab.getAttribute("aria-controls"));
};
const closeModal = () => fireEvent.click(screen.getByRole("button", { name: "Close" }));

beforeAll(() => setupI18n());
beforeEach(() => {
  window.localStorage.clear();
  prefSync.savePrefs.mockClear();
});

describe("設定頁開著時別處改了設定", () => {
  test("一格都沒動就關掉：別處的改動留著，也不上傳舊值", () => {
    store({ ...DEFAULT_PREFS });
    const onSave = vi.fn();
    open(onSave);
    // 設定頁開著的時候，另一個分頁把黑名單加了一個人。
    store({ ...DEFAULT_PREFS, blacklist: "spammer" });
    closeModal();
    expect(stored().blacklist).toBe("spammer");
    expect(prefSync.savePrefs).not.toHaveBeenCalled();
  });

  test("只改了一格：那一格寫進去，別處改的那格也留著", () => {
    store({ ...DEFAULT_PREFS });
    const onSave = vi.fn();
    const panel = open(onSave);
    store({ ...DEFAULT_PREFS, blacklist: "spammer" });
    fireEvent.click(panel.querySelector('[name="enableBell"]'));
    closeModal();
    expect(stored()).toMatchObject({ blacklist: "spammer", enableBell: false });
    expect(prefSync.savePrefs.mock.calls[0][0]).toMatchObject({ blacklist: "spammer", enableBell: false });
    expect(onSave.mock.calls[0][0]).toMatchObject({ blacklist: "spammer", enableBell: false });
  });
});
