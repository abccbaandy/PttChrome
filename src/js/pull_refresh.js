// 手機的「下拉重新整理」（docs/screen-refresh.md「下拉重整」）。
//
// **為什麼這裡自己做、不接瀏覽器原生的 pull-to-refresh**（CLAUDE.md「原生行為不准模擬」
// 的例外，理由逐條對照該規範）：
//   1. 沒有入口可接：Chrome 的 pull-to-refresh 唯一的結果是**整頁重新載入**＝斷線＋重新
//      登入，頁面拿不到「使用者拉了」這個事件、也不能把結果換成別的動作（beforeunload
//      只能問要不要離開）。接上去等於把功能做成「斷線」。
//   2. 觸控事件有完整相位：touchstart／touchmove／touchend 分得出「手指還在／放開了」，
//      不是 WheelEvent 那種缺 phase 的輸入（觸控板返回手勢被禁止模擬的核心理由）⇒
//      「拉過門檻、放手才生效」「拉回去就取消」做得正確。
//   3. 沒有使用者層級的系統設定可違反：Android 沒有關閉 pull-to-refresh 的系統開關。
// 原生那條仍要關掉（否則兩個一起跑＝重新整理＋整頁重載）：main.css 在手機版面給
// html/body `overscroll-behavior-y: contain`（**只動 y 軸**，x 軸的返回導航照舊放行）。
//
// 只在手機版面、畫面重整得了（screenRefresh.target()）、捲動視口已在頂端時才開始追蹤；
// 被動監聽、從不 preventDefault ⇒ 捲動與點擊完全不受影響。

import { HOME_DASHBOARD_ID } from './home_dashboard';

// 拉動阻尼（指示器位移 = 手指位移 × RESISTANCE），門檻與上限都以指示器位移計。
export const PULL_RESISTANCE = 0.5;
export const PULL_THRESHOLD_PX = 64;
export const PULL_MAX_PX = 96;
// 起手的方向判定：先走到這麼遠才決定是「往下拉」還是別的手勢。
const PULL_SLOP_PX = 8;

// 純函式：一次觸控的位移 → 狀態。
//   'idle'   還沒走出 slop
//   'cancel' 不是往下拉（往上、或水平主導）⇒ 這次觸控不再追蹤
//   'pull'   拉動中，未過門檻
//   'armed'  已過門檻，放手就重新整理
export function pullState(dx, dy) {
  const ax = Math.abs(dx);
  if (Math.max(ax, Math.abs(dy)) < PULL_SLOP_PX) return { state: 'idle', offset: 0 };
  if (dy <= 0 || ax > dy) return { state: 'cancel', offset: 0 };
  const offset = Math.min(dy * PULL_RESISTANCE, PULL_MAX_PX);
  return { state: offset >= PULL_THRESHOLD_PX ? 'armed' : 'pull', offset: offset };
}

// 觸控點底下最近的「真的捲得動」的祖先（好讀文章的 .main、列表好讀的 .listBodyView…）。
// 沒有 ⇒ 畫面本身不捲（原生 24 列），永遠算在頂端。
export function scrollParentOf(el, win) {
  const w = win || window;
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    if (n === document.body || n === document.documentElement) return null;
    if (n.scrollHeight <= n.clientHeight + 1) continue;
    const oy = w.getComputedStyle(n).overflowY;
    if (oy === 'auto' || oy === 'scroll') return n;
  }
  return null;
}

// 不該起手的觸控：工具列／App Bar／sheet／對話框裡的東西，以及多指。
// 首頁儀表板整片都是卡片按鈕：在它上面拉照樣算（點一下不會走出 slop，不影響點擊）。
function ignoredTarget(t) {
  if (!t || !t.closest) return true;
  if (t.closest('#' + HOME_DASHBOARD_ID)) return !!t.closest('input, textarea, select');
  return !!t.closest(
    '#mobileToolbar, #mobileAppBar, .mantine-Modal-root, .mantine-Drawer-root, ' +
      '.mobileSheet, input, textarea, select, button, [role="dialog"]'
  );
}

export function installPullRefresh(core, doc) {
  const d = doc || document;
  let track = null;
  let indicator = null;

  const ensureIndicator = function() {
    if (indicator) return indicator;
    indicator = d.createElement('div');
    indicator.className = 'pullRefreshIndicator nomouse_command';
    indicator.setAttribute('aria-hidden', 'true');
    indicator.innerHTML =
      '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4"/>' +
      '<path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/></svg>';
    d.body.appendChild(indicator);
    return indicator;
  };

  const paint = function(offset, armed) {
    const el = ensureIndicator();
    const top = (() => {
      const bar = d.getElementById('mobileAppBar');
      return bar ? bar.getBoundingClientRect().bottom : 0;
    })();
    el.style.top = top + 'px';
    el.style.transform =
      'translate(-50%, ' + (offset - 40) + 'px) rotate(' + offset * 3 + 'deg)';
    el.style.opacity = String(Math.min(1, offset / PULL_THRESHOLD_PX));
    el.classList.toggle('armed', !!armed);
    el.classList.add('visible');
  };

  const hide = function() {
    if (!indicator) return;
    indicator.classList.remove('visible', 'armed');
    indicator.style.opacity = '0';
  };

  const onStart = function(e) {
    track = null;
    if (!core.mobile || core.mobileSelectMode || core.modalShown) return;
    if (!e.touches || e.touches.length !== 1) return;
    if (ignoredTarget(e.target)) return;
    const refresh = core.screenRefresh;
    if (!refresh || !refresh.target()) return;
    const sp = scrollParentOf(e.target);
    if (sp && sp.scrollTop > 0) return;
    const t = e.touches[0];
    track = { x: t.clientX, y: t.clientY, scroller: sp, state: 'idle' };
  };

  const onMove = function(e) {
    if (!track) return;
    if (!e.touches || e.touches.length !== 1) {
      track = null;
      hide();
      return;
    }
    // 視口在拉的途中被捲動了（例如先往上捲再往下）⇒ 不是從頂端拉。
    if (track.scroller && track.scroller.scrollTop > 0) {
      track = null;
      hide();
      return;
    }
    const t = e.touches[0];
    const r = pullState(t.clientX - track.x, t.clientY - track.y);
    if (r.state === 'cancel') {
      track = null;
      hide();
      return;
    }
    track.state = r.state;
    if (r.state !== 'idle') paint(r.offset, r.state === 'armed');
  };

  const onEnd = function() {
    const armed = track && track.state === 'armed';
    track = null;
    hide();
    if (armed && core.screenRefresh) core.screenRefresh.refresh('pull');
  };

  const onCancel = function() {
    track = null;
    hide();
  };

  const opts = { passive: true, capture: true };
  d.addEventListener('touchstart', onStart, opts);
  d.addEventListener('touchmove', onMove, opts);
  d.addEventListener('touchend', onEnd, opts);
  d.addEventListener('touchcancel', onCancel, opts);
  return function uninstall() {
    d.removeEventListener('touchstart', onStart, opts);
    d.removeEventListener('touchmove', onMove, opts);
    d.removeEventListener('touchend', onEnd, opts);
    d.removeEventListener('touchcancel', onCancel, opts);
    if (indicator && indicator.parentNode) indicator.parentNode.removeChild(indicator);
    indicator = null;
  };
}
