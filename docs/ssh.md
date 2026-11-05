# SSH 連線

連線協議可選 **WebSocket**（預設，現行 telnet over `wss://ws.ptt.cc`）或 **SSH**（PTT 的 `ptt.cc:22`）。
SSH 經 relay 轉送：relay 只做「WebSocket ⇄ TCP ptt.cc:22」，**SSH 在網頁裡解開**，relay（包括專案提供的
Cloudflare Worker）看不到帳號密碼。這是 SSH 比 telnet WS proxy 真正多出來的好處：WS proxy 為了改寫
Origin，結構上一定得解開 TLS，看得到明文。

不做：ptt2、自動切換或自動探測協議、relay 端終結 SSH、live e2e 跑 SSH。

## 量測結果（PTT 端）

`ssh-keyscan` 6 台各一次、`bbs@ptt.cc` 連一次（只看畫面、沒登入）：

- server 軟體叫 `bbs-sshd`，PTT 私有實作，不是 upstream 的 bbsrf／OpenSSH。
- SSH 層認證方式 `none`，帳號 `bbs`，不用密碼。
- **SSH 通道裡的內容和 WS 一樣**：第一則輸出同樣是 `HTTP/1.1 200 OK`，接著是 logind 的登入畫面，也一樣送
  CPR 偵測編碼 ⇒ `bbs-sshd` 和 wsproxy 一樣只是 logind 前面的一層殼（LIKELY），登入、自動登入、編碼偵測都不用改。
  （讀 upstream 原始碼得出的「SSH 沒有 telnet 層、登入畫面是另一版」是 bbsrf 那套舊路徑，PTT 線上沒用。）
- 演算法：kex `curve25519-sha256`／`dh-group16-sha512`／`dh-group14-sha256`；host key `ssh-ed25519`／
  `ecdsa-sha2-nistp256`／`rsa-sha2-512/256`；cipher `chacha20-poly1305`／`aes256-gcm`／`aes-ctr`；MAC `hmac-sha2-*`。
- host key（6 個 IP 同一組，內建在 `src/js/ssh/ssh_host_keys.js`）：
  - ED25519 `SHA256:oTf7wY7klc9gi0FHhYQNHQu7aJfYGz/bFLSpdOxhbxg`
  - ECDSA `SHA256:3rvcAywUJszX7jPzC3JkbtxqnHiApB4tuwQ3swSYmSo`
  - RSA `SHA256:9/gkjxWjuteMj//K0sRo1gj7h5qTp0HPIH3n7+e3Jqc`
- 瀏覽器 Local Network Access（Chrome 156 實測）：公開 https 頁面連 `ws://127.0.0.1` 會被擋
  （`ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`），使用者授權後就通（每個站台一次）；從 `http://localhost`
  頁面連不受影響。Safari 很可能直接擋（LIKELY，未實測）。APK 的 WebView 沒有這個檢查。

**還沒驗（要登入）**：登入後客戶端送的 telnet IAC（NAWS、TIMING-MARK 保活）在 SSH 下會不會照常被 logind 吃掉；
視窗大小看 pty-req、NAWS 還是兩者。目前兩者都送（NAWS 照送＋SSH `window-change`，`telnet.js#sendNaws`），
確認後若 NAWS 在 SSH 下也有效，可只留一種。這兩件事由人在 dev 手動登入一次確認，不進 live e2e。

## 架構

```
網頁  telnet 層（telnet.js）以上完全不變
        │  載體介面：open／data／close(detail.reason)／send／close()／resize()
        ├─ Websocket（websocket.js）           wstelnet:// wsstelnet://
        └─ SshTransport（ssh/ssh_transport.js） wssh:// wsssh://
              │  SSH client（ssh/ssh_client.js，WebCrypto，lazy chunk）
              ▼  WebSocket（binary frame＝原始 TCP bytes）
relay  自架 Node（tools/ssh-relay/）｜dev /ssh｜CF Worker（proxy/ssh-relay-worker/）｜APK 原生 /ssh/<token>
              ▼  TCP
PTT    ptt.cc:22（bbs-sshd → logind）
```

- **載體依 scheme 選**（`transport.js#createTransport`）：`ws`＋`telnet`／`ssh`，多一個 `s` 是加密的 WebSocket。
- **SSH 載體**要等 KEX、host key 驗證、pty、shell 都完成才發 `open`；`close` 帶原因：
  `relay`（relay 連不上／拒絕）、`tcp`（relay 通、PTT 的 22 連不上）、`hostkey`、`auth`、`protocol`、
  `unsupported`（非 secure context）、`closed`（open 過之後斷線）。
- pty-req 帶初始尺寸（`buf.cols/rows`），TERM `vt100`（與 telnet TERM-TYPE 一致）。
- **SSH 函式庫 lazy**：`ssh_client`／`ssh_crypto`／`ssh_host_keys` 只在 SSH 載體 `import()`，選 WebSocket 的人不下載。
- **測試注入點**：dev build 的 `window.__pttTestTransport(site, opts)` 取代載體，offline e2e 在 SSH 協議下直接餵明文
  （`tests/e2e/offline/ssh_protocol.offline.spec.js`）。WebSocket stub 餵不了 SSH 線路上的加密 bytes。

### SSH client（`src/js/ssh/`）

自寫最小 client，只用 WebCrypto（選型見 `docs/build-modernization.md`「SSH client」）：

| 類別 | 提供（依序） | 備註 |
|---|---|---|
| kex | `curve25519-sha256`(@libssh)、`diffie-hellman-group14-sha256` | X25519 沒有就只剩 DH14（BigInt modpow） |
| host key | `ssh-ed25519`、`ecdsa-sha2-nistp256`、`rsa-sha2-512/256` | Ed25519 沒有就跳過 |
| cipher | `aes256-gcm@openssh.com`、`aes128-gcm@openssh.com` | chacha20 WebCrypto 沒有 |
| 其他 | strict kex（Terrapin 對策）、server 發起的 rekey、流量窗口 | 不做 client rekey、壓縮、轉發 |

- host key：先比對指紋表（`ssh_host_keys.js`），再驗 exchange hash 的簽章。不符 ⇒ `hostkey`，**不自動重連**
  （App 本來就沒有自動重連；斷線提示寫明「請勿在這條連線上登入」）。PTT 換 key 時更新指紋表並在本文記一筆。
- 認證：`none`、帳號 `bbs`。被拒 ⇒ `auth`。
- 守護：`tests/unit/ssh_client.test.js`（對 `ssh2` 套件起的本機 server，另一份獨立實作）、`transport.test.js`。
- 踩過：X25519 共享秘密最高位元是 1 很正常（約一半機率），不能走 mpint 的符號檢查（曾讓一半連線握手失敗）。

## relay 合約

三種 relay（自架 Node、CF Worker、APK 原生）一致：

- 只轉送 binary frame 的 bytes，一個 byte 都不解讀；收到 text frame 以 1003 關。
- **目的地是常數 `ptt.cc:22`**，絕不從 URL／header／frame 解析。
- 拒絕也先完成握手，再以 close code 關（瀏覽器看不到握手被拒的 HTTP 狀態，頁面要靠 code 分辨原因）：

| code | 意義 | 頁面判成 |
|---|---|---|
| 4003 | Origin 不在白名單 | `relay` |
| 4004 | 路徑／token 不對 | `relay` |
| 4029 | 限流 | `relay` |
| 4502 | relay → PTT 的 TCP 失敗／逾時 | `tcp` |
| 1000 | PTT 關線 | `closed` |

常數在 `src/js/ssh/ssh_transport.js#RELAY_CLOSE`，三份 relay 各有一份，`tests/unit/ssh_relay.test.js` 比對一致。
APK 的 Origin／token 拒絕沿用 `/bbs` 的 HTTP 403／404（頁面判 `relay`，結果相同）。

## 自架 relay

單檔、零依賴的 Node 程式 `tools/ssh-relay/ptt-ssh-relay.mjs`（Windows／macOS／Linux 都一樣，需要 Node 18 以上）：

```bash
node ptt-ssh-relay.mjs
```

啟動後印出 `wssh://127.0.0.1:8022/ssh/<token>`，貼到「設定 → 連線 → SSH relay 位址」、協議選 SSH。
選項：`--port <n>`、`--origin <網頁來源>`（可重複；預設只收正式站與 `http://localhost:8080`）、`--new-token`。
token 存在家目錄的 `.ptt-ssh-relay-token`，重開不必重貼。

- 只綁 127.0.0.1、檢查 Origin、路徑帶 token ⇒ 別的網站借不到（CSWSH）。**不推 websocat**：它不檢查 Origin。
- 用 Node 腳本而不是預先編好的執行檔：用已安裝的 Node 跑，不會碰到 Gatekeeper／SmartScreen（未簽章、從瀏覽器
  下載的執行檔才會被擋）。
- Chrome 第一次會跳「存取本機網路」權限，允許即可；Safari 不支援從公開網頁連本機。要跨瀏覽器就自架成 `wss://`
  （例如部署自己的 `proxy/ssh-relay-worker`）。
- 自架的意義也是「用自己的 IP」：公用 Worker 是所有人共用 Cloudflare 出口 IP，較可能觸發 PTT 的 BOT 偵測。

dev server 的 `/ssh` 共用同一份實作（`vite.config.mjs#devSshRelay`）：只收同源頁面、不帶 token。
協議選 SSH、relay 欄位空白時，dev 的站台是 `wssh://<頁面 host>/ssh`，正式版是公用 Worker
（`util.js#DEFAULT_SSH_RELAY_HOST`）。

## 設定與開站優先序

- 「設定 → 連線」：協議（`connectionProtocol`：`websocket`｜`ssh`）與 SSH relay 位址（`sshRelayUrl`，空白＝公用
  relay，placeholder 顯示它）。**兩者都是本機專屬**（`pref_sync_logic.js#LOCAL_ONLY_PREF_KEYS`）：不同步、不進備份、
  雲端或匯入都蓋不掉。理由：自架 relay 是 `127.0.0.1`＋這台的 token，協議能不能用也看這台的網路。
- relay 位址可填裸 host（補成 `wsssh://<host>/ssh`）、`wss://`／`ws://`（換成 `wsssh://`／`wssh://`）或完整位址
  （`util.js#sshSiteFromPrefs`）。
- WebCrypto 只在 secure context（https、localhost）⇒ 從區網 http 開 dev 時，設定頁不出現 SSH、開站忽略 SSH pref。
- 開站優先序（`boot_site.js`）：`?site` > APK 原生 proxy > **協議選 SSH** > telnet proxy（`useProxy`）> 預設。

## 失敗提示

連線失敗診斷回傳「判斷結果＋建議清單」（`connection_probe.js#adviseConnectFailure`，決策表守在
`tests/unit/connection_advice.test.js`）：

| 情況 | 建議 |
|---|---|
| WebSocket 從未連上：Origin 被擋 | 開 proxy、改用 SSH |
| WebSocket 從未連上：其他 | 改用 SSH |
| SSH 從未連上：relay 連不上／拒絕 | 改用 WebSocket＋提示檢查 relay 位址（APK 不提示） |
| SSH 從未連上：PTT 的 22 連不上／host key 不符／協商失敗／不支援 | 改用 WebSocket |
| open 過之後才斷 | 無 |
| 被 PTT 的 BOT 偵測封鎖 | 無（不診斷：換協議也是再登入一次，只會延長封鎖） |

- 只能手動按，不自動切換、不自動探測。按下後**記住新協議並立即重連**：網頁寫回本機 pref，APK 走 bridge。
- 這個頁面跑不了 SSH（非 secure context）時不給「改用 SSH」。

## APK

- 原生本機 proxy（`LocalWebSocketProxy.kt`）多一條 `/ssh/<token>`：沿用 token、Origin 鎖，目的地寫死在
  `connectPttSsh()`（`AppConfig.SSH_UPSTREAM_HOST/PORT`）。PTT 連不上時握手照樣完成再以 4502 關。
- 協議在原生「App 設定 → 連線 → 用 SSH 連 PTT」（`AppSettings.protocol`，不經 pref_sync）。原生依設定注入對應的站台
  （`ConnectionService.site`），網頁不需要知道協議；網頁設定頁在 APK 裡不顯示協議選項。在 App 設定切換後回到主畫面，
  站台變了就重建 WebView。
- 失敗提示的「改用另一個協議」走 bridge `setProtocol`（寫原生設定，回新站台，網頁立即重連、不重建 WebView）。
  能力旗標 `config.setProtocol`（比照 `quitApp`）：舊 APK 沒有旗標就不顯示這個選項。
- 守護：JVM `LocalWebSocketProxyTest`（路徑、token、Origin、4502、雙向轉送）、`tests/unit/android_set_protocol.test.js`。

## 風險與對策

| 風險 | 對策 |
|---|---|
| relay 變成開放 TCP 代理，被濫用後 CF 出口 IP 遭 PTT 封鎖 | 目的地是常數；Worker 檢查 Origin 並依 IP 限流；靜態守護掃每個開 TCP 的呼叫點 |
| 本機 relay 被任意網站借用（CSWSH） | 強制檢查 Origin、帶 token、只綁 loopback |
| relay 中間人攔截 | 內建指紋表，不符就失敗 |
| 協議設定跨裝置滲透 | 網頁的協議與 relay 位址是本機 pref；APK 的在原生 |
| 所有人共用 CF 出口 IP，觸發 BOT 偵測 | 切換協議只能手動；自架 relay＝用自己的 IP |
| 免費 Worker 的 CPU | 免費方案（負載型態同現行 WS proxy：長連線雙向搬 bytes），上線前實測 |
| WebCrypto 只在 secure context | 非 secure context 隱藏 SSH 選項、開站忽略 SSH pref |

## 上線前檢查（人手）

1. 部署 `proxy/ssh-relay-worker`（`README.md`），確認網域與 `util.js#DEFAULT_SSH_RELAY_HOST` 一致。
2. 長時間連線（掛著 1 小時以上、期間有閒置）不會被 Worker 的 CPU 上限切斷。
3. 在 dev 以 SSH 手動登入一次，確認上面「還沒驗」的兩件事（IAC／視窗大小）。
4. 改到連線鏈：照規定跑 offline＋adverse＋一輪 live core（live 只跑 WebSocket 的 `core.spec.js`）。
