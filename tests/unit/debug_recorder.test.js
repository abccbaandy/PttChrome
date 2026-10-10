// @unit-env browser
// real-input: tests/e2e/offline/debug_record.offline.spec.js
//   （好讀長頁的真滾輪寫進錄製檔；本檔手捏事件只測分支邏輯，見 tests/unit/e2e_real_input.test.js）
import { DebugRecorder, snapshotState, cursorGeomSample } from "../../src/js/debug_recorder";
import { diag, diagActive } from "../../src/js/diag";

// mock app：只給 recorder 用到的面。onData / conn._sendRaw 保留原行為可驗證。
function makeApp() {
  const calls = { onData: [], sendRaw: [] };
  const app = {
    connectState: 1,
    connectedUrl: { url: "wstelnet://x/bbs" },
    buf: { pageState: 2, cur_x: 1, cur_y: 3, cols: 80, rows: 24, easyReadingFunctionMode: false },
    view: {
      useEasyReadingMode: true,
      _gridRender: true,
      chw: 12, chh: 24, scaleX: 1, scaleY: 1,
    },
    listSession: { state: "idle" },
    onData(d) {
      calls.onData.push(d);
    },
    conn: {
      // 真 TelnetConnection 的建構初值（VK_NORMAL）
      _vkStatePrev: 0,
      _sendRaw(d) {
        calls.sendRaw.push(d);
      },
    },
  };
  return { app, calls };
}

describe("snapshotState", () => {
  it("還沒連上（app.conn 不存在）也不會炸", () => {
    const { app } = makeApp();
    app.conn = null;
    expect(() => snapshotState(app)).not.toThrow();
    expect(snapshotState(app).vkState).toBeFalsy();
  });

  it("純讀取輕量快照", () => {
    const { app } = makeApp();
    expect(snapshotState(app)).toEqual({
      pageState: 2,
      cur_x: 1,
      cur_y: 3,
      connectState: 1,
      easyReading: true,
      listState: "idle",
      // 看板列表平滑捲動：本例的 app stub 沒建這個 session ⇒ undefined
      brdListState: undefined,
      // 這一幀的列表畫面是誰在畫（null＝原生）
      listOwner: null,
      fnMode: false,
      gridRender: true,
      srowIsBufRow: false,
      // server 端 vtkbd 停在哪（送出之前）；stub 的 conn 沒送過東西 ⇒ 建構初值 0
      vkState: 0,
      chw: 12,
      chh: 24,
      scaleX: 1,
      scaleY: 1,
      dpr: window.devicePixelRatio,
      fontsReady: document.fonts ? document.fonts.status === "loaded" : undefined,
    });
  });

  // 好讀長頁 ↔ 原生鏡像是游標幾何問題的第一個分岔（推文 prompt 走鏡像）。
  // srowIsBufRow 與 gridRender **不等價**：列表好讀視窗兩者一真一假，而
  // #cursor／#t 的錨點只在兩者皆真時才可信（見 term_view._rowAnchor）。
  it("錄下 functionMode 與 gridRender／srowIsBufRow", () => {
    const { app } = makeApp();
    app.buf.easyReadingFunctionMode = true;
    app.view._gridRender = false;
    const s = snapshotState(app);
    expect(s.fnMode).toBe(true);
    expect(s.gridRender).toBe(false);

    app.view._gridRender = true;
    app.view._srowIsBufRow = true;
    expect(snapshotState(app).srowIsBufRow).toBe(true);
  });

  it("view / buf 缺席時不丟例外", () => {
    expect(() => snapshotState({})).not.toThrow();
    expect(snapshotState({}).gridRender).toBe(false);
  });
});

// 幾何取樣**只錄數字座標，不錄任何文字** ⇒ 不觸及 serializeRecording 的 redact 契約。
describe("cursorGeomSample", () => {
  function mountGrid() {
    document.body.innerHTML =
      '<div class="main" id="m">' +
      '<div id="mainContainer">' +
      '<span type="bbsrow" srow="0">a</span>' +
      '<span type="bbsrow" srow="3">b</span>' +
      "</div>" +
      '<div id="cursor"></div>' +
      "</div>";
    return document.getElementById("m");
  }

  it("取樣 cursor / 該列 / .main（含捲動量）", () => {
    const main = mountGrid();
    const view = { buf: { cur_x: 1, cur_y: 3 }, mainDisplay: main };
    const s = cursorGeomSample(view, document);
    expect(s.cur_x).toBe(1);
    expect(s.cur_y).toBe(3);
    expect(s.cursor).not.toBe(null);
    expect(s.row).not.toBe(null);
    expect(s.main).toHaveProperty("scrollTop");
    expect(s.main).toHaveProperty("scrollHeight");
    expect(s.main).toHaveProperty("clientHeight");
    // 只有數字，沒有任何文字內容
    expect(JSON.stringify(s)).not.toContain("bbsrow");
  });

  it("找不到該列節點時回 null 欄位而不是丟例外", () => {
    const main = mountGrid();
    const view = { buf: { cur_x: 0, cur_y: 99 }, mainDisplay: main };
    expect(cursorGeomSample(view, document).row).toBe(null);
  });

  it("view 缺席回 null", () => {
    expect(cursorGeomSample(null, document)).toBe(null);
  });
});

describe("DebugRecorder", () => {
  it("start 後 send/recv 被記錄且原行為保留；stop 還原原函式", () => {
    const { app, calls } = makeApp();
    const origOnData = app.onData;
    const origSendRaw = app.conn._sendRaw;

    const rec = new DebugRecorder(app);
    rec.start();
    expect(rec.isRecording).toBe(true);

    app.onData("server-bytes");
    app.conn._sendRaw("\x1b[6~");
    // 原行為保留
    expect(calls.onData).toEqual(["server-bytes"]);
    expect(calls.sendRaw).toEqual(["\x1b[6~"]);
    // 有記錄（含 record.start log）
    const dirs = rec.events.map((e) => e.dir);
    // 起點補一筆「目前這篇」脈絡（之後只在變動時記）——App Bar 標題殘留類問題靠它定案。
    expect(rec.events.find((e) => e.tag === "article.context").info).toEqual({
      author: null,
      board: null,
      title: null,
    });
    expect(dirs).toContain("recv");
    expect(dirs).toContain("send");
    expect(rec.events.find((e) => e.dir === "recv").state.pageState).toBe(2);

    const json = rec.stop();
    expect(rec.isRecording).toBe(false);
    expect(app.onData).toBe(origOnData);
    expect(app.conn._sendRaw).toBe(origSendRaw);

    const out = JSON.parse(json);
    expect(out.meta.mode).toBe("debug");
    expect(out.cassette.steps.length).toBeGreaterThan(0);
  });

  it("stop 套 prefs redact（autoLoginUser/Password）", () => {
    const { app } = makeApp();
    const rec = new DebugRecorder(app);
    rec.start();
    app.onData("hi myuser secret99 end");
    const out = JSON.parse(
      rec.stop({ prefs: { autoLoginUser: "myuser", autoLoginPassword: "secret99" } })
    );
    const recvEv = out.events.find((e) => e.dir === "recv");
    const decoded = atob(recvEv.data);
    expect(decoded).toBe("hi xxxxxx xxxxxxxx end");
  });

  // 2FA 密鑰是長期憑證，外洩必須重設 2FA 才能作廢 → 一定要進 redact 清單。
  it("stop 也 redact autoLoginOtpSecret", () => {
    const { app } = makeApp();
    const rec = new DebugRecorder(app);
    rec.start();
    app.onData("code ABCDEFGHIJKLMNOP end");
    const out = JSON.parse(
      rec.stop({
        prefs: {
          autoLoginUser: "myuser",
          autoLoginPassword: "secret99",
          autoLoginOtpSecret: "ABCDEFGHIJKLMNOP"
        }
      })
    );
    const recvEv = out.events.find((e) => e.dir === "recv");
    const decoded = atob(recvEv.data);
    expect(decoded).toBe("code xxxxxxxxxxxxxxxx end");
  });

  // ptt-debug-20260928-181323：「150% 滾輪往上捲不動、畫面上下抖」的錄製檔在開文後
  // 23 秒一筆事件都沒有 —— 捲動軌跡、倍率切換、佔位盒高度全都沒錄到。
  it("錄製期間收進渲染鏈的診斷 log（diag），停止後不再收", () => {
    const { app } = makeApp();
    const rec = new DebugRecorder(app);
    expect(diagActive()).toBe(false);
    rec.start();
    expect(diagActive()).toBe(true);
    diag("image.size", { mode: "zoom@1.5", slots: 3 });
    const ev = rec.events.find((e) => e.tag === "image.size");
    expect(ev && ev.info).toEqual({ mode: "zoom@1.5", slots: 3 });

    rec.stop();
    expect(diagActive()).toBe(false);
    const n = rec.events.length;
    diag("image.size", { mode: "normal" });
    expect(rec.events).toHaveLength(n);
  });

  it("錄製期間記下好讀捲動容器的滾輪輸入與捲動位置，停止後拆掉 listener", () => {
    const { app } = makeApp();
    // 真版面（unit-browser）：scrollTop 只有在真的可捲動時才會停在 1200。
    const main = document.createElement("div");
    main.style.cssText = "height: 900px; overflow-y: auto";
    const content = document.createElement("div");
    content.style.height = "5000px";
    main.appendChild(content);
    document.body.appendChild(main);
    main.scrollTop = 1200;
    app.view.mainDisplay = main;
    const rec = new DebugRecorder(app);
    rec.start();

    main.dispatchEvent(new window.WheelEvent("wheel", { deltaY: -100 }));
    main.dispatchEvent(new window.Event("scroll"));
    const wheel = rec.events.find((e) => e.tag === "main.wheel");
    const scroll = rec.events.find((e) => e.tag === "main.scroll");
    expect(wheel.info).toMatchObject({ dy: -100, top: 1200 });
    expect(scroll.info).toEqual({ top: 1200, sh: 5000, ch: 900 });

    rec.stop();
    const n = rec.events.length;
    main.dispatchEvent(new window.WheelEvent("wheel", { deltaY: -100 }));
    main.dispatchEvent(new window.Event("scroll"));
    expect(rec.events).toHaveLength(n);
    main.remove();
  });

  // 列表好讀的捲動視口在 render 層、可能在錄製開始後才建立 ⇒ 必須在 document capture
  // 層收（scroll 不冒泡）。錄製檔 ptt-debug-20261008-003701 就是少了這段，「往上捲卡住」
  // 只剩 bytes 可看。
  it("列表視口 .listBodyView 的 scroll／觸控／滾輪寫進錄製檔（視口晚於 start 建立也收得到）", () => {
    const { app } = makeApp();
    app.buf.listRenderOwner = "article-list";
    app.listSession = { state: "active", _renderMode: "buffer", _topNum: 351699, _edgeUp: false, _edgeDown: true };
    app.commandQueue = { idle: false, inFlightKind: "prefetch-up" };
    app.view.componentScreen = { _listReservePx: 400, getListScrollTop: () => 800 };
    const rec = new DebugRecorder(app);
    rec.start();

    const v = document.createElement("div");
    v.className = "listBodyView";
    v.style.cssText = "height:300px;overflow-y:auto";
    const content = document.createElement("span");
    content.style.cssText = "display:block;height:3000px";
    v.appendChild(content);
    document.body.appendChild(v);
    v.scrollTop = 1200;

    v.dispatchEvent(new window.Event("scroll"));
    content.dispatchEvent(new window.TouchEvent("touchstart", { bubbles: true }));
    content.dispatchEvent(new window.WheelEvent("wheel", { deltaY: -50, bubbles: true }));
    document.body.dispatchEvent(new window.TouchEvent("touchend", { bubbles: true }));

    const scroll = rec.events.find((e) => e.tag === "list.scroll");
    expect(scroll.info).toMatchObject({
      top: 1200, ctop: 800, res: 400, sh: 3000, ch: 300, ov: "auto",
      own: "article-list", st: "active", rm: "buffer", topNum: 351699,
      eu: false, ed: true, idle: false, fl: "prefetch-up",
    });
    const touches = rec.events.filter((e) => e.tag === "touch");
    expect(touches.map((e) => [e.info.type, e.info.inList])).toEqual([
      ["touchstart", true],
      ["touchend", false],
    ]);
    expect(touches[0].info.topNum).toBe(351699);
    expect(rec.events.find((e) => e.tag === "list.wheel").info).toMatchObject({ dy: -50, top: 1200 });

    rec.stop();
    const n = rec.events.length;
    v.dispatchEvent(new window.Event("scroll"));
    content.dispatchEvent(new window.TouchEvent("touchstart", { bubbles: true }));
    expect(rec.events).toHaveLength(n);
    v.remove();
  });

  it("未錄製時 log() no-op；重複 stop 回 null", () => {
    const { app } = makeApp();
    const rec = new DebugRecorder(app);
    rec.log("x");
    expect(rec.events).toHaveLength(0);
    rec.start();
    rec.stop();
    expect(rec.stop()).toBe(null);
  });
});
