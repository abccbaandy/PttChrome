// 設定頁關閉時的通知權限檢查。
//
// REGRESSION（實測回報）：原本只在勾選 checkbox 的當下問權限，但兩個通知 pref 的
// 預設值都是 true ⇒ 使用者不會去勾一個已經勾好的框 ⇒ 權限永遠停在 'default'，
// 系統通知永遠不出現，要「關掉再打開」那個開關才會觸發，等於隱藏操作。
// 現在改成每次關閉設定頁都再檢查一次。
//
// 水球通知（enableNotifications）與 deep link 交接通知（deepLinkHandoffNotify）
// 共用同一個瀏覽器權限，任一為開就該有權限——水球那個從來不曾請求過。
import { render, screen, fireEvent } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { PrefModal } from "../../src/components/ContextMenu/PrefModal";
import { setupI18n } from "../../src/js/i18n";
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

let requestCalls;
const installNotification = (permission) => {
  requestCalls = [];
  const Ctor = function () {};
  Ctor.permission = permission;
  Ctor.requestPermission = () => {
    requestCalls.push(permission);
    return Promise.resolve(permission);
  };
  globalThis.Notification = Ctor;
};

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

const closeModal = () =>
  fireEvent.click(screen.getByRole("button", { name: "Close" }));

beforeAll(() => setupI18n());
beforeEach(() => window.localStorage.clear());
afterEach(() => {
  delete globalThis.Notification;
});

describe("設定頁關閉：通知權限檢查", () => {
  // 這就是 bug 本體：兩個開關都是預設開，使用者什麼都不用改。
  test("通知預設開著、權限還沒問過 → 關閉設定頁時請求權限", () => {
    installNotification("default");
    expect(DEFAULT_PREFS.deepLinkHandoffNotify).toBe(true);
    expect(DEFAULT_PREFS.enableNotifications).toBe(true);
    openModal();
    closeModal();
    expect(requestCalls).toHaveLength(1);
  });

  test("已授權 → 不再打擾（不重複請求）", () => {
    installNotification("granted");
    openModal();
    closeModal();
    expect(requestCalls).toHaveLength(0);
  });

  test("已被瀏覽器封鎖 → 不請求（送了也叫不出彈窗）", () => {
    installNotification("denied");
    openModal();
    closeModal();
    expect(requestCalls).toHaveLength(0);
  });

  test("兩個通知開關都關掉 → 完全不碰權限", () => {
    installNotification("default");
    openModal({ deepLinkHandoffNotify: false, enableNotifications: false });
    closeModal();
    expect(requestCalls).toHaveLength(0);
  });

  test("只有水球通知開著也要請求（它從來不曾自己問過權限）", () => {
    installNotification("default");
    openModal({ deepLinkHandoffNotify: false, enableNotifications: true });
    closeModal();
    expect(requestCalls).toHaveLength(1);
  });

  // 使用者在設定頁裡把通知關掉才按關閉 → 依關閉當下的值判斷，不是開啟時的值。
  test("關掉開關後才關閉設定頁 → 不請求", () => {
    installNotification("default");
    openModal({ enableNotifications: false });
    fireEvent.click(document.querySelector('[name="deepLinkHandoffNotify"]'));
    closeModal();
    expect(requestCalls).toHaveLength(0);
  });
});
