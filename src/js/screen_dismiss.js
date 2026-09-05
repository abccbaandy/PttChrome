// 「這一幀有沒有一個滑鼠關得掉的框」—— 純函式，零 DOM、零狀態。
//
// PTT 停在「等一個按鍵」的畫面時（進版畫面收尾、vmsg 橫幅、vgetstring 輸入欄），
// 滑鼠原本沒有任何出口：resolveMouseRegion 對 pageState 5 走 default → NONE，
// 對 inputPrompt 更是整幀早退。使用者只能去鍵盤敲一下。這個模組決定「點空白處
// 要送哪個 byte」。
//
// ---- pttbbs 事實（逐條讀 3rd_script/pttbbs 原始碼，非畫面反推）----
//
// A. pressanykey：include/proto.h `#define pressanykey() vmsg(NULL)`
//    → mbbsd/vtuikit.c#vshowmsg(NULL) 在**最後一列**（move(b_lines,0)）畫
//    VMSG_PAUSE_PAD("▄") 填滿 ＋ 正中央 VMSG_PAUSE(" 請按任意鍵繼續 ")，
//    配色 VCLR_PAUSE = ANSI_COLOR(1;37;44)（include/vtuikit.h:39-40）。
//
// B. vmsg 橫幅：同一支 vshowmsg 帶訊息時印 VMSG_MSG_PREFIX(" ◆ ") ＋訊息＋
//    右靠 VMSG_MSG_FLOAT(" [按任意鍵繼續]")（vtuikit.h:41-42）。判讀共用
//    push_screen.parseVmsgText，**不要在這裡另寫一份 regex**。
//
// A/B 的等待迴圈都是 vtuikit.c:445 `do { i = vkey(); } while (i == 0);`
// ⇒ **任何真的按鍵**都收得掉。但 `\f`(Ctrl-L) 不算：mbbsd/io.c:228-247 的
// system_key_hook 對 Ctrl('L') 回 KEY_INCOMPLETE，vkey() 直接 continue
// ⇒ 用它關框會整串位移一格（docs/pttbbs-screen-protocol.md §6 有實錯記錄）。
// 所以一律用**空白鍵**。
//
// C. vgetstring 輸入欄：vtuikit.c:1346 `case Ctrl('C'): rt.icurr=rt.iend=0;
//    buf[0]=0; abort=1;` ⇒ getdata 回 0 ⇒ 呼叫端一律當「取消」。指紋沿用
//    term_buf.isCursorOnInputField()（游標所在格白底黑字、且該列不是從 col 0
//    就反白），source 校準見該函式的註解。
//
// ---- 為什麼不可以「點空白就送一個安全鍵」----
// **沒有安全鍵**。`Ctrl-C` 在文章列表是 ClearTagList()（mbbsd/read.c:950-955，
// 清掉標記清單）；空白鍵在文章裡是翻頁。所以一定要先確定框存在，
// resolveDismiss 回 null 就是「什麼都不做」。
//
// ---- 為什麼不用 pageState === 5 當判準 ----
// pageState 5 有第二條完全不同的來源（term_buf.setPageState 的
// `isUnicolor(lastRow,28,53) && cur_y==lastRow && cur_x==cols-1` 啟發式），
// 那條畫面不保證在等按鍵；反過來 vmsg 橫幅根本不會讓 setPageState 轉 5。
//
// 消費端：pttchrome.App.mouse_click（送鍵）、mouse_regions.resolveMouseRegion
// （只換指標）。unit 守護 tests/unit/screen_dismiss.test.js。

import { parseVmsgText } from './push_screen';

// vgetstring 的 Ctrl-C：清空 buf 並 abort（vtuikit.c:1345-1351）⇒ getdata 回 0
// ⇒ 呼叫端當取消，不寫入任何東西。
export const KEY_ABORT = '\x03';
// vmsg 的 `do { i = vkey(); } while (i == 0);` 要一個真的按鍵才消得掉；
// Ctrl-L 會被 io.c#system_key_hook 吃掉，所以用空白。
export const KEY_DISMISS = ' ';

export const DISMISS_ANY_KEY = 'anyKey';
export const DISMISS_INPUT = 'inputField';

// include/vtuikit.h:39 VMSG_PAUSE。padding 是 VMSG_PAUSE_PAD("▄")，這裡只比對
// 訊息本體（用 indexOf，不管左右填了幾格、也不管 `▄` 在 b2u 之後長什麼樣）。
const PAUSE_TEXT = '請按任意鍵繼續';
// fork 沿用：term_buf.setPageState 從 PttChrome 時代就同時認這一句（Maple 系
// BBS 的寫法，**不在 pttbbs 原始碼裡**）。它字面就指名空白鍵，收尾鍵與 A 相同。
const PAUSE_TEXT_ALT = '請按 空白鍵 繼續';

// 這一幀「有沒有一個滑鼠關得掉的框」。
//   lastRowText         buf.getRowText(rows - 1, 0, cols)
//   cursorOnInputField  buf.isCursorOnInputField()
// 回 null ＝沒有框（**預設就是什麼都不做**）。
//
// 判斷順序刻意讓**輸入欄優先**：vans/getdata 的提示（` 確定[y/N]:`、
// `要使用小天使匿名推文嗎？ [Y/n]:`）畫在同一列，光看文字分不出來，
// 但游標在不在反白欄裡是確定的。
export function resolveDismiss(input) {
  const o = input || {};
  if (o.cursorOnInputField)
    return { kind: DISMISS_INPUT, bytes: KEY_ABORT };
  const last = String(o.lastRowText == null ? '' : o.lastRowText);
  if (last.indexOf(PAUSE_TEXT) >= 0 || last.indexOf(PAUSE_TEXT_ALT) >= 0)
    return { kind: DISMISS_ANY_KEY, bytes: KEY_DISMISS };
  if (parseVmsgText(last) !== null)
    return { kind: DISMISS_ANY_KEY, bytes: KEY_DISMISS };
  return null;
}

// 這一「點」算不算點在空白處。**與 resolveDismiss 分開**：前者只看畫面、
// 後者還要看滑鼠落在哪一格 —— 分開才兩邊都測得動，也才不會有人把 clickRow
// 塞進畫面判斷裡搞出兩個真相源。
//
// 游標所在那一列**排除**（使用者 2026-09 定案）：輸入欄開著時那一列是使用者
// 正在打的字，點它就取消太意外；pressanykey 的 `▄` 橫幅也在那一列
// （vshowmsg 一律 move(b_lines,0)，游標就停在那裡），留給它「不是空白」比較一致。
export function dismissClickAllowed(input) {
  const o = input || {};
  return o.clickRow !== o.cursorRow;
}
