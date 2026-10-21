# 水球收件匣（`message_inbox.js`）

動 `message_inbox.js`、`components/MessageInbox` 或 `App.onData` 的水球解析前先讀。

## 是什麼

這次連線收到的水球、系統廣播與新信提示留在一份清單裡。還沒收到任何一則時畫面上什麼都不多；收到後桌機右上角（手機在 App Bar 右端）出現鈴鐺，帶未讀數，點開列出寄件人、時間、內容（新的在前）。開關 `enableMessageInbox`（預設開）。

## 規則

- **一個 byte 都不送**：只看收到的資料，所以不在安全模式名單內。點鈴鐺、點清單都不是點終端機（mousedown preventDefault 不搶 `#t` 焦點；`App._onUploadLayer` 認 `#messageInbox`）。
- **認不出 ⇒ 不收**：格式同 `string_util.parseWaterball`（`WATERBALL_SCAN_RE`／`BROADCAST_SCAN_RE`，依據 mbbsd/kaede.c#outmsg 與 doupdate 的廣播列），畫面照原生顯示，收件匣只是多留一份。
- **每包都解析**：`App.onData` 每個 chunk 都餵 `noteData`；失焦通知（`enableNotifications`）那條照舊只在 `!appFocused` 時跑，兩者互不影響。
- **跨包接續**：WebSocket 會在任意位元組切塊。最後一則之後若有開頭標記（`ESC[1;33;46m`／`ESC[1;37;46m`／`ESC[24;`）但還沒有 `ESC[m` 收尾，就把 raw 從標記起留到下一包（最多 `CARRY_LIMIT`）。標記只用 ASCII 的 ESC 序列：b2u 不會吃掉或生出 ESC，raw 與轉碼後的字串裡找到的是同一個標記；★ 在 Big5 線路上是兩個 byte，不能當標記。
- **重畫去重**：^L 會把還在畫面上的水球列再送一次 ⇒ 跟最後一則同類、同人、同字且在 `REPAINT_WINDOW_MS` 內就不收。代價是十分鐘內有人連丟兩次一模一樣的字只留一則。
- **跟著連線走**：只放記憶體，`App.onClose` 清空（含沒收尾的半則）；不寫 localStorage、不上雲。最多 `INBOX_LIMIT` 則。pref 中途關掉 ⇒ 下一包資料進來時已收的一起收掉。
- **位置**：桌機 fixed 右上角，文章工具側欄展開時讓到它左邊（不蓋住收合鈕）；手機由 `MobileAppBar` 以 `inline` 渲染，浮動版不畫。z-index 160：低於 Mantine overlay（200）。

## 新信提示

- 依據：`mbbsd/menu.c#redraw_title` 在 `ISNEWMAIL` 時把標題列中段換成「你有新信件」（主選單、看板列表、文章列表共用這條標題列；手機 App Bar 的新信點也讀它，`mobile_app_bar.NEW_MAIL_MARK`）。
- 收法：`screenSettled` 只讀 row 0（`noteScreen`）。row 0 認得出是標題列（`【X】`或看板標題）、且不是文章時才更新「有沒有新信」；文章、prompt、編輯器這類沒有標題列的畫面不動狀態（看不到不代表沒有新信）。由無變有時收一則（`kind: 'mail'`，寄件人欄寫「信箱」，沒有回覆鈕），一直亮著不重收；看得出提示消失（讀完信）才重新武裝，再來一封會再收一則。登入時就有新信 ⇒ 第一個看得到標題列的畫面收一則。斷線清空時一起歸零。
- 一個 byte 都不送：不幫使用者開信箱（那要送 Ctrl+Z m，畫面會被換掉）。

## 回覆

- 每一則水球都有「回覆」鈕（廣播、新信提示沒有）。送的都是 `view.sendKeyAsUser('r', { ctrlKey: true })`，跟使用者自己按 Ctrl+R 同一條路（含序列化閘門），清單收起，之後全是 PTT 原生的回覆畫面。
- **最新一位寄件人**（清單裡最新一則水球的人，廣播不算）：只按一下。pttbbs `wmsg.c` 兩種水球模式第一下 ^R 都指向他 —— 一般模式（`wmsg_handle_ctrl_r_default`，watermode −1）回 `swater[0]` 最後一則的寄件人；一對一模式（`UF_PAGER_OFO`，`ofo_my_write`）預設選 `swater[0]`。`swater_get_slot` 每收一則就把寄件人提到 `swater[0]`。
- **其他寄件人**（`waterball_reply.js`）：按第一下後，每次畫面停下都認一次畫面，沒對上就再按一下 ^R —— 兩種模式換人都是 ^R：
  - 一對一模式：row 0 `丟<id>:`（`PROMPT_OFO`）＋row 1「↑反擊對象↓」名單（`ofo_init_screen`，最多 5 人）；^R＝`ofo_switch_user(1)`，row 0 換成下一位。
  - 一般模式：第一下 row 0 `訊息傳過去: `（`PROMPT_TO`）；再按 ^R 在 row 1 畫「訊息回顧」面板（`wmsg_show_panel_new`），row 3 起最近 `MAX_REVIEW`=7 則，選中那則行首 `>`＋寄件人；每按一下往舊的選一則，送出時對象是選中那則的寄件人（`my_write_get_input` 的 watermode > 0 分支）。
  - 對上就停手，交給使用者打字。**認不出 ⇒ 不送鍵**：等下一次畫面停下（按第一下時好讀切原生鏡像會先停一次舊畫面），3 秒內一直認不出就收手（小天使提示等）；換滿 8 下還沒對上（對方不在名單、超過回顧則數）也收手。收手時使用者停在 PTT 原生回覆畫面，可以自己換人或 ← 取消。
- 一般模式第一下 ^R 會用 `outmsg` 把「★id 上一則內容」再畫一次（同水球格式）：那正是清單最新一則 ⇒ 被重畫去重擋掉，不會多收一則。
- 不經閱讀紀錄：`my_write`／`ofo_my_write` 前後是 `scr_dump`／`scr_restore`，回覆完原畫面原樣回來，使用者的位置沒變。

## 測試

unit：`waterball_reply.test.js`（兩種模式的畫面認法、換人、認不出等待／逾時、換滿收手）、`message_inbox.test.js`（解析、跨包、去重、上限、斷線清空、pref、新信提示的認法與由無變有）、`message_inbox_ui.test.jsx`（照 state 畫、不搶焦點、點外面收起、桌機／手機只畫一個、讓開側欄、新信那則的寫法）。offline e2e：`message_inbox.offline.spec.js`（真 onData → 鈴鐺、真滑鼠點開不送鍵、點終端機收起、斷線清空、pref 關）。
