// 焦點框只在鍵盤操作時畫（docs/mobile.md「點擊回饋」）。
//
// 為什麼 :focus-visible 自己不夠：終端機的鍵盤入口是隱藏 input #t，文字輸入框聚焦時
// 恆為 :focus-visible。點／觸控打開對話框或 bottom sheet 時，focus trap 用程式把焦點從 #t
// 搬到第一個按鈕，Chromium 讓新焦點**繼承**前一個焦點的 :focus-visible ⇒ 用手指點開
// 「更多」，第一項（選取模式）就有一圈焦點框，看起來像被選中；設定頁的關閉鈕同理。
//
// 做法：document capture 階段記最後一次輸入是指標還是鍵盤，寫在 <html data-input-modality>；
// main.css 在 pointer 時把 :focus-visible 的 outline 拿掉。只是裝飾：不攔事件、不碰焦點。
export const MODALITY_ATTR = 'data-input-modality';

export function installFocusRing(doc) {
  const d = doc || document;
  const root = d.documentElement;
  const set = (m) => {
    if (root.getAttribute(MODALITY_ATTR) !== m) root.setAttribute(MODALITY_ATTR, m);
  };
  const onPointer = () => set('pointer');
  const onKey = () => set('keyboard');
  d.addEventListener('pointerdown', onPointer, { passive: true, capture: true });
  d.addEventListener('keydown', onKey, { capture: true });
  return () => {
    d.removeEventListener('pointerdown', onPointer, { capture: true });
    d.removeEventListener('keydown', onKey, { capture: true });
    root.removeAttribute(MODALITY_ATTR);
  };
}
