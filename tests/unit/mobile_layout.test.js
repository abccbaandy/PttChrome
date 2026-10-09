// 手機模式的純邏輯（src/js/mobile_layout.js，docs/mobile.md）。
import {
  isMobileEnv,
  inputModeFor,
  MOBILE_KEYPAD_ROWS,
  MOBILE_MAX_SHORT_SIDE,
  MOBILE_ROW_FONT_PX,
  mobileTermGeometry,
  keyboardInset,
  overlayKeyboardInset,
  mobileChromeInsets,
  mobileRowsHeight,
  MOBILE_APPBAR_PX,
  KEYBOARD_MIN_PX,
  MOBILE_KEYPAD_EXTRA_ROW,
  MOBILE_TOOLBAR_PX,
  mobileCtrlKey,
  clampFloatPos,
  loadFloatPos,
  saveFloatPos,
  FLOAT_TOOLS_DEFAULT_POS,
  FLOAT_TOOLS_POS_STORAGE_KEY,
} from "../../src/js/mobile_layout";
import { KeyMap } from "../../src/js/term_keyboard";
import { DEFAULT_PREFS } from "../../src/js/pref_storage";

const phone = { coarse: true, hoverNone: true, width: 390, height: 844 };

describe("isMobileEnv", () => {
  test("auto：觸控＋不能 hover＋短邊小 ⇒ 手機（直立與橫放都算）", () => {
    expect(isMobileEnv({ mode: "auto", ...phone })).toBe(true);
    expect(isMobileEnv({ mode: "auto", ...phone, width: 844, height: 390 })).toBe(true);
  });

  test("auto：桌機（fine pointer 或能 hover）不是手機", () => {
    expect(isMobileEnv({ mode: "auto", ...phone, coarse: false })).toBe(false);
    expect(isMobileEnv({ mode: "auto", ...phone, hoverNone: false })).toBe(false);
  });

  test("auto：短邊夠大的平板照桌機版面（80 欄放得下）", () => {
    expect(
      isMobileEnv({ mode: "auto", ...phone, width: 1024, height: MOBILE_MAX_SHORT_SIDE }),
    ).toBe(false);
  });

  test("auto：尺寸未知（0）不當手機", () => {
    expect(isMobileEnv({ mode: "auto", ...phone, width: 0, height: 0 })).toBe(false);
  });

  test("on/off 強制，無視裝置", () => {
    expect(isMobileEnv({ mode: "on", coarse: false, hoverNone: false, width: 1920, height: 1080 })).toBe(true);
    expect(isMobileEnv({ mode: "off", ...phone })).toBe(false);
  });

  test("pref 預設 auto", () => {
    expect(DEFAULT_PREFS.mobileLayout).toBe("auto");
  });
});

describe("inputModeFor（tap 不叫鍵盤）", () => {
  test("非手機：移除屬性（桌機零改動）", () => {
    expect(inputModeFor({ mobile: false, softKeyboard: false })).toBe(null);
    expect(inputModeFor({ mobile: false, softKeyboard: true })).toBe(null);
  });

  test("手機：預設 none，鍵盤鈕叫出後 text", () => {
    expect(inputModeFor({ mobile: true, softKeyboard: false })).toBe("none");
    expect(inputModeFor({ mobile: true, softKeyboard: true })).toBe("text");
  });
});

describe("MOBILE_KEYPAD_ROWS", () => {
  const keys = MOBILE_KEYPAD_ROWS.flat();

  test("每個鍵都是 term_keyboard 認得的 KeyboardEvent.key（sendKeyAsUser 才送得出去）", () => {
    for (const k of keys) expect(KeyMap[k.key]).toBeDefined();
  });

  test("包含手機鍵盤沒有的導覽鍵", () => {
    const names = keys.map((k) => k.key);
    for (const n of ["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"])
      expect(names).toContain(n);
  });

  test("鍵不重複", () => {
    const names = keys.map((k) => k.key);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("mobileTermGeometry（Phase 2：畫面不被切）", () => {
  // .main 的實際寬高 ＝ chw*80+10、chh*rows+10（term_view.setTermFontSize）。
  const fits = (g, w, h) => {
    expect((g.chh / 2) * g.cols + 10).toBeLessThanOrEqual(w + 1e-9);
    expect(g.chh * g.rows + 10).toBeLessThanOrEqual(h + 1e-9);
  };

  test("直立：80 欄塞滿寬度（不被切），列數由 16px 字級與高度決定", () => {
    const g = mobileTermGeometry({ width: 390, height: 750, dpr: 2.625 });
    expect(g.cols).toBe(80);
    expect(g.rows).toBe(Math.floor(750 / MOBILE_ROW_FONT_PX));
    fits(g, 390, 750);
    // 寬度是瓶頸：再大一個裝置像素就塞不下
    expect(((g.chh + 1 / 2.625) / 2) * 80 + 10).toBeGreaterThan(390);
  });

  test("橫放：高度是瓶頸，列數最少 24", () => {
    const g = mobileTermGeometry({ width: 844, height: 360, dpr: 3 });
    expect(g.rows).toBe(24);
    fits(g, 844, 360);
  });

  test("chh 對齊裝置像素（與 fixedResize 同規則，避免列間黑縫）", () => {
    const dpr = 2.625;
    const g = mobileTermGeometry({ width: 412, height: 800, dpr });
    expect(Math.abs(g.chh * dpr - Math.round(g.chh * dpr))).toBeLessThan(1e-9);
  });

  test("尺寸未知不回負值", () => {
    expect(mobileTermGeometry({ width: 0, height: 0, dpr: 1 }).chh).toBe(0);
  });

  test("格線畫面沒有 mainWidth（照 80 欄算寬）", () => {
    expect(mobileTermGeometry({ width: 412, height: 800, dpr: 2.625 }).mainWidth).toBe(null);
  });
});

describe("mobileTermGeometry surface 'article'（Phase 3：好讀文章換行）", () => {
  const dpr = 2.625;

  test("rows 與 surface 無關 ⇒ 進出好讀不重送 NAWS", () => {
    for (const [w, h] of [[412, 800], [390, 750], [844, 360], [412, 390]]) {
      const grid = mobileTermGeometry({ width: w, height: h, dpr });
      const art = mobileTermGeometry({ width: w, height: h, dpr, surface: "article" });
      expect(art.rows).toBe(grid.rows);
      expect(art.cols).toBe(80);
    }
  });

  test("正常字級（不再為塞 80 欄縮小），`.main` 寬＝視窗寬", () => {
    // 812 = 50 列 × 16 + 12：高度有餘裕時就是完整的 16px
    const g = mobileTermGeometry({ width: 412, height: 812, dpr, surface: "article" });
    expect(g.chh).toBe(MOBILE_ROW_FONT_PX);
    expect(g.mainWidth).toBe(412);
    expect(g.chh).toBeGreaterThan(mobileTermGeometry({ width: 412, height: 812, dpr }).chh);
  });

  test("高度仍塞得下（.main 高 chh*rows+10 不出視窗），並對齊裝置像素", () => {
    const g = mobileTermGeometry({ width: 412, height: 390, dpr, surface: "article" });
    expect(g.chh * g.rows + 10).toBeLessThanOrEqual(390 + 1e-9);
    expect(g.chh).toBeLessThanOrEqual(MOBILE_ROW_FONT_PX);
    expect(Math.abs(g.chh * dpr - Math.round(g.chh * dpr))).toBeLessThan(1e-9);
  });
});

// 兩條常駐 bar＋safe-area（viewport-fit=cover 的瀏海／手勢列）。
describe("mobileChromeInsets／mobileRowsHeight", () => {
  test("沒有 safe-area：上＝App Bar、下＝工具列＋按鍵面板＋鍵盤", () => {
    expect(mobileChromeInsets({ kb: 0, keysPanel: 0 })).toEqual({
      top: MOBILE_APPBAR_PX,
      bottom: MOBILE_TOOLBAR_PX,
      safeTop: 0,
      safeBottom: 0,
    });
    expect(mobileChromeInsets({ kb: 300, keysPanel: 150 }).bottom).toBe(300 + MOBILE_TOOLBAR_PX + 150);
  });
  test("safe-area 併進上下；鍵盤升起時手勢列被蓋住 ⇒ 下緣 safe 歸 0", () => {
    const a = mobileChromeInsets({ kb: 0, keysPanel: 0, safeTop: 24, safeBottom: 16 });
    expect(a).toMatchObject({ top: MOBILE_APPBAR_PX + 24, bottom: MOBILE_TOOLBAR_PX + 16, safeBottom: 16 });
    const b = mobileChromeInsets({ kb: 300, keysPanel: 0, safeTop: 24, safeBottom: 16 });
    expect(b).toMatchObject({ bottom: 300 + MOBILE_TOOLBAR_PX, safeBottom: 0 });
  });
  test("列數高度扣兩條 bar 與兩邊 safe-area", () => {
    expect(mobileRowsHeight(800)).toBe(800 - MOBILE_APPBAR_PX - MOBILE_TOOLBAR_PX);
    expect(mobileRowsHeight(800, { top: 24, bottom: 16 })).toBe(800 - 96 - 40);
  });
});

// 手機 bottom sheet 裡的搜尋框叫出的鍵盤：不是按鍵面板 ⌨ 叫的（softKeyboard 為 false），
// 但 sheet 仍要讓位。只寫 CSS 變數，不推終端機。
describe("overlayKeyboardInset", () => {
  const f = { mobile: true, softKeyboard: false, layoutHeight: 800, vvOffsetTop: 0, vvScale: 1 };
  test("不看 softKeyboard 閘門", () => {
    expect(keyboardInset({ ...f, vvHeight: 480 })).toBe(0);
    expect(overlayKeyboardInset({ ...f, vvHeight: 480 })).toBe(320);
  });
  test("其餘規則相同：非手機／雙指縮放／雜訊 ⇒ 0", () => {
    expect(overlayKeyboardInset({ ...f, vvHeight: 480, mobile: false })).toBe(0);
    expect(overlayKeyboardInset({ ...f, vvHeight: 400, vvScale: 2 })).toBe(0);
    expect(overlayKeyboardInset({ ...f, vvHeight: 800 - (KEYBOARD_MIN_PX - 1) })).toBe(0);
  });
});

describe("keyboardInset", () => {
  const kb = { mobile: true, softKeyboard: true, layoutHeight: 800, vvOffsetTop: 0, vvScale: 1 };

  test("鍵盤升起：layout 高 − 可視底", () => {
    expect(keyboardInset({ ...kb, vvHeight: 480 })).toBe(320);
  });

  test("不是使用者叫的鍵盤／不是手機 ⇒ 0", () => {
    expect(keyboardInset({ ...kb, vvHeight: 480, softKeyboard: false })).toBe(0);
    expect(keyboardInset({ ...kb, vvHeight: 480, mobile: false })).toBe(0);
  });

  test("雙指縮放（scale ≠ 1）也會縮 visualViewport，不算鍵盤", () => {
    expect(keyboardInset({ ...kb, vvHeight: 400, vvScale: 2 })).toBe(0);
  });

  test("小於門檻的差距（網址列伸縮）視為雜訊", () => {
    expect(keyboardInset({ ...kb, vvHeight: 800 - (KEYBOARD_MIN_PX - 1) })).toBe(0);
  });

  // Android APK：鍵盤疊在 WebView 上（刻意不縮 WebView，否則改列數重送 NAWS），
  // visualViewport 完全沒變，高度只能靠原生回報。
  test("APK：visualViewport 沒變時採用原生回報的鍵盤高度", () => {
    expect(keyboardInset({ ...kb, vvHeight: 800, hostInset: 300 })).toBe(300);
  });

  test("APK：兩邊都量到同一塊鍵盤時取較大者，不相加", () => {
    expect(keyboardInset({ ...kb, vvHeight: 500, hostInset: 280 })).toBe(300);
  });

  test("APK：原生回報也受 softKeyboard／縮放閘門管", () => {
    expect(keyboardInset({ ...kb, vvHeight: 800, hostInset: 300, softKeyboard: false })).toBe(0);
    expect(keyboardInset({ ...kb, vvHeight: 800, hostInset: 300, vvScale: 2 })).toBe(0);
  });
});

// 黏滯 Ctrl：字母走 Alt remap（繞過 Ctrl+A／C／V 的 UI 快捷鍵），符號走 ctrlKey。
describe("mobileCtrlKey", () => {
  test("字母 ⇒ Alt remap（byte 與 Ctrl 相同，不被全選／複製／貼上攔走）", () => {
    expect(mobileCtrlKey("p")).toEqual({ key: "p", altKey: true });
    expect(mobileCtrlKey("V")).toEqual({ key: "v", altKey: true });
    for (const c of ["a", "c", "v"]) expect(mobileCtrlKey(c).ctrlKey).toBeUndefined();
  });
  test("CtrlShiftMap 的符號 ⇒ ctrlKey", () => {
    for (const c of ["@", "[", "\\", "]", "^", "_", "?"])
      expect(mobileCtrlKey(c)).toEqual({ key: c, ctrlKey: true });
  });
  test("沒有控制碼的字元／多字元 ⇒ null", () => {
    expect(mobileCtrlKey("1")).toBeNull();
    expect(mobileCtrlKey("中")).toBeNull();
    expect(mobileCtrlKey("ab")).toBeNull();
    expect(mobileCtrlKey("")).toBeNull();
  });
});

describe("MOBILE_KEYPAD_EXTRA_ROW（手機鍵盤打不出來的鍵）", () => {
  test("Esc／Tab／Delete，且都在 KeyMap", () => {
    expect(MOBILE_KEYPAD_EXTRA_ROW.map((k) => k.key)).toEqual(["Escape", "Tab", "Delete"]);
    for (const k of MOBILE_KEYPAD_EXTRA_ROW) expect(KeyMap[k.key]).toBeDefined();
  });
  test("與前兩列不重複", () => {
    const names = [...MOBILE_KEYPAD_ROWS.flat(), ...MOBILE_KEYPAD_EXTRA_ROW].map((k) => k.key);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("浮動工具「⋯」位置（泛用版）", () => {
  const vp = { vw: 390, vh: 700, w: 36, h: 36 };
  const memStorage = () => {
    const mem = new Map();
    return {
      mem,
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, v),
    };
  };

  test("壞值退回預設；夾回視窗內", () => {
    expect(clampFloatPos(null, vp, FLOAT_TOOLS_DEFAULT_POS)).toEqual(FLOAT_TOOLS_DEFAULT_POS);
    expect(clampFloatPos({ right: -20, bottom: 900 }, vp, FLOAT_TOOLS_DEFAULT_POS)).toEqual({
      right: 0,
      bottom: 664,
    });
  });

  test("預設位置在手機底部工具列之上，不重疊", () => {
    expect(FLOAT_TOOLS_DEFAULT_POS.bottom).toBeGreaterThanOrEqual(MOBILE_TOOLBAR_PX + 8);
  });

  test("存取 round-trip；存的是專用 key，不是 prefs", () => {
    const st = memStorage();
    saveFloatPos(FLOAT_TOOLS_POS_STORAGE_KEY, { right: 5, bottom: 6 }, st);
    expect(loadFloatPos(FLOAT_TOOLS_POS_STORAGE_KEY, FLOAT_TOOLS_DEFAULT_POS, st)).toEqual({
      right: 5,
      bottom: 6,
    });
    expect([...st.mem.keys()]).toEqual([FLOAT_TOOLS_POS_STORAGE_KEY]);
  });

  test("storage throw／壞 JSON ⇒ 預設位置", () => {
    const boom = {
      getItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadFloatPos(FLOAT_TOOLS_POS_STORAGE_KEY, FLOAT_TOOLS_DEFAULT_POS, boom)).toEqual(
      FLOAT_TOOLS_DEFAULT_POS,
    );
    expect(
      loadFloatPos(FLOAT_TOOLS_POS_STORAGE_KEY, FLOAT_TOOLS_DEFAULT_POS, { getItem: () => "[" }),
    ).toEqual(FLOAT_TOOLS_DEFAULT_POS);
  });
});
