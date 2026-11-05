// SshClient（src/js/ssh/ssh_client.js）對 ssh2 起的本機 SSH server 實測：
// KEX／host key 驗證（含不符）／pty 尺寸／resize／雙向資料／流量窗口／server rekey／斷線原因。
// 用另一份獨立實作當對手，才驗得到「我們對 RFC 的理解」而不是自己跟自己對。
import { startServer, connectClient, hostKey, waitFor } from "./node_helpers/ssh_test_server";
import { defaultAlgorithms, negotiate } from "../../src/js/ssh/ssh_client";
import { PTT_HOST_KEYS } from "../../src/js/ssh/ssh_host_keys";

const pinned = (type) => {
  const k = hostKey(type);
  return { [k.keyType]: [k.fingerprint] };
};

let server;
afterEach(async () => {
  if (server) await server.close();
  server = null;
});

test("curve25519 + ed25519 + aes256-gcm: pty, shell, data both ways, resize", async () => {
  server = await startServer({ greeting: Buffer.from("HTTP/1.1 200 OK\r\n\xa4\xa4", "latin1") });
  const c = connectClient(server.port, { hostKeys: pinned("ed25519"), size: { cols: 100, rows: 30 } });
  await c.ready;
  expect(server.events.pty).toMatchObject({ cols: 100, rows: 30 });
  await waitFor(() => c.data().length >= 19);
  // 位元組原樣（Big5／telnet IAC 都不能被轉碼）。
  expect([...c.data()]).toEqual([...Buffer.from("HTTP/1.1 200 OK\r\n\xa4\xa4", "latin1")]);

  c.client.write(new Uint8Array([0xff, 0xfb, 0x1f, 0x61]));
  await waitFor(() => server.events.received.length >= 4);
  expect([...server.events.received]).toEqual([0xff, 0xfb, 0x1f, 0x61]);

  c.client.resize(120, 40);
  await waitFor(() => server.events.windowChange.length === 1);
  expect(server.events.windowChange[0]).toMatchObject({ cols: 120, rows: 40 });
  c.client.disconnect();
  expect((await c.closed).reason).toBe("closed");
});

// X25519 共享秘密的最高位元約一半機率是 1；曾被當成負數 mpint 拒絕 ⇒ 一半的連線握手失敗。
// 連 12 次全不撞到的機率是 1/4096。
test("curve25519 handshakes succeed regardless of the shared secret's high bit", async () => {
  server = await startServer({});
  for (let i = 0; i < 12; i++) {
    const c = connectClient(server.port, { hostKeys: pinned("ed25519") });
    const first = await Promise.race([c.ready.then(() => "ready"), c.closed.then((x) => x.reason)]);
    expect(first).toBe("ready");
    c.client.disconnect();
  }
});

test("the browser offers X25519/Ed25519 first when WebCrypto has them", async () => {
  const a = await defaultAlgorithms();
  expect(a.kex[0]).toBe("curve25519-sha256");
  expect(a.hostKey[0]).toBe("ssh-ed25519");
  expect(a.cipher).toContain("aes256-gcm@openssh.com");
});

test("negotiate picks the client's first choice the server also has", () => {
  expect(negotiate(["a", "b", "c"], ["c", "b"])).toBe("b");
  expect(negotiate(["a"], ["b"])).toBe(null);
});

test("unknown host key ⇒ close reason 'hostkey', never ready", async () => {
  server = await startServer({ greeting: "secret" });
  const c = connectClient(server.port, { hostKeys: PTT_HOST_KEYS });
  let ready = false;
  c.ready.then(() => (ready = true));
  const closed = await c.closed;
  expect(closed.reason).toBe("hostkey");
  expect(ready).toBe(false);
  expect(c.data().length).toBe(0);
});

test("key type pinned but different key ⇒ 'hostkey'", async () => {
  server = await startServer({});
  const c = connectClient(server.port, {
    hostKeys: { "ssh-ed25519": ["SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"] },
  });
  expect((await c.closed).reason).toBe("hostkey");
});

test("fallback: diffie-hellman-group14-sha256 + ecdsa-sha2-nistp256", async () => {
  server = await startServer({ keyType: "ecdsa", greeting: "ok" });
  const c = connectClient(server.port, {
    hostKeys: pinned("ecdsa"),
    algorithms: {
      kex: ["diffie-hellman-group14-sha256"],
      hostKey: ["ecdsa-sha2-nistp256"],
      cipher: ["aes128-gcm@openssh.com"],
      mac: ["hmac-sha2-256"],
    },
  });
  await c.ready;
  await waitFor(() => c.data().length >= 2);
  expect(Buffer.from(c.data()).toString()).toBe("ok");
  c.client.disconnect();
});

test("rsa-sha2-512 host key", async () => {
  server = await startServer({ keyType: "rsa", greeting: "rsa" });
  const c = connectClient(server.port, { hostKeys: pinned("rsa") });
  await c.ready;
  await waitFor(() => c.data().length >= 3);
  c.client.disconnect();
}, 20000);

test("auth 'none' rejected ⇒ close reason 'auth'", async () => {
  server = await startServer({ auth: () => false });
  const c = connectClient(server.port, { hostKeys: pinned("ed25519") });
  expect((await c.closed).reason).toBe("auth");
});

test("no common cipher ⇒ 'protocol'", async () => {
  server = await startServer({ algorithms: { cipher: ["aes128-ctr"] } });
  const c = connectClient(server.port, { hostKeys: pinned("ed25519") });
  expect((await c.closed).reason).toBe("protocol");
});

test("server closes the shell ⇒ 'closed'", async () => {
  server = await startServer({
    onShell: (stream) => setTimeout(() => stream.close(), 20),
  });
  const c = connectClient(server.port, { hostKeys: pinned("ed25519") });
  await c.ready;
  expect((await c.closed).reason).toBe("closed");
});

test("large transfers respect the flow-control windows in both directions", async () => {
  const big = Buffer.alloc(3 * 1024 * 1024 + 7, 0x41);
  server = await startServer({ onShell: (stream) => stream.write(big) });
  const c = connectClient(server.port, { hostKeys: pinned("ed25519") });
  await c.ready;
  await waitFor(() => c.data().length === big.length, 15000);
  const up = new Uint8Array(300 * 1024).fill(0x42);
  c.client.write(up);
  await waitFor(() => server.events.received.length === up.length, 15000);
  c.client.disconnect();
}, 30000);

test("server-initiated rekey keeps the session going", async () => {
  let streamRef;
  server = await startServer({ onShell: (stream) => (streamRef = stream) });
  const c = connectClient(server.port, { hostKeys: pinned("ed25519") });
  await c.ready;
  await new Promise((res) => server.events.conns[0].rekey(res));
  streamRef.write("after-rekey");
  await waitFor(() => Buffer.from(c.data()).toString().includes("after-rekey"));
  c.client.write(new TextEncoder().encode("up"));
  await waitFor(() => server.events.received.toString() === "up");
  c.client.disconnect();
});
