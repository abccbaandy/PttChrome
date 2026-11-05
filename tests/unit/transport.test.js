// 載體抽象（src/js/transport.js）＋SSH 載體（src/js/ssh/ssh_transport.js）＋telnet 層的接縫。
// SSH 載體端到端：假 WebSocket 把 bytes 經真 TCP 接到 ssh2 起的本機 server（＝relay 的角色）。
import net from "node:net";
import { parseSite, siteProtocol, createTransport } from "../../src/js/transport";
import { Websocket } from "../../src/js/websocket";
import { SshTransport, relayCloseReason, RELAY_CLOSE } from "../../src/js/ssh/ssh_transport";
import { TelnetConnection } from "../../src/js/telnet";
import { siteToWsUrl } from "../../src/js/connection_probe";
import { startServer, hostKey, waitFor } from "./node_helpers/ssh_test_server";

class FakeWs {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this._l = {};
    FakeWs.last = this;
  }
  addEventListener(t, f) {
    (this._l[t] = this._l[t] || []).push(f);
  }
  emit(t, ev = {}) {
    (this._l[t] || []).forEach((f) => f(ev));
  }
  send(b) {
    this.sent.push(b);
  }
  close() {
    this.readyState = 3;
  }
}

// relay 角色：WebSocket 的 bytes ⇄ TCP。closeCode 模擬 relay 端的收攤 code。
class TcpRelayWs extends FakeWs {
  constructor(url) {
    super(url);
    this.sock = net.connect(TcpRelayWs.port, "127.0.0.1");
    this.sock.on("connect", () => {
      this.readyState = 1;
      this.emit("open");
    });
    this.sock.on("data", (d) => this.emit("message", { data: d.buffer.slice(d.byteOffset, d.byteOffset + d.length) }));
    this.sock.on("close", () => {
      this.readyState = 3;
      this.emit("close", { code: 1000 });
    });
  }
  send(b) {
    this.sock.write(Buffer.from(b));
  }
  close() {
    this.sock.destroy();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("parseSite / scheme → protocol", () => {
  test.each([
    ["wstelnet://localhost:8080/bbs", "websocket", "ws://localhost:8080/bbs"],
    ["wsstelnet://ws.ptt.cc/bbs", "websocket", "wss://ws.ptt.cc/bbs"],
    ["wssh://127.0.0.1:8022/ssh/tok", "ssh", "ws://127.0.0.1:8022/ssh/tok"],
    ["wsssh://relay.example/ssh", "ssh", "wss://relay.example/ssh"],
    ["wsssh://relay.example", "ssh", "wss://relay.example/"],
  ])("%s", (site, protocol, wsUrl) => {
    expect(parseSite(site)).toMatchObject({ protocol, wsUrl });
    expect(siteProtocol(site)).toBe(protocol);
  });

  test("unsupported schemes → null", () => {
    expect(parseSite("telnet://ptt.cc")).toBe(null);
    expect(parseSite("ssh://ptt.cc")).toBe(null);
    expect(parseSite("garbage")).toBe(null);
    expect(createTransport("ssh://ptt.cc")).toBe(null);
  });

  test("siteToWsUrl only converts WebSocket-protocol sites (probe targets)", () => {
    expect(siteToWsUrl("wsstelnet://x/bbs")).toBe("wss://x/bbs");
    expect(siteToWsUrl("wsssh://x/ssh")).toBe(null);
  });
});

describe("createTransport picks the carrier by scheme", () => {
  test("wsstelnet → Websocket", () => {
    vi.stubGlobal("WebSocket", FakeWs);
    const t = createTransport("wsstelnet://ws.ptt.cc/bbs");
    expect(t).toBeInstanceOf(Websocket);
    expect(FakeWs.last.url).toBe("wss://ws.ptt.cc/bbs");
  });

  test("wsssh → SshTransport (relay URL, not ptt.cc)", () => {
    vi.stubGlobal("WebSocket", FakeWs);
    const t = createTransport("wsssh://relay.example/ssh");
    expect(t).toBeInstanceOf(SshTransport);
    expect(FakeWs.last.url).toBe("wss://relay.example/ssh");
  });

  test("test injection point only in dev builds", () => {
    vi.stubGlobal("WebSocket", FakeWs);
    const fake = { fake: true };
    const factory = vi.fn(() => fake);
    vi.stubGlobal("window", { __pttTestTransport: factory });
    vi.stubEnv("DEVELOPER_MODE", "");
    expect(createTransport("wsssh://r/ssh")).toBeInstanceOf(SshTransport);
    vi.stubEnv("DEVELOPER_MODE", "true");
    expect(createTransport("wsssh://r/ssh")).toBe(fake);
    expect(factory).toHaveBeenLastCalledWith("wsssh://r/ssh", expect.objectContaining({ protocol: "ssh" }));
  });
});

describe("relay close → reason", () => {
  test("upstream TCP failure code ⇒ tcp; nothing relayed ⇒ relay", () => {
    expect(relayCloseReason(RELAY_CLOSE.UPSTREAM_FAILED, false)).toBe("tcp");
    expect(relayCloseReason(1006, false)).toBe("relay");
    expect(relayCloseReason(RELAY_CLOSE.ORIGIN_REJECTED, false)).toBe("relay");
  });

  test("relay never opens ⇒ close detail.reason 'relay'", async () => {
    const t = new SshTransport("wss://r/ssh", { WebSocketImpl: FakeWs });
    const ws = FakeWs.last;
    const closed = new Promise((r) => t.addEventListener("close", (e) => r(e.detail)));
    ws.emit("error");
    ws.emit("close", { code: 1006 });
    expect((await closed).reason).toBe("relay");
  });

  test("relay up, PTT unreachable ⇒ 'tcp'", async () => {
    const t = new SshTransport("wss://r/ssh", { WebSocketImpl: FakeWs });
    const ws = FakeWs.last;
    const closed = new Promise((r) => t.addEventListener("close", (e) => r(e.detail)));
    ws.emit("open");
    ws.emit("close", { code: RELAY_CLOSE.UPSTREAM_FAILED });
    expect((await closed).reason).toBe("tcp");
  });

  test("not a secure context ⇒ 'unsupported' without touching the relay", async () => {
    vi.stubGlobal("isSecureContext", false);
    FakeWs.last = null;
    const t = new SshTransport("wss://r/ssh", { WebSocketImpl: FakeWs });
    const detail = await new Promise((r) => t.addEventListener("close", (e) => r(e.detail)));
    expect(detail.reason).toBe("unsupported");
    expect(FakeWs.last).toBe(null);
  });
});

describe("SshTransport end to end through a byte relay", () => {
  let server;
  afterEach(async () => {
    if (server) await server.close();
    server = null;
  });

  const pinned = () => {
    const k = hostKey("ed25519");
    return { [k.keyType]: [k.fingerprint] };
  };

  test("open after shell, latin1 data both ways, NAWS also sends window-change", async () => {
    server = await startServer({ greeting: Buffer.from([0xff, 0xfd, 0x1f, 0xa4, 0x40]) });
    TcpRelayWs.port = server.port;
    const t = new SshTransport("ws://relay/ssh", {
      WebSocketImpl: TcpRelayWs,
      hostKeys: pinned(),
      size: () => ({ cols: 80, rows: 24 }),
    });
    const telnet = new TelnetConnection(t);
    const opened = new Promise((r) => telnet.addEventListener("open", r));
    let doNaws = false;
    telnet.addEventListener("doNaws", () => (doNaws = true));
    let text = "";
    telnet.addEventListener("data", (e) => (text += e.detail.data));
    await opened;
    expect(server.events.pty).toMatchObject({ cols: 80, rows: 24 });
    // server 的 IAC DO NAWS 由 telnet 層吃掉，剩下的 Big5 bytes 原樣。
    await waitFor(() => doNaws && text.length >= 2);
    expect(text).toBe("\xa4\x40");

    telnet.sendNaws(100, 30);
    await waitFor(() => server.events.windowChange.length === 1);
    expect(server.events.windowChange[0]).toMatchObject({ cols: 100, rows: 30 });
    // NAWS 本身也照送（telnet 層，給 logind）。
    await waitFor(() => server.events.received.includes(Buffer.from([0xff, 0xfa, 0x1f, 0, 100, 0, 30, 0xff, 0xf0])));

    const closed = new Promise((r) => telnet.addEventListener("close", (e) => r(e.detail)));
    telnet.abort();
    expect((await closed).reason).toBe("closed");
  });

  test("host key mismatch ⇒ close reason 'hostkey' propagates through the telnet layer, never opens", async () => {
    server = await startServer({ greeting: "x" });
    TcpRelayWs.port = server.port;
    const t = new SshTransport("ws://relay/ssh", {
      WebSocketImpl: TcpRelayWs,
      hostKeys: { "ssh-ed25519": ["SHA256:nope"] },
    });
    const telnet = new TelnetConnection(t);
    let opened = false;
    telnet.addEventListener("open", () => (opened = true));
    const detail = await new Promise((r) => telnet.addEventListener("close", (e) => r(e.detail)));
    expect(detail.reason).toBe("hostkey");
    expect(opened).toBe(false);
  });
});
