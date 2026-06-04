# 瀏覽器直連 PTT：Chrome 擴充改寫 Origin（取代第三方 proxy）

## 背景 / 動機

純靜態部署（如 GitHub Pages）時，瀏覽器無法直連 `wss://ws.ptt.cc/bbs`：PTT 有 **Origin 白名單**（只認 `https://term.ptt.cc` 等），而瀏覽器 JS 不能自設 WebSocket 的 `Origin` header。常見解法是架一個會改寫 Origin 的反向 proxy 中轉，但第三方/免費 proxy 會增加延遲。

實測（從台灣，HiNet）：經免費 Cloudflare Worker（進入點 colo 落在新加坡 SIN）每個按鍵回顯要多繞一趟跨海，~57 ms ping；直連 `ws.ptt.cc`（140.112.172.2, 台大）僅 **~9 ms**。

**唯一免費根治法：不經任何 proxy，瀏覽器直連 `wss://ws.ptt.cc/bbs`。** 障礙只有 Origin 白名單 → 用 Chrome 擴充在**網路層**改寫 Origin 即可繞過。

> Tampermonkey/userscript **做不到**：原生 `WebSocket` 不收自訂 header，`GM_xmlhttpRequest` 只管 HTTP 不管 WS。必須用瀏覽器擴充。

適用範圍：**僅限有裝擴充的桌面 Chrome**（個人優化用）。手機 Chrome 不能裝擴充、一般訪客不會裝 → 不是全體訪客的解；公開部署的預設連線方式不受影響，只有「裝擴充 + 帶 `?site=`」的你走直連。

---

## 方案組成（三塊拼圖）

| # | 元件 | 作用 |
|---|---|---|
| ① | Chrome 擴充（本文件）| 對 `ws.ptt.cc` 的 websocket 請求 set `Origin: https://term.ptt.cc` |
| ② | `?site=wsstelnet://ws.ptt.cc/bbs` | 讓前端直連 PTT（`wsstelnet`→`wss:443`，見 `src/js/pttchrome.js:172,199`）|
| ③ | build flag `ALLOW_SITE_IN_QUERY` | 否則 `?site=` 不生效（`src/js/main.js:26` + `webpack.config.js` 的 `DefinePlugin`）|

---

## ① 擴充內容（MV3，static declarativeNetRequest rule）

建立資料夾 `ptt-origin-ext/`，放兩個檔：

### `ptt-origin-ext/manifest.json`

```json
{
  "manifest_version": 3,
  "name": "PTT Origin Rewriter",
  "version": "1.0.0",
  "description": "Set Origin: https://term.ptt.cc on WebSocket handshakes to ws.ptt.cc, enabling direct browser->PTT connection (no proxy).",
  "permissions": ["declarativeNetRequest"],
  "host_permissions": ["wss://ws.ptt.cc/*", "https://ws.ptt.cc/*"],
  "declarative_net_request": {
    "rule_resources": [
      {
        "id": "ptt_origin",
        "enabled": true,
        "path": "rules.json"
      }
    ]
  }
}
```

### `ptt-origin-ext/rules.json`

```json
[
  {
    "id": 1,
    "priority": 1,
    "action": {
      "type": "modifyHeaders",
      "requestHeaders": [
        { "header": "Origin", "operation": "set", "value": "https://term.ptt.cc" }
      ]
    },
    "condition": {
      "urlFilter": "||ws.ptt.cc/bbs",
      "resourceTypes": ["websocket"]
    }
  }
]
```

### 安裝

1. Chrome → `chrome://extensions` → 右上角開「開發人員模式」。
2. 「載入未封裝項目」→ 選 `ptt-origin-ext/` 資料夾。
3. 完成。規則對所有分頁的 `ws.ptt.cc/bbs` websocket 握手生效。

---

## ② + ③ 讓前端直連

### ③ 開放 query 覆寫（build flag）

官方版前端的站台來源優先序在 `src/js/main.js:26-27`：

```js
process.env.ALLOW_SITE_IN_QUERY && getQueryVariable('site')
  || process.env.DEFAULT_SITE
```

`ALLOW_SITE_IN_QUERY` / `DEFAULT_SITE` 由 webpack 的 `DefinePlugin` 於 build 時注入（見 `webpack.config.js`）。要讓 `?site=` 生效，build 時需把 `ALLOW_SITE_IN_QUERY` 設為真值（例如在 `webpack.config.js` 的 `DefinePlugin` 把 `process.env.ALLOW_SITE_IN_QUERY` 定義成 `'yes'`，或由環境變數帶入）。

> 安全面：開了之後任何人可用 `?site=` 連任意站台。本服務本就是公開 PTT 前端，風險低，但要知道有這開放面。

### ② 直連書籤

部署後用此 URL 開站（把 `<PAGES_URL>` 換成你的部署網址）：

```
https://<PAGES_URL>/?site=wsstelnet://ws.ptt.cc/bbs
```

裝了擴充 + 帶這個 `?site=` → 瀏覽器直連 PTT，延遲 ≈ local。

---

## 驗證

1. 裝擴充、開 `.../?site=wsstelnet://ws.ptt.cc/bbs`，能正常連上 PTT（沒被 Origin 白名單擋）= 擴充生效。
2. DevTools → Network → WS，看連線是 `wss://ws.ptt.cc/bbs`。
3. 主觀：打字回顯應與 local 一樣即時。

## Fallback：`declarativeNetRequest` 改不動 Origin 時

少數 Chrome 版本可能擋 `Origin` 的 modifyHeaders。改用 `webRequest` + `onBeforeSendHeaders`（CORS 類擴充常用、較老牌）：manifest 改 MV2 或 MV3 service worker 內監聽 `chrome.webRequest.onBeforeSendHeaders`（含 `extraHeaders`/`requestHeaders`），對 `wss://ws.ptt.cc/*` 把 `Origin` 設為 `https://term.ptt.cc`。原理同，只是攔截點不同。

## 相關檔案 pointer

- 連線 URL / scheme 解析：`src/js/pttchrome.js:172,199`（`wsstelnet`→`wss:443`）
- 站台來源優先序 / `?site=` 覆寫：`src/js/main.js:26-27`
- build flag 注入（`DEFAULT_SITE` / `ALLOW_SITE_IN_QUERY`）：`webpack.config.js`（`DefinePlugin`）
- Origin 白名單根本約束：`pttchrome-research.md` §「Origin 白名單」
