// 背景錄製（環形緩衝，只留最後三分鐘）：
//   - ringTrim：只裁到關鍵幀上（檔頭永遠是一張完整畫面）、現況 log 搬到新檔頭、記憶體保險絲；
//   - screenKeyframe：當下畫面 → 位元組，餵給全新的 TermBuf 要重建出同一個畫面（字、顏色、
//     游標、捲動範圍、目前的 SGR 屬性）；
//   - DebugRecorder 背景模式整段跑：錄了十分鐘後才存檔，檔案只剩最後三分鐘左右，而且
//     重放這份檔案解得回存檔當下的畫面（「事後才存」的錄製檔要能用，這是整個功能的前提）。
import listCassette from "../e2e/cassettes/cchat-list.json";
import { TermBuf } from "../../src/js/term_buf";
import { AnsiParser } from "../../src/js/ansi_parser";
import { DebugRecorder, screenKeyframe } from "../../src/js/debug_recorder";
import {
  ringTrim,
  ringEventCost,
  RING_WINDOW_MS,
  RING_KEYFRAME_MS,
  RING_MAX_BYTES,
} from "../../src/js/debug_recorder_logic";
import { loadBig5Tables, decodeRecv } from "./helpers/load_big5_tables";

beforeAll(loadBig5Tables);
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeTerm(cols = 80, rows = 24) {
  const buf = new TermBuf(cols, rows);
  buf.setView({
    update() {},
    updateCursorPos() {},
    refreshCursorVisibility() {},
    blinkOn: false,
  });
  buf.useMouseBrowsing = false;
  return { buf, parser: new AnsiParser(buf) };
}

const ATTRS = ["fg", "bg", "bright", "blink", "underLine", "invert", "ch", "isLeadByte"];
function screenOf(buf) {
  return {
    rows: buf.lines.map((line) => line.map((c) => ATTRS.map((k) => c[k]).join("|"))),
    cur: [buf.cur_x, buf.cur_y],
    region: [buf.scrollStart, buf.scrollEnd],
    attr: ["fg", "bg", "bright", "blink", "underLine", "invert"].map((k) => buf.attr[k]),
  };
}

function rebuild(bytes, cols, rows) {
  const t = makeTerm(cols, rows);
  t.parser.feed(bytes);
  return t.buf;
}

describe("ringTrim", () => {
  const recv = (t, extra) => Object.assign({ t, dir: "recv", data: "x".repeat(10) }, extra);
  const key = (t) => recv(t, { key: true });
  const log = (t, tag, info) => ({ t, dir: "log", tag, info });

  test("沒有關鍵幀可裁 ⇒ 原封不動（寧可多留，也不要沒有起點畫面）", () => {
    const evs = [recv(0), recv(100), recv(500)];
    expect(ringTrim(evs, 400, 0).events).toBe(evs);
  });

  test("裁到 t <= cutoff 的最後一張關鍵幀：窗口從那張完整畫面開始", () => {
    const evs = [key(0), recv(10), key(100), recv(150), key(300), recv(350), key(500)];
    const out = ringTrim(evs, 320, 0).events;
    expect(out[0]).toBe(evs[4]);
    expect(out.map((e) => e.t)).toEqual([300, 350, 500]);
  });

  test("被裁掉的現況 log 每個 tag 留最後一筆、t 改成新檔頭，排在關鍵幀前；一般 log 直接丟", () => {
    const evs = [
      log(0, "record.start", { url: "u" }),
      log(0, "article.context", { title: "舊" }),
      key(0),
      log(50, "article.context", { title: "新" }),
      log(60, "queue.send", {}),
      log(70, "appBar", { title: "看板" }),
      key(200),
      recv(250),
    ];
    const out = ringTrim(evs, 210, 0).events;
    expect(out.map((e) => [e.t, e.dir, e.tag || ""])).toEqual([
      [200, "log", "record.start"],
      [200, "log", "article.context"],
      [200, "log", "appBar"],
      [200, "recv", ""],
      [250, "recv", ""],
    ]);
    expect(out[1].info).toEqual({ title: "新" });
    // 不改到原本的事件物件（snapshot 前面已經 push 進陣列的引用）
    expect(evs[3].t).toBe(50);
  });

  test("連續裁多次，搬過來的現況 log 不會越疊越多", () => {
    let evs = [log(0, "list.filter", { n: 1 }), key(0), recv(1)];
    for (let t = 100; t <= 1000; t += 100) {
      evs.push(key(t), recv(t + 1));
      evs = ringTrim(evs, t, 0).events;
    }
    expect(evs.filter((e) => e.tag === "list.filter")).toHaveLength(1);
    expect(evs[0]).toMatchObject({ tag: "list.filter", t: 1000 });
  });

  test("估計用量超過上限 ⇒ 提早裁到後面的關鍵幀（窗口變短，但不會無限長）", () => {
    const evs = [key(0), recv(1), key(10), recv(11), key(20), recv(21)];
    const per = ringEventCost(evs[0]);
    const r = ringTrim(evs, -1, per * 3);
    expect(r.events[0]).toBe(evs[4]);
    expect(r.bytes).toBe(per * 2);
  });
});

describe("screenKeyframe：當下畫面 → 餵給全新 TermBuf 重建出同一個畫面", () => {
  test("真看板列表畫面（Big5、顏色、反白游標列）", () => {
    const a = makeTerm(listCassette.cols, listCassette.rows);
    for (const step of listCassette.steps) if (step.recv) a.parser.feed(decodeRecv(step.recv));
    const b = rebuild(screenKeyframe(a.buf), listCassette.cols, listCassette.rows);
    expect(screenOf(b)).toEqual(screenOf(a.buf));
    expect(b.getRowText(0, 0, b.cols)).toContain("C_Chat");
  });

  test("捲動範圍、游標位置與目前的 SGR 屬性都還原（server 下一包可能直接沿用）", () => {
    const a = makeTerm();
    a.parser.feed("\x1b[2J\x1b[1;33;44mhead\x1b[m\r\n\x1b[5;20r\x1b[7;9H\x1b[1;31m");
    const b = rebuild(screenKeyframe(a.buf), 80, 24);
    expect(screenOf(b)).toEqual(screenOf(a.buf));
    // 接著餵同一段後續 ⇒ 兩邊畫面仍一致（屬性、捲動範圍都沿用到了）
    const tail = "red text\x1b[20;1H\n\nscrolled";
    a.parser.feed(tail);
    const c = rebuild(screenKeyframe(a.buf), 80, 24);
    new AnsiParser(b).feed(tail);
    expect(screenOf(b)).toEqual(screenOf(a.buf));
    expect(screenOf(c)).toEqual(screenOf(a.buf));
  });
});

describe("DebugRecorder 背景模式（真 TermBuf／AnsiParser）", () => {
  function makeApp() {
    const t = makeTerm(listCassette.cols, listCassette.rows);
    const sent = [];
    return {
      buf: t.buf,
      parser: t.parser,
      connectState: 1,
      connectedUrl: { url: "wstelnet://x/bbs" },
      view: {},
      onData(d) {
        this.parser.feed(d);
      },
      conn: { _sendRaw: (d) => sent.push(d) },
      sent,
    };
  }

  test("錄了十分鐘才存：檔案只剩最後三分鐘左右，重放解得回存檔當下的畫面", () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const app = makeApp();
    const rec = new DebugRecorder(app, { windowMs: RING_WINDOW_MS });
    rec.start();
    const recvs = listCassette.steps.filter((s) => s.recv).map((s) => decodeRecv(s.recv));
    let i = 0;
    for (now = 0; now < 10 * 60 * 1000; now += 7000) {
      app.conn._sendRaw("\x1b[B");
      app.onData(recvs[i++ % recvs.length]);
    }
    const json = JSON.parse(rec.snapshot({ prefs: {} }));
    expect(rec.isRecording).toBe(true); // 存檔不停錄

    expect(json.meta).toMatchObject({ background: true, windowMs: RING_WINDOW_MS });
    const evs = json.events;
    const span = evs[evs.length - 1].t - evs[0].t;
    expect(span).toBeGreaterThanOrEqual(RING_WINDOW_MS - 7000);
    expect(span).toBeLessThanOrEqual(RING_WINDOW_MS + RING_KEYFRAME_MS + 7000);
    // 檔頭：搬過來的現況 log，接著第一筆 recv 就是關鍵幀
    expect(evs.find((e) => e.dir === "recv").key).toBe(true);
    expect(evs.some((e) => e.tag === "record.start")).toBe(true);
    expect(evs.some((e) => e.dir === "send")).toBe(true);

    const b = makeTerm(listCassette.cols, listCassette.rows);
    for (const ev of evs) if (ev.dir === "recv") b.parser.feed(atob(ev.data));
    expect(screenOf(b.buf)).toEqual(screenOf(app.buf));
    // cassette 導出（離線重放格式）同樣從整頁畫面開始
    expect(atob(json.cassette.steps[0].recv).startsWith("\x1b[m\x1b[r\x1b[H\x1b[2J")).toBe(true);
  });

  test("parser 卡在半條跳脫序列時不拍關鍵幀（等下一包）", () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const app = makeApp();
    const rec = new DebugRecorder(app, { windowMs: RING_WINDOW_MS });
    rec.start();
    const keys = () => rec.events.filter((e) => e.key).length;
    expect(keys()).toBe(1);
    now = RING_KEYFRAME_MS + 1;
    app.onData("abc\x1b[3");
    expect(keys()).toBe(2);
    now += RING_KEYFRAME_MS + 1;
    app.onData("1mred");
    expect(keys()).toBe(2);
    app.onData("more");
    expect(keys()).toBe(3);
  });

  test("背景模式不做會強制 reflow 的幾何取樣；promote 成手動錄製後才做、也不再裁切", () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const app = makeApp();
    const rec = new DebugRecorder(app, { windowMs: RING_WINDOW_MS });
    rec.start();
    expect(rec.background).toBe(true);
    expect(rec.wantsGeometry).toBe(false);
    rec.promote();
    expect(rec.background).toBe(false);
    expect(rec.wantsGeometry).toBe(true);
    for (now = 0; now < 10 * 60 * 1000; now += 10000) app.onData("x");
    expect(rec.events.filter((e) => e.dir === "recv" && !e.key).length).toBe(60);
  });

  test("重連（新的 conn）⇒ 送出改錄新連線、舊連線的 _sendRaw 還原", () => {
    const app = makeApp();
    const oldConn = app.conn;
    const oldRaw = oldConn._sendRaw;
    const rec = new DebugRecorder(app, { windowMs: RING_WINDOW_MS });
    rec.start();
    expect(oldConn._sendRaw).not.toBe(oldRaw);
    const newSent = [];
    const origNew = (d) => newSent.push(d);
    const newConn = { _sendRaw: origNew };
    rec.attachConn(newConn);
    expect(oldConn._sendRaw).toBe(oldRaw); // 換回原函式本體
    newConn._sendRaw("q");
    expect(newSent).toEqual(["q"]);
    expect(rec.events.filter((e) => e.dir === "send").map((e) => e.data)).toEqual(["q"]);
    rec.stop({ discard: true });
    expect(newConn._sendRaw).toBe(origNew);
  });

  // 回歸：超過記憶體保險絲、又沒有可裁的關鍵幀時，舊版每一筆都重掃整個緩衝（O(n²)，
  // 實測一筆 0.1ms）。裁切一律每秒最多一次。
  test("超過記憶體保險絲也一樣每秒最多裁一次", () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const app = makeApp();
    const rec = new DebugRecorder(app, { windowMs: RING_WINDOW_MS });
    rec.start();
    const trim = vi.spyOn(rec, "_trim");
    const big = "x".repeat(64 * 1024);
    for (let i = 0; i < 200; ++i) {
      now += 1;
      app.onData(big);
    }
    expect(rec._bytes).toBeGreaterThan(RING_MAX_BYTES);
    expect(trim.mock.calls.length).toBeLessThanOrEqual(1);
  });

  test("stop({ discard }) 不序列化、清掉緩衝", () => {
    const app = makeApp();
    const rec = new DebugRecorder(app, { windowMs: RING_WINDOW_MS });
    rec.start();
    app.onData("x");
    expect(rec.stop({ discard: true })).toBe(null);
    expect(rec.events).toEqual([]);
    expect(rec.isRecording).toBe(false);
  });
});
