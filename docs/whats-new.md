# 更新後的新功能介紹＋快捷鍵一覽

## 新功能介紹（`src/js/whats_new.js`、`src/components/HomeDashboard/` 的 WhatsNewSection、`src/components/WhatsNew/`）

pref `showWhatsNew`，預設開。只改顯示、不送任何鍵 ⇒ 不在安全模式名單內。

- **清單的唯一來源是 README「## ✨ 功能特色」的條目**（`- **名稱** — 說明`）。README 本來就規定每個新功能要寫一條（`tests/unit/readme_features.test.js`），不另維護一份清單。README 以 `?raw` 動態 import，拆成獨立 chunk，只在主功能表第一次出現時才載。
- **「新」＝名稱沒出現在上次記下的清單裡**（localStorage `pttchrome.whatsNew.seen.v1`，不上雲）。同一功能的延伸改進照 README 規範是改寫原條目、名稱不變 ⇒ 不會被當成新功能。**改既有條目的名稱會讓它被當成新功能再列一次**，改名前想一下。
- **第一次用（沒有紀錄：新使用者、清過資料、換裝置、無痕視窗）⇒ 默默記下整份清單、不顯示**：對他們來說每個功能都是新的，一次列幾十條沒意義。
- **畫在哪**：首頁儀表板開著（`homeDashboard.state.visible`）⇒ 儀表板最上面的「這次更新」區塊；儀表板沒開、或按了「原生主選單」⇒ 右下角小卡。兩邊讀同一個控制器狀態（`items`＝還沒按看過的新條目，`visible`＝現在在主功能表）。
- **按「知道了」（小卡是 ✕）才記成看過**（`acknowledge()`）。之前的版本「出現當下就記」，但首頁儀表板登入後約 0.9 秒就背景按 ^Z f 抓我的最愛，畫面離開主功能表 ⇒ 小卡實際上看不到就被記掉了。現在離開主功能表只是暫時藏起來（`visible:false`，`items` 留著），回主功能表又出現。每頁只比對一次（README 只載一次）。
- 設定關掉、故障隔離 ⇒ `dismiss()`：收起且這一頁不再出現，**不記成看過**。
- **每條的「⚙ 設定」**：`src/js/whats_new_settings.js#FEATURE_SETTING` 把 README 功能名稱對到設定搜尋索引的 key（pref 名稱、`ui:…`、`section:…`），按下去走跟指令面板一樣的 `prefJump`（開設定頁、切分頁、捲到那一項並高亮）；分頁是按下去時才動態載入索引查（儀表板開站必載，不能靜態 import `pref_search.js`，它會帶進兩份語系檔）。值是 null ＝沒有開關，不放按鈕。**README 加一條功能就要在表裡補一列**（`tests/unit/whats_new_settings.test.js` 掃真的 README 守，key 也要真的在索引裡）。
- 不是 modal：不呼叫 `setModalOpen`，mousedown preventDefault 不搶 `#t` 焦點，打字照常送 PTT。滑鼠／滾輪由 `App._onUploadLayer`（`isWhatsNewTarget`）放過。
- 小卡位置：右下角，z-index 145（高於首頁儀表板 140、低於 App Bar 150）；手機讓開底部工具列。
- e2e 不受影響：每個 e2e 都是全新 localStorage ⇒ 第一次用 ⇒ 不顯示。

## 快捷鍵一覽（`src/js/shortcut_list.js`，設定頁「快捷鍵」分頁）

- 只列本站自己加的鍵（PTT 的鍵看 `h` 說明）。可自訂的鍵讀目前設定值；功能開關關掉的不列。
- **新增可自訂快捷鍵**（pref 名稱 `*Key`、預設值是 F 鍵）時要補進 `CUSTOM_KEY_PREFS` 與 `shortcutList`，`tests/unit/shortcut_list.test.js` 會掃 `DEFAULT_PREFS` 守。

守護：`tests/unit/whats_new.test.jsx`、`tests/unit/whats_new_settings.test.js`、`tests/unit/shortcut_list.test.js`。
