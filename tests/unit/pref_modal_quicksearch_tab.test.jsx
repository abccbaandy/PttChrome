// 設定面板「快速搜尋」分頁的 UI 契約。
// 內建項目只能停用（pref 只存被停用的 id，見 pref_storage.js#quickSearchDisabled），
// 自訂項目可新增／編輯／刪除；全部走既有的「關閉時才寫入 localStorage」路徑。
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

const openTab = (prefs = {}) => {
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
  fireEvent.click(
    screen.getByRole("tab", { name: i18n("options_quickSearch") }),
  );
};

// 設定是「關閉時才寫入」，所以每條斷言都要先關掉對話框再讀 localStorage。
const closeModal = () =>
  fireEvent.click(screen.getByRole("button", { name: "Close" }));

const builtinCheckbox = (id) =>
  document.querySelector(`[name="quickSearchBuiltin-${id}"]`);
const rows = () => document.querySelectorAll(".PrefModal__QuickSearchRow");

beforeAll(() => setupI18n());
beforeEach(() => window.localStorage.clear());

describe("快速搜尋分頁：內建項目", () => {
  test("三個內建項目都畫出來且預設全啟用", () => {
    openTab();
    for (const id of ["google", "pixiv-user", "pixiv-artwork"]) {
      expect(builtinCheckbox(id)).toBeChecked();
    }
  });

  test("取消勾選 → 關閉後只存下被停用的 id", () => {
    openTab();
    fireEvent.click(builtinCheckbox("google"));
    closeModal();
    expect(readValuesWithDefault().quickSearchDisabled).toEqual(["google"]);
  });

  test("重新勾回 → 該 id 從停用清單移除（不會重複塞）", () => {
    openTab({ quickSearchDisabled: ["google"] });
    expect(builtinCheckbox("google")).not.toBeChecked();
    fireEvent.click(builtinCheckbox("google"));
    closeModal();
    expect(readValuesWithDefault().quickSearchDisabled).toEqual([]);
  });
});

describe("快速搜尋分頁：自訂項目", () => {
  test("新增 → 填名稱與網址 → 關閉後寫進 quickSearchCustom", () => {
    openTab();
    expect(rows()).toHaveLength(0);

    fireEvent.click(
      screen.getByRole("button", { name: i18n("options_quickSearchAdd") }),
    );
    expect(rows()).toHaveLength(1);

    const row = rows()[0];
    fireEvent.change(row.querySelector(".PrefModal__QuickSearchRow__Name input"), {
      target: { value: "巴哈" },
    });
    fireEvent.change(row.querySelector(".PrefModal__QuickSearchRow__Url input"), {
      target: { value: "https://acg.gamer.com.tw/search.php?kw=%s" },
    });
    closeModal();

    expect(readValuesWithDefault().quickSearchCustom).toMatchObject([
      {
        name: "巴哈",
        urlTemplate: "https://acg.gamer.com.tw/search.php?kw=%s",
        match: "any",
        enabled: true,
      },
    ]);
  });

  test("按了新增卻沒填 → 關閉時整列被丟掉，不留半成品在偏好裡", () => {
    openTab();
    fireEvent.click(
      screen.getByRole("button", { name: i18n("options_quickSearchAdd") }),
    );
    closeModal();
    expect(readValuesWithDefault().quickSearchCustom).toEqual([]);
  });

  test("刪除鈕移除該列", () => {
    openTab({
      quickSearchCustom: [
        {
          id: "c1",
          name: "甲",
          urlTemplate: "https://a.test/?q=%s",
          match: "any",
          enabled: true,
        },
        {
          id: "c2",
          name: "乙",
          urlTemplate: "https://b.test/?q=%s",
          match: "any",
          enabled: true,
        },
      ],
    });
    expect(rows()).toHaveLength(2);
    fireEvent.click(
      rows()[0].querySelector(
        `[aria-label="${i18n("options_quickSearchDelete")}"]`,
      ),
    );
    closeModal();
    expect(
      readValuesWithDefault().quickSearchCustom.map((c) => c.id),
    ).toEqual(["c2"]);
  });

  test("網址缺 %s → 該欄顯示錯誤訊息", () => {
    openTab({
      quickSearchCustom: [
        {
          id: "c1",
          name: "壞的",
          urlTemplate: "https://a.test/search",
          match: "any",
          enabled: true,
        },
      ],
    });
    expect(screen.getByText(i18n("quicksearch_err_url"))).toBeInTheDocument();
  });

  test("剛新增的空白列不噴紅字（還沒開始填就罵人很煩）", () => {
    openTab();
    fireEvent.click(
      screen.getByRole("button", { name: i18n("options_quickSearchAdd") }),
    );
    expect(screen.queryByText(i18n("quicksearch_err_name"))).toBeNull();
    expect(screen.queryByText(i18n("quicksearch_err_url"))).toBeNull();
  });
});
