// 手機「讀到文末再往上拉 ⇒ 開下一篇」（docs/next-article.md「往上拉」）。
//
// 與下拉重整（pull_refresh.js）同一個例外理由：瀏覽器的 overscroll 沒有任何入口告訴頁面
// 「使用者在底部又拉了一段」，而觸控事件有完整相位（手指還在／放開了）⇒「拉過門檻、放手
// 才生效」「拉回去就取消」做得正確。被動監聽、從不 preventDefault ⇒ 捲動、Android 原生
// 的 overscroll 拉伸效果與點擊完全照舊；我們只在放手那一下決定要不要開下一篇。
// 不碰滾輪：WheelEvent 沒有相位（觸控板的慣性尾巴分不出是不是使用者還在拉），桌機只有點卡片。
//
// 只在：手機版面、下一篇卡片顯示中（不在開啟中）、捲動容器已經在底部時開始追蹤。

import { pullState } from './pull_refresh';
import { NEXT_ARTICLE_ID } from './next_article';

// 觸控點底下的捲動容器（好讀文章是 .main）。
function scrollerOf(el) {
  return el && el.closest ? el.closest('.main') : null;
}

// 已經捲到底（含內容比視窗短、根本捲不動）。
export function atScrollBottom(sp) {
  if (!sp) return false;
  return sp.scrollTop + sp.clientHeight >= sp.scrollHeight - 1;
}

// 工具列／App Bar／sheet／對話框裡的東西，以及卡片本身（點卡片走 click）不起手。
function ignoredTarget(t) {
  if (!t || !t.closest) return true;
  return !!t.closest(
    '#mobileToolbar, #mobileAppBar, .mantine-Modal-root, .mantine-Drawer-root, ' +
      '.mobileSheet, input, textarea, select, [role="dialog"], #' + NEXT_ARTICLE_ID
  );
}

export function installPullNextArticle(core, doc) {
  const d = doc || document;
  let track = null;

  const reset = function() {
    if (track && track.state !== 'idle' && core.nextArticle) core.nextArticle.setPull(null);
    track = null;
  };

  const onStart = function(e) {
    reset();
    const na = core.nextArticle;
    if (!core.mobile || core.mobileSelectMode || core.modalShown || !na) return;
    if (!e.touches || e.touches.length !== 1) return;
    const st = na.state;
    if (!st.visible || st.pending) return;
    if (ignoredTarget(e.target)) return;
    const sp = scrollerOf(e.target);
    if (!atScrollBottom(sp)) return;
    const t = e.touches[0];
    track = { x: t.clientX, y: t.clientY, scroller: sp, state: 'idle' };
  };

  const onMove = function(e) {
    if (!track) return;
    if (!e.touches || e.touches.length !== 1 || !atScrollBottom(track.scroller)) {
      reset();
      return;
    }
    const t = e.touches[0];
    // 往上拉＝手指往上走（dy 為負）⇒ 鏡像成 pullState 的「往下」。
    const r = pullState(t.clientX - track.x, track.y - t.clientY);
    if (r.state === 'cancel') {
      reset();
      return;
    }
    if (r.state === track.state) return;
    track.state = r.state;
    if (r.state !== 'idle') core.nextArticle.setPull(r.state);
  };

  const onEnd = function() {
    const armed = track && track.state === 'armed';
    reset();
    if (armed && core.nextArticle) core.nextArticle.open();
  };

  const opts = { passive: true, capture: true };
  d.addEventListener('touchstart', onStart, opts);
  d.addEventListener('touchmove', onMove, opts);
  d.addEventListener('touchend', onEnd, opts);
  d.addEventListener('touchcancel', reset, opts);
  return function uninstall() {
    d.removeEventListener('touchstart', onStart, opts);
    d.removeEventListener('touchmove', onMove, opts);
    d.removeEventListener('touchend', onEnd, opts);
    d.removeEventListener('touchcancel', reset, opts);
  };
}
