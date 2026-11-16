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
  searchPrefSettings,
} from "../../src/js/pref_search";
import { setupI18n, i18n } from "../../src/js/i18n";

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

const openModal = () =>
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
