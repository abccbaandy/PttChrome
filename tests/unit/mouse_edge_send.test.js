// 邊緣翻頁區的**出口**鎖（區域判斷本身在 mouse_regions.test.js）。
//
// 這裡鎖的是一件純函式看不到、但一漏就壞得很難看的事：
//
//   四種邊緣動作一律走 App.sendNavKeyAsUser（合成 keydown 走既有分派鏈），
//   **絕不直送 byte**。
//
// 理由與 docs/mouse.md「出口」那節相同：同一顆 PageUp 在三條 render 分支的語意
// 完全不同 —— 原生要送 \x1b[5~ 給 PTT、文章好讀是捲一頁（easy_reading 的 case）、
// 列表好讀必須走 ListSession 的封閉互動交易（裸送 byte ＝在交易中途插隊）。那三套
// 早就寫在鍵盤路徑上，直送只會各自重寫一遍。
import { App } from "../../src/js/pttchrome";
import {
  ACT_PAGE_UP,
  ACT_PAGE_DOWN,
  ACT_HOME,
  ACT_END,
  ACT_ENTER,
  ACT_NONE,
} from "../../src/js/mouse_regions";

function makeApp({ action = ACT_NONE, mouseActionRow = -1, cur_y = 5 } = {}) {
  const app = Object.create(App.prototype);
  app.conn = { isConnected: true };
  app.aidNavigation = { active: false };
  app.buf = { mouseAction: action, mouseActionRow, cur_y };
  app.view = { _send: vi.fn() };
  app.easyReading = { _onMouseClick: vi.fn() };
  app.onDisableLiveHelperModalState = vi.fn();
  app.sendNavKeyAsUser = vi.fn(() => true);
  return app;
}

const clickEvent = () => ({ defaultPrevented: false, preventDefault: vi.fn() });

describe("App.onMouse_click：邊緣區送的是按鍵，不是 byte", () => {
  test.each([
    [ACT_PAGE_UP, "PageUp"],
    [ACT_PAGE_DOWN, "PageDown"],
    [ACT_HOME, "Home"],
    [ACT_END, "End"],
  ])("%s → sendNavKeyAsUser('%s')，view._send 一個 byte 都沒有", (action, key) => {
    const app = makeApp({ action });
    app.onMouse_click(clickEvent());
    expect(app.sendNavKeyAsUser).toHaveBeenCalledWith(key);
    expect(app.view._send).not.toHaveBeenCalled();
  });

  // 另一半：既有的動作沒有被這四個 case 搶走。
  test("ACT_ENTER 仍然是「移游標＋Enter」的 byte 序列", () => {
    const app = makeApp({ action: ACT_ENTER, mouseActionRow: 8, cur_y: 5 });
    app.onMouse_click(clickEvent());
    expect(app.sendNavKeyAsUser).not.toHaveBeenCalled();
    expect(app.view._send).toHaveBeenCalledWith("\x1b[B\x1b[B\x1b[B\r");
  });

  test("ACT_NONE 真的什麼都不做（舊 case 0 會送左方向鍵）", () => {
    const app = makeApp({ action: ACT_NONE });
    app.onMouse_click(clickEvent());
    expect(app.sendNavKeyAsUser).not.toHaveBeenCalled();
    expect(app.view._send).not.toHaveBeenCalled();
  });

  // sendNavKeyAsUser 自己帶 navKeyAllowed 守門（modal／未連線／pageState 0,5,6／
  // PTT 開著輸入框都不送），所以這條路不必、也不應該在點擊端再判一次。
  test("守門說不送就不送，而且不會退而求其次直送 byte", () => {
    const app = makeApp({ action: ACT_PAGE_DOWN });
    app.sendNavKeyAsUser = vi.fn(() => false);
    app.onMouse_click(clickEvent());
    expect(app.view._send).not.toHaveBeenCalled();
  });

  // 好讀模式的文章：easyReading._onMouseClick 只在 ACT_EXIT_ARTICLE 時
  // stopEasyReading()，翻頁動作**不可以**把使用者踢出好讀（那是最容易漏的一條）。
  test("文章好讀：翻頁不會觸發 stopEasyReading", () => {
    const app = makeApp({ action: ACT_PAGE_DOWN });
    let stopped = false;
    app.easyReading = {
      _onMouseClick: vi.fn(() => {
        stopped = true;
      }),
    };
    app.onMouse_click(clickEvent());
    // _onMouseClick 照樣被呼叫（它自己判斷要不要收狀態機），但送出去的仍是按鍵。
    expect(stopped).toBe(true);
    expect(app.sendNavKeyAsUser).toHaveBeenCalledWith("PageDown");
  });
});

// ── 列表好讀（buffer/frozen）那一條分支 ──────────────────────────────────────
//
// 那個畫面的點擊**永遠不會**走到上面的 action switch（App.mouse_click 提早分流給
// ListSession），所以邊緣區在那裡必須另外接一次。兩件事要鎖：
//   1. 邊緣區送的仍然是按鍵（ListSession._classifyKey 會把它變成 nav 交易），
//      不可以繞過 CommandQueue 直送 byte；
//   2. 它吃的是**螢幕列號**，不是 clientToPos 回來的序列 index。
describe("App.mouse_click：列表好讀視窗的邊緣區", () => {
  function makeListApp({ edge = null } = {}) {
    const app = Object.create(App.prototype);
    app.modalShown = false;
    app.CmdHandler = { getAttribute: () => "0", setAttribute: () => {} };
    app.buf = { useMouseBrowsing: true, listRenderMode: "buffer", cur_y: 3 };
    app.view = {
      _send: vi.fn(),
      listEdgeRegion: vi.fn(() => edge),
    };
    app.mouseButtons = { onMouseDown: vi.fn(), onMouseUp: vi.fn() };
    app.aidNavigation = { active: false };
    app.dblclickTimer = null;
    app.setDblclickTimer = vi.fn();
    app.clientToPos = vi.fn(() => ({ col: 70, row: 812 })); // 序列 index，不是螢幕列
    app.gridGeometry = vi.fn(() => ({
      chh: 24,
      rows: 24,
      scaleX: 1,
      scaleY: 1,
      firstGridTop: 0,
      innerHeight: 600,
    }));
    app.mouseGates = vi.fn(() => ({ leftClick: true }));
    app.sendNavKeyAsUser = vi.fn(() => true);
    app.onMouse_click = vi.fn();
    app.setInputAreaFocus = vi.fn();
    app.checkClass = vi.fn(() => false);
    app._onUploadLayer = vi.fn(() => false);
    const session = { onMouseClick: vi.fn(), onMouseExitClick: vi.fn() };
    app.activeListSession = vi.fn(() => session);
    vi.spyOn(window, "getSelection").mockReturnValue({
      isCollapsed: true,
      toString: () => "",
    });
    return { app, session };
  }

  const listClick = () => ({
    button: 0,
    clientX: 900,
    clientY: 500,
    target: { className: "", tagName: "SPAN", closest: () => null },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  });

  afterEach(() => vi.restoreAllMocks());

  test("命中邊緣區 → 送按鍵，不開文、不直送 byte", () => {
    const { app, session } = makeListApp({
      edge: { action: ACT_PAGE_DOWN, hintBand: {} },
    });
    app.mouse_click(listClick());
    expect(app.sendNavKeyAsUser).toHaveBeenCalledWith("PageDown");
    expect(session.onMouseClick).not.toHaveBeenCalled();
    expect(app.view._send).not.toHaveBeenCalled();
  });

  test("REGRESSION：判斷吃螢幕列號，不是 clientToPos 的序列 index", () => {
    const { app } = makeListApp({ edge: null });
    app.mouse_click(listClick());
    // clientY 500 / 24px 一列 ⇒ 螢幕第 20 列；序列 index 812 絕不可出現在這裡。
    expect(app.view.listEdgeRegion).toHaveBeenCalledWith(20, 70);
  });

  test("沒命中 ⇒ 照舊交給 ListSession 開文", () => {
    const { app, session } = makeListApp({ edge: null });
    app.mouse_click(listClick());
    expect(session.onMouseClick).toHaveBeenCalledWith(812, 70);
    expect(app.sendNavKeyAsUser).not.toHaveBeenCalled();
  });
});

// ── 自家浮動按鈕（開燈／圖文並排／AI 校正／debug 錄製）────────────────────────
//
// REGRESSION：找回邊緣翻頁區之前，文章區的 col >= 7 沒有任何滑鼠動作，所以那幾顆
// 純 <button>（render/merge_buttons.js，**沒有 class**⇒ checkClass 認不出來）點下去
// 只會觸發按鈕自己的 listener。加上「上半／下半翻頁」之後，不擋的話每按一次就順便
// 送一個翻頁鍵給 PTT —— 實錄：lights_on.offline.spec.js 量到送出的 bytes 從 `\` 變成
// `\` ＋ End。
describe("App.mouse_click：自家的浮動按鈕不得觸發翻頁", () => {
  function makeNativeApp(target) {
    const app = Object.create(App.prototype);
    app.modalShown = false;
    app.conn = { isConnected: true };
    app.CmdHandler = { getAttribute: () => "0", setAttribute: () => {} };
    app.buf = {
      useMouseBrowsing: true,
      listRenderMode: "native",
      cur_y: 3,
      mouseAction: ACT_PAGE_DOWN,
      mouseActionRow: -1,
      dismissTarget: () => null,
      onMouse_move: vi.fn(),
    };
    app.view = { _send: vi.fn() };
    app.mouseButtons = { onMouseDown: vi.fn(), onMouseUp: vi.fn() };
    app.aidNavigation = { active: false };
    app.dblclickTimer = null;
    app.setDblclickTimer = vi.fn();
    app.clientToPos = vi.fn(() => ({ col: 40, row: 20 }));
    app.mouseGates = vi.fn(() => ({ leftClick: true, misclickGuard: false }));
    app.activeListSession = vi.fn(() => null);
    app.sendNavKeyAsUser = vi.fn(() => true);
    app.easyReading = { _onMouseClick: vi.fn() };
    app.onDisableLiveHelperModalState = vi.fn();
    app.setInputAreaFocus = vi.fn();
    app.checkClass = vi.fn(() => false);
    app._onUploadLayer = vi.fn(() => false);
    vi.spyOn(window, "getSelection").mockReturnValue({
      isCollapsed: true,
      toString: () => "",
    });
    return {
      app,
      event: {
        button: 0,
        clientX: 100,
        clientY: 100,
        target,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      },
    };
  }

  afterEach(() => vi.restoreAllMocks());

  test("點浮動按鈕本體 ⇒ 一個翻頁鍵都不送", () => {
    const btn = document.createElement("button");
    btn.id = "lightsOnBtn";
    const { app, event } = makeNativeApp(btn);
    app.mouse_click(event);
    expect(app.sendNavKeyAsUser).not.toHaveBeenCalled();
    expect(app.view._send).not.toHaveBeenCalled();
  });

  test("點按鈕裡的文字節點（closest 才抓得到）同樣不送", () => {
    const btn = document.createElement("button");
    const span = document.createElement("span");
    btn.appendChild(span);
    const { app, event } = makeNativeApp(span);
    app.mouse_click(event);
    expect(app.sendNavKeyAsUser).not.toHaveBeenCalled();
  });

  test("NEGATIVE：一般文字上照樣翻頁（別把整個畫面擋掉了）", () => {
    const span = document.createElement("span");
    span.className = "q7 b0";
    const { app, event } = makeNativeApp(span);
    app.mouse_click(event);
    expect(app.sendNavKeyAsUser).toHaveBeenCalledWith("PageDown");
  });
});
