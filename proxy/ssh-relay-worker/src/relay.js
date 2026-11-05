// PttChrome 的 SSH relay（Cloudflare Worker 版）：只做「WebSocket ⇄ TCP ptt.cc:22」。
// SSH 在瀏覽器裡解開（src/js/ssh/），Worker 只搬加密過的 bytes ⇒ 看不到帳號密碼
//（現行 telnet 的 WS proxy 為了改寫 Origin 一定得解開 TLS，看得到明文；這是 SSH 多出來的好處）。
//
// 本檔是純邏輯（Cloudflare 專屬 API 由 index.js 注入），讓主 repo 的 unit 測得到：
// tests/unit/ssh_relay.test.js。合約（close code）與自架版、APK 原生版一致：
// src/js/ssh/ssh_transport.js#RELAY_CLOSE、docs/ssh.md「relay 合約」。
//
// 安全邊界（docs/ssh.md「風險與對策」）：
//   - 目的地是常數，絕不從 URL／header／frame 解析 ⇒ 不會變成開放 TCP 代理
//     （被濫用的話 Cloudflare 出口 IP 會被 PTT 封，所有使用者一起連不上）。
//   - 檢查 Origin（只收 PttChrome 正式站與本機 dev）。
//   - 依來源 IP 限流（RATE_LIMITER binding，wrangler.jsonc；沒設定就不限）。

// ⚠ 安全邊界：目的地只能是這兩個常數。
export const UPSTREAM_HOST = 'ptt.cc';
export const UPSTREAM_PORT = 22;

export const RELAY_CLOSE = Object.freeze({
  ORIGIN_REJECTED: 4003,
  BAD_PATH: 4004,
  RATE_LIMITED: 4029,
  UPSTREAM_FAILED: 4502,
});

export const ALLOWED_ORIGINS = Object.freeze([
  'https://abccbaandy.github.io',
  'http://localhost:8080',
]);

const defaultUpgradeResponse = (client) => new Response(null, { status: 101, webSocket: client });

// deps：{ connect, WebSocketPair, upgradeResponse }（index.js 給 Cloudflare 的實作，測試給假的）。
export async function handleRequest(request, env, deps) {
  const url = new URL(request.url);
  if (url.pathname !== '/ssh') return new Response('PttChrome SSH relay\n', { status: 404 });
  if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
    return new Response('expected websocket\n', { status: 426 });
  }
  const upgradeResponse = deps.upgradeResponse || defaultUpgradeResponse;
  const pair = new deps.WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();

  // 拒絕也要先完成握手再以 close code 關：瀏覽器看不到握手被拒的 HTTP 狀態，
  // 頁面要靠 code 分辨「relay 拒絕」與「PTT 連不上」。
  const deny = (code, reason) => {
    server.close(code, reason);
    return upgradeResponse(client);
  };

  if (!ALLOWED_ORIGINS.includes(request.headers.get('Origin') || '')) {
    return deny(RELAY_CLOSE.ORIGIN_REJECTED, 'origin not allowed');
  }
  if (env && env.RATE_LIMITER) {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const { success } = await env.RATE_LIMITER.limit({ key: ip });
    if (!success) return deny(RELAY_CLOSE.RATE_LIMITED, 'rate limited');
  }

  pipe(server, deps.connect);
  return upgradeResponse(client);
}

function pipe(ws, connect) {
  let socket;
  let closed = false;
  let upstreamOpen = false;
  const close = (code, reason) => {
    if (closed) return;
    closed = true;
    try {
      ws.close(code, reason);
    } catch (e) {}
    try {
      socket && socket.close();
    } catch (e) {}
  };
  try {
    socket = connect({ hostname: UPSTREAM_HOST, port: UPSTREAM_PORT });
  } catch (e) {
    close(RELAY_CLOSE.UPSTREAM_FAILED, 'upstream connect failed');
    return;
  }
  const writer = socket.writable.getWriter();

  socket.opened.then(
    () => {
      upstreamOpen = true;
    },
    () => close(RELAY_CLOSE.UPSTREAM_FAILED, 'upstream connect failed')
  );

  ws.addEventListener('message', (e) => {
    if (typeof e.data === 'string') {
      close(1003, 'binary only');
      return;
    }
    writer.write(new Uint8Array(e.data)).catch(() => close(1011, 'upstream write failed'));
  });
  ws.addEventListener('close', () => close(1000, ''));
  ws.addEventListener('error', () => close(1011, ''));

  (async () => {
    const reader = socket.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.length) ws.send(value);
      }
      close(upstreamOpen ? 1000 : RELAY_CLOSE.UPSTREAM_FAILED, 'upstream closed');
    } catch (e) {
      close(upstreamOpen ? 1011 : RELAY_CLOSE.UPSTREAM_FAILED, 'upstream error');
    }
  })();
}
