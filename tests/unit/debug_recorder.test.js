import { DebugRecorder, snapshotState, cursorGeomSample } from "../../src/js/debug_recorder";

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
      _sendRaw(d) {
        calls.sendRaw.push(d);
      },
    },
  };
  return { app, calls };
}

describe("snapshotState", () => {
  it("純讀取輕量快照", () => {
    const { app } = makeApp();
    expect(snapshotState(app)).toEqual({
      pageState: 2,
      cur_x: 1,
      cur_y: 3,
      connectState: 1,
      easyReading: true,
      listState: "idle",
      fnMode: false,
      gridRender: true,
      chw: 12,
      chh: 24,
      scaleX: 1,
      scaleY: 1,
      dpr: window.devicePixelRatio,
      fontsReady: document.fonts ? document.fonts.status === "loaded" : undefined,
    });
  });

  // 好讀長頁 ↔ 原生鏡像是游標幾何問題的第一個分岔（推文 prompt 走鏡像）。
  it("錄下 functionMode 與 gridRender", () => {
    const { app } = makeApp();
    app.buf.easyReadingFunctionMode = true;
    app.view._gridRender = false;
    const s = snapshotState(app);
    expect(s.fnMode).toBe(true);
    expect(s.gridRender).toBe(false);
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
    const decoded = Buffer.from(recvEv.data, "base64").toString("latin1");
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
    const decoded = Buffer.from(recvEv.data, "base64").toString("latin1");
    expect(decoded).toBe("code xxxxxxxxxxxxxxxx end");
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
