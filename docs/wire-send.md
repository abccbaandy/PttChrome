# 送給 PTT 的唯一出口（`src/js/wire_send.js`）

新增任何會送 byte 給 PTT 的入口（按鍵、滑鼠、浮層按鈕、機器序列）前先讀。

## 規則

- **所有上線的 byte 都經過 `wire_send.js`**。傳輸層（`telnet.js`、`websocket.js`、`ssh/`）以外不准直接叫
  `conn.send`／`convSend`／`sendUserKey`／`convSendUserKey`／`sendNaws`／`sendWillNaws`／`sendTimingMark`。
  守護 `tests/unit/wire_send.test.js`（靜態掃整個 `src`）。
- **機器送出要說明身分**：`sendBytes(source, conn, bytes)`／`sendText(source, conn, text)`，`source` 取自
  `WIRE_SOURCE`；不認得就丟。新入口先在 `WIRE_SOURCE` 加一個身分（守護也要求每個身分都有人用）。
- **兩種變體的界線是入口不是內容**：機器用 `sendBytes`／`sendText`（懸空 ESC 一律化解）；真鍵盤／IME 用
  `sendUserKey`／`sendUserText`，只有 `term_view._send`／`_convSend` 能叫（推導見 `vtkbd_send_state.js` 檔頭，
  守護 `tests/unit/user_key_send_wiring.test.js`）。
- **conn 由呼叫端傳**：`term_view.conn` 只在 `onConnect` 更新、CPR／NAWS 綁的是觸發它的那條連線，跟 `App.conn`
  不一定同一個。照原樣傳才不會改到送往哪條連線。

## 現在的身分

| `WIRE_SOURCE` | 呼叫點 | 自己的閘門 |
|---|---|---|
| `QUEUE` | `App` 的 `CommandQueue.send` | 連線中才送 |
| `MACHINE` | `App.sendMachineBytes`（好讀自動翻頁、整頁重繪） | 連線中才送，回傳有沒有上線 |
| `APP_TEXT` | `App.sendData` | `connectState == 1` |
| `BBS_CMD` | `App.setBBSCmd`（滑鼠、滾輪、手勢） | 上游 `_mouseSendBlocked`、prompt 判斷 |
| `INPUT_HELPER` | 輸入小幫手的色碼／文字（`ContextMenu/index.jsx`） | `inputHelperBlocked` |
| `CPR` | UTF-8 線路偵測的游標位置回應 | 只回應目前這條連線 |

不帶身分的：`sendUserKey`／`sendUserText`（真鍵盤）、`sendWindowSize`（NAWS）、`sendKeepAliveProbe`
（TIMING-MARK，在 server 的 telnet 層就被吃掉、不是按鍵）。

## 線路使用權（`src/js/wire_lease.js`）

替使用者送**多步序列**的功能（搜尋、重新整理、跳到第一篇未讀、設為已讀、原生列表稍後再讀、首頁抓我的最愛），
序列跑完前要佔住線路：期間使用者的鍵一律吞掉＋提示（`serialized_op_gate.serializedOpHint`），不然中間插進來的
byte 會被 PTT 的 typeahead 吃掉或打進 prompt。

- **功能自己帶提示字來拿**：`beginInFlight(core, OWNER, HINT)`／`submitSerializedSteps(core, steps, { flag, hint })`
  （`article_search.js`，底下是 `acquireWire`／`releaseWire`）。閘門只問「現在有沒有人拿著」，**新功能不必回來改閘門**。
  帶 owner 就要帶提示字；逾時（15 秒）自動放掉，防收尾漏掉造成永久吞鍵。
- `core[owner]`（舊的 `xxxInFlight` 欄位名）仍鏡像成 true／false 給只讀它的人（`search_status`、e2e 的
  `__app.searchInFlight === false`）。**寫它只准經 `wire_lease`**。
- 守護 `tests/unit/wire_lease.test.js`：閘門不准再列舉 `InFlight`、鏡像欄位不准別處寫、帶 owner 必帶提示字、
  各功能提示字與搬家前一字不差。

### 自己有 session 的序列（`holdWireWhile`）

AID 跳文、長推文、登出、略過進板畫面的「佔著線路」由 session 自己的狀態決定（`active`／`busy`），狀態轉換散在
十幾條收尾路徑上 ⇒ 不走 acquire／release（漏一條就永久吞鍵），而是**建構時登記一次「怎麼問我」**
（`holdWireWhile(core, owner, hintOf)`），閘門每次現算。`hintOf` 是各 session 模組 export 的
`xxxWireHint(session)`（長推文看 `active` 不看 `busy`：armed 時使用者在打字；略過進板只看 `busy`：arm 等待期不擋）。

- 名次固定在 `SESSION_WIRE_RANK`（AID → 長推文 → 登出 → 略過進板），排在 `acquireWire` 的使用權前面；沒有名次的 owner 直接丟。
- `serialized_op_gate` 不准再認識任何功能（靜態守護 `wire_lease.test.js`）。
- 測試的假 session（`{ aidNavigation: { active: true } }`）沒跑建構子：用 `tests/unit/helpers/session_wire.js#wireFakeSessions(core)` 代登記。

## 還沒搬的（A2 步驟 c 之後）

- `board_search_bridge.submit`（搜尋彈窗在背景 `s` prompt 已開著時送出）不問閘門。不能只加一道「忙就回 false」：
  回 false 後呼叫端改走 `submitSearch`，它會因 prompt 開著拒絕，背景 prompt 就沒人收（橋接沒 cancel）；在別人拿著線路時
  送 Ctrl-C 收掉也一樣是插鍵。現在靠「開彈窗時問過＋modal 擋鍵＋`submitSerializedSteps` 在 prompt 開著時不送」沒事；
  要收得先決定「忙的時候背景 prompt 誰收、何時收」。
- `commandQueue.inFlightKind` 那道在 `App.onFunctionKey` 裡排在 `functionKeyClickPlan` 之後，位置本身有語意，照原樣。
- 「使用者輸入要不要放行、prompt 是否開著」還在各入口判斷，還沒收進出口。
