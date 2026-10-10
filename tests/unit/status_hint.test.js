// @unit-env browser
// 狀態提示分級（src/js/status_hint.js）＋顯示開關 showStatusHints。
//
// 行為合約：
//   - 一般提示（讀取中、已切至原生、推文已送出…）在 showStatusHints=false 時不出現；
//   - 錯誤提示（逾時切原生、操作失敗）永遠出現，且顏色跟一般提示不同（紅底）；
//   - 逾時／偏離被迫切原生的出口一律以錯誤級送出。
import {
  HINT_ERROR,
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
  test("預設開啟", () => {
    expect(DEFAULT_PREFS.showStatusHints).toBe(true);
  });
  test("錯誤與一般的顏色不同", () => {
    expect(hintColors(HINT_ERROR).background).not.toBe(hintColors().background);
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
