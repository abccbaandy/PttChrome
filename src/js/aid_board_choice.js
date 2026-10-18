// 沒寫看板的 #AID 點下去先問「在哪個看板找」（docs/enhanced-addon.md「無看板 AID 的
// 看板選擇」）。
//
// 為什麼要問：PTT 的 # 搜尋只搜 currboard，沒有 (Board)／@Board 後綴、也沒從轉錄
// 標頭補到看板的 #AID，舊版一律遞補「目前文章所在看板」——別板的文章貼過來（推文裡
// 最常見）就必定搜不到。看板只有使用者知道，所以給兩個選項：本版跳轉／指定看板。
//
// 「指定看板」原樣複用 `s` 看板搜尋彈窗（SearchModal＋board_search_bridge 的原生補全），
// 送出＝在背景 prompt 上進板，落地後 aid_navigation.continuePicked 接手 #AID。
// 背景 prompt 一開就離開文章，返回錨要在開彈窗前記（aid_navigation.preparePicked）。
import { BOARD_RE } from './aid_codec';

// 點擊時要不要跳彈窗。explicitBoard＝連結自己帶的看板（後綴或轉錄標頭）。
// 跳轉根本不會發生的情況（另一趟導航在跑、好讀沒開）不問：問完也是 noop。
export function needsAidBoardChoice(o) {
  const opts = o || {};
  if (opts.explicitBoard) return false;
  if (opts.navigating) return false;
  return !!opts.startedEasyReading;
}

// 「本版」能不能選：目前文章的看板要是合法板名。
export function currentBoardOption(board) {
  return typeof board === 'string' && BOARD_RE.test(board) ? board : null;
}
