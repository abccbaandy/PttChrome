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

## 下一步（A2 步驟 b）

`serialized_op_gate.js` 逐一列舉的 in-flight 旗標改成「向出口取得使用權」（帶提示文字與逾時），使用者輸入
要不要放行、prompt 是否開著都在出口判斷。閘門目前**都還在原呼叫點**，搬的時候一條一條來、每條跑 offline e2e，
`onFunctionKey` 的先後順序照原樣。
