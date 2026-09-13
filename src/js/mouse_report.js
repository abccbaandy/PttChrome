// XTerm SGR 滑鼠回報（把滑鼠事件回報給 PTT server）。
//
// 純函式 ＋ 狀態容器，零 DOM、零網路。送出由 pttchrome.jsx 呼叫 view._send()。
//
// 刻意**不叫** locator.js：`locator` 在 DEC 語彙裡是 DECELR/DECLRP（另一種、更老的
// 定位機制），拿來命名 XTerm mouse tracking 會誤導下一個人。
//
// ── PTT server 端已驗證事實（vendored 3rd_script/pttbbs）─────────────────────
//   mbbsd/term.c:79-118   三種模式的實際字串：
//                           CLICK = ESC[?1003l ESC[?1000h ESC[?1006h
//                           DRAG  = ESC[?1003l ESC[?1002h ESC[?1006h
//                           TRACK = ESC[?1003h ESC[?1006h
//                           關閉  = ESC[?1000l ESC[?1002l ESC[?1003l ESC[?1006l
//   mbbsd/term.c:136      term_init() **無條件**呼叫 term_enable_mouse(CLICK)
//                         ⇒ 沒有 UF_MOUSE 的人（預設就是沒有）收到的是關閉四連
//                         ⇒ 每個 session 都會收到這些序列。
//   include/uflags.h:22   UF_MOUSE 預設關（mbbsd/user.c:452-455 的設定項）。
//   common/sys/vtkbd.c:299-326
//                         server 解析入站滑鼠**只認 SGR**（csi_prefix == '<'），
//                         而且**不看 UF_MOUSE** ⇒ 只要我們送，它一定當按鍵收。
//   include/vtkbd.h:130-131 / mbbsd/io.c:262
//                         KEY_MOUSE 目前**沒有任何消費者**；只有 release 被
//                         丟成 KEY_INCOMPLETE。
//   mbbsd/io.c:231-240    任何非 KEY_INCOMPLETE 的鍵都會更新 currutmp->lastact
//                         ⇒ 若實作 1003 motion 回報，使用者**永不 idle**。
//
// ── 由上面推出的三條設計決定（別「優化」掉）──────────────────────────────
//   1. pref `mouseServerReport` **預設 false**：PTT 端還沒有東西會用 KEY_MOUSE，
//      預設開等於拿我們自己那套滑鼠瀏覽去換一個 server 還不會用的按鍵。
//   2. **只實作 1000（click）+ 1006（SGR）**。1002/1003 記錄模式但**不送 motion**
//      （否則上面的 lastact 副作用讓使用者永不 idle）。
//   3. `sgr` **初值 false**：主機只開 1000 沒開 1006 時**不可以**送 SGR。
//      （參考實作 ptt-term 的 locator.js:22 把它初始化成 true，是錯的。）

// 我們會記錄的 tracking 模式。9（X10）/1001/1005/1015 刻意**不收也不記**：
// 它們是**別的 wire 格式**，記錄了卻不實作是最難查的不一致；而且 PTT 全 repo
// 只吐 1000/1002/1003/1006 這四個。
export const MOUSE_MODES = [1000, 1002, 1003];
export const MOUSE_SGR = 1006;

// SGR 按鍵編碼。
//   bit 0-1：0 左 / 1 中 / 2 右
//   bit 2  ：Shift(4)
//   bit 3  ：Alt / Meta(8)
//   bit 4  ：Ctrl(16)
//   64/65  ：滾輪上／下
// 對得起 vtkbd.c:314 的 `flags = btn_raw & (4|8|16)`。
export function sgrButtonCode(e) {
  const o = e || {};
  let cb;
  if (o.wheel === 'up') cb = 64;
  else if (o.wheel === 'down') cb = 65;
  else cb = Number(o.button) || 0;
  if (o.shiftKey) cb |= 4;
  if (o.altKey || o.metaKey) cb |= 8;
  if (o.ctrlKey) cb |= 16;
  return cb;
}

// 格子座標（0-based）→ 終端機座標（1-based），並夾在畫面範圍內。
// 夾住是必要的：clientToPos 在邊緣可能回傳 -1 或 cols，送出界座標 server 端會
// 算出負的 KEY_MOUSE 位置。
export function toOneBased(p) {
  const o = p || {};
  const cols = o.cols == null ? 80 : o.cols;
  const rows = o.rows == null ? 24 : o.rows;
  const clamp = (v, hi) => {
    const n = Math.floor(Number(v)) + 1;
    if (!isFinite(n) || n < 1) return 1;
    return n > hi ? hi : n;
  };
  return { col1: clamp(o.col, cols), row1: clamp(o.row, rows) };
}

// SGR 回報字串。press 以 'M' 結尾、release 以 'm' 結尾（vtkbd.c:320-325）。
export function encodeSgrMouse(p) {
  const o = p || {};
  return '\x1b[<' + o.cb + ';' + o.col1 + ';' + o.row1 + (o.release ? 'm' : 'M');
}

// 一次點擊要送的兩段（press + release）。
// **刻意合成一次送**：io.c:262 直接把 release 丟成 KEY_INCOMPLETE，server 不區分
// 先後；拆到 mousedown/mouseup 兩個 listener 會讓「拖曳選字」也送出 press。
export function encodeClick(p) {
  const o = p || {};
  const { col1, row1 } = toOneBased(o);
  const cb = sgrButtonCode(o);
  return (
    encodeSgrMouse({ cb: cb, col1: col1, row1: row1, release: false }) +
    encodeSgrMouse({ cb: cb, col1: col1, row1: row1, release: true })
  );
}

// 滾輪一格。xterm 的滾輪只有 press、沒有 release。
export function encodeWheel(p) {
  const o = p || {};
  const { col1, row1 } = toOneBased(o);
  return encodeSgrMouse({
    cb: sgrButtonCode(o),
    col1: col1,
    row1: row1,
    release: false
  });
}

// 主機宣告的滑鼠模式狀態（per-connection）。
export function MouseReportState() {
  this.trackingMode = 0; // 0 / 1000 / 1002 / 1003
  this.sgr = false; // 見檔頭決定 3：初值必須是 false
  this.enabled = false; // pref mouseServerReport
}

MouseReportState.prototype = {
  // 真的可以送 byte 嗎：使用者開了、主機開了 tracking、而且主機也開了 SGR。
  isActive: function() {
    return !!this.enabled && this.trackingMode > 0 && this.sgr;
  },

  handleDECSET: function(mode) {
    if (mode === MOUSE_SGR) {
      this.sgr = true;
      return;
    }
    if (MOUSE_MODES.indexOf(mode) >= 0) this.trackingMode = mode;
  },

  handleDECRST: function(mode) {
    if (mode === MOUSE_SGR) {
      // 主機關掉 SGR ⇒ **停止回報**，而不是退回 X10。
      // 理由：vtkbd.c:305 只在 csi_prefix == '<' 才認滑鼠 ⇒ X10 送給 PTT 是廢的；
      // 而繼續送 SGR 主機會回 KEY_UNKNOWN。兩條都沒有正確答案 ⇒ 唯一正確行為是
      // 不送。PTT 的關閉四連本來就含 ESC[?1006l，這條讓它變成雙保險。
      // （參考實作 ptt-term 的 locator.js:92-94 刻意讓這裡 no-op，是錯的。）
      this.sgr = false;
      return;
    }
    // **只有相符才清**：主機送 ESC[?1002l 時若當前是 1000，不可以把它關掉
    // （term.c 的 CLICK 模式第一件事就是送 ESC[?1003l）。
    if (this.trackingMode === mode) this.trackingMode = 0;
  },

  // 連線層級重設。**不動 enabled**（那是使用者偏好，不隨連線走）。
  reset: function() {
    this.trackingMode = 0;
    this.sgr = false;
  }
};
