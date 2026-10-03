# e2e 剩餘的固定睡眠（offline 已收斂；剩 sleep-ok 候選＋live）

offline 的固定時間等待（`waitForTimeout`、evaluate 內自包的 `setTimeout` Promise、自訂 `sleep` 定義）已全數改成
柵欄／輪詢，或標上 `sleep-ok:`（靜態守護 `tests/unit/e2e_no_bare_sleep.test.js`；替代品對照表在
`tests/e2e/README.md`「offline：`waitForTimeout` 一律要具名理由」）。驗證法：在 `helpers/replay.js#installReplay`
開頭暫時注入 CDP `Emulation.setCPUThrottlingRate`（6～8 倍）＋ `--repeat-each` 新舊版對照，不要只看一般速度全綠。

## 1. sleep-ok 裡可再強化的（需要先在產品端加訊號）
- `bare-domain-link`×2、`url-fix-gray`×2：1500ms「沒有推論」觀察窗。缺 AI 推論鏈的 idle 訊號
  （`render/signature_task.js` 的任務沒對外狀態）。要拔掉：讓 screen 暴露 urlAi/fixAi 任務在途數。
- `pref_close_in_list`：400ms「關框後不轉移」。缺 ^L 回應→settle→ADOPT 的單一 idle 訊號。
- 存活型（`selection`×3、`pusher_highlight`×1）：需要「重繪已發生」的明確訊號再斷言選取仍在。
- `blink_cursor`×2：閃爍是時間語意，牆鐘取樣合理；要更硬可改 `page.clock` 快轉 `timerEverySec`。

## 2. 發現但未處理：「點圖縮小後仍在視野內（捲動錨定）」量不到位移
`offline/easy-reading.offline.spec.js`「点图缩小后被点的图仍在视野内」三卷素材 before／after 的 `scrollTop`、`rel`
**完全相同**（舊版 sleep 寫法也一樣，非本次改壞）⇒ 位移恆 0、斷言恆綠，錨定邏輯沒被驗到。

根因（probe 實測，guess→高可信）：**整頁同時只掛得上一張圖**。逐一把 stock-end 的 11 個 slot 捲到中央、
`waitPreviewsSettled` 後，已掛載的 `img.hyperLinkPreview` 永遠只有視野內那一張；相距約 900px 的鄰居既不預載
（應在 `LAZY_MOUNT_MARGIN_PX`=1500 內）也立刻被卸掉（應在 `LAZY_UNMOUNT_MARGIN_PX`=6000 內）。
`render/inline_preview_slot.js#ensureObservers` 的兩個 IntersectionObserver **沒給 root**（隱式 root＝viewport），
而 slot 在捲動容器 `.main` 裡：規格上 rootMargin 只擴 root，祖先捲動容器的裁切照算 ⇒ 兩個 margin 實際≈0
（預載與遲滯都失效：捲到才開始載、捲出就卸，往回捲重新下載／解碼）。修法候選：`root: .main`（注意 `.main`
有 transform scale、且 observer 是 module 級共用、`.main` 可能重建）。產品 bug ⇒ 先寫會紅的 e2e（例：捲到某 slot
中央後，鄰近 <1500px 的 slot 必須已掛載）再修；修完這條錨定測試才量得到位移，屆時補「before/after scrollTop 必須有變」的前提斷言。

## 3. live e2e（tests/e2e/*.spec.js、helpers/ptt.js，約 100 處）
未分類。限制：登入預算（每輪只登入一次）、PTT 維護／BOT 封鎖時不可重跑 ⇒ 無法用 `--repeat-each` 壓測驗證，
改動需在主目錄合回 dev 後統一跑一輪。`tools/record-cassette.spec.js` 是錄製工具，不是測試。

## 已知陷阱：列表 cassette 要先關列表好讀再餵
`enableEasyReadingList` 預設開。`replayListCassette` 之後才 `applyPrefs({enableEasyReadingList:false})` ＝與 start
step 的 settle 賽跑：輸了就 engage 送錨定 jump，`cchat-list-nav` 的 jump recv 沒有 Ctrl+L 全幅重繪 ⇒ footer 空白 ⇒
`pageState` 0。新 spec 一律先關再餵（範例 `offline/easy-reading-list.offline.spec.js`「原生列表：鍵盤游標底色」）。
