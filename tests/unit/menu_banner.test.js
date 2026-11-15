// @unit-env browser
// 手機選單上方的動態看板收成一列（P87，js/menu_banner.js、render/menu_card.js#buildMenuBannerBar）。
// 症狀：選單上方 11 列動態看板／心情點播（ANSI 圖）縮小格線佔掉近半螢幕，選單大按鈕只看得到 4 顆。
// 鎖：①收起時動態看板區只剩一條摘要（真 main.css 下只有第一條看得到）、心情點播附註列跟著收、
// 第一顆選單按鈕緊接在下面②整塊空白就什麼都不畫③按那一條只呼叫 onToggle（不送鍵）④展開時
// 原圖回來、標題列畫「收起」⑤開關關掉／信件列表／桌機一列都不換⑥切換會換 annotationsKey。
// real-input: tests/e2e/offline/mobile_main_menu.offline.spec.js
import mainCss from "../../src/css/main.css?raw";
import { setupI18n } from "../../src/js/i18n";
import { mountScreen, unmountAll } from "./helpers/mount_screen";
import {
  bannerSummaryText,
  isUsongAlertRow,
  menuBannerMode,
  readMenuBannerExpanded,
  writeMenuBannerExpanded,
  MENU_BANNER_EXPANDED_KEY,
} from "../../src/js/menu_banner";
import { annotationsKey, sameKey } from "../../src/js/screen_annotate_cache";
import { MAIN_MENU_ROWS, MAIN_MENU_ITEM_ROWS } from "./fixtures/main_menu_rows";

let style;
beforeAll(() => {
  setupI18n();
  style = document.createElement("style");
  style.textContent = mainCss;
  document.head.appendChild(style);
});
afterAll(() => style.remove());
afterEach(() => unmountAll());

const NORMAL = {
  fg: 7,
  bg: 0,
  blink: false,
  equals(o) {
    return !!o && o.fg === this.fg && o.bg === this.bg && o.blink === this.blink;
  },
};
const line = (str) =>
  str.split("").map((c) => ({
    ch: c,
    isLeadByte: false,
    isStartOfURL: () => false,
    isEndOfURL: () => false,
    getFullURL: () => null,
    getColor: () => NORMAL,
  }));

const STATUS = " 主選單   某節日   10/9 週五 13:31 | someone | 線上1人      (h)說明  ";
const BLANK = " ".repeat(80);
const ROWS = [...MAIN_MENU_ROWS, ...Array(4).fill(BLANK), STATUS];
// 動態看板關掉（UF_ADBANNER 沒開）：row 1～11 空白、沒有附註列（選單從 row 12 起，這裡只換掉看板區）。
const ROWS_NO_BANNER = ROWS.map((r, i) => (i >= 1 && i <= 12 ? BLANK : r));

function render(enhance, rows = ROWS) {
  const s = mountScreen({
    lines: rows.map(line),
    enableLinkInlinePreview: false,
    enableLinkHoverPreview: false,
    enhance: { pageState: 1, menuCards: true, ...enhance },
  });
  s.root.classList.add("mobileMenu");
  s.root.style.width = "412px";
  return s;
}
const rowNode = (s, r) => s.container.querySelector(`[type="bbsrow"][srow="${r}"]`);
const shown = (n) => !!n && getComputedStyle(n).display !== "none";
const visibleBars = (s) => Array.from(s.container.querySelectorAll(".menuBannerBar")).filter(shown);

describe("純函式", () => {
  test("摘要拿掉框線與色塊；整列只有畫圖符號 ⇒ 空字串", () => {
    expect(bannerSummaryText(MAIN_MENU_ROWS[1])).toBe("");
    expect(bannerSummaryText(MAIN_MENU_ROWS[7])).toBe("");
    expect(bannerSummaryText("│右繞佛塔        │     ██    在在所生處    遠離於八難   │")).toBe(
      "右繞佛塔 在在所生處 遠離於八難",
    );
    expect(bannerSummaryText(BLANK)).toBe("");
  });

  test("心情點播附註列只認 row 12＋原字串", () => {
    expect(isUsongAlertRow(12, MAIN_MENU_ROWS[12])).toBe(true);
    expect(isUsongAlertRow(13, MAIN_MENU_ROWS[12])).toBe(false);
    expect(isUsongAlertRow(12, MAIN_MENU_ROWS[13])).toBe(false);
  });

  test("menuBannerMode：只在一般選單＋開關開", () => {
    expect(menuBannerMode({ menuCards: true, prefOn: true, expanded: false })).toBe("collapsed");
    expect(menuBannerMode({ menuCards: true, prefOn: true, expanded: true })).toBe("expanded");
    expect(menuBannerMode({ menuCards: true, prefOn: false, expanded: false })).toBeUndefined();
    expect(menuBannerMode({ menuCards: "mail", prefOn: true, expanded: false })).toBeUndefined();
    expect(menuBannerMode({ menuCards: false, prefOn: true, expanded: false })).toBeUndefined();
  });

  test("展開的選擇存本機", () => {
    const mem = new Map();
    const storage = {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, v),
      removeItem: (k) => mem.delete(k),
    };
    expect(readMenuBannerExpanded(storage)).toBe(false);
    writeMenuBannerExpanded(true, storage);
    expect(mem.get(MENU_BANNER_EXPANDED_KEY)).toBe("1");
    expect(readMenuBannerExpanded(storage)).toBe(true);
    writeMenuBannerExpanded(false, storage);
    expect(readMenuBannerExpanded(storage)).toBe(false);
  });
});

describe("render（真 main.css）", () => {
  test("收起：只看得到一條摘要，附註列收起，第一顆選單按鈕緊接在下面", () => {
    const s = render({ menuBanner: "collapsed" });
    const bars = visibleBars(s);
    expect(bars.length).toBe(1);
    expect(bars[0].querySelector(".menuBannerText").textContent).toBe("右繞佛塔 在在所生處 遠離於八難");
    expect(bars[0].querySelector(".menuBannerToggle").getAttribute("aria-expanded")).toBe("false");
    for (let r = 1; r <= 12; ++r) {
      const n = rowNode(s, r);
      if (n !== bars[0]) expect(shown(n)).toBe(false);
      // 契約：每列仍有 bbsline/data-row。
      expect(n.querySelector('[data-type="bbsline"]').getAttribute("data-row")).toBe(String(r));
    }
    const barBottom = bars[0].getBoundingClientRect().bottom;
    const firstCard = rowNode(s, MAIN_MENU_ITEM_ROWS[0]).getBoundingClientRect();
    expect(Math.abs(firstCard.top - barBottom)).toBeLessThan(1);
  });

  test("動態看板整塊空白 ⇒ 什麼都不畫，選單從最上面開始", () => {
    const s = render({ menuBanner: "collapsed" }, ROWS_NO_BANNER);
    expect(visibleBars(s).length).toBe(0);
    const top = s.container.getBoundingClientRect().top;
    expect(rowNode(s, MAIN_MENU_ITEM_ROWS[0]).getBoundingClientRect().top - top).toBeLessThan(1);
  });

  test("按那一條只呼叫 onToggle", () => {
    const onToggle = vi.fn();
    const s = render({ menuBanner: "collapsed", onMenuBannerToggle: onToggle });
    visibleBars(s)[0].querySelector("button").click();
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  test("展開：原圖回來，標題列畫「收起」", () => {
    const onToggle = vi.fn();
    const s = render({ menuBanner: "expanded", onMenuBannerToggle: onToggle });
    const head = rowNode(s, 0);
    expect(head.classList.contains("menuBannerHead")).toBe(true);
    expect(shown(head)).toBe(true);
    expect(head.querySelector("button").getAttribute("aria-expanded")).toBe("true");
    expect(s.container.querySelectorAll(".menuBannerSummary").length).toBe(0);
    expect(shown(rowNode(s, 2))).toBe(true);
    expect(rowNode(s, 2).textContent).toContain("右繞佛塔");
    expect(shown(rowNode(s, 12))).toBe(true);
    head.querySelector("button").click();
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  test("開關關掉（menuBanner undefined）：跟原本一樣，一條都不畫", () => {
    const s = render({});
    expect(s.container.querySelectorAll(".menuBannerBar").length).toBe(0);
    expect(shown(rowNode(s, 2))).toBe(true);
    expect(rowNode(s, 0).classList.contains("menuChromeRow")).toBe(true);
  });

  test("信件列表（menuCards 'mail'）就算帶了 menuBanner 也不動", () => {
    const s = render({ menuCards: "mail", menuBanner: "collapsed" });
    expect(s.container.querySelectorAll(".menuBannerBar").length).toBe(0);
  });

  test("切換會換 annotationsKey（整批重畫）", () => {
    const k = (b) => annotationsKey({ lines: ROWS.map(line), enhance: { pageState: 1, menuCards: true, menuBanner: b } });
    expect(sameKey(k("collapsed"), k("expanded"))).toBe(false);
    expect(sameKey(k("collapsed"), k(undefined))).toBe(false);
  });
});
