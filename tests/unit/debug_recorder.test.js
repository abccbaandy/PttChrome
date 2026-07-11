import { DebugRecorder, snapshotState } from "../../src/js/debug_recorder";

// mock app：只給 recorder 用到的面。onData / conn._sendRaw 保留原行為可驗證。
function makeApp() {
  const calls = { onData: [], sendRaw: [] };
  const app = {
    connectState: 1,
    connectedUrl: { url: "wstelnet://x/bbs" },
    buf: { pageState: 2, cur_x: 1, cur_y: 3, cols: 80, rows: 24 },
    view: { useEasyReadingMode: true },
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
    });
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
