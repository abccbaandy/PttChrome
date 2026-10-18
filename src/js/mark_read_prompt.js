// 文章列表 `v` 的 getdata prompt 指紋 —— 純函式，零 DOM、零狀態。
//
// pttbbs `mbbsd/bbs.c#b_mark_read_unread`：
//   move(b_lines-4, 0); clrtobot(); 說明「設定已讀未讀記錄 …」；
//   getdata(b_lines-1, 0, "設定所有文章 (U)未讀 (V)已讀 (W)前已讀後未讀 (Q)取消？[Q] ", …)
// 消費端兩個：「設為全部已讀」（mark_all_read.js，送 v⏎）與列表好讀的「前已讀後未讀」
// （list_session.markReadUnreadBefore，送 w⏎）。兩者都是「第一步 `v` 真的開出 prompt
// 才准送第二步」：沒開出來時第二步的鍵會落回列表按鍵（`w` ＝對作者送呼叫器）。
// **共用這一份**，不要在呼叫端另寫 indexOf。
//
// 只認**行首**：getdata 從 col 0 起印 prompt；文章列一律以編號／游標開頭，標題剛好
// 引用這段字（「[問題] 前已讀後未讀是什麼」）也不會在行首。列號不綁死（b_lines-1 隨
// 終端機列數變），掃整個畫面。
//
// 守護：tests/unit/mark_all_read.test.js、list_mark_read.test.js、
// parse_failure_degrade.test.js。

const PROMPT_HEAD = '設定所有文章';
const PROMPT_ALL_READ = '(V)已讀';

// 畫面上有沒有 `v` 的 getdata prompt。
export function markReadPromptShown(rowTexts) {
  return (rowTexts || []).some(function(t) {
    return !!t && t.indexOf(PROMPT_HEAD) === 0 && t.indexOf(PROMPT_ALL_READ) !== -1;
  });
}
