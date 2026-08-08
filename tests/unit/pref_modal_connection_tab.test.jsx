// 設定面板「連線」分頁的 UI 契約（jsdom + @testing-library/react）。
// 這個分頁把「連線相關」的設定從一般分頁抽出來獨立成一頁，收兩組：
//   1) BBS proxy（useProxy / proxyUrl）——原本埋在一般分頁最下面
//   2) imgur 圖片快取代理（useImgurProxy / imgurProxyUrl）
// 兩組形狀相同：Checkbox 當閘門，URL 欄位在閘門關閉時反灰但**值保留**，
// 且 URL 欄位預設就填好可用位址（使用者不必知道要填什麼）。
//
// imgur 代理**預設開啟**且代理由專案方持有 ⇒ 隱私揭露文字必須真的渲染出來，
// 這是決定預設開啟時對使用者的承諾，故釘一條測試守護。
import { render, screen, fireEvent } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { PrefModal } from "../../src/components/ContextMenu/PrefModal";
import { setupI18n, i18n } from "../../src/js/i18n";
import { DEFAULT_PREFS } from "../../src/js/pref_storage";
import { DEFAULT_IMGUR_PROXY_BASE } from "../../src/js/imgur_proxy";
import { DEFAULT_PROXY_HOST } from "../../src/js/util";

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

const openConnectionTab = (prefs = {}) => {
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
  fireEvent.click(screen.getByRole("tab", { name: i18n("options_connection") }));
};

const field = (name) => document.querySelector(`[name="${name}"]`);

beforeAll(() => setupI18n());
beforeEach(() => window.localStorage.clear());

describe("連線分頁：兩組代理設定都在這一頁", () => {
  test("BBS proxy 與 imgur 圖片代理的四個欄位同時可見", () => {
    openConnectionTab();
    for (const name of [
      "useProxy",
      "proxyUrl",
      "useImgurProxy",
      "imgurProxyUrl",
    ]) {
      expect(field(name)).toBeInTheDocument();
    }
  });

  // 「已從一般分頁搬走」用「落在哪個 tabpanel」來鎖：Mantine Tabs 預設 keepMounted，
  // 未選中的分頁內容仍留在 DOM，所以不能用「存不存在」判斷（可見性那層守在
  // tests/e2e/offline/ui_behavior.offline.spec.js 的分頁切換那條）。
  test("proxy 欄位與一般分頁的設定不在同一個分頁", () => {
    openConnectionTab();
    const panelOf = (name) => field(name).closest('[role="tabpanel"]');
    expect(panelOf("proxyUrl")).toBe(panelOf("imgurProxyUrl"));
    expect(panelOf("proxyUrl")).not.toBe(panelOf("copyOnSelect"));
  });
});

describe("連線分頁：閘門與 URL 欄位", () => {
  test.each([
    ["useProxy", "proxyUrl", "my.example.dev"],
    ["useImgurProxy", "imgurProxyUrl", "https://my.example.dev"],
  ])("%s 關閉時 %s 反灰，但自訂值保留", (toggle, url, custom) => {
    openConnectionTab({ [toggle]: false, [url]: custom });
    expect(field(url)).toBeDisabled();
    expect(field(url).value).toBe(custom);
  });

  test.each([
    ["useProxy", "proxyUrl"],
    ["useImgurProxy", "imgurProxyUrl"],
  ])("%s 開啟時 %s 可編輯", (toggle, url) => {
    openConnectionTab({ [toggle]: true });
    expect(field(url)).not.toBeDisabled();
  });

  // 核心設計：**欄位預設是空的，預設位址放在 placeholder**。使用者只要勾開關就能用
  // （空＝用預設），想自架就覆寫，把自訂值刪光又回到預設——不會刪成「開著卻沒位址」。
  test.each([
    ["proxyUrl", DEFAULT_PROXY_HOST],
    ["imgurProxyUrl", DEFAULT_IMGUR_PROXY_BASE],
  ])("%s 預設留空，預設位址顯示在 placeholder", (name, fallback) => {
    openConnectionTab();
    expect(field(name).value).toBe("");
    expect(field(name)).toHaveAttribute("placeholder", fallback);
  });

  test("自訂位址刪光後值是空字串（由純函式回退到預設位址）", () => {
    openConnectionTab({ imgurProxyUrl: "https://my.example.dev" });
    fireEvent.change(field("imgurProxyUrl"), { target: { value: "" } });
    expect(field("imgurProxyUrl").value).toBe("");
    // 回退本身守在 imgur_proxy.test.js / proxy_site.test.js（純函式層）。
  });

  test("imgur 代理預設開啟", () => {
    openConnectionTab();
    expect(field("useImgurProxy")).toBeChecked();
    expect(field("imgurProxyUrl")).not.toBeDisabled();
  });
});

describe("連線分頁：隱私揭露", () => {
  test("imgur 代理的揭露文字有渲染出來", () => {
    openConnectionTab();
    expect(screen.getByText(i18n("tooltip_imgurProxy"))).toBeInTheDocument();
  });
});
