// 設定面板「設定備份」分頁的 UI 契約（jsdom + @testing-library/react）。
// 這個分頁收三件事：匯出成檔案、從檔案匯入、雲端同步（從一般分頁搬過來）。
// 守的重點：
//   1) 匯出檔**永遠不含** PTT 帳號／密碼／2FA 金鑰（純邏輯的回歸在
//      tests/unit/pref_backup.test.js，這裡守 UI 這條路真的走那支函式）
//   2) 匯入＝立即寫入 localStorage 並走 onReset 全量套用（對話框沒有取消鈕）
//   3) 壞檔案不得寫入任何東西
//   4) 雲端同步的登入入口在這一頁，不在一般分頁
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { PrefModal } from "../../src/components/ContextMenu/PrefModal";
import { setupI18n, i18n } from "../../src/js/i18n";
import { DEFAULT_PREFS } from "../../src/js/pref_storage";
import { downloadAsFile } from "../../src/js/util";

// 雲端同步不是本測試的標的，且會拉 Firebase SDK。
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

// 只換掉 downloadAsFile（jsdom 沒有真的下載），其餘照原樣（PrefModal 也用
// DEFAULT_PROXY_HOST）。
vi.mock("../../src/js/util", async (importOriginal) => ({
  ...(await importOriginal()),
  downloadAsFile: vi.fn(),
}));

const PREF_KEY = "pttchrome.pref.v1";

// jsdom 沒有 matchMedia / ResizeObserver，Mantine 的 useMantineColorScheme 與
// Modal 會直接炸。最小 stub，與被測行為無關。
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

const onReset = vi.fn();

const renderModal = (prefs = {}) => {
  window.localStorage.setItem(
    PREF_KEY,
    JSON.stringify({ values: { ...DEFAULT_PREFS, ...prefs } }),
  );
  render(
    <MantineProvider>
      <PrefModal
        show
        onSave={() => {}}
        onReset={onReset}
        debugMode={false}
        onDebugModeChange={() => {}}
      />
    </MantineProvider>,
  );
};

const openBackupTab = (prefs = {}) => {
  renderModal(prefs);
  fireEvent.click(screen.getByRole("tab", { name: i18n("options_backup") }));
};

const storedValues = () =>
  JSON.parse(window.localStorage.getItem(PREF_KEY)).values;

// 觸發隱藏的 input[type=file]（按鈕只是轉發點擊）。file.text() 是 async，
// 所以等到三則結果訊息其中一則出現才算處理完。
const importJson = async (json, filename = "backup.json") => {
  const input = document.querySelector('input[name="backupImportFile"]');
  const file = new File([json], filename, { type: "application/json" });
  fireEvent.change(input, { target: { files: [file] } });
  const messages = [
    "options_backupImported",
    "options_backupErrorBadJson",
    "options_backupErrorBadFormat",
  ].map(i18n);
  await waitFor(() =>
    expect(messages.some((m) => screen.queryByText(m))).toBe(true),
  );
};

const withCredentials = {
  autoLogin: true,
  autoLoginUser: "someuser",
  autoLoginPassword: "s3cret",
  autoLoginOtpSecret: "JBSWY3DPEHPK3PXP",
  enableWorkMode: true,
};

beforeAll(() => setupI18n());

beforeEach(() => {
  window.localStorage.clear();
  downloadAsFile.mockClear();
  onReset.mockClear();
});

describe("設定備份分頁：匯出", () => {
  test("按下匯出 → 觸發下載，檔名帶時間戳", () => {
    openBackupTab();
    fireEvent.click(
      screen.getByRole("button", { name: i18n("options_backupExportBtn") }),
    );

    expect(downloadAsFile).toHaveBeenCalledTimes(1);
    const [filename, , mime] = downloadAsFile.mock.calls[0];
    expect(filename).toMatch(/^pttchrome-prefs-\d{8}-\d{6}\.json$/);
    expect(mime).toBe("application/json");
  });

  test("匯出內容不含帳號／密碼／2FA 金鑰", () => {
    openBackupTab(withCredentials);
    fireEvent.click(
      screen.getByRole("button", { name: i18n("options_backupExportBtn") }),
    );

    const text = downloadAsFile.mock.calls[0][1];
    expect(text).not.toContain("s3cret");
    expect(text).not.toContain("someuser");
    expect(text).not.toContain("JBSWY3DPEHPK3PXP");
    const payload = JSON.parse(text);
    expect(payload.prefs).not.toHaveProperty("autoLoginPassword");
    // 非機密的設定照樣帶走。
    expect(payload.prefs.fontSize).toBe(DEFAULT_PREFS.fontSize);
  });

  test("匯出的是當下表單值（含還沒關閉存檔的修改）", () => {
    openBackupTab();
    fireEvent.click(screen.getByRole("tab", { name: i18n("options_general") }));
    fireEvent.click(
      document.querySelector('label[for="pref-check-copyOnSelect"]'),
    );
    fireEvent.click(screen.getByRole("tab", { name: i18n("options_backup") }));
    fireEvent.click(
      screen.getByRole("button", { name: i18n("options_backupExportBtn") }),
    );

    expect(JSON.parse(downloadAsFile.mock.calls[0][1]).prefs.copyOnSelect).toBe(
      !DEFAULT_PREFS.copyOnSelect,
    );
  });
});

describe("設定備份分頁：匯入", () => {
  test("匯入立即寫入 localStorage 並走 onReset 全量套用", async () => {
    openBackupTab({ fontSize: 20 });
    await importJson(JSON.stringify({ prefs: { fontSize: 28, lineWrap: 60 } }));

    expect(storedValues().fontSize).toBe(28);
    expect(storedValues().lineWrap).toBe(60);
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(onReset.mock.calls[0][0].fontSize).toBe(28);
    expect(
      screen.getByText(i18n("options_backupImported")),
    ).toBeInTheDocument();
  });

  test("匯入後表單同步更新（切到一般分頁看得到新值）", async () => {
    openBackupTab({ copyOnSelect: false });
    await importJson(JSON.stringify({ prefs: { copyOnSelect: true } }));

    fireEvent.click(screen.getByRole("tab", { name: i18n("options_general") }));
    expect(document.querySelector('input[name="copyOnSelect"]')).toBeChecked();
  });

  test("備份檔沒提到的設定回預設值，不是保留本機現值", async () => {
    openBackupTab({ fontSize: 30, lineWrap: 99 });
    await importJson(JSON.stringify({ prefs: { lineWrap: 60 } }));

    expect(storedValues().lineWrap).toBe(60);
    expect(storedValues().fontSize).toBe(DEFAULT_PREFS.fontSize);
  });

  test("憑證與上班模式不受匯入影響（即使檔案裡硬塞）", async () => {
    openBackupTab(withCredentials);
    await importJson(
      JSON.stringify({
        prefs: {
          fontSize: 28,
          autoLoginUser: "evil",
          autoLoginPassword: "evil",
          autoLoginOtpSecret: "EVIL",
          enableWorkMode: false,
        },
      }),
    );

    const v = storedValues();
    expect(v.fontSize).toBe(28);
    expect(v.autoLoginUser).toBe("someuser");
    expect(v.autoLoginPassword).toBe("s3cret");
    expect(v.autoLoginOtpSecret).toBe("JBSWY3DPEHPK3PXP");
    expect(v.enableWorkMode).toBe(true);
  });

  test("壞掉的 JSON → 顯示錯誤，且完全不動 localStorage", async () => {
    openBackupTab({ fontSize: 30 });
    await importJson("{not json");

    expect(storedValues().fontSize).toBe(30);
    expect(onReset).not.toHaveBeenCalled();
    expect(
      screen.getByText(i18n("options_backupErrorBadJson")),
    ).toBeInTheDocument();
  });

  test("不是設定備份檔 → 顯示錯誤，且完全不動 localStorage", async () => {
    openBackupTab({ fontSize: 30 });
    await importJson(JSON.stringify({ hello: "world" }));

    expect(storedValues().fontSize).toBe(30);
    expect(onReset).not.toHaveBeenCalled();
    expect(
      screen.getByText(i18n("options_backupErrorBadFormat")),
    ).toBeInTheDocument();
  });

  test("匯出的檔案匯得回來（往返）", async () => {
    openBackupTab({ fontSize: 26, lineWrap: 60 });
    fireEvent.click(
      screen.getByRole("button", { name: i18n("options_backupExportBtn") }),
    );
    const exported = downloadAsFile.mock.calls[0][1];

    await importJson(exported);

    expect(storedValues().fontSize).toBe(26);
    expect(storedValues().lineWrap).toBe(60);
  });
});

describe("設定備份分頁：雲端同步", () => {
  test("雲端同步的登入入口在備份分頁，不在一般分頁", () => {
    renderModal();

    fireEvent.click(screen.getByRole("tab", { name: i18n("options_general") }));
    expect(
      screen.queryByRole("button", { name: i18n("options_syncSignIn") }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: i18n("options_backup") }));
    expect(
      screen.getByRole("button", { name: i18n("options_syncSignIn") }),
    ).toBeInTheDocument();
  });
});
