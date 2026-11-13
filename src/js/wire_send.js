// 送給 PTT 的唯一出口（架構 review A2 步驟 a，docs/wire-send.md）。
//
// 所有上線的 byte 都經過這裡：呼叫端不准直接碰 `conn.send`／`convSend`／`sendUserKey`／
// `convSendUserKey`／`sendNaws`／`sendWillNaws`／`sendTimingMark`（守護
// tests/unit/wire_send.test.js，靜態掃整個 src）。這一步**行為不變**：每支函式就是原本那一行
// `conn.xxx(...)`，閘門（prompt 開著不送、列表 cursor-sync、serializedOpHint…）全部留在原呼叫點。
// 步驟 b 再把「線路上有沒有別人在跑」的使用權收進來，所以現在先要求每次送出說明身分。
//
// 兩種變體的界線是**入口**不是位元組內容（推導見 vtkbd_send_state.js 檔頭）：
//   sendBytes／sendText          機器送出：懸空的 ESC 態一律化解
//   sendUserKey／sendUserText    真鍵盤／IME：保留 ESC 組合鍵，只有 term_view._send／_convSend 能叫
//
// conn 由呼叫端傳入（不從 App 取）：term_view 的 conn 只在 onConnect 更新、CPR／NAWS 綁的是
// 觸發它的那條連線，跟 App.conn 不一定同一個；照原樣傳才不會改到送往哪條連線。
// conn 是 undefined 時跟原本一樣直接丟例外（呼叫端各自先檢查，這裡不默默吞掉）。

// 送出身分（步驟 b 的使用權會以它為準）。新增送鍵入口就在這裡加一個。
export const WIRE_SOURCE = Object.freeze({
  QUEUE: 'queue', // CommandQueue（列表好讀、長推文、AID 跳文…的序列化指令）
  MACHINE: 'machine', // App.sendMachineBytes（好讀自動翻頁、整頁重繪）
  APP_TEXT: 'appText', // App.sendData（設定頁、選單送的文字）
  BBS_CMD: 'bbsCmd', // App.setBBSCmd（滑鼠、滾輪、手勢的方向鍵／翻頁／Enter）
  INPUT_HELPER: 'inputHelper', // 輸入小幫手（色碼、文字）
  CPR: 'cpr', // 回應 server 的游標位置查詢（UTF-8 線路偵測）
});

const KNOWN = new Set(Object.values(WIRE_SOURCE));

function checkSource(source) {
  if (!KNOWN.has(source)) throw new TypeError('wire_send: unknown source ' + String(source));
}

// 機器 byte（Big5／控制序列原樣）。
export function sendBytes(source, conn, bytes) {
  checkSource(source);
  conn.send(bytes);
}

// 機器文字（Unicode，conn 轉線路編碼）。
export function sendText(source, conn, text) {
  checkSource(source);
  conn.convSend(text);
}

// 真鍵盤／IME 的 byte。只有 term_view._send 可以叫。
export function sendUserKey(conn, bytes) {
  conn.sendUserKey(bytes);
}

// 真鍵盤／IME 的文字。只有 term_view._convSend 可以叫。
export function sendUserText(conn, text) {
  conn.convSendUserKey(text);
}

// 視窗大小（telnet NAWS）。will＝先宣告 WILL NAWS（回應 server 的 DO NAWS）。
export function sendWindowSize(conn, cols, rows, { will = false } = {}) {
  if (will) conn.sendWillNaws();
  conn.sendNaws(cols, rows);
}

// 連線保持探針（IAC DO TIMING-MARK，在 server 的 telnet 層就被吃掉、不是按鍵）。
export function sendKeepAliveProbe(conn) {
  conn.sendTimingMark();
}
