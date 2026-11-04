// Live 文小幫手：PTT 官方推文實況（文章裡按 v，more.c#live_run）的操作面板背後的決策。
//
// 舊版小幫手自己輪詢：每 N 秒裸送 ←→End（離開文章、重開游標下那篇、跳文末）。沒有任何驗證，
// 開錯篇、推文型別選單上被當成選「推」的風險都有，還得先關掉好讀。PTT 有了官方實況之後，
// 新推文由 server 主動送上畫面，小幫手只剩「幫你按 v／q／B」，並把狀態列的事實顯示出來；
// 好讀照樣開著（推文由 term_view._accumulateLive 接在累積頁後面，見 docs/easy-reading.md「實況模式」）。
//
// 送的都是使用者在原生畫面上自己也會按的那一個鍵，而且只在本幀認得出來的畫面上送：
//   開始實況 v  pmore 文章頁（底列是 pmore 狀態列、游標不在輸入欄）＝pmore.c#pmore_cmd_live 綁的鍵
//   離開實況 q  實況畫面（底列是實況狀態列）＝live_run 唯一的離開鍵
//   鈴聲    B  實況畫面＝live_run 的 (B)鈴聲 切換
// 不在對的畫面一律不送（pageState 會黏住，不可以只看它，見 long_push_gate.atPagerStatusRow 的註解）。

import { parseStatusRow } from './string_util';
import { parseLiveStatusRow } from './live_mode';
import { serializedOpHint } from './serialized_op_gate';
import { isEasyReadingLive } from './easy_reading';

export const LIVE_START_KEY = 'v';
export const LIVE_LEAVE_KEY = 'q';
export const LIVE_BELL_KEY = 'B';

// 面板要顯示什麼（純函式）。
//   { kind: 'live', elapsedSec, received, canComment, bell }  實況中
//   { kind: 'ready' }        在 pmore 文章頁，可以開始
//   { kind: 'busy' }         線路上有序列化操作（AID 跳文／長推文）或指令在途
//   { kind: 'unavailable' }  不在文章裡（列表、選單、prompt…）
export function liveHelperView({ pageState, lastRowText, cursorOnInputField, busy }) {
  const live = parseLiveStatusRow(lastRowText);
  if (live) return Object.assign({ kind: busy ? 'busy' : 'live' }, live);
  if (busy) return { kind: 'busy' };
  if (pageState === 3 && parseStatusRow(lastRowText) && !cursorOnInputField) return { kind: 'ready' };
  return { kind: 'unavailable' };
}

// 從 App 讀本幀的事實。
export function liveHelperFacts(core) {
  const buf = core && core.buf;
  if (!buf) return { kind: 'unavailable' };
  const busy = !!(serializedOpHint(core) || (core.commandQueue && core.commandQueue.inFlightKind));
  return liveHelperView({
    pageState: buf.pageState,
    lastRowText: buf.getRowText(buf.rows - 1, 0, buf.cols),
    cursorOnInputField: typeof buf.isCursorOnInputField === 'function' && buf.isCursorOnInputField(),
    busy
  });
}

// 送鍵前先讓好讀切原生鏡像（同使用者自己按這個鍵，easy_reading._onKeyDownProcessUI／_onLiveKeyDown）：
//   v：實況服務連不上時是 vmsg 等按鍵，好讀的累積頁會把它蓋住；成功時 _evalFunctionModeExit 認出
//      實況狀態列就回好讀、捲到底。
//   q：回列表的那一幀要畫出來，由 settle 收尾。
function enterMirror(core) {
  const er = core.easyReading;
  if (er && er._enabled && er.startedEasyReading && typeof er._enterFunctionMode === 'function')
    er._enterFunctionMode();
}

function send(core, key) {
  if (core.view && typeof core.view._send === 'function') core.view._send(key);
}

// 三個動作：回 true ＝送出了；false ＝這一幀不是對的畫面，什麼都沒送。
export function startLive(core) {
  if (liveHelperFacts(core).kind !== 'ready') return false;
  enterMirror(core);
  send(core, LIVE_START_KEY);
  return true;
}

export function leaveLive(core) {
  if (liveHelperFacts(core).kind !== 'live') return false;
  if (isEasyReadingLive(core.easyReading)) enterMirror(core);
  send(core, LIVE_LEAVE_KEY);
  return true;
}

export function toggleLiveBell(core) {
  if (liveHelperFacts(core).kind !== 'live') return false;
  send(core, LIVE_BELL_KEY);
  return true;
}

// 面板開著時多久重讀一次本幀。實況狀態列每秒重畫一次（LIVE_STATUS_REFRESH_MS 1000），
// 半秒讀一次計時就不會落後超過一格。
export const LIVE_HELPER_POLL_MS = 500;

// 兩次讀到的面板狀態一樣嗎（一樣就不 setState，免得每半秒重 render）。
export function sameLiveHelperView(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.kind === b.kind && a.elapsedSec === b.elapsedSec &&
    a.received === b.received && a.bell === b.bell && a.canComment === b.canComment;
}

// 「mm:ss」
export function formatLiveElapsed(sec) {
  const s = Math.max(0, sec | 0);
  const pad = (n) => String(n).padStart(2, '0');
  return pad(Math.floor(s / 60)) + ':' + pad(s % 60);
}
