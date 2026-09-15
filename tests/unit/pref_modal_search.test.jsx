// 設定頁搜尋框的 UI 契約。
//
// 純邏輯（比對／排序）在 pref_search.test.js，索引覆蓋度在
// pref_search_index.test.js。這裡只驗**接起來之後**的行為：搜尋框在哪、打字會
// 不會出下拉、選了之後有沒有真的切分頁並標出那一項，以及不能誤傷的既有契約
// （Escape 的歸屬、e2e marker、不會多寫一次 pref）。
//
// 「有沒有真的捲動」測不到（jsdom 沒有版面，scrollIntoView 是 setup.js 的
// stub）——那條在 tests/e2e/offline/pref_search.offline.spec.js。
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import {
  PrefModal,
  PREF_FLASH_CLASS,
} from "../../src/components/ContextMenu/PrefModal";
import { setupI18n, i18n } from "../../src/js/i18n";
import { PREF_SEARCH_ITEMS } from "../../src/js/pref_search";
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

const onSave = vi.fn();

const openModal = (prefs = {}) => {
  window.localStorage.setItem(
    PREF_KEY,
    JSON.stringify({ values: { ...DEFAULT_PREFS, ...prefs } }),
  );
  return render(
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
};

const searchBox = () =>
  screen.getByLabelText(i18n("options_settingsSearchLabel"));

const type = (text) => {
  const box = searchBox();
  fireEvent.change(box, { target: { value: text } });
  return box;
};

// 只抓**搜尋框自己的**選項：畫面上其他 Mantine Select 的選項同樣是
// role=option 且已 mount，全域抓會把它們一起撈進來。
const options = () => [
  ...document.querySelectorAll(".PrefModal__Search__Dropdown [role='option']"),
];

// Mantine Combobox 預設 keepMounted + keepMountedMode:"display-none"，所以下拉的
// DOM **永遠在**，關閉時只是被加上 inline 的 display:none。⇒ 判斷「開了沒」不能
// 數 option 數量（關閉後照樣是 8 個），要看可見性。
const dropdown = () => document.querySelector(".PrefModal__Search__Dropdown");
const anchorOf = (key) => document.querySelector(`[data-pref-anchor="${key}"]`);

beforeAll(() => {
  // jsdom 預設語系是 en-US，i18n 與 searchPrefSettings 都讀它。不釘成 zh-TW
  // 的話「好讀」這種查詢會走到「另一語系命中」那條分支，測到的就不是預期的
  // 情境（而且不會畫高亮，因為 ranges 只在當前語系標題命中時才有值）。
  Object.defineProperty(navigator, "languages", {
    value: ["zh-TW"],
    configurable: true,
  });
  setupI18n();
});
beforeEach(() => {
  onSave.mockClear();
  prefSync.savePrefs.mockClear();
  window.localStorage.clear();
});

describe("設定搜尋框", () => {
  test("在左欄，且不在任何分頁內容裡", () => {
    openModal();
    const box = searchBox();
    expect(box.closest(".PrefModal__Grid__Col--left")).toBeTruthy();
    // 這條同時保護 pref_modal_mouse_tab.test.jsx 的「panel 裡所有
    // aria-haspopup=listbox 都要 disabled」——搜尋框也有那個屬性，只要它不在
    // panel 內就不會被那支測試掃到。
    expect(box.closest("[role='tabpanel']")).toBeNull();
  });

  test("沒打字時下拉是收起來的", () => {
    openModal();
    expect(dropdown()).not.toBeVisible();
  });

  test("打字後列出結果，含分頁名與項目標題", () => {
    openModal();
    type("好讀");
    const rows = options();
    expect(rows.length).toBeGreaterThan(0);
    const text = rows.map((r) => r.textContent).join("\n");
    expect(text).toContain(i18n("options_enableEasyReading"));
    expect(text).toContain(i18n("options_general"));
  });

  test("命中片段被標示出來", () => {
    openModal();
    type("好讀");
    const marks = document.querySelectorAll("mark.PrefModal__Search__Mark");
    expect(marks.length).toBeGreaterThan(0);
    marks.forEach((m) => expect(m.textContent).toBe("好讀"));
  });

  test("查無結果時顯示提示，不是一片空白", () => {
    openModal();
    type("zzzzznotathing");
    expect(dropdown()).toBeVisible();
    expect(options().length).toBe(0);
    expect(screen.getByText(i18n("options_settingsSearchEmpty"))).toBeVisible();
  });

  test("點選結果會切到該分頁並標出那一項", async () => {
    openModal();
    type("好讀");
    const row = options().find((r) =>
      r.textContent.includes(i18n("options_enableEasyReading")),
    );
    fireEvent.click(row);

    const tab = screen.getByRole("tab", { name: i18n("options_general") });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    await waitFor(() => {
      expect(anchorOf("enableEasyReading")).toBeTruthy();
      expect(
        anchorOf("enableEasyReading").classList.contains(PREF_FLASH_CLASS),
      ).toBe(true);
    });
  });

  test("Enter 直接送出第一筆（不必先按方向鍵）", async () => {
    openModal();
    const box = type("滑鼠瀏覽");
    await waitFor(() => expect(options().length).toBeGreaterThan(0));
    fireEvent.keyDown(box, { key: "Enter", code: "Enter" });

    const tab = screen.getByRole("tab", { name: i18n("options_mouse") });
    await waitFor(() => expect(tab.getAttribute("aria-selected")).toBe("true"));
  });

  test("方向鍵可以換選項（會走到 Mantine 的 scrollIntoView）", async () => {
    openModal();
    const box = type("好讀");
    await waitFor(() => expect(options().length).toBeGreaterThan(1));
    // 沒有 setup.js 的 scrollIntoView stub 的話，這一行會直接丟 TypeError。
    fireEvent.keyDown(box, { key: "ArrowDown", code: "ArrowDown" });
    const second = options()[1];
    expect(second.getAttribute("data-combobox-selected")).toBe("true");
  });

  test("跳到條件渲染的『自動登入』分頁也找得到目標", async () => {
    openModal();
    // 這一頁刻意只在切過去時才渲染（避免瀏覽器密碼管理員誤觸發），所以錨點在
    // 點下去的那一刻根本還不存在 —— 跳轉必須等一個 frame。
    expect(anchorOf("autoLoginPassword")).toBeNull();
    type("autoLoginPassword");
    const row = options()[0];
    fireEvent.click(row);
    await waitFor(() => {
      const node = anchorOf("autoLoginPassword");
      expect(node).toBeTruthy();
      expect(node.classList.contains(PREF_FLASH_CLASS)).toBe(true);
    });
  });

  test("下拉開著時 Escape 只關下拉，不關設定頁", async () => {
    openModal();
    const box = type("好讀");
    expect(dropdown()).toBeVisible();
    // Combobox.Target 會在下拉開著時掛上 data-mantine-stop-propagation，
    // Modal 的 window+capture Esc 監聽就會放過這一次。stopPropagation() 對
    // capture 階段的監聽無效，所以這個屬性是唯一的機制。
    expect(box.getAttribute("data-mantine-stop-propagation")).toBe("true");

    fireEvent.keyDown(box, { key: "Escape", code: "Escape" });

    await waitFor(() => expect(dropdown()).not.toBeVisible());
    expect(onSave).not.toHaveBeenCalled();
    // 屬性跟著消失 ⇒ 下一次 Esc 就歸設定頁了。
    expect(box.getAttribute("data-mantine-stop-propagation")).toBeNull();
  });

  test("只是搜尋不會寫入或上傳 pref", () => {
    openModal();
    type("好讀");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    // 查詢字是純 UI state，沒進 values ⇒ onCloseClick 的 deepEqual 會短路，
    // 不該多 ping 其他裝置一次。
    expect(prefSync.savePrefs).not.toHaveBeenCalled();
  });

  test("重開設定頁時查詢字與高亮都清乾淨", async () => {
    const { rerender } = openModal();
    type("好讀");
    fireEvent.click(options()[0]);
    await waitFor(() =>
      expect(document.querySelector(`.${PREF_FLASH_CLASS}`)).toBeTruthy(),
    );

    const modal = (show) => (
      <MantineProvider>
        <PrefModal
          show={show}
          onSave={onSave}
          onReset={() => {}}
          debugMode={false}
          onDebugModeChange={() => {}}
        />
      </MantineProvider>
    );
    rerender(modal(false));
    rerender(modal(true));

    expect(searchBox().value).toBe("");
    expect(document.querySelector(`.${PREF_FLASH_CLASS}`)).toBeNull();
  });
});

describe("錨點覆蓋度（索引裡每一項都跳得到）", () => {
  // 靜態掃描（pref_search_index.test.js）只能確認原始碼裡寫了錨點；條件渲染、
  // 打錯 key、adapter 沒把屬性傳下去這些都要真的 render 才看得出來。
  const byTab = {};
  PREF_SEARCH_ITEMS.forEach((it) => {
    (byTab[it.tab] ||= []).push(it);
  });

  const TAB_LABEL_KEY = {
    general: "options_general",
    mouse: "options_mouse",
    connection: "options_connection",
    enhance: "options_enhance",
    quicksearch: "options_quickSearch",
    autologin: "options_autoLoginTab",
    ai: "options_ai",
    local: "options_local",
    backup: "options_backup",
    about: "options_about",
  };

  // 終端機大小的兩種模式是互斥的渲染分支：fixed-term-size 出欄／列數，
  // fixed-font-size 出字級。兩種都跑一次取聯集，才涵蓋得到全部欄位。
  const anchorsInTab = (tab, prefs) => {
    const { unmount } = openModal(prefs);
    fireEvent.click(
      screen.getByRole("tab", { name: i18n(TAB_LABEL_KEY[tab]) }),
    );
    const found = new Set(
      [...document.querySelectorAll("[data-pref-anchor]")].map((el) =>
        el.getAttribute("data-pref-anchor"),
      ),
    );
    unmount();
    return found;
  };

  Object.entries(byTab).forEach(([tab, items]) => {
    test(`「${tab}」分頁的 ${items.length} 個錨點都在 DOM 裡`, () => {
      const found = new Set([
        ...anchorsInTab(tab, { termSizeMode: "fixed-term-size" }),
        ...anchorsInTab(tab, { termSizeMode: "fixed-font-size" }),
      ]);
      const missing = items.filter((it) => !found.has(it.key)).map((it) => it.key);
      expect(`${tab} 缺錨點: ${missing.join(", ")}`).toBe(`${tab} 缺錨點: `);
    });
  });
});

describe("既有 e2e marker 未被破壞", () => {
  test("checkbox 的 id/name 契約還在", () => {
    openModal();
    const input = document.getElementById("pref-check-enableEasyReading");
    expect(input).toBeTruthy();
    expect(input.getAttribute("type")).toBe("checkbox");
    expect(input.getAttribute("name")).toBe("enableEasyReading");
    // label[for=…] 是「點文字也能切換」與 e2e 定位的依據。
    expect(
      document.querySelector('label[for="pref-check-enableEasyReading"]'),
    ).toBeTruthy();
  });

  test("加了錨點的輸入元件仍保有 name", () => {
    openModal();
    expect(document.querySelector('[name="mouseWheel"]')).toBeTruthy();
    expect(document.querySelector('[name="fontFace"]')).toBeTruthy();
  });

  test("錨點掛在整列外框上，不是掛在 input 上", () => {
    openModal();
    const node = anchorOf("enableEasyReading");
    // 掛錯地方（落到 <input>）的話捲動與高亮都只會作用在那個小方塊上。
    expect(node.tagName).not.toBe("INPUT");
    expect(node.contains(document.getElementById("pref-check-enableEasyReading"))).toBe(
      true,
    );
    // wrapperProps.className 會蓋掉 Mantine 的 root class —— 這條顧的是那個坑。
    expect(node.className).toContain("mantine-Checkbox-root");
  });
});
