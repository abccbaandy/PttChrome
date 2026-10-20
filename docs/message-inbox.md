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

## 回覆

- 只有**最新一位寄件人**（清單裡最新一則水球的人，廣播不算）的水球有「回覆」鈕。點了＝`view.sendKeyAsUser('r', { ctrlKey: true })`，跟使用者自己按 Ctrl+R 同一條路（含序列化閘門），清單收起，之後全是 PTT 原生的回覆畫面。
- 為什麼只有他：pttbbs `wmsg.c` 兩種水球模式第一下 ^R 都指向最新一位寄件人 —— 一般模式（`wmsg_handle_ctrl_r_default`，watermode −1）回 `swater[0]` 最後一則的寄件人；一對一模式（`UF_PAGER_OFO`，`ofo_my_write`）預設選 `swater[0]`。`swater_get_slot` 每收一則就把寄件人提到 `swater[0]`。
- 回別人要在原生畫面裡換人，鍵位依模式不同（一對一模式 ↑↓／^T^R；一般模式第二下 ^R 進 watermode 面板、Tab／^T 輪轉），收件匣不知道使用者是哪個模式 ⇒ 不代按。要做得先能從畫面認出模式與目前選中的人，認不出就停手。
- 一般模式第一下 ^R 會用 `outmsg` 把「★id 上一則內容」再畫一次（同水球格式）：那正是清單最新一則 ⇒ 被重畫去重擋掉，不會多收一則。
- 不經閱讀紀錄：`my_write`／`ofo_my_write` 前後是 `scr_dump`／`scr_restore`，回覆完原畫面原樣回來，使用者的位置沒變。

## 測試

unit：`message_inbox.test.js`（解析、跨包、去重、上限、斷線清空、pref）、`message_inbox_ui.test.jsx`（照 state 畫、不搶焦點、點外面收起、桌機／手機只畫一個、讓開側欄）。offline e2e：`message_inbox.offline.spec.js`（真 onData → 鈴鐺、真滑鼠點開不送鍵、點終端機收起、斷線清空、pref 關）。
