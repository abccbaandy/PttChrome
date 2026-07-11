import {
  b64encode,
  b64decode,
  classifySend,
  eventsToCassetteSteps,
  serializeRecording,
} from "../../src/js/debug_recorder_logic";

describe("classifySend", () => {
  it("鍵表映射", () => {
    expect(classifySend("\x1b[6~")).toEqual({ on: "pagedown" });
    expect(classifySend("\x1b[5~")).toEqual({ on: "pageup" });
    expect(classifySend("\x1b[4~")).toEqual({ on: "end" });
    expect(classifySend("\x1b[A")).toEqual({ on: "up" });
    expect(classifySend("\x1b[D")).toEqual({ on: "back" });
    expect(classifySend("/")).toEqual({ on: "slash" });
    expect(classifySend("\r")).toEqual({ on: "open" });
    expect(classifySend("123\r")).toEqual({ on: "jump", num: 123 });
  });

  it("交易尾 \\f 先剝再比對（v5 跳號）", () => {
    expect(classifySend("42\r\x0c")).toEqual({ on: "jump", num: 42 });
  });

  it("未知鍵 → raw 帶原始 bytes", () => {
    const r = classifySend("abc");
    expect(r.on).toBe("raw");
    expect(b64decode(r.send)).toBe("abc");
  });
});

describe("eventsToCassetteSteps", () => {
  const ev = (dir, data) => ({ t: 0, dir, data });

  it("start 段 + send 分界 + 連續 recv 合併", () => {
    const steps = eventsToCassetteSteps([
      ev("recv", "page1a"),
      ev("recv", "page1b"),
      ev("send", "\x1b[6~"),
      ev("recv", "page2"),
      ev("send", "\x1b[4~"),
      ev("recv", "last"),
    ]);
    expect(steps.map((s) => s.on)).toEqual(["start", "pagedown", "end"]);
    expect(b64decode(steps[0].recv)).toBe("page1apage1b");
    expect(b64decode(steps[1].recv)).toBe("page2");
    expect(b64decode(steps[2].recv)).toBe("last");
  });

  it("無 recv 回應的 send 不產生 step；telnet 協商(IAC)略過", () => {
    const steps = eventsToCassetteSteps([
      ev("send", "\xff\xfb\x1f"), // IAC WILL NAWS
      ev("recv", "screen"),
      ev("send", "\x1b\x1b"), // anti-idle，無回應
      ev("send", "\x1b[6~"),
      ev("recv", "p2"),
    ]);
    expect(steps.map((s) => s.on)).toEqual(["start", "pagedown"]);
  });

  it("與既有 cassette schema 同形（on/recv[/num]）", () => {
    const steps = eventsToCassetteSteps([
      ev("recv", "list"),
      ev("send", "99\r"),
      ev("recv", "article"),
    ]);
    expect(steps[1]).toEqual({ on: "jump", num: 99, recv: b64encode("article") });
  });
});

describe("serializeRecording", () => {
  const events = [
    { t: 0, dir: "recv", data: "hello myuser 1.2.3.4", state: { pageState: 1 } },
    { t: 5, dir: "log", tag: "easyReading.enter", info: { a: 1 } },
    { t: 9, dir: "send", data: "\x1b[6~", state: { pageState: 3 } },
    { t: 12, dir: "recv", data: "pw123 page2" },
  ];

  const parse = () =>
    JSON.parse(
      serializeRecording({
        events,
        meta: { url: "wstelnet://x/bbs" },
        cols: 80,
        rows: 24,
        redact: { ids: ["myuser"], secrets: ["pw123"] },
      })
    );

  it("round-trip：events base64 解回、redact 套用、log 保留", () => {
    const out = parse();
    expect(out.meta.mode).toBe("debug");
    expect(out.meta.url).toBe("wstelnet://x/bbs");
    expect(out.meta.warning).toBeTruthy();
    expect(out.events).toHaveLength(4);
    expect(b64decode(out.events[0].data)).toBe("hello xxxxxx xxxxxxx");
    expect(out.events[0].state).toEqual({ pageState: 1 });
    expect(out.events[1]).toEqual({
      t: 5,
      dir: "log",
      tag: "easyReading.enter",
      info: { a: 1 },
    });
    expect(b64decode(out.events[3].data)).toBe("xxxxx page2");
  });

  it("導出 cassette：debug-derived、steps 可直接餵 replay", () => {
    const out = parse();
    expect(out.cassette.meta.mode).toBe("debug-derived");
    expect(out.cassette.cols).toBe(80);
    expect(out.cassette.steps.map((s) => s.on)).toEqual(["start", "pagedown"]);
    expect(b64decode(out.cassette.steps[0].recv)).toBe("hello xxxxxx xxxxxxx");
    expect(b64decode(out.cassette.steps[1].recv)).toBe("xxxxx page2");
  });

  it("b64 round-trip 支援 8-bit bytes（Big5）", () => {
    const s = "\xac\x4f\xff\x00A";
    expect(b64decode(b64encode(s))).toBe(s);
  });
});
