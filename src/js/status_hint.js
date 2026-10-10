// 狀態提示（term_view.flashListHint／setListLoading）的分級與外觀。
//
// 兩級：
//   - 一般（預設，level 省略）：「讀取中」「已切至原生操作」「推文已送出」這類說明
//     當下發生什麼事的提示。受 pref `showStatusHints` 控制，熟手可以整組關掉。
//   - HINT_ERROR：操作失敗／逾時被迫切原生／畫面偏離被迫退回原生。**永遠顯示**，
//     而且用紅底跟一般提示區分 —— 這類情況使用者必須知道，關掉提示也不能吞。
//
// 判準：「事情沒照使用者要的發生」＝錯誤；「照著發生了、只是告訴你一聲」＝一般。
// 「指令處理中，請稍候…」這類吞鍵提示屬一般：鍵被擋是設計，不是失敗。

export const HINT_ERROR = 'error';

export function isErrorHint(level) {
  return level === HINT_ERROR;
}

// 這則提示要不要顯示。showStatusHints 只有明確 false 才關（未設定＝預設開）。
export function shouldShowHint(level, showStatusHints) {
  return isErrorHint(level) || showStatusHints !== false;
}

// 底色／字色。錯誤用明顯的紅底白字；一般維持原本的深灰底。
export function hintColors(level) {
  return isErrorHint(level)
    ? { background: 'rgba(176,24,24,.94)', color: '#fff' }
    : { background: 'rgba(20,20,20,.88)', color: '#eee' };
}
