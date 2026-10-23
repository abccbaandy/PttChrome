# 更新後的新功能小卡＋快捷鍵一覽

## 新功能小卡（`src/js/whats_new.js`、`src/components/WhatsNew/`）

pref `showWhatsNew`，預設開。只改顯示、不送任何鍵 ⇒ 不在安全模式名單內。

- **清單的唯一來源是 README「## ✨ 功能特色」的條目**（`- **名稱** — 說明`）。README 本來就規定每個新功能要寫一條（`tests/unit/readme_features.test.js`），不另維護一份清單。README 以 `?raw` 動態 import，拆成獨立 chunk，只在主功能表第一次出現時才載。
- **「新」＝名稱沒出現在上次記下的清單裡**（localStorage `pttchrome.whatsNew.seen.v1`，不上雲）。同一功能的延伸改進照 README 規範是改寫原條目、名稱不變 ⇒ 不會被當成新功能。**改既有條目的名稱會讓它被當成新功能再列一次**，改名前想一下。
- **第一次用（沒有紀錄：新使用者、清過資料、換裝置、無痕視窗）⇒ 默默記下整份清單、不顯示**：對他們來說每個功能都是新的，一次列幾十條沒意義。
- 卡片出現當下就記下（不必按 ✕），同一批只出現一次。每頁只比對一次。
- 只在主功能表（標題列 `rowHasTitle(row0, MAIN_MENU)`）出現，離開主功能表就收起；README 還在載的時候離開了 ⇒ 這次不顯示（已記下，寧可漏看也不蓋到別的畫面）。
- 不是 modal：不呼叫 `setModalOpen`，mousedown preventDefault 不搶 `#t` 焦點，打字照常送 PTT。滑鼠／滾輪由 `App._onUploadLayer`（`isWhatsNewTarget`）放過。
- 位置：右下角，z-index 145（高於首頁儀表板 140、低於 App Bar 150）；手機讓開底部工具列。
- e2e 不受影響：每個 e2e 都是全新 localStorage ⇒ 第一次用 ⇒ 不顯示。

## 快捷鍵一覽（`src/js/shortcut_list.js`，設定頁「快捷鍵」分頁）

- 只列本站自己加的鍵（PTT 的鍵看 `h` 說明）。可自訂的鍵讀目前設定值；功能開關關掉的不列。
- **新增可自訂快捷鍵**（pref 名稱 `*Key`、預設值是 F 鍵）時要補進 `CUSTOM_KEY_PREFS` 與 `shortcutList`，`tests/unit/shortcut_list.test.js` 會掃 `DEFAULT_PREFS` 守。

守護：`tests/unit/whats_new.test.jsx`、`tests/unit/shortcut_list.test.js`。
