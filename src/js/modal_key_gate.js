'use strict';

// 「關掉 modal 的那一下按鍵」不可以落到終端機。
//
// 為什麼光靠 modalShown 擋不住：Mantine Modal 的 Escape handler 掛在 **window
// capture** keydown（@mantine/core ModalBase/use-modal），它 onClose() 之後，React
// 在兩個 listener 之間的 microtask 裡就 commit 完、ContextMenu 的 effect 把
// modalShown 翻成 false ⇒ 同一個 keydown 冒泡到 term_view 時守門已經放行。
// 讀狀態會被 listener 順序打敗（vtkbd_send_state.js 檔頭記過那次失敗）。
//
// 改比**時間**：事件是在 modal 關閉之前產生的 ⇒ 它是按給 modal 的，跟誰先跑無關。
// Event.timeStamp 與 performance.now() 是同一個時間基準（兩者都是 DOMHighResTimeStamp，
// 相對 time origin）；App.setModalOpen 在最後一個來源關閉時記 modalClosedAt。
//
// 關框**之後**才按的鍵（timeStamp 晚於關閉）照常送 —— 那時畫面上真的沒有彈窗，
// Esc 是合法的終端機輸入；它留下的懸空 ESC 態由 vtkbd_send_state 化解。
//
// 實錄：ptt-debug-20260919-010054.json —— 長推文輸入框按 Esc 取消，一個裸 ESC
// 上線，而且 easyReading._onKeyDown 把待還原的閱讀位置當成「使用者接手」清掉；
// 點「取消」則兩者都不會發生。守護：tests/unit/modal_key_gate.test.js、
// tests/e2e/offline/long_push.offline.spec.js。
export function keyEventPredatesModalClose(eventTimeStamp, modalClosedAt) {
  if (typeof eventTimeStamp !== 'number' || !(eventTimeStamp === eventTimeStamp))
    return false;
  return eventTimeStamp <= modalClosedAt;
}
