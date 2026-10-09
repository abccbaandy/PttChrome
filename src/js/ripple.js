// 按下的波紋回饋（Material ripple）—— 手機底部導覽／sheet 項目，以及桌機的 Mantine 按鈕與
// 右鍵選單項目。docs/mobile.md「點擊回饋」。
//
// 做法：document 上一個 passive pointerdown 委派，只處理帶 `.pttRipple` 的元素（Mantine 元件
// 由 MantineRoot 的 theme classNames 掛上），在按下點插一個 span 跑完 CSS 動畫就移除。
// 規則：
//   - **核心畫面（#mainContainer）一律跳過**：那裡是純 JS 渲染鏈的單一寫入路徑
//     （CLAUDE.md「不要在 #mainContainer 上開第二條寫入路徑」），選單大按鈕／列表卡片只用
//     CSS :active。
//   - prefers-reduced-motion 時不畫（只剩各元件自己的 :active 底色）。
//   - 只是裝飾：不 preventDefault、不攔事件、不碰焦點。
export const RIPPLE_CLASS = 'pttRipple';
export const RIPPLE_MS = 450;

export function rippleHost(target) {
  if (!target || typeof target.closest !== 'function') return null;
  const host = target.closest('.' + RIPPLE_CLASS);
  if (!host || host.closest('#mainContainer')) return null;
  if (host.disabled || host.getAttribute('data-disabled') != null) return null;
  return host;
}

export function installRipple(doc, win) {
  const d = doc || document;
  const w = win || window;
  const reduced = () =>
    !!(w.matchMedia && w.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const onDown = (e) => {
    const host = rippleHost(e.target);
    if (!host || reduced()) return;
    const r = host.getBoundingClientRect();
    const size = Math.max(r.width, r.height) * 2;
    const span = d.createElement('span');
    span.className = 'pttRippleWave';
    span.setAttribute('aria-hidden', 'true');
    span.style.width = span.style.height = size + 'px';
    span.style.left = e.clientX - r.left - size / 2 + 'px';
    span.style.top = e.clientY - r.top - size / 2 + 'px';
    host.appendChild(span);
    w.setTimeout(() => span.remove(), RIPPLE_MS);
  };
  d.addEventListener('pointerdown', onDown, { passive: true, capture: true });
  return () => d.removeEventListener('pointerdown', onDown, { capture: true });
}
