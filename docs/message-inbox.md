# 水球收件匣（`message_inbox.js`）

動 `message_inbox.js`、`components/MessageInbox` 或 `App.onData` 的水球解析前先讀。

## 是什麼

這次連線收到的水球與系統廣播留在一份清單裡。還沒收到任何一則時畫面上什麼都不多；收到後桌機右上角（手機在 App Bar 右端）出現鈴鐺，帶未讀數，點開列出寄件人、時間、內容（新的在前）。開關 `enableMessageInbox`（預設開）。

## 規則

- **一個 byte 都不送**：只看收到的資料，所以不在安全模式名單內。點鈴鐺、點清單都不是點終端機（mousedown preventDefault 不搶 `#t` 焦點；`App._onUploadLayer` 認 `#messageInbox`）。
- **認不出 ⇒ 不收**：格式同 `string_util.parseWaterball`（`WATERBALL_SCAN_RE`／`BROADCAST_SCAN_RE`，依據 mbbsd/kaede.c#outmsg 與 doupdate 的廣播列），畫面照原生顯示，收件匣只是多留一份。
- **每包都解析**：`App.onData` 每個 chunk 都餵 `noteData`；失焦通知（`enableNotifications`）那條照舊只在 `!appFocused` 時跑，兩者互不影響。
- **跨包接續**：WebSocket 會在任意位元組切塊。最後一則之後若有開頭標記（`ESC[1;33;46m`／`ESC[1;37;46m`／`ESC[24;`）但還沒有 `ESC[m` 收尾，就把 raw 從標記起留到下一包（最多 `CARRY_LIMIT`）。標記只用 ASCII 的 ESC 序列：b2u 不會吃掉或生出 ESC，raw 與轉碼後的字串裡找到的是同一個標記；★ 在 Big5 線路上是兩個 byte，不能當標記。
- **重畫去重**：^L 會把還在畫面上的水球列再送一次 ⇒ 跟最後一則同類、同人、同字且在 `REPAINT_WINDOW_MS` 內就不收。代價是十分鐘內有人連丟兩次一模一樣的字只留一則。
- **跟著連線走**：只放記憶體，`App.onClose` 清空（含沒收尾的半則）；不寫 localStorage、不上雲。最多 `INBOX_LIMIT` 則。pref 中途關掉 ⇒ 下一包資料進來時已收的一起收掉。
- **位置**：桌機 fixed 右上角，文章工具側欄展開時讓到它左邊（不蓋住收合鈕）；手機由 `MobileAppBar` 以 `inline` 渲染，浮動版不畫。z-index 160：低於 Mantine overlay（200）。

## 還沒做

點一則直接回覆（todo P8 的後半）：回覆走 pttbbs `wmsg.c` 的 ^R。水球模式不同時行為不同（`ofo_my_write` 的 ↑↓ 換人、`wmsg_handle_ctrl_r_default` 的連按 ^R），要先讀碼數出目標在名單的位置、送鍵後讀回覆提示確認對象，認不出就停手。

## 測試

unit：`message_inbox.test.js`（解析、跨包、去重、上限、斷線清空、pref）、`message_inbox_ui.test.jsx`（照 state 畫、不搶焦點、點外面收起、桌機／手機只畫一個、讓開側欄）。offline e2e：`message_inbox.offline.spec.js`（真 onData → 鈴鐺、真滑鼠點開不送鍵、點終端機收起、斷線清空、pref 關）。
