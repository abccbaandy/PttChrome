// @unit-env browser
// real-input: tests/e2e/offline/mobile_toolbar.offline.spec.js
//   （touchscreen.tap；本檔手捏事件只測分支邏輯，見 tests/unit/e2e_real_input.test.js）
// 手機底部工具列（src/components/MobileToolbar）。鎖：
//  1. 按鈕依畫面顯示（推＝文章裡；搜尋＝列表）——資料來自 App.onScreenContextChange；
//  2. 送鍵走 view.sendKeyAsUser（鍵盤同一條分派），不是裸送 byte；
//  3. mousedown 被 preventDefault（不搶 #t 焦點）、滑鼠事件不外洩到 window；
//  4. 工具列高度 ＝ MOBILE_TOOLBAR_PX（終端機可用高度扣的就是它）。
import { render, fireEvent, act } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MobileToolbar, LOGOUT_CONFIRM_MS, HAPTIC_MS } from "../../src/components/MobileToolbar";
import { MOBILE_TOOLBAR_PX } from "../../src/js/mobile_layout";
import { setupI18n, i18n } from "../../src/js/i18n";
import { readValuesWithDefault, writeValues } from "../../src/js/pref_storage";
import toolbarCss from "../../src/components/MobileToolbar/MobileToolbar.css?raw";

beforeAll(() => {
  setupI18n();
});

function makeCore({ mobile = true, context } = {}) {
  const listeners = new Set();
  const ctxListeners = new Set();
  let ctx = context || { push: false, search: [] };
  const core = {
    mobile,
    softKeyboard: false,
    mobileSelectMode: false,
    mobileCtrlArmed: false,
    view: { sendKeyAsUser: vi.fn() },
    startLogout: vi.fn(() => true),
    setMobileKeysPanelInset: vi.fn(),
    setMobileSelectMode: vi.fn((on) => {
      core.mobileSelectMode = !!on;
      return core.mobileSelectMode;
    }),
    setMobileCtrlArmed: vi.fn((on) => {
      core.mobileCtrlArmed = !!on;
      return core.mobileCtrlArmed;
    }),
    toggleSoftKeyboard: vi.fn(() => {
      core.softKeyboard = !core.softKeyboard;
      return core.softKeyboard;
    }),
    onMobileChange: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    onScreenContextChange: (fn) => {
      ctxListeners.add(fn);
      fn(ctx);
      return () => ctxListeners.delete(fn);
    },
    emit: (m, kb = false, sel = false, c = false) => {
      core.mobile = m;
      listeners.forEach((fn) => fn(m, kb, sel, c));
    },
    setContext: (next) => {
      ctx = next;
      ctxListeners.forEach((fn) => fn(next));
    },
  };
  return core;
}

const byKey = (k) => document.querySelector(`[data-key="${k}"]`);
// 「更多」是 Mantine Drawer：內容在 transition 開始後才掛上、結束後才卸下（非同步）。
const openMore = async () => {
  fireEvent.click(byKey("__more"));
  await vi.waitFor(() => expect(byKey("__select")).not.toBeNull());
};
const sheetClosed = () => vi.waitFor(() => expect(byKey("__select")).toBeNull());
// 「更多」是 Mantine Drawer（components/MobileSheet）⇒ 要 MantineProvider。
const renderBar = (core, props = {}) =>
  render(
    <MantineProvider>
      <MobileToolbar pttchrome={core} {...props} />
    </MantineProvider>,
  );

describe("顯示", () => {
  test("非手機不渲染；mobile 變化時跟著出現／消失", () => {
    const core = makeCore({ mobile: false });
    renderBar(core);
    expect(document.getElementById("mobileToolbar")).toBeNull();
    act(() => core.emit(true));
    expect(document.getElementById("mobileToolbar")).not.toBeNull();
    act(() => core.emit(false));
    expect(document.getElementById("mobileToolbar")).toBeNull();
  });

  test("modal 開著時隱藏", () => {
    renderBar(makeCore(), { hidden: true });
    expect(document.getElementById("mobileToolbar")).toBeNull();
  });

  test("按鍵、更多常駐；推只在文章、搜尋只在列表", () => {
    const core = makeCore();
    renderBar(core);
    expect(byKey("__keys")).not.toBeNull();
    expect(byKey("__more")).not.toBeNull();
    expect(byKey("X")).toBeNull();
    expect(byKey("__search")).toBeNull();
    act(() => core.setContext({ push: true, search: [] }));
    expect(byKey("X")).not.toBeNull();
    expect(byKey("__search")).toBeNull();
    act(() => core.setContext({ push: false, search: ["title", "author", "push", "board"] }));
    expect(byKey("X")).toBeNull();
    expect(byKey("__search")).not.toBeNull();
  });

  test("工具列高度與 MOBILE_TOOLBAR_PX 一致（終端機可用高度扣的就是它）", () => {
    const m = /\.mobileToolbarBar\s*\{[^}]*?\bheight:\s*(\d+)px/.exec(toolbarCss);
    expect(m && Number(m[1])).toBe(MOBILE_TOOLBAR_PX);
  });
});

describe("推／搜尋", () => {
  test("推送 X（走 sendKeyAsUser，跟實體鍵盤同一條分派 ⇒ 預設開長推文）", () => {
    const core = makeCore({ context: { push: true, search: [] } });
    renderBar(core);
    fireEvent.click(byKey("X"));
    expect(core.view.sendKeyAsUser).toHaveBeenCalledWith("X");
  });

  test("推文列收進底部導覽（收合模式）⇒ 推＝展開推文列，不送 X；收合關掉或列不可用 ⇒ 照送 X", () => {
    const core = makeCore({ context: { push: true, search: [] } });
    core.commentBar = { state: { available: true, folded: true }, expand: vi.fn(() => true) };
    renderBar(core);
    fireEvent.click(byKey("X"));
    expect(core.commentBar.expand).toHaveBeenCalledTimes(1);
    expect(core.view.sendKeyAsUser).not.toHaveBeenCalled();
    core.commentBar.state = { available: true, folded: false };
    fireEvent.click(byKey("X"));
    expect(core.view.sendKeyAsUser).toHaveBeenLastCalledWith("X");
    core.commentBar.state = { available: false, folded: true };
    fireEvent.click(byKey("X"));
    expect(core.commentBar.expand).toHaveBeenCalledTimes(1);
    expect(core.view.sendKeyAsUser).toHaveBeenCalledTimes(2);
  });

  // 使用者定案：不要子選單，直接開彈窗（種類在彈窗上方切）。
  test("搜尋直接開彈窗：文章列表預設標題，不出現子選單", () => {
    const core = makeCore({ context: { push: false, search: ["title", "author", "push", "board"] } });
    const onOpenSearch = vi.fn();
    renderBar(core, { onOpenSearch });
    fireEvent.click(byKey("__search"));
    expect(onOpenSearch).toHaveBeenCalledWith("title");
    expect(document.querySelector('[data-panel="search"]')).toBeNull();
    expect(document.querySelector('[data-key^="__search_"]')).toBeNull();
  });

  test("看板列表／主功能表：預設看板", () => {
    const core = makeCore({ context: { push: false, search: ["board"] } });
    const onOpenSearch = vi.fn();
    renderBar(core, { onOpenSearch });
    fireEvent.click(byKey("__search"));
    expect(onOpenSearch).toHaveBeenCalledWith("board");
  });

  test("按搜尋會收掉開著的按鍵面板", () => {
    const core = makeCore({ context: { push: false, search: ["title"] } });
    renderBar(core, { onOpenSearch: vi.fn() });
    fireEvent.click(byKey("__keys"));
    expect(byKey("PageDown")).not.toBeNull();
    fireEvent.click(byKey("__search"));
    expect(byKey("PageDown")).toBeNull();
  });
});

describe("依畫面的動作（文章／信件／文章列表）", () => {
  const ARTICLE = { push: true, reply: true, mail: false, share: true, threadNav: true, post: false, search: [] };

  test("文章：推／回文（分享在「更多」裡），回文送 y（pager_common_cmds）", () => {
    const core = makeCore({ context: ARTICLE });
    renderBar(core);
    expect(["X", "__reply", "__keys", "__more"].every((k) => byKey(k))).toBe(true);
    expect(byKey("__share")).toBeNull();
    expect(byKey("__post")).toBeNull();
    expect(byKey("__reply").textContent).toBe(i18n("mobileToolbar_reply"));
    fireEvent.click(byKey("__reply"));
    expect(core.view.sendKeyAsUser).toHaveBeenLastCalledWith("y");
  });

  test("信件 pager：只有回信（label 換成回信），沒有推／分享", () => {
    renderBar(makeCore({ context: { ...ARTICLE, push: false, share: false, threadNav: false, mail: true } }));
    expect(byKey("__reply").textContent).toBe(i18n("mobileToolbar_replyMail"));
    expect(byKey("X")).toBeNull();
    expect(byKey("__share")).toBeNull();
  });

  test("分享（在「更多」裡）：同步呼叫 deepLinkController.shareCurrentPostLink（帶 App Bar 標題）", async () => {
    const core = makeCore({
      context: { ...ARTICLE, appBar: { kind: "article", title: "[問卦] 測試", subtitle: "", newMail: false } },
    });
    core.deepLinkController = { shareCurrentPostLink: vi.fn(() => true) };
    renderBar(core);
    expect(byKey("__share")).toBeNull();
    await openMore();
    fireEvent.click(byKey("__share"));
    expect(core.deepLinkController.shareCurrentPostLink).toHaveBeenCalledWith("[問卦] 測試");
    await sheetClosed();
  });

  test("更多：不是文章（share false）就沒有分享", async () => {
    renderBar(makeCore({ context: { ...ARTICLE, share: false } }));
    await openMore();
    expect(byKey("__share")).toBeNull();
  });

  test("重整：永遠在，context.refresh 為假時反灰；按下走 screenRefresh.refresh('toolbar')", () => {
    const core = makeCore({ context: { ...ARTICLE, refresh: false } });
    core.screenRefresh = { refresh: vi.fn(() => true) };
    renderBar(core);
    expect(byKey("__refresh").disabled).toBe(true);
    fireEvent.click(byKey("__refresh"));
    expect(core.screenRefresh.refresh).not.toHaveBeenCalled();
    act(() => core.setContext({ ...ARTICLE, refresh: true }));
    expect(byKey("__refresh").disabled).toBe(false);
    fireEvent.click(byKey("__refresh"));
    expect(core.screenRefresh.refresh).toHaveBeenCalledWith("toolbar");
    expect(core.view.sendKeyAsUser).not.toHaveBeenCalled();
  });

  test("到底：永遠在，context.end 為假時反灰；送 End（走 sendKeyAsUser）", () => {
    const core = makeCore({ context: { ...ARTICLE, end: false } });
    renderBar(core);
    expect(byKey("__end").disabled).toBe(true);
    act(() => core.setContext({ ...ARTICLE, end: true }));
    fireEvent.click(byKey("__end"));
    expect(core.view.sendKeyAsUser).toHaveBeenLastCalledWith("End");
  });

  test("格位固定：重整／到底／按鍵／更多在文章、列表、主功能表都在同一格", () => {
    const core = makeCore({ context: ARTICLE });
    renderBar(core);
    const slotOf = (k) => [...document.querySelector(".mobileToolbarBar").children].indexOf(byKey(k));
    const positions = () => ["__refresh", "__end", "__keys", "__more"].map(slotOf);
    const inArticle = positions();
    expect(inArticle).toEqual([2, 3, 4, 5]);
    act(() => core.setContext({ push: false, search: ["title"], post: true, refresh: true, end: true }));
    expect(positions()).toEqual(inArticle);
    expect(slotOf("__search")).toBe(0);
    expect(slotOf("__post")).toBe(1);
    act(() => core.setContext({ push: false, search: ["board"] }));
    expect(positions()).toEqual(inArticle);
    expect(slotOf("__search")).toBe(0);
    // 沒有第 2 格動作 ⇒ 佔位（寬度照算），不是把後面的按鈕往前擠。
    expect(document.querySelector('[data-slot-empty="1"]')).not.toBeNull();
    expect(document.querySelector(".mobileToolbarBar").children.length).toBe(6);
  });

  test("冷卻：反灰＋按鈕上倒數，歸零後恢復（F5／下拉觸發的冷卻也會通知）", () => {
    vi.useFakeTimers();
    try {
      let left = 0;
      const listeners = new Set();
      const core = makeCore({ context: { ...ARTICLE, refresh: true } });
      core.screenRefresh = {
        refresh: vi.fn(() => true),
        cooldownLeftMs: () => left,
        onCooldown: (fn) => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
      };
      renderBar(core);
      expect(byKey("__refresh").disabled).toBe(false);
      expect(byKey("__refresh").textContent).toBe(i18n("mobileToolbar_refresh"));
      left = 4200;
      act(() => listeners.forEach((fn) => fn(left)));
      expect(byKey("__refresh").disabled).toBe(true);
      expect(byKey("__refresh").textContent).toBe("5" + i18n("mobileToolbar_secUnit"));
      left = 1500;
      act(() => vi.advanceTimersByTime(300));
      expect(byKey("__refresh").textContent).toBe("2" + i18n("mobileToolbar_secUnit"));
      left = 0;
      act(() => vi.advanceTimersByTime(300));
      expect(byKey("__refresh").disabled).toBe(false);
      expect(byKey("__refresh").textContent).toBe(i18n("mobileToolbar_refresh"));
    } finally {
      vi.useRealTimers();
    }
  });

  test("文章列表：發文送 Ctrl+P（Alt remap，繞過瀏覽器的列印）", () => {
    const core = makeCore({ context: { push: false, search: ["title"], post: true } });
    renderBar(core);
    fireEvent.click(byKey("__post"));
    expect(core.view.sendKeyAsUser).toHaveBeenLastCalledWith("p", { altKey: true });
  });

  test("更多：文章導覽只在文章出現，送 [ ] = b f 並收起 sheet", async () => {
    const core = makeCore({ context: ARTICLE });
    renderBar(core);
    for (const k of ["[", "]", "=", "b", "f"]) {
      await openMore();
      fireEvent.click(byKey(k));
      await sheetClosed();
    }
    expect(core.view.sendKeyAsUser.mock.calls.map((c) => c[0])).toEqual(["[", "]", "=", "b", "f"]);
    act(() => core.setContext({ push: false, search: [] }));
    await openMore();
    expect(byKey("__threadNav")).toBeNull();
  });

  test("按下有觸覺回饋（navigator.vibrate 短震）", () => {
    const vibrate = vi.fn(() => true);
    const orig = Object.getOwnPropertyDescriptor(Navigator.prototype, "vibrate");
    Object.defineProperty(navigator, "vibrate", { configurable: true, value: vibrate });
    try {
      renderBar(makeCore({ context: ARTICLE }));
      fireEvent.click(byKey("__reply"));
      expect(vibrate).toHaveBeenCalledWith(HAPTIC_MS);
    } finally {
      delete navigator.vibrate;
      if (orig) Object.defineProperty(Navigator.prototype, "vibrate", orig);
    }
  });

  test("每個按鈕都有 icon＋文字 label", () => {
    renderBar(makeCore({ context: ARTICLE }));
    for (const btn of document.querySelectorAll(".mobileToolbarBtn")) {
      expect(btn.querySelector("svg")).not.toBeNull();
      expect(btn.querySelector(".mobileToolbarLabel").textContent.length).toBeGreaterThan(0);
    }
  });
});

describe("按鍵面板", () => {
  test("預設收起，按「按鍵」展開，按鍵走 sendKeyAsUser", () => {
    const core = makeCore();
    renderBar(core);
    expect(byKey("PageDown")).toBeNull();
    fireEvent.click(byKey("__keys"));
    for (const k of ["PageDown", "ArrowLeft", "Escape", "Tab", "Delete"]) fireEvent.click(byKey(k));
    expect(core.view.sendKeyAsUser.mock.calls.map((c) => c[0])).toEqual([
      "PageDown",
      "ArrowLeft",
      "Escape",
      "Tab",
      "Delete",
    ]);
    fireEvent.click(byKey("__keys"));
    expect(byKey("PageDown")).toBeNull();
  });

  test("展開時把面板高度回報給 App（終端機排在面板上方），收起回 0", () => {
    const core = makeCore();
    renderBar(core);
    fireEvent.click(byKey("__keys"));
    const last = () => core.setMobileKeysPanelInset.mock.calls.at(-1)[0];
    expect(last()).toBeGreaterThan(0);
    fireEvent.click(byKey("__keys"));
    expect(last()).toBe(0);
  });

  test("鍵盤鈕呼叫 toggleSoftKeyboard；App 自己歸零時亮燈跟著熄", () => {
    const core = makeCore();
    renderBar(core);
    fireEvent.click(byKey("__keys"));
    fireEvent.click(byKey("__keyboard"));
    expect(core.toggleSoftKeyboard).toHaveBeenCalledTimes(1);
    expect(byKey("__keyboard").getAttribute("aria-pressed")).toBe("true");
    act(() => core.emit(true, false));
    expect(byKey("__keyboard").getAttribute("aria-pressed")).toBe("false");
  });

  test("Ctrl：切 App 的黏滯狀態，用掉之後（App 通知）亮燈熄", () => {
    const core = makeCore();
    renderBar(core);
    fireEvent.click(byKey("__keys"));
    fireEvent.click(byKey("__ctrl"));
    expect(core.setMobileCtrlArmed).toHaveBeenCalledWith(true);
    expect(byKey("__ctrl").getAttribute("aria-pressed")).toBe("true");
    act(() => core.emit(true, false, false, false));
    expect(byKey("__ctrl").getAttribute("aria-pressed")).toBe("false");
    expect(core.view.sendKeyAsUser).not.toHaveBeenCalled();
  });
});

describe("更多（bottom sheet）", () => {
  test("選取模式：呼叫 setMobileSelectMode", async () => {
    const core = makeCore();
    renderBar(core);
    await openMore();
    expect(byKey("__select").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(byKey("__select"));
    expect(core.setMobileSelectMode).toHaveBeenCalledWith(true);
  });

  test("設為全部已讀：只在文章列表（context.markAllRead）出現，按下走 markAllRead.start 並收起", async () => {
    const core = makeCore({ context: { push: false, search: [], markAllRead: true } });
    core.markAllRead = { start: vi.fn(() => true) };
    renderBar(core);
    await openMore();
    fireEvent.click(byKey("__markAllRead"));
    expect(core.markAllRead.start).toHaveBeenCalledTimes(1);
    await sheetClosed();
  });

  test("操作說明：底列有 (h)說明 才出現（context.help），按下送 h（sendKeyAsUser）並收起", async () => {
    const core = makeCore({ context: { push: false, search: [], help: true } });
    renderBar(core);
    await openMore();
    fireEvent.click(byKey("__help"));
    expect(core.view.sendKeyAsUser).toHaveBeenCalledWith("h");
    await sheetClosed();
  });

  test("操作說明：沒有 (h)說明 的畫面就沒有", async () => {
    renderBar(makeCore());
    await openMore();
    expect(byKey("__help")).toBeNull();
  });

  test("設為全部已讀：不是文章列表就沒有", async () => {
    renderBar(makeCore());
    await openMore();
    expect(byKey("__markAllRead")).toBeNull();
  });

  test("全選：有內容的畫面才有（context.contentTools），按下呼叫 doSelectAll（桌機右鍵同一個入口）", async () => {
    const core = makeCore({ context: { push: false, search: [], contentTools: true } });
    core.doSelectAll = vi.fn();
    renderBar(core);
    await openMore();
    fireEvent.click(byKey("__selectAll"));
    expect(core.doSelectAll).toHaveBeenCalledTimes(1);
  });

  test("主功能表（contentTools 假）：沒有全選、也沒有圖片上傳兩項", async () => {
    const core = makeCore();
    core.imageUpload = { openFilePicker: vi.fn(), openPanel: vi.fn() };
    renderBar(core);
    await openMore();
    expect(byKey("__selectAll")).toBeNull();
    expect(byKey("__uploadImage")).toBeNull();
    expect(byKey("__uploadHistory")).toBeNull();
  });

  test("圖片上傳兩項：跟著 enableImageUpload；按下開檔案選擇器／上傳紀錄", async () => {
    const core = makeCore({ context: { push: false, search: [], contentTools: true } });
    core.imageUpload = { openFilePicker: vi.fn(), openPanel: vi.fn() };
    writeValues({ ...readValuesWithDefault(), enableImageUpload: false });
    try {
      const r = renderBar(core);
      await openMore();
      expect(byKey("__uploadImage")).toBeNull();
      expect(byKey("__uploadHistory")).toBeNull();
      r.unmount();

      writeValues({ ...readValuesWithDefault(), enableImageUpload: true });
      renderBar(core);
      await openMore();
      fireEvent.click(byKey("__uploadImage"));
      expect(core.imageUpload.openFilePicker).toHaveBeenCalledTimes(1);
      await sheetClosed();
      await openMore();
      fireEvent.click(byKey("__uploadHistory"));
      expect(core.imageUpload.openPanel).toHaveBeenCalledTimes(1);
    } finally {
      window.localStorage.clear();
    }
  });

  // 症狀（使用者回報）：手機叫不出快速搜尋。選取模式下長按走 Chrome 原生選單，我們的長按
  // 選單（快速搜尋原本唯一的入口）出不來 ⇒ 選好字後從「更多」查。
  describe("快速搜尋（選取模式下的選取）", () => {
    let textEl;
    const selectText = () => {
      const range = document.createRange();
      range.selectNodeContents(textEl);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    };
    beforeEach(() => {
      textEl = document.createElement("div");
      textEl.textContent = "12345678";
      document.body.appendChild(textEl);
    });
    afterEach(() => {
      window.getSelection().removeAllRanges();
      textEl.remove();
    });

    test("REGRESSION：選取模式＋有選取 ⇒ 列出快速搜尋，按下開新分頁並收起", async () => {
      const open = vi.spyOn(window, "open").mockImplementation(() => null);
      try {
        const core = makeCore();
        core.mobileSelectMode = true;
        renderBar(core);
        selectText();
        await openMore();
        // 純數字 ⇒ 內建三項（Google＋pixiv 兩項）都出現，關鍵字畫在第二行。
        const google = byKey("__qs-google");
        expect(google).not.toBeNull();
        expect(byKey("__qs-pixiv-user")).not.toBeNull();
        expect(google.textContent).toContain("12345678");
        fireEvent.click(google);
        expect(open).toHaveBeenCalledWith(
          "https://www.google.com/search?q=12345678",
          "_blank",
          "noopener",
        );
        await sheetClosed();
      } finally {
        open.mockRestore();
      }
    });

    test("按下「更多」的 tap 先把選取清掉也沒關係：用 pointerdown 當下記住的選取", async () => {
      const core = makeCore();
      core.mobileSelectMode = true;
      renderBar(core);
      selectText();
      fireEvent.pointerDown(byKey("__more"));
      window.getSelection().removeAllRanges();
      await openMore();
      expect(byKey("__qs-google")).not.toBeNull();
    });

    test("選取模式關（長按選單本身就有快速搜尋）／沒有選取 ⇒ 不列", async () => {
      const core = makeCore();
      const r = renderBar(core);
      selectText();
      await openMore();
      expect(byKey("__qs-google")).toBeNull();
      r.unmount();

      core.mobileSelectMode = true;
      window.getSelection().removeAllRanges();
      renderBar(core);
      await openMore();
      expect(byKey("__qs-google")).toBeNull();
    });
  });

  test("設定：交給 onOpenSettings", async () => {
    const onOpenSettings = vi.fn();
    renderBar(makeCore(), { onOpenSettings });
    await openMore();
    fireEvent.click(byKey("__settings"));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  test("登出要二次確認；確認才呼叫 startLogout", async () => {
    const core = makeCore();
    renderBar(core);
    await openMore();
    fireEvent.click(byKey("__logout"));
    expect(core.startLogout).not.toHaveBeenCalled();
    fireEvent.click(byKey("__logoutYes"));
    expect(core.startLogout).toHaveBeenCalledTimes(1);
  });

  // sheet 開著＝modal（遮罩點下去的 click 會到 window 上的 App 滑鼠入口，靠 modalShown
  // 早退）；系統返回＝收起（向 App 登記關閉函式，history_back_guard 先問它）。
  test("開著時以具名來源設 modal、登記系統返回；收起時兩者都撤銷", async () => {
    const core = makeCore();
    const sources = new Set();
    core.setModalOpen = vi.fn((s, on) => (on ? sources.add(s) : sources.delete(s)));
    const dismissers = [];
    core.registerSheetDismiss = vi.fn((fn) => {
      dismissers.push(fn);
      return () => dismissers.splice(dismissers.indexOf(fn), 1);
    });
    renderBar(core);
    expect(sources.size).toBe(0);
    await openMore();
    expect(sources.size).toBe(1);
    expect(dismissers).toHaveLength(1);
    act(() => dismissers[0]()); // 系統返回
    await sheetClosed();
    expect(sources.size).toBe(0);
    expect(dismissers).toHaveLength(0);
  });

  test("登出確認沒動作會自己收回（防口袋誤觸）", async () => {
    const core = makeCore();
    renderBar(core);
    await openMore();
    vi.useFakeTimers();
    try {
      fireEvent.click(byKey("__logout"));
      expect(byKey("__logoutYes")).not.toBeNull();
      act(() => vi.advanceTimersByTime(LOGOUT_CONFIRM_MS + 10));
      expect(byKey("__logoutYes")).toBeNull();
      expect(byKey("__logout")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("焦點與事件邊界", () => {
  test("mousedown 被 preventDefault（不搶 #t 焦點）", () => {
    renderBar(makeCore());
    const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    byKey("__keys").dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  // 「更多」sheet 在 portal 裡、不在這道攔截內：它開著算 modal，App 的滑鼠入口靠
  // modalShown 早退（見上面「更多（bottom sheet）」的 modal 測試）。
  test("工具列與按鍵面板的 mousedown／mouseup／click 不外洩到 window", () => {
    renderBar(makeCore({ context: { push: false, search: ["title"] } }));
    fireEvent.click(byKey("__keys"));
    const seen = [];
    const spy = (e) => seen.push(e.type);
    for (const t of ["mousedown", "mouseup", "click"]) window.addEventListener(t, spy);
    try {
      for (const k of ["__search", "PageDown"])
        for (const t of ["mousedown", "mouseup", "click"])
          byKey(k).dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }));
    } finally {
      for (const t of ["mousedown", "mouseup", "click"]) window.removeEventListener(t, spy);
    }
    expect(seen).toEqual([]);
  });
});

describe("更多：常用項目的圖示格（P40）", () => {
  const grid = () => document.querySelector("[data-more-grid]");
  const LIST_CTX = { push: false, search: [], markAllRead: true, contentTools: true };

  test("文章列表：常用的收進上面的圖示格（短字＋完整字在 aria-label），設定／登出留在下面清單", async () => {
    const core = makeCore({ context: LIST_CTX });
    renderBar(core);
    await openMore();
    const g = grid();
    expect(g).not.toBeNull();
    for (const k of ["__markAllRead", "__select", "__selectAll"]) {
      expect(g.contains(byKey(k))).toBe(true);
    }
    expect(g.contains(byKey("__settings"))).toBe(false);
    expect(g.contains(byKey("__logout"))).toBe(false);
    const markAll = byKey("__markAllRead");
    expect(markAll.getAttribute("aria-label")).toBe(i18n("cmenu_markAllRead"));
    expect(markAll.textContent).toBe(i18n("mobileMoreShort_markAllRead"));
    expect(markAll.querySelector("svg")).not.toBeNull();
    // 圖示格在清單上面（不捲就點得到）
    expect(g.compareDocumentPosition(byKey("__settings")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("圖示格裡的開關照舊：選取模式 aria-pressed，點了呼叫 setMobileSelectMode", async () => {
    const core = makeCore({ context: LIST_CTX });
    renderBar(core);
    await openMore();
    const sel = byKey("__select");
    expect(grid().contains(sel)).toBe(true);
    expect(sel.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(sel);
    expect(core.setMobileSelectMode).toHaveBeenCalledWith(true);
  });

  // 開著的時候畫面 context 變了（開機剛連上、還沒第一次 screenSettled 就開了「更多」）：
  // 「選取模式」原本在清單，context 一更新圖示格湊滿 3 格就被搬進去 ⇒ 按鈕節點換掉，
  // 手指按下到放開之間換掉 ⇒ Chromium 不發 click（同 #152）。開著時不搬已經畫出來的項目。
  test("開著時 context 變了：已經畫出來的項目不搬家（節點不換）；關掉重開才重新分組", async () => {
    const core = makeCore();
    renderBar(core);
    await openMore();
    const sel = byKey("__select");
    expect(grid()).toBeNull();
    act(() => core.setContext(LIST_CTX));
    expect(byKey("__select")).toBe(sel);
    expect(sel.isConnected).toBe(true);
    // 新出現的項目照樣出現
    expect(byKey("__markAllRead")).not.toBeNull();
    fireEvent.click(sel);
    expect(core.setMobileSelectMode).toHaveBeenCalledWith(true);
    await sheetClosed();
    await openMore();
    expect(grid().contains(byKey("__select"))).toBe(true);
  });

  test("主功能表（項目太少）：不收圖示格，照舊是清單", async () => {
    const core = makeCore();
    renderBar(core);
    await openMore();
    expect(grid()).toBeNull();
    expect(byKey("__select").classList.contains("mobileSheetItem")).toBe(true);
    expect(byKey("__select").textContent).toBe(i18n("mobileKeypad_select"));
  });
});
