// 錄製檔分流的純邏輯（tests/e2e/helpers/recording_triage.js）：切幀、切點、切段、時間對應、
// 再 redact 與寫檔把關。瀏覽器那半由 tests/e2e/offline/recording_triage.offline.spec.js 自證。
import fs from "fs";
import os from "os";
import path from "path";
import {
  BSU,
  ESU,
  FULL_CLEAR,
  planFrames,
  firstCheckableFrame,
  cutCandidates,
  groupFailures,
  segmentCassette,
  eventTimeAt,
  testAt,
  redactCassette,
  assertNoLocalInfo,
  pendingBase,
  writePending,
} from "../e2e/helpers/recording_triage";
import { sanityViolations } from "../e2e/helpers/screen_sanity";

const b64e = (s) => Buffer.from(s, "latin1").toString("base64");
const b64d = (s) => Buffer.from(s || "", "base64").toString("latin1");
const frame = (body) => BSU + body + ESU;

// step0：中途開始的殘幀；step1：清屏重繪＋一個 diff 幀；step2：home 起頭的 diff；
// step3：沒有 ESU 的尾巴。
const CLEAR = frame(FULL_CLEAR + "hello");
const DIFF = frame("\x1b[3;1Hx");
const HOME = frame("\x1b[Hy");
const TAIL = "\x1b[5;1Hz";
const cassette = {
  cols: 80,
  rows: 24,
  steps: [
    { on: "start", recv: b64e(frame("\x1b[2;1Hpartial")) },
    { on: "raw", send: b64e("s"), recv: b64e(CLEAR + DIFF) },
    { on: "pagedown", recv: b64e(HOME) },
    { on: "jump", num: 12, recv: b64e(TAIL) },
  ],
};

describe("planFrames：以 ESU 切幀", () => {
  const frames = planFrames(cassette);
  test("每個 ESU 結束一幀，沒有 ESU 的尾巴自成一幀", () => {
    expect(frames.map((f) => [f.step, f.bytes])).toEqual([
      [0, frame("\x1b[2;1Hpartial")],
      [1, CLEAR],
      [1, DIFF],
      [2, HOME],
      [3, TAIL],
    ]);
  });
  test("global offset 首尾相接，覆蓋整條 recv 串流", () => {
    const stream = cassette.steps.map((s) => b64d(s.recv)).join("");
    for (let i = 1; i < frames.length; i++)
      expect(frames[i].globalStart).toBe(frames[i - 1].globalEnd);
    expect(frames[frames.length - 1].globalEnd).toBe(stream.length);
    for (const f of frames)
      expect(stream.slice(f.globalStart, f.globalEnd)).toBe(f.bytes);
  });
  test("clear＝含 ESC[H ESC[2J；home＝（BSU 後）以 ESC[H 起頭", () => {
    expect(frames.map((f) => f.clear)).toEqual([false, true, false, false, false]);
    expect(frames.map((f) => f.home)).toEqual([false, true, false, true, false]);
  });
  test("第一個整頁重繪之前的幀不檢查；整卷沒有重繪 ⇒ -1", () => {
    expect(firstCheckableFrame(frames)).toBe(1);
    expect(firstCheckableFrame(planFrames({ steps: [{ recv: b64e(DIFF) }] }))).toBe(-1);
  });
});

describe("cutCandidates", () => {
  const frames = planFrames(cassette);
  test("由近到遠的 home 候選，最後一個保底是最近的 clear", () => {
    expect(cutCandidates(frames, 4)).toEqual([3, 1]);
    expect(cutCandidates(frames, 3)).toEqual([3, 1]);
    expect(cutCandidates(frames, 2)).toEqual([1]);
  });
  test("home 候選有上限", () => {
    expect(cutCandidates(frames, 4, 0)).toEqual([1]);
  });
  test("紅幀之前沒有任何整頁重繪 ⇒ 切不出來", () => {
    expect(cutCandidates(frames, 0)).toEqual([]);
  });
});

describe("groupFailures", () => {
  test("連續且違規種類相同才併；斷開或種類不同各自一段，只切第一幀", () => {
    const runs = groupFailures([
      { idx: 5, violations: ["gridMisaligned"] },
      { idx: 6, violations: ["gridMisaligned"] },
      { idx: 7, violations: ["decodeFail"] },
      { idx: 9, violations: ["decodeFail"] },
    ]);
    expect(runs).toEqual([
      { first: 5, last: 6, count: 2, violations: ["gridMisaligned"] },
      { first: 7, last: 7, count: 1, violations: ["decodeFail"] },
      { first: 9, last: 9, count: 1, violations: ["decodeFail"] },
    ]);
  });
});

describe("segmentCassette", () => {
  const frames = planFrames(cassette);
  test("從切點幀開頭到紅幀結尾；首段改 start，中間 step 保留 on/send/num", () => {
    const c = segmentCassette(cassette, frames, 2, 4, { source: "x.json" });
    expect(c.meta).toEqual({ mode: "pending", source: "x.json" });
    expect(c.steps.map((s) => s.on)).toEqual(["start", "pagedown", "jump"]);
    expect(c.steps[0].send).toBeUndefined();
    expect(c.steps[2].num).toBe(12);
    expect(c.steps.map((s) => b64d(s.recv))).toEqual([DIFF, HOME, TAIL]);
  });
  test("紅幀在 step 中間 ⇒ 末段 recv 截到紅幀為止", () => {
    const c = segmentCassette(cassette, frames, 1, 1);
    expect(c.steps.map((s) => b64d(s.recv))).toEqual([CLEAR]);
  });
  test("不改動來源 cassette；範圍顛倒丟錯", () => {
    const before = JSON.stringify(cassette);
    segmentCassette(cassette, frames, 1, 4);
    expect(JSON.stringify(cassette)).toBe(before);
    expect(() => segmentCassette(cassette, frames, 3, 1)).toThrow();
  });
});

describe("eventTimeAt／testAt", () => {
  const rec = {
    events: [
      { t: 0, dir: "log", tag: "test.begin", info: { title: "A" } },
      { t: 10, dir: "recv", data: b64e("abc") },
      { t: 20, dir: "log", tag: "test.end", info: { title: "A" } },
      { t: 30, dir: "send", data: b64e("q") },
      { t: 40, dir: "recv", data: b64e("defg") },
      { t: 50, dir: "log", tag: "test.begin", info: { title: "B" } },
      { t: 60, dir: "recv", data: b64e("h") },
    ],
  };
  test("recv 串流 offset → 涵蓋它的那個 recv 事件時間", () => {
    expect(eventTimeAt(rec, 3)).toBe(10);
    expect(eventTimeAt(rec, 4)).toBe(40);
    expect(eventTimeAt(rec, 8)).toBe(60);
    expect(eventTimeAt(rec, 99)).toBe(null);
  });
  test("時間點落在哪條 test；兩條之間回 null", () => {
    expect(testAt(rec, 10)).toBe("A");
    expect(testAt(rec, 40)).toBe(null);
    expect(testAt(rec, 60)).toBe("B");
  });
});

describe("pending 寫檔把關", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "triage-"));
    fs.rmSync(dir, { recursive: true });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const LOCAL = { home: "/home/someone", user: "someone" };
  const entry = (c, extra = {}) =>
    Object.assign({ frame: 7, violations: ["decodeFail"], detail: "row 3" }, extra, { cassette: c });
  const seg = (recvs) => ({
    meta: { mode: "pending", source: "live-x.json" },
    cols: 80,
    rows: 24,
    steps: recvs.map((r, i) => (i ? { on: "raw", send: b64e("k"), recv: b64e(r) } : { on: "start", recv: b64e(r) })),
  });

  test("沒有紅幀 ⇒ 不寫任何檔、連目錄都不建", () => {
    expect(writePending(dir, "live-x", [], {}, { localInfo: LOCAL })).toEqual([]);
    expect(fs.existsSync(dir)).toBe(false);
  });

  test("有紅幀 ⇒ 每段一卷＋清單；重跑全綠時清掉這一卷上一輪的產物（別卷不動）", () => {
    const files = writePending(dir, "live-x", [entry(seg(["ab"]))], { frames: 9 }, { localInfo: LOCAL });
    expect(files.map((f) => path.basename(f))).toEqual(["live-x--f7.json"]);
    const list = JSON.parse(fs.readFileSync(path.join(dir, "live-x.list.json"), "utf8"));
    expect(list).toMatchObject({ source: "live-x.json", summary: { frames: 9 } });
    expect(list.items[0]).toMatchObject({ file: "live-x--f7.json", frame: 7, violations: ["decodeFail"] });
    expect(list.items[0].cassette).toBeUndefined();
    fs.writeFileSync(path.join(dir, "other--f1.json"), "{}");

    writePending(dir, "live-x", [], {}, { localInfo: LOCAL });
    expect(fs.readdirSync(dir)).toEqual(["other--f1.json"]);
  });

  test("再 redact 是對串流做：帳號被切在兩個 step 之間也遮得到", () => {
    const parts = ["\u00a7\u00da\u00acO my", "user] hi"];
    const c = redactCassette(seg(parts), { ids: ["myuser"], secrets: [] });
    const joined = c.steps.map((s) => b64d(s.recv)).join("");
    expect(joined.toLowerCase()).not.toContain("myuser");
    // \u7b49\u9577\u66ff\u63db \u21d2 \u6bcf\u500b step \u7684\u5207\u9ede\u4e0d\u8b8a\u3002
    expect(c.steps.map((s) => b64d(s.recv).length)).toEqual(parts.map((p) => p.length));
  });

  test("redact 後仍含帳號／密碼 ⇒ 丟錯，整卷一個檔都不寫", () => {
    vi.stubEnv("PTT_USER", "myuser");
    vi.stubEnv("PTT_PASS", "s3cret!");
    // 密碼出現在 send（手動鍵入）：redact 規則遮得到就遮；遮不到的由 assertNoLeak 擋。
    const leaky = seg(["ok", "x"]);
    leaky.steps[1].send = b64e("s3cret!\r");
    expect(() =>
      writePending(dir, "live-x", [entry(leaky)], {}, { localInfo: LOCAL, redact: { ids: [], secrets: [] } })
    ).toThrow(/隱私把關失敗/);
    expect(fs.existsSync(dir)).toBe(false);
  });

  test("用 env 帳密再 redact ⇒ 錄製時漏遮的帳號在落地前被遮掉", () => {
    vi.stubEnv("PTT_USER", "myuser");
    const files = writePending(dir, "live-x", [entry(seg(["[myuser] hi"]))], {}, { localInfo: LOCAL });
    expect(fs.readFileSync(files[0], "utf8")).not.toContain(b64e("myuser"));
    const c = JSON.parse(fs.readFileSync(files[0], "utf8"));
    expect(b64d(c.steps[0].recv).toLowerCase()).not.toContain("myuser");
  });

  test("清單明文（違規描述）含帳號 ⇒ 遮掉後才寫", () => {
    vi.stubEnv("PTT_USER", "myuser");
    writePending(dir, "live-x", [entry(seg(["a"]), { detail: "row 0 我是 myuser" })], {}, { localInfo: LOCAL });
    expect(fs.readFileSync(path.join(dir, "live-x.list.json"), "utf8").toLowerCase()).not.toContain("myuser");
  });

  test("本機路徑／使用者名稱出現在要寫出的文字 ⇒ 丟錯", () => {
    const local = { home: "C:\\Users\\someone", user: "someone" };
    expect(() => assertNoLocalInfo('{"source":"C:\\\\Users\\\\someone\\\\x.json"}', local)).toThrow(/本機/);
    expect(() => assertNoLocalInfo('{"source":"C:/Users/someone/x.json"}', local)).toThrow(/本機/);
    expect(() => assertNoLocalInfo('{"note":"by someone"}', local)).toThrow(/本機/);
    expect(() => assertNoLocalInfo('{"source":"live-x.json"}', local)).not.toThrow();
    const c = seg(["a"]);
    c.meta.source = "/home/someone/rec.json";
    expect(() => writePending(dir, "live-x", [entry(c)], {}, { localInfo: LOCAL })).toThrow(/本機/);
    expect(fs.existsSync(dir)).toBe(false);
  });

  test("pendingBase 只取檔名（絕對路徑不進 meta／檔名）", () => {
    expect(pendingBase(path.join("a", "b", "live-2026.json"))).toBe("live-2026");
  });
});

describe("sanityViolations（live／offline／分流共用門檻）", () => {
  const ok = {
    decoderReady: true,
    checked: 24,
    missingRows: [],
    textMismatch: [],
    gridMisaligned: [],
    decodeFail: [],
    orphanHighBytes: [{ row: 1 }],
    horizontalOverflow: 0,
  };
  test("健全畫面零違規；落單高位元組不判紅", () => {
    expect(sanityViolations(ok)).toEqual([]);
  });
  test("每種違規各自報出", () => {
    expect(sanityViolations({ ...ok, decoderReady: false })).toEqual(["decoderNotReady"]);
    expect(sanityViolations({ ...ok, checked: 0 })).toEqual(["noRowsChecked"]);
    expect(sanityViolations({ ...ok, missingRows: [{}] })).toEqual(["missingRows"]);
    expect(sanityViolations({ ...ok, textMismatch: [{}] })).toEqual(["textMismatch"]);
    expect(sanityViolations({ ...ok, gridMisaligned: [{}] })).toEqual(["gridMisaligned"]);
    expect(sanityViolations({ ...ok, decodeFail: [{}] })).toEqual(["decodeFail"]);
    expect(sanityViolations({ ...ok, horizontalOverflow: 3 })).toEqual(["horizontalOverflow"]);
  });
});
