// 好讀按 End 之後「黏在文末」（docs/easy-reading.md「反向讀取」捲動段）。
//
// 瀏覽器內建的 scroll anchoring 只會保住**視窗頂端**的錨點：錨點下方（視窗內、文末那
// 幾列）的行內預覽之後才載入長高，文末就被推出視窗下緣，讀者停在「離底部一段距離」。
// 沒有原生的「錨在底部」可接，所以按 End 的讀者由這裡貼底：內容每次變高就捲回底部，
// 直到讀者自己捲動為止。
//
// 放手只認**讀者的輸入**（wheel／pointerdown／touchstart，鍵盤由 EasyReading 的按鍵入口
// 呼叫 release），不看 scroll 事件：程式自己的捲動（接合幀的 _restoreRowAnchor、anchoring
// 補償）也會發 scroll，而且 scroll 事件在同一幀裡比 ResizeObserver 先派送 ⇒ 用「離底部
// 多遠」判斷放手，會在補回底部之前就先把自己放掉。
//
// 只在按 End 時 engage、不在「捲到底」時自動 engage：forward 讀取把新頁接在底部，停在
// 底部讀的人會被一路拖著走。
export function createBottomStick({ scroller, content }) {
  let engaged = false;
  let ro = null;
  const USER_EVENTS = ['wheel', 'pointerdown', 'touchstart'];

  const toBottom = () => { scroller.scrollTop = scroller.scrollHeight; };
  const onUser = () => release();

  function engage() {
    toBottom();
    if (engaged) return;
    engaged = true;
    USER_EVENTS.forEach((t) => scroller.addEventListener(t, onUser, { passive: true }));
    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(() => { if (engaged) toBottom(); });
      ro.observe(content);
      ro.observe(scroller);
    }
  }

  function release() {
    if (!engaged) return;
    engaged = false;
    USER_EVENTS.forEach((t) => scroller.removeEventListener(t, onUser, { passive: true }));
    if (ro) { ro.disconnect(); ro = null; }
  }

  return {
    engage,
    release,
    get engaged() { return engaged; }
  };
}
