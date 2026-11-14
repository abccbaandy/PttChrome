// 手機「選取文字」頁（P81，pref mobileSelectTextPage，預設開；components/SelectTextPage）。
//
// 終端機一行 80 欄剛好塞滿手機螢幕寬，每行第一個字貼著螢幕左緣：原生選取把手只剩半個在畫面上、
// 往左拉還會觸發系統「返回」手勢。這一頁把**畫面上這篇已載入的文字**轉成留邊、自動換行的純文字，
// 讓 Android 原生選取（把手、複製工具列）照常運作，我們只提供「全選」「複製選取的字」兩顆鈕。
//
// 三條線：
//   1. **一個 byte 都不送**：文字只取畫面這一份（view._renderedLines：好讀累積頁 buf.pageLines，
//      或存到本機的唯讀頁 _staticRows）；不是這兩種畫面就不出現入口（原生 24 列鏡像、列表、
//      編輯器都不給 ⇒ 認不出就不接手）。
//   2. **不碰終端機渲染**：不改 #mainContainer、不在上面寫東西；頁面是 body 底下的 portal。
//   3. **原生選取不模擬**：頁面只是一般可選取的文字（user-select: text），把手、放大鏡、複製工具列
//      都是系統的（CLAUDE.md「系統／瀏覽器的原生行為不准模擬」）。
//
// 列號＝view._renderedLines 的索引（＝畫面列的 data-row），長按選單開的就捲到那一列。
// 被藏起來的列（黑名單推文、推文篩選收起的列）照畫面也不放：讀 ScreenController 上一幀的標註。
// 守護：tests/unit/select_text_page.test.js、offline e2e mobile_select_text.offline.spec.js。

import { readEffectivePrefs } from './pref_storage';

// 這一列在畫面上是不是被藏起來（render/screen.js 的 dropHidden 規則：hidden 且不是篩選展開的列）。
export function annotationHidesRow(ann) {
  return !!(ann && ann.hidden && !ann.filterShown);
}

// 畫面列 → 這一頁的文字列。rowText(r) 回傳第 r 列的文字（buf.getRowText，全形字與 WIDE_TRAIL
// 的換算由它負責）；isHidden(r) 為真的列不放。列尾空白去掉（終端機補滿 80 欄的空格不是內容）。
// 回傳 [{ row, text }]，row 保留畫面列號，長按選單才找得到對應那一行。
export function pageTextLines(count, rowText, isHidden) {
  const out = [];
  for (let r = 0; r < count; r++) {
    if (isHidden && isHidden(r)) continue;
    out.push({ row: r, text: String(rowText(r) || '').replace(/\s+$/, '') });
  }
  return out;
}

// 要捲到的那一行：row 那一列被藏起來時找它之前最近的一行；找不到就第一行。回傳 lines 的索引。
export function lineIndexForRow(lines, row) {
  if (row == null || !lines.length) return -1;
  let best = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].row > row) break;
    best = i;
  }
  return best;
}

// 共用 data-row（＝row）的 count 行裡，手指下那一行（lineText）真正是第幾列：在 row..row+count-1
// 依序找第一個文字含有它的列。空白行、找不到 ⇒ row。畫面空白是 &nbsp;，先換回一般空白再比。
export function rowForLine(row, count, lineText, rowText) {
  const needle = String(lineText || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  if (!needle || !(count > 1)) return row;
  for (let j = 0; j < count; j++) {
    const hay = String(rowText(row + j) || '').replace(/\s+/g, ' ');
    if (hay.indexOf(needle) >= 0) return row + j;
  }
  return row;
}

export function SelectTextPage(core) {
  this._core = core;
  this._listeners = new Set();
  this._state = { open: false, lines: [], focusIndex: -1 };
}

SelectTextPage.prototype = {
  get state() {
    return this._state;
  },

  onChange: function(fn) {
    this._listeners.add(fn);
    fn(this._state);
    const set = this._listeners;
    return function() {
      set.delete(fn);
    };
  },

  _set: function(next) {
    this._state = next;
    this._listeners.forEach(function(fn) {
      fn(next);
    });
  },

  // 畫面這一份文字的來源；不是好讀累積頁／唯讀頁就是 null（入口不出現）。
  _source: function() {
    const core = this._core;
    const view = core && core.view;
    const buf = view && view.buf;
    if (!view || !buf) return null;
    const lines = view._renderedLines;
    if (!lines || !lines.length) return null;
    const accumulated = lines === buf.pageLines;
    const saved = !!view._staticRows && lines === view._staticRows;
    if (!accumulated && !saved) return null;
    return { view: view, buf: buf, lines: lines };
  },

  // 入口要不要出現（開「更多」／長按選單的那一刻算）。
  available: function() {
    const core = this._core;
    if (!core || !core.mobile) return false;
    if (!readEffectivePrefs().mobileSelectTextPage) return false;
    return !!this._source();
  },

  // 手指下那個畫面列元素 → 畫面列號。同作者推文合併塊（mergeSameAuthorComments）與推文卡片裡，
  // 好幾行 bbsline 共用第一則的 data-row ⇒ 用那一行的文字在後面幾列裡找它真正住的那一列
  // （rowForLine）；找不到就是第一則。
  rowOfElement: function(rowEl) {
    if (!rowEl) return null;
    const row = Number(rowEl.getAttribute('data-row'));
    if (isNaN(row)) return null;
    const cont = rowEl.closest ? rowEl.closest('#mainContainer') : null;
    const src = this._source();
    if (!cont || !src) return row;
    const same = cont.querySelectorAll('[data-type="bbsline"][data-row="' + row + '"]').length;
    return rowForLine(
      row,
      same,
      rowEl.textContent,
      function(r) {
        return r < src.lines.length ? src.buf.getRowText(r, 0, src.buf.cols, src.lines) : '';
      }
    );
  },

  // 畫面上方約 1/3 高那一列的列號（「更多」開的：捲到使用者正在讀的地方）。elementsFromPoint
  // 穿過正在收起的 sheet／App Bar 這類浮層；找不到 ⇒ null（從頭開）。
  rowAtViewport: function() {
    if (typeof document === 'undefined' || typeof document.elementsFromPoint !== 'function') return null;
    const y = Math.round(window.innerHeight / 3);
    const els = document.elementsFromPoint(Math.round(window.innerWidth / 2), y);
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      const line = el.closest ? el.closest('#mainContainer [data-type="bbsline"]') : null;
      if (line) return this.rowOfElement(line);
    }
    return null;
  },

  // row：要捲到的那一列（畫面列號）；null ＝從頭開。
  open: function(row) {
    if (!this.available()) return false;
    const src = this._source();
    const ctl = src.view.componentScreen;
    const ann = (ctl && ctl._annotations) || [];
    const lines = pageTextLines(
      src.lines.length,
      function(r) {
        return src.buf.getRowText(r, 0, src.buf.cols, src.lines);
      },
      function(r) {
        return annotationHidesRow(ann[r]);
      }
    );
    this._set({ open: true, lines: lines, focusIndex: lineIndexForRow(lines, row) });
    return true;
  },

  close: function() {
    if (!this._state.open) return;
    this._set({ open: false, lines: [], focusIndex: -1 });
  },
};
