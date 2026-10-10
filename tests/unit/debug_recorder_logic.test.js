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

  // REGRESSION（2026-10，live scenario 錄製的隱私把關抓到）：redact 原本逐個 event 做，
  // 帳號被 WebSocket 切成兩個封包時（「我是my」＋「user]」）兩半各自都不像帳號 ⇒ 原樣
  // 留在錄製檔裡；導出的 cassette 把 recv 接起來之後帳號就完整出現了。密碼同理。
  it("帳號／密碼被切在兩個封包之間也要遮掉（events 與 cassette 都是）", () => {
    const out = JSON.parse(
      serializeRecording({
        events: [
          { t: 0, dir: "recv", data: "[\xa7\xda\xac\x4fmy" },
          { t: 1, dir: "recv", data: "user] 1.2." },
          { t: 2, dir: "recv", data: "3.4 ok" },
          { t: 3, dir: "send", data: "pw" },
          { t: 4, dir: "send", data: "123\r" },
          { t: 5, dir: "recv", data: "next" },
        ],
        redact: { ids: ["myuser"], secrets: ["pw123"] },
      })
    );
    const ev = out.events.map((e) => b64decode(e.data));
    expect(ev.join("")).not.toMatch(/myuser|pw123|1\.2\.3\.4/i);
    // 等長替換、封包邊界不變（逐 event 的長度與原始相同）。
    expect(ev).toEqual(["[\xa7\xda\xac\x4fxx", "xxxx] xxxx", "xxx ok", "xx", "xxx\r", "next"]);
    const steps = out.cassette.steps.map((s) => b64decode(s.recv) + (s.send ? b64decode(s.send) : ""));
    expect(steps.join("")).not.toMatch(/myuser|pw123|1\.2\.3\.4/i);
  });

  // log info 會帶畫面上解出來的文字（article.context 的作者、appBar 標題）：同一套遮蔽。
  it("log info 內的字串（含巢狀）也要遮帳號／密碼／IP", () => {
    const out = JSON.parse(
      serializeRecording({
        events: [
          {
            t: 0,
            dir: "log",
            tag: "article.context",
            info: { author: "myuser", title: "Re: pw123", n: 3, ok: true, nested: { ip: "1.2.3.4" }, none: null },
          },
        ],
        redact: { ids: ["myuser"], secrets: ["pw123"] },
      })
    );
    expect(out.events[0].info).toEqual({
      author: "xxxxxx",
      title: "Re: xxxxx",
      n: 3,
      ok: true,
      nested: { ip: "xxxxxxx" },
      none: null,
    });
  });

  it("b64 round-trip 支援 8-bit bytes（Big5）", () => {
    const s = "\xac\x4f\xff\x00A";
    expect(b64decode(b64encode(s))).toBe(s);
  });
});
