# e2e 剩餘的 waitForTimeout（第 2～4 類＋live）

背景：offline e2e 的「sleep 後單次讀值做肯定斷言」（第 1 類）已全數改掉（2026-10）。改法與共用 helper：
- 餵畫面後 → `helpers/replay.js#waitScreenSettled(page, rows?)`（notify＋settle 都清空）
- 動作後讀值 → `expect.poll` ／多條斷言包 `expect(async () => {…}).toPass()`
- 送出記錄 → `helpers/capture.js`（`peekCapture` 可輪詢；`takeCapture` 會清空，不可 poll）
- hover 後 → `helpers/real_input.js#nextFrames`（mousemove 是 rAF 對齊派發）
- 驗證法：在 `installReplay` 開頭暫時注入 CDP `Emulation.setCPUThrottlingRate`（6～8 倍）＋ `--repeat-each` 新舊版對照；不要只看一般速度全綠。

本檔＝刻意沒改的部分，後續 session 決定要不要動。每一類先決定策略再批次做。

## 第 2 類：sleep 後只做否定斷言（證明「沒發生」）
不會偶發紅，但可能假綠（慢機器上「還沒發生」也通過）。強化法：在後面補一個必定會發生的事件當柵欄，等它到了再斷言前面沒多送。
- `offline/alt_ctrl_keys.offline.spec.js`：非字母 Alt、Alt+Shift（`toBe('')`）
- `offline/aid_back_ui.offline.spec.js`：onPasteDone 後 `__sent` 為空
- `offline/mouse.offline.spec.js`：deep link 點擊不翻頁、左鍵關閉不送 ←、總開關關閉 `exercise()`
- `offline/mouse_report.offline.spec.js`：三處 `not.toContain('\x1b[<')`、右鍵不回報
- `offline/screen_dismiss.offline.spec.js`：四處 `toBe('')`＋「輸入欄畫面沒有按鈕」
- `offline/function_keys.offline.spec.js`：括號不可點 `toBe('')`
- `offline/long_push.offline.spec.js`：IME／貼上不漏送、關框後 `__termKeys` 為空
- `offline/easy-reading-list.offline.spec.js`：CapsLock/F2 死鍵、Shift+Insert 不送
- `offline/image_upload.offline.spec.js`：Ctrl+V 沒圖不攔
- `offline/harness.offline.spec.js`：console 轉送不產生 `__sent`
- `offline/ui_behavior.offline.spec.js`：`errors` 為空前的 50ms
- `offline/bare-domain-link.offline.spec.js`、`offline/url-fix-gray.offline.spec.js`：1500ms「若真有推論早該回來」
- `offline/pref_close_in_list.offline.spec.js`：關設定頁後狀態不轉移（混一條肯定的 `^L` 已送出，`sendMachineBytes` 同步，風險低）

## 存活型觀察窗（選取／高亮之後「沒被重繪打斷」）
改 poll 會變弱（選取立刻成立，poll 第一下就過）。若要強化，需要一個「重繪已發生」的明確訊號再斷言選取仍在。
- `offline/selection.offline.spec.js`：`dragSelect` 收尾、雙擊、三擊後各 150ms
- `offline/pusher_highlight.offline.spec.js`：雙擊推文列選字不被高亮重繪打斷

## 時間語意的處理法（第 4 類已完成，供第 2 類參考）
- 證明「沒排程」→ 開機後 `page.clock.install()` ＋ `runFor`，並在同一假時鐘下放一個對照組證明時鐘有接上（`offline/deep_link.offline.spec.js`「分頁已在前景」）。開機前裝會連 boot 鏈的 timer 一起凍住。
- 等某個 app 內 timer 到期 → `waitForFunction` 等該 timer 本身清空，不猜固定毫秒（`offline/mouse.offline.spec.js#clickAt` 等 `__app.dblclickTimer`）。

## 其他（非 sleep-as-wait）
- 輪詢迴圈內的間隔：`easy-reading-list` 與 `list_mark_read` 的 `waitState`（200ms）
- 按鍵節奏：`easy-reading-list` ArrowUp×3 間的 50ms（讀值已改 `waitState`）
- 後面緊接輪詢的多餘 sleep：`easy-reading-list` 的捲動後 300ms（接 `waitState`）、PgUp 後 300ms（接 `waitForFunction`）→ 可直接刪
- `offline/image_load_conditions.offline.spec.js:190`：慢圖情境刻意「不等 settle」的抽樣迴圈（每個捲動位置 500ms 看有沒有讀取中）

## live e2e（tests/e2e/*.spec.js、helpers/ptt.js，約 100 處）
未分類。限制：登入預算（每輪只登入一次）、PTT 維護／BOT 封鎖時不可重跑 ⇒ 無法用 `--repeat-each` 壓測驗證，改動需在主目錄合回 dev 後統一跑一輪。`tools/record-cassette.spec.js` 是錄製工具，不是測試。

## 已知陷阱：列表 cassette 要先關列表好讀再餵
`enableEasyReadingList` 預設開。`replayListCassette` 之後才 `applyPrefs({enableEasyReadingList:false})` ＝與 start step 的 settle 賽跑：輸了就 engage 送錨定 jump，`cchat-list-nav` 的 jump recv 沒有 Ctrl+L 全幅重繪 ⇒ footer 空白 ⇒ `pageState` 0。新 spec 一律先關再餵（範例 `offline/easy-reading-list.offline.spec.js`「原生列表：鍵盤游標底色」）。

## 防回歸（未做）
靜態守護：新增的 `waitForTimeout` 後面不准緊接單次讀值的肯定斷言（參考 `tests/unit/e2e_layout_settle.test.js` 的掃描手法）。
