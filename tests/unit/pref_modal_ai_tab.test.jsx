// 設定面板「AI」分頁的 UI 契約（jsdom + @testing-library/react）。
// 守的是使用者定案的三條規則：
//   1) 總開關 enableAi 是**總閘門**——關閉時所有子選項反灰，但值原樣保留。
//   2) 未支援／裝置不符的瀏覽器：分頁照常顯示，總開關與子選項全部反灰。
//   3) 勾選總開關即帶著 user activation 觸發模型下載；取消勾選釋放 session。
// 顯示條件一律以 availability() 探測結果為準（Chromium 有 window.LanguageModel
// 這個 global 卻沒有模型，見 docs/enhanced-addon.md 踩坑 A）。
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { PrefModal } from "../../src/components/ContextMenu/PrefModal";
import { setupI18n, i18n } from "../../src/js/i18n";
import { DEFAULT_PREFS } from "../../src/js/pref_storage";

// 雲端同步不是本測試的標的，且會拉 Firebase SDK。
vi.mock("../../src/js/pref_sync", () => ({
  savePrefs: vi.fn(),
  signIn: vi.fn(() => Promise.resolve()),
  signOut: vi.fn(() => Promise.resolve()),
  onAuthState: vi.fn(() => () => {}),
}));

const ensurePromptApiModel = vi.fn(() => Promise.resolve("available"));
const destroyPromptApi = vi.fn();
let availability = "available";

vi.mock("../../src/js/prompt_api", () => ({
  promptApiAvailability: () => Promise.resolve(availability),
  ensurePromptApiModel: (...a) => ensurePromptApiModel(...a),
  destroyPromptApi: (...a) => destroyPromptApi(...a),
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
        onReset={() => {}}
        debugMode={false}
        onDebugModeChange={() => {}}
      />
    </MantineProvider>,
  );
};

// 以指定 prefs 開啟面板並切到 AI 分頁。
const openAiTab = (prefs = {}) => {
  renderModal(prefs);
  fireEvent.click(screen.getByRole("tab", { name: i18n("options_ai") }));
};

const cb = (name) => document.querySelector(`input[name="${name}"]`);
// 點 label 文字（非方框）→ 順帶守 PrefCheckbox 的 id/htmlFor 關聯不脫落。
const clickPref = (name) =>
  fireEvent.click(document.querySelector(`label[for="pref-check-${name}"]`));

beforeAll(() => setupI18n());

beforeEach(() => {
  availability = "available";
  ensurePromptApiModel.mockClear();
  destroyPromptApi.mockClear();
  window.localStorage.clear();
});

describe("AI 分頁：總閘門", () => {
  test("總開關關閉 → 子選項反灰，但勾選狀態（值）原樣保留", () => {
    openAiTab({
      enableAi: false,
      enableCaptionAi: true,
      enableUrlAi: true,
      enableBareDomainLink: true,
    });

    expect(cb("enableAi")).not.toBeDisabled();
    expect(cb("enableCaptionAi")).toBeDisabled();
    expect(cb("enableUrlAi")).toBeDisabled();
    // 反灰 ≠ 清空：重開總開關就回到先前的組合。
    expect(cb("enableCaptionAi")).toBeChecked();
    expect(cb("enableUrlAi")).toBeChecked();
  });

  test("總開關開啟 → 子選項解除反灰", () => {
    openAiTab({ enableAi: true, enableBareDomainLink: true });
    expect(cb("enableCaptionAi")).not.toBeDisabled();
    expect(cb("enableUrlAi")).not.toBeDisabled();
  });

  test("enableUrlAi 仍依附增強功能分頁的裸網域自動連結", () => {
    openAiTab({ enableAi: true, enableBareDomainLink: false });
    expect(cb("enableCaptionAi")).not.toBeDisabled();
    expect(cb("enableUrlAi")).toBeDisabled();
  });
});

describe("AI 分頁：不支援的瀏覽器／裝置", () => {
  test.each(["unsupported", "unavailable"])(
    "%s → 分頁照常顯示，總開關與子選項全部反灰並附狀態說明",
    async (state) => {
      availability = state;
      openAiTab({ enableAi: true, enableBareDomainLink: true });

      await waitFor(() => expect(cb("enableAi")).toBeDisabled());
      expect(cb("enableCaptionAi")).toBeDisabled();
      expect(cb("enableUrlAi")).toBeDisabled();
      expect(
        screen.getByText(i18n("options_aiStatus_" + state)),
      ).toBeInTheDocument();
    },
  );
});

describe("AI 分頁：模型下載", () => {
  test("勾選總開關即觸發下載（那一次點擊就是 user activation）", async () => {
    availability = "downloadable";
    openAiTab({ enableAi: false });

    await waitFor(() => expect(cb("enableAi")).not.toBeDisabled());
    clickPref("enableAi");

    expect(cb("enableAi")).toBeChecked();
    expect(ensurePromptApiModel).toHaveBeenCalledTimes(1);
  });

  test("取消勾選 → 釋放常駐 session，不再觸發下載", () => {
    openAiTab({ enableAi: true });

    clickPref("enableAi");

    expect(cb("enableAi")).not.toBeChecked();
    expect(destroyPromptApi).toHaveBeenCalledTimes(1);
    expect(ensurePromptApiModel).not.toHaveBeenCalled();
  });

  test("已勾選但模型未下載（跨裝置同步）→ 出現補救的下載按鈕", async () => {
    availability = "downloadable";
    openAiTab({ enableAi: true });

    // 勾選那一次的 user activation 早在別台機器用掉了，需要另一個入口。
    const btn = await screen.findByRole("button", {
      name: i18n("options_aiDownloadBtn"),
    });
    expect(btn).toBeInTheDocument();
  });

  test("模型已就緒 → 不出現下載按鈕", async () => {
    openAiTab({ enableAi: true });
    await waitFor(() =>
      expect(
        screen.getByText(i18n("options_aiStatus_available")),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: i18n("options_aiDownloadBtn") }),
    ).toBeNull();
  });
});

// 「AI 設定已全數移出增強功能分頁」守在 offline e2e
// （tests/e2e/offline/ui_behavior.offline.spec.js 的分頁切換那條）：enhance 分頁
// 有 Mantine autosize Textarea，jsdom 缺 layout API 會讓它在 mount 時就炸，
// 這條只有真瀏覽器測得動。
