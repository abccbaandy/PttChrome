// 連線失敗診斷（src/js/connection_probe.js）。
//
// 瀏覽器拿不到 WebSocket 握手被拒的 HTTP 403（只給 close 1006），所以「Origin 偽裝
// 沒設好」只能主動探測：直連從未 open 時，另開一條 WS 經 proxy 試連。
//   proxy 通、直連不通 ⇒ 被 PTT 的 Origin 白名單擋（origin）
//   兩者都不通       ⇒ PTT 維護／網路問題（unreachable），這時問使用者要不要開 proxy 沒意義
import {
  siteToWsUrl,
  probeWebSocket,
  diagnoseConnectFailure,
  ORIGIN_SETUP_URL,
} from "../../src/js/connection_probe";

describe("siteToWsUrl", () => {
  test("wsstelnet → wss、wstelnet → ws，保留 host:port 與路徑", () => {
    expect(siteToWsUrl("wsstelnet://ws.ptt.cc/bbs")).toBe("wss://ws.ptt.cc/bbs");
    expect(siteToWsUrl("wstelnet://localhost:8080/bbs")).toBe(
      "ws://localhost:8080/bbs",
    );
    expect(siteToWsUrl("wsstelnet://host.dev")).toBe("wss://host.dev/");
  });

  test("不支援的 scheme 回 null", () => {
    expect(siteToWsUrl("telnet://ptt.cc")).toBe(null);
    expect(siteToWsUrl("garbage")).toBe(null);
  });
});

// 可手動觸發事件的假 WebSocket。
function fakeWsFactory() {
  const made = [];
  class FakeWs {
    constructor(url) {
      this.url = url;
      this.listeners = {};
      this.close = vi.fn();
      made.push(this);
    }
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    }
    fire(type) {
      for (const fn of this.listeners[type] || []) fn({});
    }
  }
  return { FakeWs, made };
}

describe("probeWebSocket", () => {
  afterEach(() => vi.useRealTimers());

  test("open → true，且立刻關掉探測連線（不登入、不佔名額）", async () => {
    const { FakeWs, made } = fakeWsFactory();
    const p = probeWebSocket("wss://relay.dev/bbs", { WebSocketImpl: FakeWs });
    expect(made[0].url).toBe("wss://relay.dev/bbs");
    made[0].fire("open");
    await expect(p).resolves.toBe(true);
    expect(made[0].close).toHaveBeenCalled();
  });

  test("error／close → false", async () => {
    for (const type of ["error", "close"]) {
      const { FakeWs, made } = fakeWsFactory();
      const p = probeWebSocket("wss://relay.dev/bbs", { WebSocketImpl: FakeWs });
      made[0].fire(type);
      await expect(p).resolves.toBe(false);
    }
  });

  test("逾時 → false，且關掉懸著的連線", async () => {
    vi.useFakeTimers();
    const { FakeWs, made } = fakeWsFactory();
    const p = probeWebSocket("wss://relay.dev/bbs", {
      WebSocketImpl: FakeWs,
      timeoutMs: 1000,
    });
    vi.advanceTimersByTime(1000);
    await expect(p).resolves.toBe(false);
    expect(made[0].close).toHaveBeenCalled();
  });

  test("只 resolve 一次：open 之後的 close 不會改寫結果", async () => {
    const { FakeWs, made } = fakeWsFactory();
    const p = probeWebSocket("wss://relay.dev/bbs", { WebSocketImpl: FakeWs });
    made[0].fire("open");
    made[0].fire("close");
    await expect(p).resolves.toBe(true);
  });

  test("建構子 throw（URL 不合法）→ false", async () => {
    class Throws {
      constructor() {
        throw new Error("SyntaxError");
      }
    }
    await expect(
      probeWebSocket("nope", { WebSocketImpl: Throws }),
    ).resolves.toBe(false);
  });
});

describe("diagnoseConnectFailure 決策表", () => {
  const DEFAULT = "wsstelnet://ws.ptt.cc/bbs";
  const PROXY = "wsstelnet://relay.dev/bbs";
  const base = { site: DEFAULT, defaultSite: DEFAULT, proxySite: PROXY };

  test("這次連線 open 過（中途斷線）⇒ disconnected，不探測", async () => {
    const probe = vi.fn();
    await expect(
      diagnoseConnectFailure({ ...base, opened: true, probe }),
    ).resolves.toBe("disconnected");
    expect(probe).not.toHaveBeenCalled();
  });

  test("目前站台不是預設直連（已走 proxy／自訂 ?site=）⇒ null，不探測", async () => {
    const probe = vi.fn();
    await expect(
      diagnoseConnectFailure({ ...base, site: PROXY, opened: false, probe }),
    ).resolves.toBe(null);
    expect(probe).not.toHaveBeenCalled();
  });

  test("直連從未 open、proxy 通 ⇒ origin（探的是 proxy 的 ws URL）", async () => {
    const probe = vi.fn(async () => true);
    await expect(
      diagnoseConnectFailure({ ...base, opened: false, probe }),
    ).resolves.toBe("origin");
    expect(probe).toHaveBeenCalledWith("wss://relay.dev/bbs");
  });

  test("直連從未 open、proxy 也不通 ⇒ unreachable", async () => {
    const probe = vi.fn(async () => false);
    await expect(
      diagnoseConnectFailure({ ...base, opened: false, probe }),
    ).resolves.toBe("unreachable");
  });

  test("探測本身 throw ⇒ unreachable（不可卡在檢查中）", async () => {
    const probe = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(
      diagnoseConnectFailure({ ...base, opened: false, probe }),
    ).resolves.toBe("unreachable");
  });
});

test("ORIGIN_SETUP_URL 指向 README 方法一（擴充套件）", () => {
  expect(ORIGIN_SETUP_URL).toMatch(
    /^https:\/\/github\.com\/abccbaandy\/PttChrome#/,
  );
});
