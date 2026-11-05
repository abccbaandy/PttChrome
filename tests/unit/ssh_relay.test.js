// SSH relay 三種實作的合約與安全邊界（docs/ssh.md「relay 合約」「風險與對策」）：
//   - 自架 Node 版 tools/ssh-relay/ptt-ssh-relay.mjs（dev server 的 /ssh 共用）
//   - Cloudflare Worker 版 proxy/ssh-relay-worker/src/relay.js
//   - APK 原生版 android/.../LocalWebSocketProxy.kt（行為由 JVM 測，這裡只做靜態守護）
// 最重要的一條：**目的地是常數**，絕不從 URL／header／frame 解析。被當成開放 TCP 代理濫用的話，
// Cloudflare 的出口 IP 會被 PTT 封，所有使用者一起連不上。
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import {
  handleUpgrade,
  makeAuthorizer,
  parseFrames,
  UPSTREAM_HOST,
  UPSTREAM_PORT,
  RELAY_CLOSE,
  DEFAULT_ALLOWED_ORIGINS,
} from "../../tools/ssh-relay/ptt-ssh-relay.mjs";
import * as worker from "../../proxy/ssh-relay-worker/src/relay.js";
import { RELAY_CLOSE as CLIENT_RELAY_CLOSE } from "../../src/js/ssh/ssh_transport";

const ROOT = path.resolve(__dirname, "../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const ORIGIN = "https://abccbaandy.github.io";

// 每個 `name(` 呼叫的參數字串（括號配對，參數裡有巢狀呼叫也取得完整）。
function callArgs(src, name) {
  const out = [];
  const re = new RegExp("\\b" + name + "\\(", "g");
  let m;
  while ((m = re.exec(src))) {
    let depth = 1;
    let j = m.index + m[0].length;
    const start = j;
    for (; j < src.length && depth; j++) {
      if (src[j] === "(") depth++;
      else if (src[j] === ")") depth--;
    }
    out.push(src.slice(start, j - 1).trim());
  }
  return out;
}

describe("destination is a constant (static guard)", () => {
  test("all three relays target ptt.cc:22", () => {
    expect([UPSTREAM_HOST, UPSTREAM_PORT]).toEqual(["ptt.cc", 22]);
    expect([worker.UPSTREAM_HOST, worker.UPSTREAM_PORT]).toEqual(["ptt.cc", 22]);
    const kt = read("android/app/src/main/java/io/github/abccbaandy/pttchrome/AppConfig.kt");
    expect(kt).toMatch(/const val SSH_UPSTREAM_HOST = "ptt\.cc"/);
    expect(kt).toMatch(/const val SSH_UPSTREAM_PORT = 22\b/);
  });

  // 每個「開 TCP」的呼叫點，參數只准是那兩個常數。新增呼叫點或改參數 ⇒ 這裡紅，逼人重新審。
  test.each([
    ["tools/ssh-relay/ptt-ssh-relay.mjs", "connect", ["UPSTREAM_PORT, UPSTREAM_HOST", "port, host"]],
    ["proxy/ssh-relay-worker/src/relay.js", "connect", ["{ hostname: UPSTREAM_HOST, port: UPSTREAM_PORT }"]],
    [
      "android/app/src/main/java/io/github/abccbaandy/pttchrome/LocalWebSocketProxy.kt",
      "InetSocketAddress",
      ['InetAddress.getByName("127.0.0.1"), 0', "AppConfig.SSH_UPSTREAM_HOST, AppConfig.SSH_UPSTREAM_PORT"],
    ],
  ])("%s opens TCP only to the constants", (file, name, allowed) => {
    const args = callArgs(read(file), name).filter((a) => a !== "");
    expect(args.length).toBeGreaterThan(0);
    for (const a of args) expect(allowed).toContain(a);
  });

  test("APK: the SSH connector takes no destination parameter", () => {
    const kt = read("android/app/src/main/java/io/github/abccbaandy/pttchrome/LocalWebSocketProxy.kt");
    expect(kt).toMatch(/private val sshConnect: \(\) -> Socket = \{ connectPttSsh\(\) \}/);
    expect(callArgs(kt, "Socket")).toEqual([""]);
  });

  test("Node relay: the only net.connect wrapper is called with the constants", () => {
    const src = read("tools/ssh-relay/ptt-ssh-relay.mjs");
    expect(src).toContain("const upstream = connect(UPSTREAM_PORT, UPSTREAM_HOST);");
    expect(src.match(/net\.connect\(/g)).toHaveLength(1);
  });

  test("relay close codes agree between client and relays", () => {
    expect(RELAY_CLOSE).toEqual(CLIENT_RELAY_CLOSE);
    expect(worker.RELAY_CLOSE).toEqual(CLIENT_RELAY_CLOSE);
  });

  test("self-hosted relay binds loopback only", () => {
    const src = read("tools/ssh-relay/ptt-ssh-relay.mjs");
    expect(src.match(/\.listen\(/g)).toHaveLength(1);
    expect(src).toMatch(/server\.listen\(args\.port, '127\.0\.0\.1'/);
    expect(src).not.toMatch(/\.listen\([^)]*0\.0\.0\.0/);
  });
});

describe("Node relay (handleUpgrade)", () => {
  let server;
  let upstream;
  let connectCalls;
  afterEach(async () => {
    await new Promise((r) => (server ? server.close(r) : r()));
    await new Promise((r) => (upstream ? upstream.close(r) : r()));
    server = upstream = null;
  });

  // 本機 echo server 當「PTT」，connect 注入成連它，同時記下 relay 要求的目的地。
  async function setup({ authorize, upstreamDown = false } = {}) {
    connectCalls = [];
    upstream = net.createServer((s) => s.on("data", (d) => s.write(Buffer.concat([Buffer.from("echo:"), d]))));
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    const upPort = upstream.address().port;
    if (upstreamDown) await new Promise((r) => upstream.close(r));
    if (upstreamDown) upstream = null;
    server = http.createServer();
    server.on("upgrade", (req, socket, head) =>
      handleUpgrade(req, socket, head, {
        authorize,
        connect: (port, host) => {
          connectCalls.push([port, host]);
          return net.connect(upPort, "127.0.0.1");
        },
      })
    );
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    return server.address().port;
  }

  function open(port, urlPath, origin = ORIGIN) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${urlPath}`, { headers: { Origin: origin } });
    ws.binaryType = "arraybuffer";
    const msgs = [];
    ws.onmessage = (e) => msgs.push(Buffer.from(e.data).toString());
    const closed = new Promise((r) => (ws.onclose = (e) => r(e.code)));
    const opened = new Promise((r) => (ws.onopen = r));
    return { ws, msgs, closed, opened };
  }

  test("pipes bytes both ways, always to the constant destination (URL/headers ignored)", async () => {
    const port = await setup({ authorize: makeAuthorizer({ allowedOrigins: [ORIGIN], token: "tok123" }) });
    const c = open(port, "/ssh/tok123?host=evil.example&port=25");
    await c.opened;
    c.ws.send(new Uint8Array([0x53, 0x53, 0x48]));
    await vi.waitFor(() => expect(c.msgs.join("")).toBe("echo:SSH"));
    expect(connectCalls).toEqual([[22, "ptt.cc"]]);
    c.ws.close();
  });

  test("wrong origin ⇒ 4003, no TCP opened", async () => {
    const port = await setup({ authorize: makeAuthorizer({ allowedOrigins: [ORIGIN], token: "tok123" }) });
    const c = open(port, "/ssh/tok123", "https://evil.example");
    expect(await c.closed).toBe(RELAY_CLOSE.ORIGIN_REJECTED);
    expect(connectCalls).toEqual([]);
  });

  test("wrong token ⇒ 4004, no TCP opened", async () => {
    const port = await setup({ authorize: makeAuthorizer({ allowedOrigins: [ORIGIN], token: "tok123" }) });
    const c = open(port, "/ssh/nope");
    expect(await c.closed).toBe(RELAY_CLOSE.BAD_PATH);
    expect(connectCalls).toEqual([]);
  });

  test("PTT unreachable ⇒ 4502", async () => {
    const port = await setup({
      authorize: makeAuthorizer({ allowedOrigins: [ORIGIN], token: "t".repeat(16) }),
      upstreamDown: true,
    });
    const c = open(port, "/ssh/" + "t".repeat(16));
    expect(await c.closed).toBe(RELAY_CLOSE.UPSTREAM_FAILED);
  });

  test("dev authorizer: same-origin page allowed without token, other sites rejected", () => {
    const auth = makeAuthorizer({ allowedOrigins: [...DEFAULT_ALLOWED_ORIGINS], sameOriginOk: true });
    const req = (origin, host, url = "/ssh") => ({ headers: { origin, host }, url });
    expect(auth(req("http://localhost:8080", "localhost:8080"))).toBe(null);
    expect(auth(req("http://192.168.1.5:8080", "192.168.1.5:8080"))).toBe(null);
    expect(auth(req("https://evil.example", "localhost:8080"))).toBe(RELAY_CLOSE.ORIGIN_REJECTED);
    expect(auth(req("", "localhost:8080"))).toBe(RELAY_CLOSE.ORIGIN_REJECTED);
  });

  test("parseFrames rejects unmasked and oversized client frames", () => {
    expect(() => parseFrames(Buffer.from([0x82, 0x01, 0x41]))).toThrow(/unmasked/);
    const big = Buffer.from([0x82, 0xff, 0, 0, 0, 0, 0x10, 0, 0, 0]);
    expect(() => parseFrames(big)).toThrow(/too large/);
  });
});

describe("Cloudflare Worker relay (relay.js)", () => {
  function makePair() {
    const mk = () => ({
      l: {},
      sent: [],
      closedWith: null,
      accept() {},
      addEventListener(t, f) {
        (this.l[t] = this.l[t] || []).push(f);
      },
      send(v) {
        this.sent.push(v);
      },
      close(code, reason) {
        this.closedWith = [code, reason];
      },
    });
    const client = mk();
    const server = mk();
    return { client, server, Pair: function () { return { 0: client, 1: server }; } };
  }
  function makeConnect({ fail = false } = {}) {
    const calls = [];
    const written = [];
    let push;
    const connect = (addr) => {
      calls.push(addr);
      const readable = new ReadableStream({ start: (c) => (push = c) });
      return {
        opened: fail ? Promise.reject(new Error("refused")) : Promise.resolve(),
        readable,
        writable: new WritableStream({ write: (chunk) => written.push(chunk) }),
        close() {},
      };
    };
    return { connect, calls, written, push: () => push };
  }
  const req = (origin, url = "https://relay.example/ssh?host=evil.example") =>
    new Request(url, { headers: { Upgrade: "websocket", Origin: origin } });

  test("pipes to the constant destination and relays bytes", async () => {
    const p = makePair();
    const c = makeConnect();
    const res = await worker.handleRequest(req(ORIGIN), {}, {
      connect: c.connect,
      WebSocketPair: p.Pair,
      upgradeResponse: (client) => ({ client }),
    });
    expect(res.client).toBe(p.client);
    expect(c.calls).toEqual([{ hostname: "ptt.cc", port: 22 }]);
    p.server.l.message[0]({ data: new Uint8Array([1, 2]).buffer });
    await vi.waitFor(() => expect(c.written).toHaveLength(1));
    c.push().enqueue(new Uint8Array([9]));
    await vi.waitFor(() => expect(p.server.sent).toHaveLength(1));
    c.push().close();
    await vi.waitFor(() => expect(p.server.closedWith?.[0]).toBe(1000));
  });

  test("bad origin ⇒ 4003 and no TCP", async () => {
    const p = makePair();
    const c = makeConnect();
    await worker.handleRequest(req("https://evil.example"), {}, {
      connect: c.connect,
      WebSocketPair: p.Pair,
      upgradeResponse: () => ({}),
    });
    expect(p.server.closedWith[0]).toBe(4003);
    expect(c.calls).toEqual([]);
  });

  test("rate limited ⇒ 4029 and no TCP", async () => {
    const p = makePair();
    const c = makeConnect();
    const env = { RATE_LIMITER: { limit: vi.fn(async () => ({ success: false })) } };
    await worker.handleRequest(req(ORIGIN), env, {
      connect: c.connect,
      WebSocketPair: p.Pair,
      upgradeResponse: () => ({}),
    });
    expect(p.server.closedWith[0]).toBe(4029);
    expect(c.calls).toEqual([]);
  });

  test("PTT unreachable ⇒ 4502", async () => {
    const p = makePair();
    const c = makeConnect({ fail: true });
    await worker.handleRequest(req(ORIGIN), {}, {
      connect: c.connect,
      WebSocketPair: p.Pair,
      upgradeResponse: () => ({}),
    });
    await vi.waitFor(() => expect(p.server.closedWith?.[0]).toBe(4502));
  });

  test("only /ssh with a WebSocket upgrade", async () => {
    const deps = { connect: () => null, WebSocketPair: makePair().Pair };
    expect((await worker.handleRequest(new Request("https://r/other"), {}, deps)).status).toBe(404);
    expect((await worker.handleRequest(new Request("https://r/ssh"), {}, deps)).status).toBe(426);
  });
});
