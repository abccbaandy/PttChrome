# e2e 剩餘的固定睡眠（offline 已收斂；剩 sleep-ok 候選＋in-page sleep＋live）

offline 的 `waitForTimeout` 已全數改成柵欄／輪詢，或標上 `sleep-ok:`（靜態守護
`tests/unit/e2e_no_bare_sleep.test.js`；替代品對照表在 `tests/e2e/README.md`「offline：`waitForTimeout`
一律要具名理由」）。驗證法：在 `helpers/replay.js#installReplay` 開頭暫時注入 CDP
`Emulation.setCPUThrottlingRate`（6～8 倍）＋ `--repeat-each` 新舊版對照，不要只看一般速度全綠。

## 1. sleep-ok 裡可再強化的（需要先在產品端加訊號）
- `bare-domain-link`×2、`url-fix-gray`×2：1500ms「沒有推論」觀察窗。缺 AI 推論鏈的 idle 訊號
  （`render/signature_task.js` 的任務沒對外狀態）。要拔掉：讓 screen 暴露 urlAi/fixAi 任務在途數。
- `pref_close_in_list`：400ms「關框後不轉移」。缺 ^L 回應→settle→ADOPT 的單一 idle 訊號。
- 存活型（`selection`×3、`pusher_highlight`×1）：需要「重繪已發生」的明確訊號再斷言選取仍在。

## 2. in-page `sleep()`（守護沒掃到：它掃的是 `waitForTimeout`）
`offline/easy-reading.offline.spec.js` 的 `page.evaluate` 內自寫 `sleep()`：
- ~317 `img.click(); await sleep(500)` 之後量 rect ＝第 1 類（sleep 後單次讀值肯定斷言），應改。
- ~741–764 卸載測試的 600／200／1500ms：混合觀察窗與等待，逐條判斷。
- ~311 收斂迴圈內的 30ms：輪詢間隔，可留。
做完後把 `e2e_no_bare_sleep` 擴到 in-page `sleep(`（或禁止在 evaluate 內自寫 sleep）。

## 3. live e2e（tests/e2e/*.spec.js、helpers/ptt.js，約 100 處）
未分類。限制：登入預算（每輪只登入一次）、PTT 維護／BOT 封鎖時不可重跑 ⇒ 無法用 `--repeat-each` 壓測驗證，
改動需在主目錄合回 dev 後統一跑一輪。`tools/record-cassette.spec.js` 是錄製工具，不是測試。

## 已知陷阱：列表 cassette 要先關列表好讀再餵
`enableEasyReadingList` 預設開。`replayListCassette` 之後才 `applyPrefs({enableEasyReadingList:false})` ＝與 start
step 的 settle 賽跑：輸了就 engage 送錨定 jump，`cchat-list-nav` 的 jump recv 沒有 Ctrl+L 全幅重繪 ⇒ footer 空白 ⇒
`pageState` 0。新 spec 一律先關再餵（範例 `offline/easy-reading-list.offline.spec.js`「原生列表：鍵盤游標底色」）。
