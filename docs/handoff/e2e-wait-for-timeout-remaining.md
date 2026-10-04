# e2e 剩餘的固定睡眠（offline 已清完；剩 live）

offline 的固定時間等待已全數改成柵欄／輪詢／假時鐘；剩下的 `sleep-ok:` 只有按鍵節奏
（`easy-reading-list`）與刻意抽樣中間態（`image_load_conditions`），屬合法豁免。靜態守護
`tests/unit/e2e_no_bare_sleep.test.js`；替代品對照表在 `tests/e2e/README.md`「offline：`waitForTimeout`
一律要具名理由」。驗證法：在 `helpers/replay.js#installReplay` 開頭暫時注入 CDP
`Emulation.setCPUThrottlingRate`（6～8 倍）＋ `--repeat-each` 新舊版對照，並做一次突變（把被守的
修法退回）確認新柵欄會紅。

## live e2e（tests/e2e/*.spec.js、helpers/ptt.js，約 100 處）
未分類。限制：登入預算（每輪只登入一次）、PTT 維護／BOT 封鎖時不可重跑 ⇒ 無法用 `--repeat-each` 壓測驗證，
改動需在主目錄合回 dev 後統一跑一輪。`tools/record-cassette.spec.js` 是錄製工具，不是測試。
offline 的替代品（`waitClickSettled`、`aiTaskStats`、`page.clock`）多半可直接沿用。

## 已知陷阱：列表 cassette 要先關列表好讀再餵
`enableEasyReadingList` 預設開。`replayListCassette` 之後才 `applyPrefs({enableEasyReadingList:false})` ＝與 start
step 的 settle 賽跑：輸了就 engage 送錨定 jump，`cchat-list-nav` 的 jump recv 沒有 Ctrl+L 全幅重繪 ⇒ footer 空白 ⇒
`pageState` 0。新 spec 一律先關再餵（範例 `offline/easy-reading-list.offline.spec.js`「原生列表：鍵盤游標底色」）。
