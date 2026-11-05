# ptt-ssh-relay（Cloudflare Worker）

PttChrome 的 SSH relay：只做「WebSocket ⇄ TCP `ptt.cc:22`」。SSH 在瀏覽器裡解開，Worker 只搬加密過的
bytes，**看不到帳號密碼**。設計、relay 合約與風險見 [`docs/ssh.md`](../../docs/ssh.md)。

- 目的地寫死在 `src/relay.js`（`UPSTREAM_HOST`／`UPSTREAM_PORT`），絕不從 URL／header 解析。
- 只收 `ALLOWED_ORIGINS` 的網頁來源；依來源 IP 限流（`wrangler.jsonc` 的 `RATE_LIMITER`）。
- 路徑固定 `/ssh`。使用者在 PttChrome 設定填 `wsssh://<worker 網域>/ssh`。

## 部署

免費方案即可（負載型態與現行 telnet WS proxy 相同：長連線雙向搬 bytes）。上線前要實測長時間連線
不會被 CPU 上限切斷（`docs/ssh.md`「上線前檢查」）。

```bash
cd proxy/ssh-relay-worker
```

```bash
npx wrangler@4 deploy
```

## 測試

純邏輯在 `src/relay.js`，由主 repo 的 unit 測（`tests/unit/ssh_relay.test.js`，含目的地寫死的靜態守護）：

```bash
yarn test:unit ssh_relay
```
