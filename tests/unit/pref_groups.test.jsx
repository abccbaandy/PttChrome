// @unit-env browser
// 設定「一般」分區的段落小標＋黏在上緣的跳轉列（P94，src/js/pref_groups.js）。
// 真版面：Mantine 與 PrefModal 的 CSS 以 ?raw 注入，視窗大小用 page.viewport 真的改
// （同 pref_modal_narrow.test.jsx）。
import { render, fireEvent } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { page } from "vitest/browser";
import mantineCss from "@mantine/core/styles.css?raw";
import prefModalCss from "../../src/components/ContextMenu/PrefModal.css?raw";
import { PrefModal } from "../../src/components/ContextMenu/PrefModal";
import { GENERAL_GROUPS, groupTitleByKey } from "../../src/js/pref_groups";
import {
  PREF_SEARCH_ITEMS,
  prefSectionItems,
  prefSectionRows,
  prefShown,
  searchPrefSettings,
} from "../../src/js/pref_search";
import { setupI18n, i18n } from "../../src/js/i18n";
import {
  DEFAULT_PREFS,
  NATIVE_SAFE_MODE_KEYS,
} from "../../src/js/pref_storage";

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
afterEach(() => page.viewport(1024, 768));

const openModal = ({ mobile = false } = {}) =>
  render(
    <MantineProvider>
      <PrefModal
        show
        mobile={mobile}
        onSave={() => {}}
        onReset={() => {}}
        debugMode={false}
        onDebugModeChange={() => {}}
      />
    </MantineProvider>,
  );
const mounted = () =>
  vi.waitFor(() => {
    const el = document.querySelector('[data-pref-group="basic"]');
    if (!el || !el.offsetParent) throw new Error("general tab not shown");
    return el;
  });
const rightCol = () => document.querySelector(".PrefModal__Grid__Col--right");
const bar = () => document.querySelector(".PrefModal__GroupNav");
const heading = (id) => document.querySelector(`[data-pref-group="${id}"]`);
const jumpBtn = (id) =>
  document.querySelector(`[data-pref-group-jump="${id}"]`);

describe("段落定義（純邏輯）", () => {
  test("每段從 first 那一項開始，到下一段的 first 之前", () => {
    const keys = [
      "nativeSafeMode",
      "a",
      "enableEasyReading",
      "b",
      "enableHomeDashboard",
      "enableBoardTabs",
      "easyReadingEndSwitchKey",
      "refreshKeyIntercept",
      "z",
    ];
    const m = groupTitleByKey(keys);
    expect(m.get("a")).toBe("options_groupBasic");
    expect(m.get("b")).toBe("options_groupEasyReading");
    expect(m.get("enableHomeDashboard")).toBe("options_groupHome");
    expect(m.get("z")).toBe("options_groupMisc");
  });

  test("索引裡「一般」分區的順序跟段落定義一致（每個 first 都在、照順序）", () => {
    const keys = PREF_SEARCH_ITEMS.filter(
      (it) => it.sectionKey === "options_general",
    ).map((it) => it.key);
    const pos = GENERAL_GROUPS.map((g) => keys.indexOf(g.first));
    expect(pos.every((p) => p >= 0)).toBe(true);
    expect([...pos].sort((a, b) => a - b)).toEqual(pos);
    // 第一段從「一般」分區的第一項開始，沒有項目落在段落外。
    expect(pos[0]).toBe(0);
  });

  test("設定搜尋的副標寫出在哪一段", () => {
    const hit = searchPrefSettings(i18n("options_enableHomeDashboard"))[0];
    expect(hit.key).toBe("enableHomeDashboard");
    expect(hit.sectionLabel).toBe(i18n("options_groupHome"));
    const safe = searchPrefSettings("nativeSafeMode")[0];
    expect(safe.sectionLabel).toBe(i18n("options_groupBasic"));
  });
});

describe("設定頁：一般分區的小標與跳轉列", () => {
  test("每個小標緊接在該段第一項前面，順序照段落定義", async () => {
    openModal();
    await mounted();
    const hs = [...document.querySelectorAll("[data-pref-group]")];
    expect(hs.map((h) => h.dataset.prefGroup)).toEqual(
      GENERAL_GROUPS.map((g) => g.id),
    );
    for (const g of GENERAL_GROUPS) {
      const next = heading(g.id).nextElementSibling;
      expect(next && next.getAttribute("data-pref-anchor"), g.id).toBe(g.first);
      expect(heading(g.id).textContent).toBe(i18n(g.titleKey));
    }
    expect(document.querySelectorAll("[data-pref-group-jump]")).toHaveLength(
      GENERAL_GROUPS.length,
    );
  });

  test("勾選列的標題與說明＝設定搜尋索引的字（同一份來源）", async () => {
    openModal();
    await mounted();
    const items = PREF_SEARCH_ITEMS.filter(
      (it) => it.kind === "pref" && it.sectionKey === "options_general",
    );
    let checked = 0;
    for (const it of items) {
      const box = document.getElementById(`pref-check-${it.key}`);
      if (!box) continue;
      const row = box.closest(`[data-pref-anchor="${it.key}"]`);
      expect(row.textContent, it.key).toContain(i18n(it.titleKey));
      if (it.tooltipKey) {
        // 說明是勾選列的下一個兄弟（PrefHint），或手寫列放在勾選框裡的 description。
        const want = i18n(it.tooltipKey);
        const hint = row.nextElementSibling;
        const shown =
          (hint && hint.textContent === want) || row.textContent.includes(want);
        expect(shown, it.key).toBe(true);
      }
      checked++;
    }
    // 一般分區幾乎都是勾選列；少到這個數字代表掃描本身壞了。
    expect(checked).toBeGreaterThan(30);
  });

  // 架構 review A7 第十三步起：「一般」等分區由索引畫出（PrefModal.jsx#PrefIndexRows）。
  // 索引的順序就是畫面順序；sub 的格子在縮排區裡；前置鏈關掉的熱鍵反灰。
  // 新的分區改用 PrefIndexRows 時加進 INDEX_SECTIONS（靜態掃描那邊自己會讀 JSX）。
  const INDEX_SECTIONS = [
    "options_general",
    "options_contextMenu",
    "options_appearance",
    "options_cursorHighlight",
    "options_enhance",
    "options_imgurProxy",
  ];
  // 只有一兩格的小分區（第二十步起：滑鼠分頁整頁由索引畫出，每個分區各一份；
  // 「至少三格」那條只套用上面的大分區）。
  const SMALL_SECTIONS = [
    "options_mouseBrowsing",
    "options_mouseMove",
    "options_mouseLeftClick",
    "options_mouseClickRange",
    "options_mouseEdgePaging",
    "options_mouseFunctionKeys",
    "options_mouseMiddleClick",
    "options_mouseWheel",
    "options_mouseBackNav",
    "options_mouseServerReport",
    // 第二十一步：連線分頁的 BBS 連線位址與連線協議（APK 不畫前者、不支援 SSH 不畫後者）。
    "options_connection_bbs",
    "options_connectionProtocol",
  ];
  test("由索引畫出：分區畫面上的設定項順序＝索引順序，sub 縮排", async () => {
    openModal();
    await mounted();
    for (const sectionKey of [...INDEX_SECTIONS, ...SMALL_SECTIONS]) {
      const section = document.querySelector(
        `[data-pref-anchor="section:${sectionKey}"]`,
      );
      const shown = [...section.querySelectorAll("[data-pref-anchor]")].map(
        (el) => el.dataset.prefAnchor,
      );
      // 畫面上的＝索引這一區的每一列（含 ui:…），扣掉 shownIf 條件不成立的。
      const items = prefSectionRows(sectionKey).filter((it) =>
        prefShown(it.key, DEFAULT_PREFS),
      );
      if (INDEX_SECTIONS.includes(sectionKey))
        expect(items.length, sectionKey).toBeGreaterThan(2);
      else expect(items.length, sectionKey).toBeGreaterThan(0);
      expect(shown, sectionKey).toEqual(items.map((it) => it.key));
      for (const it of items) {
        const el = section.querySelector(`[data-pref-anchor="${it.key}"]`);
        expect(!!el.closest(".PrefModal__SubOptions"), it.key).toBe(!!it.sub);
      }
    }
    expect(prefSectionItems("options_general").some((it) => it.sub)).toBe(true);

    const input = (key) => document.querySelector(`input[name="${key}"]`);
    expect(input("commandPaletteKey").disabled).toBe(false);
    expect(input("aidNavBackKey").disabled).toBe(false);
    fireEvent.click(input("enableCommandPalette"));
    await vi.waitFor(() =>
      expect(input("commandPaletteKey").disabled).toBe(true),
    );
    expect(input("aidNavBackKey").disabled).toBe(false);
  });

  // 第十六步：shownIf＝選項不適用就整格不畫（不是反灰）。外觀分區的終端機大小與手機版面。
  test("由索引畫出：shownIf 條件不成立的格子不畫，換選項就出現／消失", async () => {
    window.localStorage.setItem(
      "pttchrome.pref.v1",
      JSON.stringify({
        values: { termSizeMode: "fixed-font-size", mobileLayout: "off" },
      }),
    );
    openModal();
    await mounted();
    const anchor = (key) =>
      document.querySelector(`[data-pref-anchor="${key}"]`);
    // 固定字型大小：只有字級，沒有行列數；手機版面關：手機那 20 格都不畫。
    expect(anchor("fontSize")).not.toBeNull();
    expect(anchor("termSize.cols")).toBeNull();
    expect(anchor("fontFitWindowWidth")).toBeNull();
    const mobileKeys = prefSectionItems("options_appearance")
      .filter((it) => it.shownIf === "mobileLayoutOn")
      .map((it) => it.key);
    expect(mobileKeys.length).toBeGreaterThan(10);
    for (const k of mobileKeys) expect(anchor(k), k).toBeNull();
    // 外觀分區照樣畫得出主題切換（ui:…，custom 手寫）與字型。
    expect(anchor("ui:theme")).not.toBeNull();
    expect(anchor("fontFace")).not.toBeNull();
  });

  // P100：手機版面不看終端機大小那一組（手機一律照螢幕寬排 80 欄），設定頁不畫、
  // 原位置一行說明；電腦版照舊。設定值不動（跨裝置同步）。
  test("手機版面：終端機大小那幾格不畫，改一行說明；電腦版照舊", async () => {
    window.localStorage.setItem(
      "pttchrome.pref.v1",
      JSON.stringify({ values: { termSizeMode: "fixed-term-size" } }),
    );
    const desktopOnly = PREF_SEARCH_ITEMS.filter((it) => it.desktopOnly).map(
      (it) => it.key,
    );
    expect(desktopOnly).toEqual([
      "termSizeMode",
      "termSize.cols",
      "termSize.rows",
      "fontFitWindowWidth",
      "fontSize",
    ]);
    const anchor = (key) =>
      document.querySelector(`[data-pref-anchor="${key}"]`);
    const hint = i18n("options_desktopOnlyOnMobile");
    const r = openModal({ mobile: true });
    await mounted();
    expect(document.querySelector('input[name="termSize.cols"]')).toBeNull();
    expect(
      document.querySelector('input[name="fontFitWindowWidth"]'),
    ).toBeNull();
    // 說明掛在第一格的錨點上（設定搜尋在手機上不列這幾格，錨點留給舊連結）。
    expect(anchor("termSizeMode").textContent).toBe(hint);
    expect(anchor("mobileLayout")).not.toBeNull();
    expect(anchor("bbsMargin")).not.toBeNull();
    r.unmount();

    openModal();
    await mounted();
    expect(
      document.querySelector('input[name="termSize.cols"]'),
    ).not.toBeNull();
    expect(document.body.textContent).not.toContain(hint);
  });

  test("手機版面但設定裡手機版面選「關」（還沒存檔）：五格照常畫，不指向不見的手機字級", async () => {
    window.localStorage.setItem(
      "pttchrome.pref.v1",
      JSON.stringify({
        values: { termSizeMode: "fixed-term-size", mobileLayout: "off" },
      }),
    );
    openModal({ mobile: true });
    await mounted();
    expect(
      document.querySelector('input[name="termSize.cols"]'),
    ).not.toBeNull();
    expect(document.body.textContent).not.toContain(
      i18n("options_desktopOnlyOnMobile"),
    );
  });

  test("安全模式開著：要蓋掉的每一項在設定頁都反灰；關掉就恢復", async () => {
    window.localStorage.setItem(
      "pttchrome.pref.v1",
      JSON.stringify({ values: { nativeSafeMode: true } }),
    );
    openModal();
    await mounted();
    const input = (key) => document.querySelector(`input[name="${key}"]`);
    // 名單裡每一項都要在設定頁找得到（分頁都掛著），而且是 disabled。
    const notDisabled = NATIVE_SAFE_MODE_KEYS.filter(
      (k) => !(input(k) && input(k).disabled),
    );
    expect(notDisabled).toEqual([]);

    fireEvent.click(input("nativeSafeMode"));
    await vi.waitFor(() =>
      expect(input("enableEasyReading").disabled).toBe(false),
    );
    expect(input("enableHomeDashboard").disabled).toBe(false);
    expect(input("enableCommentBar").disabled).toBe(false);
  });

  test("點跳轉鈕：那一段的小標停在黏住的跳轉列正下方，那顆鈕亮起", async () => {
    openModal();
    await mounted();
    fireEvent.click(jumpBtn("article"));
    await vi.waitFor(
      () => {
        const boxTop = rightCol().getBoundingClientRect().top;
        // 跳轉列黏住時貼齊捲動區上緣（不留一條露出底下文字的縫）。
        expect(
          Math.abs(bar().getBoundingClientRect().top - boxTop),
        ).toBeLessThanOrEqual(1);
        const want = boxTop + bar().offsetHeight + 4;
        expect(
          Math.abs(heading("article").getBoundingClientRect().top - want),
        ).toBeLessThanOrEqual(2);
      },
      { timeout: 3000 },
    );
    await vi.waitFor(() =>
      expect(jumpBtn("article").getAttribute("aria-current")).toBe("true"),
    );
    expect(jumpBtn("basic").getAttribute("aria-current")).toBeNull();
  });

  test("自己往下捲：亮起的鈕跟著目前那一段", async () => {
    openModal();
    await mounted();
    const box = rightCol();
    const h = heading("home");
    // 捲到「首頁與收藏」小標剛好在黏住的跳轉列底下（跳轉列高度之內 2px）。
    box.scrollTop +=
      h.getBoundingClientRect().top -
      box.getBoundingClientRect().top -
      bar().offsetHeight -
      2;
    await vi.waitFor(() =>
      expect(jumpBtn("home").getAttribute("aria-current")).toBe("true"),
    );
  });

  test("手機上跳轉列比畫面寬：捲到最後一段時，亮起的那顆鈕橫向捲進列裡看得到", async () => {
    await page.viewport(390, 800);
    openModal();
    fireEvent.click(
      await vi.waitFor(() => {
        const el = document.querySelector('[data-pref-category="general"]');
        if (!el) throw new Error("no category list");
        return el;
      }),
    );
    await mounted();
    const nav = bar();
    // 前提：跳轉列真的比畫面寬，最後一顆一開始在列外。
    expect(nav.scrollWidth).toBeGreaterThan(nav.clientWidth);
    const box = rightCol();
    const h = heading("misc");
    box.scrollTop +=
      h.getBoundingClientRect().top -
      box.getBoundingClientRect().top -
      nav.offsetHeight -
      2;
    await vi.waitFor(() => {
      const btn = jumpBtn("misc");
      expect(btn.getAttribute("aria-current")).toBe("true");
      const b = btn.getBoundingClientRect();
      const n = nav.getBoundingClientRect();
      expect(b.left).toBeGreaterThanOrEqual(n.left - 1);
      expect(b.right).toBeLessThanOrEqual(n.right + 1);
    });
  });

  test("跳轉列不會把分區撐寬（說明文字不跑出右欄）", async () => {
    await page.viewport(390, 800);
    openModal();
    fireEvent.click(
      await vi.waitFor(() => {
        const el = document.querySelector('[data-pref-category="general"]');
        if (!el) throw new Error("no category list");
        return el;
      }),
    );
    await mounted();
    const box = rightCol();
    expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
    const fs = document.querySelector(
      '[data-pref-anchor="section:options_general"]',
    );
    expect(fs.getBoundingClientRect().right).toBeLessThanOrEqual(
      box.getBoundingClientRect().right,
    );
  });

  test("手機點進「一般」：跟分類同名的 legend 不再重複顯示；電腦版照舊", async () => {
    openModal();
    await mounted();
    const legend = () =>
      document.querySelector(
        '[data-pref-anchor="section:options_general"] > legend',
      );
    expect(legend().getBoundingClientRect().height).toBeGreaterThan(10);

    await page.viewport(390, 800);
    fireEvent.click(
      await vi.waitFor(() => {
        const el =
          document.querySelector('[data-pref-category="general"]') ||
          document.querySelector("[data-pref-category-back]");
        if (!el) throw new Error("narrow not applied");
        return el;
      }),
    );
    const general = document.querySelector('[data-pref-category="general"]');
    if (general) fireEvent.click(general);
    await mounted();
    await vi.waitFor(() =>
      expect(legend().getBoundingClientRect().height).toBeLessThanOrEqual(1),
    );
    // 讀屏仍讀得到分區名。
    expect(legend().textContent).toBe(i18n("options_general"));
  });
});
