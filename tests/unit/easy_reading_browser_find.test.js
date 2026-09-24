// 好讀文章的搜尋交給瀏覽器（pref easyReadingBrowserFind，預設開）。
//
// 原生 `/` 在好讀下結構性不可用：pmore 的 mf_search 從 PTT 端目前頁起找，而好讀早就
// 自動翻到文末 ⇒ 起點與使用者看的位置無關。網頁沒有 API 能開瀏覽器尋找列，所以：
//   Ctrl+F → 不攔截、不送 PTT，交給瀏覽器（累積長頁本來就是 DOM）
//   `/`    → 吞掉並提示改用 Ctrl+F／⌘F
// 本檔鎖三層：純決策、EasyReading 的處理、term_view.onKeyDown 不落到 _keyboard。
vi.mock("../../src/js/pref_storage", () => ({
  readValuesWithDefault: vi.fn(() => ({ easyReadingBrowserFind: true }))
}));

import { EasyReading, easyReadingFindKeyAction } from "../../src/js/easy_reading";
import { TermView } from "../../src/js/term_view";
import { readValuesWithDefault } from "../../src/js/pref_storage";
import { setupI18n } from "../../src/js/i18n";

beforeAll(() => setupI18n());

function keyEvent(key, mods = {}) {
  return {
    key,
    code: mods.code,
    ctrlKey: !!mods.ctrlKey,
    altKey: !!mods.altKey,
    shiftKey: !!mods.shiftKey,
    metaKey: !!mods.metaKey,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
}

const ON = { easyReadingBrowserFind: true };
const OFF = { easyReadingBrowserFind: false };

describe("easyReadingFindKeyAction（純決策）", () => {
  test("Ctrl+F → browser（CapsLock 的 'F' 也算）", () => {
    expect(easyReadingFindKeyAction(keyEvent("f", { ctrlKey: true }), ON)).toBe("browser");
    expect(easyReadingFindKeyAction(keyEvent("F", { ctrlKey: true }), ON)).toBe("browser");
  });

  test("`/` → hint", () => {
    expect(easyReadingFindKeyAction(keyEvent("/"), ON)).toBe("hint");
  });

  test("反向：Alt+F 保留本地翻頁（Ctrl+F 讓位後的替代鍵），不是 browser", () => {
    expect(easyReadingFindKeyAction(keyEvent("f", { altKey: true, code: "KeyF" }), ON)).toBe(null);
    expect(easyReadingFindKeyAction(keyEvent("ƒ", { altKey: true, code: "KeyF" }), ON)).toBe(null);
  });

  test("反向：Ctrl+Shift+F／⌘F／Ctrl+/ 不歸這裡管", () => {
    expect(easyReadingFindKeyAction(keyEvent("F", { ctrlKey: true, shiftKey: true }), ON)).toBe(null);
    expect(easyReadingFindKeyAction(keyEvent("f", { metaKey: true }), ON)).toBe(null);
    expect(easyReadingFindKeyAction(keyEvent("/", { ctrlKey: true }), ON)).toBe(null);
    expect(easyReadingFindKeyAction(keyEvent("f"), ON)).toBe(null);
  });

  test("pref 關掉 ⇒ 一律 null（舊行為）", () => {
    expect(easyReadingFindKeyAction(keyEvent("f", { ctrlKey: true }), OFF)).toBe(null);
    expect(easyReadingFindKeyAction(keyEvent("/"), OFF)).toBe(null);
    expect(easyReadingFindKeyAction(keyEvent("/"), {})).toBe(null);
  });
});

function makeEasyReading({ scrollTop = 2000 } = {}) {
  const sent = [];
  const hints = [];
  const mainDisplay = { scrollTop, scrollHeight: 10000 };
  const er = new EasyReading(
    {},
    {
      mainDisplay,
      mainContainer: { clientHeight: 10000 },
      chh: 20,
      flashListHint: (m) => hints.push(m),
    },
    { addEventListener() {}, rows: 24 }
  );
  er._enabled = true;
  er.startedEasyReading = true;
  er._turnPageLines = 20;
  er._send = (d) => {
    sent.push(d);
    return true;
  };
  er._enterFunctionMode = vi.fn();
  return { er, sent, hints, mainDisplay };
}

describe("EasyReading 的處理", () => {
  afterEach(() => readValuesWithDefault.mockReturnValue(ON));

  test("Ctrl+F：回 'browser'、不 preventDefault、零送出、不捲動、不進 functionMode", () => {
    const { er, sent, mainDisplay } = makeEasyReading();
    const e = keyEvent("f", { ctrlKey: true });
    expect(er._onKeyDown(e)).toBe("browser");
    expect(e.defaultPrevented).toBe(false);
    expect(sent).toEqual([]);
    expect(mainDisplay.scrollTop).toBe(2000);
    expect(er._enterFunctionMode).not.toHaveBeenCalled();
  });

  test("`/`：preventDefault、零送出、不進 functionMode、顯示含快捷鍵的提示", () => {
    const { er, sent, hints } = makeEasyReading();
    const e = keyEvent("/");
    expect(er._onKeyDown(e)).toBeUndefined();
    expect(e.defaultPrevented).toBe(true);
    expect(sent).toEqual([]);
    expect(er._enterFunctionMode).not.toHaveBeenCalled();
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatch(/Ctrl\+F|⌘F/);
    expect(hints[0]).not.toContain("%s");
  });

  test("pref 關：Ctrl+F 照舊本地翻頁、`/` 照舊進 functionMode 送 PTT", () => {
    readValuesWithDefault.mockReturnValue(OFF);
    const a = makeEasyReading();
    const ctrlF = keyEvent("f", { ctrlKey: true });
    expect(a.er._onKeyDown(ctrlF)).toBeUndefined();
    expect(ctrlF.defaultPrevented).toBe(true);
    expect(a.mainDisplay.scrollTop).toBe(2400);

    const b = makeEasyReading();
    const slash = keyEvent("/");
    b.er._onKeyDown(slash);
    expect(slash.defaultPrevented).toBe(false);
    expect(b.er._enterFunctionMode).toHaveBeenCalledTimes(1);
    expect(b.hints).toEqual([]);
  });

  test("Alt+F 在 pref 開時仍是本地翻頁", () => {
    const { er, sent, mainDisplay } = makeEasyReading();
    const e = keyEvent("f", { altKey: true, code: "KeyF" });
    er._onKeyDown(e);
    expect(mainDisplay.scrollTop).toBe(2400);
    expect(sent).toEqual([]);
    expect(e.defaultPrevented).toBe(true);
  });
});

function makeView({ functionMode = false, easyResult } = {}) {
  const view = Object.create(TermView.prototype);
  view.useEasyReadingMode = true;
  view.buf = {
    pageState: 3,
    listRenderMode: "native",
    startedEasyReading: true,
    easyReadingFunctionMode: functionMode,
  };
  view.bbscore = {
    buf: view.buf,
    aidNavigation: { active: false },
    longPush: { active: false },
    deepLinkController: {},
    easyReading: {
      _onKeyDown: vi.fn(() => easyResult),
      tryReenterFromNative: vi.fn(() => false),
    },
    activeListSession: () => null,
    endTurnsOnLiveUpdate: false,
  };
  view._keyboard = { onKeyDown: vi.fn() };
  view.flashListHint = vi.fn();
  return view;
}

describe("term_view.onKeyDown 的接線", () => {
  test("好讀回 'browser' ⇒ 不落到 _keyboard（不送 ^F）、不 preventDefault", () => {
    const view = makeView({ easyResult: "browser" });
    const e = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, cancelable: true });
    view.onKeyDown(e);
    expect(view._keyboard.onKeyDown).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  test("functionMode（prompt 內）不經好讀 gate，Ctrl+F 照送 PTT", () => {
    const view = makeView({ functionMode: true, easyResult: "browser" });
    const e = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, cancelable: true });
    view.onKeyDown(e);
    expect(view.bbscore.easyReading._onKeyDown).not.toHaveBeenCalled();
    expect(view._keyboard.onKeyDown).toHaveBeenCalledTimes(1);
  });
});
