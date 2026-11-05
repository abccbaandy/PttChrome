// **node 專用 helper**（unit project，不給 unit-browser 用；瀏覽器安全的 helper 才放 helpers/）。
// 本機 SSH server（ssh2 套件，另一份獨立實作），給 SshClient 對測用。
// 行為模仿 PTT 的 bbs-sshd：帳號 bbs、只收 none 認證、pty＋shell，shell 一開就送一段字。
import net from "node:net";
import crypto from "node:crypto";
import ssh2 from "ssh2";
import { SshClient } from "../../../src/js/ssh/ssh_client";

const { Server, utils } = ssh2;

// ssh2 的 generateKeyPairSync('ed25519') 約 0.4% 機率產出自己解析不了的私鑰：驗過再用，壞的重產
//（守護 tests/unit/ssh_test_server_keys.test.js）。
export function generateUsableKey(type, opts, gen = utils.generateKeyPairSync) {
  for (let i = 0; i < 20; i++) {
    const kp = gen(type, opts);
    if (!(utils.parseKey(kp.private) instanceof Error)) return kp;
  }
  throw new Error("no usable " + type + " key after 20 tries");
}

const keyCache = new Map();
// type：'ed25519'｜'ecdsa'｜'rsa'。同一種 key 整檔共用（RSA 產生要時間）。
export function hostKey(type) {
  if (!keyCache.has(type)) {
    const opts = type === "ecdsa" ? { bits: 256 } : type === "rsa" ? { bits: 2048 } : undefined;
    const kp = generateUsableKey(type, opts);
    const [keyType, b64] = kp.public.split(" ");
    const blob = Buffer.from(b64, "base64");
    const fp = "SHA256:" + crypto.createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
    keyCache.set(type, { private: kp.private, keyType, fingerprint: fp });
  }
  return keyCache.get(type);
}

// opts.keyType、opts.algorithms（ssh2 server 端）、opts.greeting（shell 一開就送的字）、
// opts.onShell(stream, info)、opts.auth（預設只收 none）。
// 回 { port, events, close() }。events：pty／windowChange／received（client 送來的 bytes）。
export async function startServer(opts = {}) {
  const key = hostKey(opts.keyType || "ed25519");
  const events = { pty: null, windowChange: [], received: Buffer.alloc(0), conns: [] };
  const server = new Server(
    { hostKeys: [key.private], algorithms: opts.algorithms },
    (client) => {
      events.conns.push(client);
      client.on("error", () => {});
      client.on("authentication", (ctx) => {
        const ok = opts.auth ? opts.auth(ctx) : ctx.method === "none" && ctx.username === "bbs";
        if (ok) ctx.accept();
        else ctx.reject(["password"]);
      });
      client.on("session", (accept) => {
        const session = accept();
        session.on("pty", (acc, rej, info) => {
          events.pty = info;
          acc && acc();
        });
        session.on("window-change", (acc, rej, info) => {
          events.windowChange.push(info);
          acc && acc();
        });
        session.on("shell", (acc) => {
          const stream = acc();
          stream.on("data", (d) => {
            events.received = Buffer.concat([events.received, d]);
          });
          if (opts.greeting) stream.write(opts.greeting);
          if (opts.onShell) opts.onShell(stream, client);
        });
      });
    }
  );
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  return {
    port: server.address().port,
    key,
    events,
    close: () =>
      new Promise((res) => {
        for (const c of events.conns) {
          try {
            c.end();
          } catch (e) {}
        }
        server.close(() => res());
      }),
  };
}

// 用真 TCP 把 SshClient 接到 server。回 { client, ready, closed, data(), socket }。
// ready：onReady 時 resolve；closed：onClose 時 resolve { reason, message }。
export function connectClient(port, opts = {}) {
  const socket = net.connect(port, "127.0.0.1");
  let received = Buffer.alloc(0);
  let resolveReady;
  let resolveClosed;
  const ready = new Promise((r) => (resolveReady = r));
  const closed = new Promise((r) => (resolveClosed = r));
  const client = new SshClient({
    send: (bytes) => socket.write(bytes),
    onReady: () => resolveReady(true),
    onData: (d) => {
      received = Buffer.concat([received, Buffer.from(d)]);
    },
    onClose: (reason, message) => {
      socket.destroy();
      resolveClosed({ reason, message });
    },
    size: () => opts.size || { cols: 80, rows: 24 },
    hostKeys: opts.hostKeys,
    user: opts.user || "bbs",
    algorithms: opts.algorithms,
  });
  socket.on("data", (d) => client.feed(new Uint8Array(d)));
  socket.on("close", () => client.disconnect());
  socket.on("connect", () => client.start());
  return { client, ready, closed, data: () => received, socket };
}

export async function waitFor(fn, timeout = 5000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}
