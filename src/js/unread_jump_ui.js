// 跳到第一篇未讀的畫面回饋（P83／P84，docs/unread-jump.md「過程回饋」）：
//   - 進度卡：找的過程顯示「已往上翻 N 頁・看過 M 篇」＋「取消」，好讀列表同時調暗。
//   - 分界線：落地後在第一篇未讀上緣畫「以下未讀 N 篇」，那一篇短暫亮起。
// 兩者都是疊在畫面上的浮層（body 底下、position:fixed），**不寫 #mainContainer**（核心渲染鏈的
// DOM 是外部契約，見 CLAUDE.md）；調暗只在 body 掛 class，由 main.css 決定樣式。
// 不送鍵、不碰狀態：送鍵與收手都在 unread_jump.js。

import { hintBottomCss } from './status_hint';

// 快的時候（End 一頁就找到）不閃：超過這麼久還沒結束才出現。
export const PROGRESS_DELAY_MS = 300;
// 分界線那一篇亮起多久後淡掉（分界線本身留到使用者捲動／按鍵／點擊）。
export const DIVIDER_FLASH_MS = 2000;
// 保險：使用者什麼都沒做也不要永遠掛著。
export const DIVIDER_MAX_MS = 15000;
// body 上的調暗 class（main.css）。
export const BUSY_BODY_CLASS = 'unreadJumpBusy';

// 進度卡第二行。pages ＝已往上翻幾頁（End 那頁不算），seen ＝讀過幾篇。
export function progressDetail(pages, seen) {
  const parts = [];
  if (pages > 0) parts.push('已往上翻 ' + pages + ' 頁');
  parts.push('看過 ' + (seen || 0) + ' 篇');
  return parts.join('・');
}

// 分界線右端的字。count ＝找的過程數到的未讀篇數（null／0 ⇒ 只寫「以下未讀」）。
export function dividerLabel(count) {
  return count > 0 ? '以下未讀 ' + count + ' 篇' : '以下未讀';
}

// 這一列是不是那一篇：列表的編號是獨立的一串數字（%7d），不能只用 includes —— 1013 會配到 11013。
export function rowShowsNum(text, num) {
  if (num == null) return false;
  return new RegExp('(^|[^0-9])' + String(num) + '([^0-9]|$)').test(text || '');
}

function el(doc, tag, cls, text) {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/**
 * @param {{ doc?: Document, onCancel?: () => void, setTimeout?: Function, clearTimeout?: Function }} [opts]
 */
export function UnreadJumpProgress(opts) {
  const o = opts || {};
  this._doc = o.doc || (typeof document !== 'undefined' ? document : null);
  this._onCancel = o.onCancel || null;
  // 包一層：直接存 window.setTimeout 再以 this._setTimeout() 呼叫，this 不是 window ⇒
  // 瀏覽器丟 Illegal invocation（unit 注入假計時器測不到，e2e 守）。
  this._setTimeout =
    o.setTimeout ||
    function(fn, ms) {
      return setTimeout(fn, ms);
    };
  this._clearTimeout =
    o.clearTimeout ||
    function(id) {
      clearTimeout(id);
    };
  this._el = null;
  this._detail = null;
  this._title = null;
  this._cancelBtn = null;
  this._timer = null;
  this._dim = false;
  this._open = false;
  this._divider = null;
}

UnreadJumpProgress.prototype = {
  // 開始找：PROGRESS_DELAY_MS 後才真的出現。dim ＝好讀列表在凍結中（原生不調暗：使用者
  // 看得到 PTT 在翻頁）。
  begin: function(dim) {
    this.end();
    this.clearDivider();
    this._open = true;
    this._dim = !!dim;
    this._pages = 0;
    this._seen = 0;
    this._cancelling = false;
    const self = this;
    this._timer = this._setTimeout(function() {
      self._timer = null;
      if (self._open) self._show();
    }, PROGRESS_DELAY_MS);
  },

  update: function(pages, seen) {
    this._pages = pages;
    this._seen = seen;
    if (this._detail && !this._cancelling) this._detail.textContent = progressDetail(pages, seen);
  },

  // 使用者按了取消：字改成「正在取消…」，取消鈕收起（之後只剩回原位那一步）。
  cancelling: function() {
    this._cancelling = true;
    if (this._title) this._title.textContent = '正在取消…';
    if (this._detail) this._detail.textContent = '回到原本的位置';
    if (this._cancelBtn) this._cancelBtn.hidden = true;
  },

  // 已經在跳號（最後一步）：不能取消了。
  committing: function() {
    if (this._cancelBtn) this._cancelBtn.hidden = true;
  },

  shown: function() {
    return !!(this._el && this._el.isConnected);
  },

  end: function() {
    this._open = false;
    if (this._timer) this._clearTimeout(this._timer);
    this._timer = null;
    if (this._el) this._el.remove();
    this._el = this._detail = this._title = this._cancelBtn = null;
    const body = this._doc && this._doc.body;
    if (body) body.classList.remove(BUSY_BODY_CLASS);
  },

  _show: function() {
    const doc = this._doc;
    if (!doc || !doc.body) return;
    const card = el(doc, 'div', 'unreadJumpProgress');
    card.setAttribute('role', 'status');
    card.style.bottom = hintBottomCss(48, false);
    const spin = el(doc, 'span', 'unreadJumpSpinner');
    spin.setAttribute('aria-hidden', 'true');
    const text = el(doc, 'span', 'unreadJumpText');
    this._title = el(doc, 'span', 'unreadJumpTitle', '正在找第一篇未讀…');
    this._detail = el(doc, 'span', 'unreadJumpDetail', progressDetail(this._pages, this._seen));
    text.appendChild(this._title);
    text.appendChild(this._detail);
    const btn = el(doc, 'button', 'unreadJumpCancel', '取消');
    btn.type = 'button';
    btn.setAttribute('data-key', '__unreadJumpCancel');
    // 不搶焦點：終端機的隱藏 input 要一直拿著鍵盤（Esc 也是取消）。
    btn.addEventListener('mousedown', function(e) {
      e.preventDefault();
    });
    const self = this;
    btn.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      if (self._onCancel) self._onCancel();
    });
    card.appendChild(spin);
    card.appendChild(text);
    card.appendChild(btn);
    this._cancelBtn = btn;
    this._el = card;
    if (this._cancelling) this.cancelling();
    doc.body.appendChild(card);
    if (this._dim) doc.body.classList.add(BUSY_BODY_CLASS);
  },

  // ---- 分界線（P84） ---------------------------------------------------------

  // findRow() ＝落地那一篇此刻在畫面上的列（呼叫端負責認對；認不出回 null）。畫成 body 底下的
  // fixed 浮層：列表自己捲動（接管後補頁、捲動錨定）時每次重新量、跟著那一列走；那一列不見了或
  // 捲出畫面就收。使用者自己動手（按鍵、點、觸控、滾輪、改視窗大小）＝看到了，收掉。
  showDivider: function(findRow, count) {
    this.clearDivider();
    const doc = this._doc;
    if (!doc || !doc.body || typeof findRow !== 'function') return false;
    const view = doc.defaultView;
    const measure = function() {
      const rowEl = findRow();
      if (!rowEl || !rowEl.getBoundingClientRect) return null;
      const r = rowEl.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return null;
      const vh = (view && view.innerHeight) || 0;
      if (vh && (r.bottom <= 0 || r.top >= vh)) return null;
      return r;
    };
    const first = measure();
    if (!first) return false;
    const wrap = el(doc, 'div', 'unreadJumpDividerLayer');
    wrap.setAttribute('aria-hidden', 'true');
    const hl = el(doc, 'div', 'unreadJumpRowFlash');
    const line = el(doc, 'div', 'unreadJumpDivider');
    line.appendChild(el(doc, 'span', 'unreadJumpDividerLabel', dividerLabel(count)));
    const place = function(r) {
      Object.assign(hl.style, {
        top: r.top + 'px',
        left: r.left + 'px',
        width: r.width + 'px',
        height: r.height + 'px'
      });
      Object.assign(line.style, { top: r.top - 1 + 'px', left: r.left + 'px', width: r.width + 'px' });
    };
    place(first);
    wrap.appendChild(hl);
    wrap.appendChild(line);
    doc.body.appendChild(wrap);
    const self = this;
    const clear = function() {
      self.clearDivider();
    };
    const follow = function() {
      const r = measure();
      if (r) place(r);
      else clear();
    };
    const target = view || doc;
    const userEvs = ['wheel', 'keydown', 'pointerdown', 'touchstart', 'resize'];
    userEvs.forEach(function(ev) {
      target.addEventListener(ev, clear, { capture: true, passive: true });
    });
    target.addEventListener('scroll', follow, { capture: true, passive: true });
    const fade = this._setTimeout(function() {
      hl.classList.add('faded');
    }, DIVIDER_FLASH_MS);
    const max = this._setTimeout(clear, DIVIDER_MAX_MS);
    this._divider = {
      el: wrap,
      dispose: function() {
        userEvs.forEach(function(ev) {
          target.removeEventListener(ev, clear, { capture: true });
        });
        target.removeEventListener('scroll', follow, { capture: true });
        self._clearTimeout(fade);
        self._clearTimeout(max);
        wrap.remove();
      }
    };
    return true;
  },

  clearDivider: function() {
    const d = this._divider;
    this._divider = null;
    if (d) d.dispose();
  },

  dividerShown: function() {
    return !!(this._divider && this._divider.el.isConnected);
  }
};

export default UnreadJumpProgress;
