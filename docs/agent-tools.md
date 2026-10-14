# AI agent 工具

目標：agent 不懂 PTT 也能完成「八卦版最新文章總結」這類指令。工具定義唯一來源 `src/js/agent_tools.js#createAgentTools`，兩種傳輸共用：

| 傳輸 | 入口 | 狀態 |
|---|---|---|
| CDP | `window.pttAgent.list()`／`.call(name, args)`（回 Promise），任何標準 CDP client 以 `Runtime.evaluate`（`awaitPromise`、`returnByValue`）呼叫 | CONFIRMED 2026-10 live（使用者主瀏覽器＋自動登入） |
| WebMCP | `document.modelContext.registerTool`（舊名 `navigator.modelContext` 也認） | guess：Chrome origin trial，API 仍可能變；沒有就不註冊 |

正式版與 dev 都會掛（`main.jsx` 開站就呼叫 `installAgentTools`）。發現提示：`meta[name=ai-agent-tools]`＋`window.pttAgent.help`。**專案不附 CDP client**（前提＝不下載本專案、只用標準 CDP 工具就能操作）。

## 工具

| 工具 | 參數 | 回傳 | 實作 |
|---|---|---|---|
| `ptt_list_articles` | `board` | `{board, articles[] 由新到舊, pinned[]}`，每篇 `num/date/author/title/recommend/deleted/locked` | `aidNavigation.startBoard(board, {end:true})` → `agent_parse.listEntriesFromScreen` |
| `ptt_read_article` | `board`＋`num`／`aid` | `{author, board, title, time, content, comments[{type,user,content,ip,time}], aid, url, complete}` | `startNum`／`startExternal` → `collectArticle` → `agent_parse.parseArticleLines` |
| `ptt_read_screen` | — | 原生畫面列文字＋`page` 種類 | 低階逃生口 |
| `ptt_send_keys` | `keys`（`{Enter}` 等，`parseKeySpec`） | 送鍵後等一次 settle 的畫面 | 低階逃生口 |

只回一頁列表（約 20 篇）；更舊的頁、置底文開文（沒有編號，要用 aid）尚未支援。

## 不變量

- **高階工具不自己拼 PTT 按鍵**：一律走 `aid_navigation` 的序列化導航（逃生前導／板跳／進板畫面／跳號／開文，每步依畫面內容驗證）。新增跳法 = 在那邊加 run 的中段：`startBoard`（`_enqueueEnd` 落地＝`endLanded`）、`startNum`（`_enqueueNumJump` 落地＝`numJumpLanded`，同 list_session open-jump 指紋）。dir `goto` 不碰返回堆疊（成功 `invalidate`）。`onEnd({ok, error})` 每輪恰好呼叫一次（`_endRun`，成功點：`_finishGoto`／`_enqueueOpen.onDone`；失敗點：`_fail`）。
- 讀全文兩條路互斥：好讀 pref 開著 ⇒ 等 `easyReadingReachedPageEnd` 且 `buf.pageLines` 連續 3 次不再長（好讀自己會翻完整篇）；沒開 ⇒ 原生 pmore 自己 PgDn 到 `pagePercent 100`，`findPageOverlap` 去重。不可兩邊同時送 PgDn。
- 未登入（這條連線沒看過主功能表）一律拒絕：逃生前導的 ← 與板名會被打進登入畫面帳號欄。不提供登入工具（登入頻率限制／BOT 封鎖，見 `CLAUDE.md`「測試」節）。
- `board` 只收 `[0-9A-Za-z_-]`：不把任意字串打進 PTT。
- `serializedOpHint(core)` 非 null 或未連線 ⇒ 拒絕，一個 byte 都不送。
- **背景分頁（`document.hidden`）一律拒絕**（`HIDDEN_TAB_ERROR`）：Chrome 把背景分頁的 setTimeout 節流到 ≥1s（藏 5 分鐘後 1 分鐘），term_buf settle 與 CommandQueue 逾時／探針全靠計時器 ⇒ 逾時先於 settle，每步誤判。CONFIRMED live：背景分頁 End 落地了仍逾時、進板畫面逾時；切前景後同流程 list 0.16s、read 0.55s。agent 端用 `Page.bringToFront`。
- 送鍵（低階）走 `view._send`／`_convSend`（使用者來源），不走 `sendMachineBytes`。

## 連線注意

- 使用者主瀏覽器用 chrome://inspect 開的遠端偵錯：`/json/*` HTTP 端點不存在（404），只能讀 `User Data/DevToolsActivePort` 拿 browser-level ws，再 `Target.attachToTarget(flatten)`；每條新 ws 會跳「允許遠端偵錯」提示（常駐一條轉發連線即可只按一次）。
- `--remote-debugging-port` 啟動的 Chrome 136+ 不准用預設 profile ⇒ 專用 profile 沒有使用者存的密碼，要自己登入一次。
- 頁面開著時改 `src/` 會觸發 Vite 重載 ⇒ 自動登入再登一次（同 live e2e 規則）。

## 待辦

- 列表翻頁（更舊的文章）、置底文開文。
- 寫入類（推文、發文）要使用者確認；送鍵節流。
- 設定頁開關（目前恆開）。
