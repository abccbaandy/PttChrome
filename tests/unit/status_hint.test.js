// @unit-env browser
// 狀態提示分級（src/js/status_hint.js）＋顯示開關 showStatusHints。
//
// 行為合約：
//   - 一般提示（讀取中、已切至原生、推文已送出…）在 showStatusHints=false 時不出現；
//   - 錯誤提示（逾時切原生、操作失敗）永遠出現，且顏色跟一般提示不同（紅底）；
//   - 逾時／偏離被迫切原生的出口一律以錯誤級送出；
//   - 設定頁蓋滿畫面時（setHintDialogCover）一般提示不出現、錯誤提示貼到畫面最底，
//     不停在替底部工具列讓位的高度壓住設定說明（e2e：mobile_settings_hint.offline.spec.js）。
import {
  HINT_ERROR,
  hintBottomCss,
  hintColors,
  shouldShowHint,
} from "../../src/js/status_hint";
import { TermView } from "../../src/js/term_view";
import { ListSession } from "../../src/js/list_session";
import { BoardListSession } from "../../src/js/board_list_session";
import { AidNavigation } from "../../src/js/aid_navigation";
import { LogoutSession } from "../../src/js/logout_session";
import { DEFAULT_PREFS } from "../../src/js/pref_storage";

const flash = TermView.prototype.flashListHint;
const setLoading = TermView.prototype.setListLoading;

function fakeView(showStatusHints) {
  return { showStatusHints };
}

afterEach(() => {
  document.querySelectorAll(".ListHint, .ListLoadingHint").forEach((el) => el.remove());
});

describe("shouldShowHint", () => {
  test("錯誤級不受開關影響", () => {
    expect(shouldShowHint(HINT_ERROR, false)).toBe(true);
    expect(shouldShowHint(HINT_ERROR, true)).toBe(true);
  });
  test("一般級跟著開關；未設定＝預設顯示", () => {
    expect(shouldShowHint(undefined, true)).toBe(true);
    expect(shouldShowHint(undefined, false)).toBe(false);
    expect(shouldShowHint(undefined, undefined)).toBe(true);
  });
  test("對話框蓋著：一般級不顯示、錯誤級照常", () => {
    expect(shouldShowHint(undefined, true, true)).toBe(false);
    expect(shouldShowHint(HINT_ERROR, true, true)).toBe(true);
    expect(shouldShowHint(HINT_ERROR, false, true)).toBe(true);
  });
  test("離底距離：平常讓開工具列，對話框蓋著時只讓 safe-area", () => {
    expect(hintBottomCss(48, false)).toBe("calc(var(--term-bottom-inset, 0px) + 48px)");
    expect(hintBottomCss(48, true)).toBe("calc(var(--safe-bottom, 0px) + 16px)");
  });
  test("預設開啟", () => {
    expect(DEFAULT_PREFS.showStatusHints).toBe(true);
  });
  test("錯誤與一般的顏色不同", () => {
    expect(hintColors(HINT_ERROR).background).not.toBe(hintColors().background);
  });
});

describe("TermView.hideListHint", () => {
  test("收掉顯示中的提示，原本的計時不會再改它", () => {
    vi.useFakeTimers();
    try {
      const v = fakeView(true);
      flash.call(v, "跳至 #1gIeu-3A (Android)…", 15000);
      const el = document.querySelector(".ListHint");
      expect(el.style.opacity).toBe("1");
      TermView.prototype.hideListHint.call(v);
      expect(el.style.opacity).toBe("0");
      expect(v._listHintTimer).toBeNull();
      // 之後再閃照常顯示
      flash.call(v, "下一則");
      expect(el.style.opacity).toBe("1");
    } finally {
      vi.useRealTimers();
    }
  });
  test("還沒有提示元素也不會炸", () => {
    expect(() => TermView.prototype.hideListHint.call(fakeView(true))).not.toThrow();
  });
});

describe("TermView.flashListHint", () => {
  test("開關關掉：一般提示不出現", () => {
    const v = fakeView(false);
    flash.call(v, "已切至原生操作");
    expect(document.querySelector(".ListHint")).toBeNull();
  });

  test("開關關掉：錯誤提示照樣出現且為錯誤外觀", () => {
    const v = fakeView(false);
    flash.call(v, "操作逾時，已切至原生模式", 4000, HINT_ERROR);
    const el = document.querySelector(".ListHint");
    expect(el.textContent).toBe("操作逾時，已切至原生模式");
    expect(el.style.opacity).toBe("1");
    expect(el.dataset.level).toBe("error");
    expect(getComputedStyle(el).backgroundColor).toBe("rgba(176, 24, 24, 0.94)");
  });

  test("同一個元素先錯誤後一般：顏色要換回一般", () => {
    const v = fakeView(true);
    flash.call(v, "失敗", 0, HINT_ERROR);
    flash.call(v, "操作完成");
    const el = document.querySelector(".ListHint");
    expect(el.dataset.level).toBe("info");
    expect(getComputedStyle(el).backgroundColor).toBe("rgba(20, 20, 20, 0.88)");
  });
});

describe("TermView.setHintDialogCover（設定頁蓋滿畫面）", () => {
  const cover = TermView.prototype.setHintDialogCover;
  function coverView() {
    const v = fakeView(true);
    v.hideListHint = TermView.prototype.hideListHint;
    v.setListLoading = setLoading;
    return v;
  }

  test("蓋上：顯示中的一般提示收掉，之後的一般提示不出現", () => {
    const v = coverView();
    flash.call(v, "已切至原生操作", 20000);
    const el = document.querySelector(".ListHint");
    cover.call(v, true);
    expect(el.style.opacity).toBe("0");
    flash.call(v, "推文已送出", 20000);
    expect(el.style.opacity).toBe("0");
    clearTimeout(v._listHintTimer);
  });

  test("蓋著時錯誤提示照常、貼底；拿掉後回到讓位的位置", () => {
    const v = coverView();
    cover.call(v, true);
    flash.call(v, "AID 跳文失敗：逾時", 20000, HINT_ERROR);
    const el = document.querySelector(".ListHint");
    expect(el.style.opacity).toBe("1");
    expect(el.style.bottom).toBe(hintBottomCss(48, true));
    cover.call(v, false);
    expect(el.style.opacity).toBe("1");
    expect(el.style.bottom).toBe(hintBottomCss(48, false));
    flash.call(v, "已切至原生操作", 20000);
    expect(el.style.opacity).toBe("1");
    clearTimeout(v._listHintTimer);
  });

  test("蓋上錯誤提示不收；讀取中蓋著先藏、拿掉後照呼叫端要的復原", () => {
    const v = coverView();
    flash.call(v, "失敗", 20000, HINT_ERROR);
    setLoading.call(v, true);
    const loading = document.querySelector(".ListLoadingHint");
    cover.call(v, true);
    expect(document.querySelector(".ListHint").style.opacity).toBe("1");
    expect(loading.style.display).toBe("none");
    cover.call(v, false);
    expect(loading.style.display).toBe("block");
    // 蓋著期間呼叫端已經關掉讀取中 ⇒ 拿掉後不會跑出來
    cover.call(v, true);
    setLoading.call(v, false);
    cover.call(v, false);
    expect(loading.style.display).toBe("none");
    clearTimeout(v._listHintTimer);
  });
});

describe("TermView.setListLoading（讀取中）", () => {
  test("開關關掉時不顯示", () => {
    const v = fakeView(false);
    setLoading.call(v, true);
    const el = document.querySelector(".ListLoadingHint");
    expect(!el || el.style.display === "none").toBe(true);
  });
  test("開關開著時顯示、關閉時隱藏", () => {
    const v = fakeView(true);
    setLoading.call(v, true);
    const el = document.querySelector(".ListLoadingHint");
    expect(el.style.display).toBe("block");
    v.showStatusHints = false;
    setLoading.call(v, false);
    expect(el.style.display).toBe("none");
  });
});

describe("被迫切原生／失敗的出口送錯誤級", () => {
  function recorder() {
    const calls = [];
    return { calls, flashListHint: (msg, ms, level) => calls.push({ msg, level }) };
  }

  test("文章列表 _degradeToNative", () => {
    const view = recorder();
    ListSession.prototype._degradeToNative.call(
      { _view: view, _enterFunctionMode() {} },
      "操作逾時，已切至原生模式",
    );
    expect(view.calls).toEqual([{ msg: "操作逾時，已切至原生模式", level: HINT_ERROR }]);
  });

  test("看板列表 _degradeToNative", () => {
    const view = recorder();
    BoardListSession.prototype._degradeToNative.call(
      { _view: view, _enterNative() {} },
      "進入看板逾時，已切至原生模式",
    );
    expect(view.calls[0].level).toBe(HINT_ERROR);
  });

  test("AID 跳文失敗", () => {
    const view = recorder();
    AidNavigation.prototype._fail.call({
      _view: view,
      _history: { abort() {} },
      _updateBackButton() {},
      _endRun() {},
      _hint: AidNavigation.prototype._hint,
    }, "畫面已變更");
    expect(view.calls[0].level).toBe(HINT_ERROR);
  });

  test("登出失敗", () => {
    const view = recorder();
    LogoutSession.prototype._fail.call({
      active: true,
      _view: view,
      _clearCloseTimer() {},
      _hint: LogoutSession.prototype._hint,
    }, "逾時");
    expect(view.calls[0].level).toBe(HINT_ERROR);
  });
});
