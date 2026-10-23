// 「讀到文末再多拉一段 ⇒ 開下一篇」（docs/next-article.md「往下拉」）。兩條入口：
//
// 手機（installPullNextArticle）：捲到底再往上拉。與下拉重整（pull_refresh.js）同一個例外
// 理由：瀏覽器的 overscroll 沒有任何入口告訴頁面「使用者在底部又拉了一段」，而觸控事件有
// 完整相位（手指還在／放開了）⇒「拉過門檻、放手才生效」「拉回去就取消」做得正確。被動監聽、
// 從不 preventDefault ⇒ 捲動、Android 原生的 overscroll 拉伸效果與點擊完全照舊；我們只在
// 放手那一下決定要不要開下一篇。只在：手機版面、下一篇卡片顯示中（不在開啟中）、捲動容器
// 已經在底部時開始追蹤。
//
// 桌機（installWheelNextArticle）：捲到底、**停一下**、再繼續往下捲一段。WheelEvent 沒有相位，
// 觸控板的慣性尾巴、一路轉滾輪捲到底的那一串，都分不出「到底了還在捲」是不是故意的 ⇒ 用
// 「手勢」來切：相隔 WHEEL_GESTURE_GAP_MS 以上的 wheel 才算新手勢，只有**起手時就已經停在
// 底部**的手勢累積位移（wheelPullStep）。所以捲到底那一下（連同慣性）永遠不會開下一篇，
// 一定要停下來再捲。同樣被動監聽、從不 preventDefault。

import { pullState, PULL_THRESHOLD_PX } from './pull_refresh';
import { NEXT_ARTICLE_ID, NEXT_THREAD_ROW_ID } from './next_article';
import { isHorizontalWheel, wheelDeltaYPx } from './swipe_gesture';

// 相隔這麼久的 wheel 事件才算新的手勢（觸控板慣性、連續轉滾輪的間隔都遠小於它）。
export const WHEEL_GESTURE_GAP_MS = 250;
// 這麼久沒有 wheel ⇒ 累積歸零（卡片字樣也還原）。
export const WHEEL_IDLE_RESET_MS = 700;
// 在底部再往下捲這麼多 px 才開（滑鼠滾輪約 4～5 格）。
export const WHEEL_THRESHOLD_PX = 480;

// 純函式：一個 wheel 事件 → 下一個狀態。
//   prev：{ lastTs, eligible, acc }（第一次給 null）
//   ev：  { t, dy, atBottom, moved }
//         dy＝往下為正的 px；moved＝這次事件之前捲動位置已經變了（合成器先捲了 ⇒ 這一下其實
//         是把人捲到底的那一下，不算起手在底部）。
// 回傳 { lastTs, eligible, acc, progress, fire }：fire＝這一下讓累積過門檻（呼叫端開下一篇）。
export function wheelPullStep(prev, ev) {
  const p = prev || { lastTs: null, eligible: false, acc: 0 };
  const gap = p.lastTs == null ? Infinity : ev.t - p.lastTs;
  if (!(ev.dy > 0)) {
    // 往上捲 ⇒ 取消；純水平（dy 0）不算數，但時間要記（同一個手勢）。
    if (ev.dy < 0) return { lastTs: ev.t, eligible: false, acc: 0, progress: 0, fire: false };
    return { lastTs: ev.t, eligible: p.eligible, acc: p.acc, progress: Math.min(1, p.acc / WHEEL_THRESHOLD_PX), fire: false };
  }
  let eligible;
  let acc;
  if (gap >= WHEEL_GESTURE_GAP_MS) {
    eligible = !!ev.atBottom && !ev.moved;
    acc = gap >= WHEEL_IDLE_RESET_MS ? 0 : p.acc;
  } else {
    eligible = p.eligible && !!ev.atBottom;
    acc = p.acc;
  }
  acc = eligible ? acc + ev.dy : 0;
  const fire = eligible && acc >= WHEEL_THRESHOLD_PX;
  return { lastTs: ev.t, eligible, acc: fire ? 0 : acc, progress: Math.min(1, acc / WHEEL_THRESHOLD_PX), fire };
}

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
      '.mobileSheet, input, textarea, select, [role="dialog"], #' + NEXT_ARTICLE_ID + ', #' + NEXT_THREAD_ROW_ID
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
    if (!st.visible || !st.entry || st.pending) return;
    if (ignoredTarget(e.target)) return;
    const sp = scrollerOf(e.target);
    if (!atScrollBottom(sp)) return;
    const t = e.touches[0];
    track = { x: t.clientX, y: t.clientY, scroller: sp, state: 'idle', progress: 0 };
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
    const progress = r.offset / PULL_THRESHOLD_PX;
    if (r.state === track.state && Math.abs(progress - track.progress) < 0.05) return;
    track.state = r.state;
    track.progress = progress;
    if (r.state !== 'idle') core.nextArticle.setPull(r.state, progress);
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

// 桌機：捲到底、停一下、再往下捲過門檻 ⇒ 開下一篇（判準在 wheelPullStep）。掛在 window 的
// capture：App 的 wheel 入口也在 window capture，原生模式會 stopPropagation（好讀文章不會，
// 但同一個 target 上的 listener 不受 stopPropagation 影響，掛這裡最保險）。scroll 事件不冒泡，
// capture 才收得到 .main 的 —— 拿來記「捲動位置上一次停在哪」（moved 的依據）。
export function installWheelNextArticle(core, target) {
  const w = target || window;
  let st = null;
  let idleTimer = null;
  let shown = false;
  const lastTop = new WeakMap();

  const clearShown = function() {
    if (shown && core.nextArticle) core.nextArticle.setPull(null);
    shown = false;
  };
  const reset = function() {
    st = null;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    clearShown();
  };

  const onScroll = function(e) {
    const t = e.target;
    if (t && t.nodeType === 1) lastTop.set(t, t.scrollTop);
  };

  const onWheel = function(e) {
    const na = core.nextArticle;
    const s = na && na.state;
    if (
      !s ||
      !s.visible ||
      !s.entry ||
      s.pending ||
      core.modalShown ||
      e.ctrlKey ||
      isHorizontalWheel(e) ||
      (core.aidNavigation && core.aidNavigation.active)
    ) {
      if (st) reset();
      return;
    }
    const sp = scrollerOf(e.target);
    if (!sp) {
      if (st) reset();
      return;
    }
    const top = sp.scrollTop;
    const moved = lastTop.has(sp) && lastTop.get(sp) !== top;
    lastTop.set(sp, top);
    const t = e.timeStamp > 0 ? e.timeStamp : typeof performance !== 'undefined' ? performance.now() : Date.now();
    st = wheelPullStep(st, { t: t, dy: wheelDeltaYPx(e), atBottom: atScrollBottom(sp), moved: moved });
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (st.fire) {
      st = null;
      shown = false;
      na.open();
      return;
    }
    if (st.eligible && st.acc > 0) {
      na.setPull('wheel', st.progress);
      shown = true;
    } else {
      clearShown();
    }
    idleTimer = setTimeout(function() {
      idleTimer = null;
      clearShown();
    }, WHEEL_IDLE_RESET_MS);
  };

  const opts = { passive: true, capture: true };
  w.addEventListener('wheel', onWheel, opts);
  w.addEventListener('scroll', onScroll, opts);
  return function uninstall() {
    reset();
    w.removeEventListener('wheel', onWheel, opts);
    w.removeEventListener('scroll', onScroll, opts);
  };
}
