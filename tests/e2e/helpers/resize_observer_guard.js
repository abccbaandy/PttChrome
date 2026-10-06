// `ResizeObserver loop completed with undelivered notifications` 的分類與守護。
//
// 這則訊息依規格是良性的：某一幀的 RO 派送途中有目標又變了尺寸、深度不夠深，這一幀
// 不再送，延到下一幀補送，然後在 window 報一個 error。有害的只有「回呼裡改尺寸 → 又觸發
// 自己」的真迴圈（例：行內預覽 slot 撐寬 grid 軌道那次，docs/easy-reading.md「slot 是單欄
// grid」）。所以不能整則吞掉，要看**是誰的 observer 沒送到**。
//
// CONFIRMED 來源（2026-10，Mantine 9.6.3／9.7.0 皆同）：offline 整套 57 次中 56 次的未送達
// 目標是 Mantine Menu 的 dropdown（floating-ui autoUpdate 建的 observer），剩 1 次是測試自己
// page.evaluate 建的 observer；本專案 observer（inline_preview_slot／bottom_stick）0 次。
// 機制：右鍵選單點項目 → 選單關閉（dropdown 170x44 → display:none）與設定 Modal 掛載
// （SegmentedControl／ScrollArea 的 observer 回呼觸發 React commit）落在同一幀的 RO 派送裡；
// dropdown 在 body 下層級淺，這一幀不再送，下一幀補送 0x0。floating-ui 只是替已隱藏的元素
// 重算位置，無可見症狀 ⇒ 良性，不修（改它得在 Mantine 內部動手）。
//
// 守護：installReplay 對每個 offline 頁面裝 installResizeObserverGuard。訊息發生當下
// （error 事件與 RO 派送同步，版面就是那一刻的版面）逐一比對每個被觀察目標「目前的
// border box」與「上次送出的 border box」，對不上的＝這一幀沒送到的目標；再依 observer
// 建立位置分類，**我們自己的（/src/）observer 有未送達目標就讓測試紅**。

const RO_LOOP_RE = /ResizeObserver loop/;
const OWN_LOOP_TAG = '[ro-guard:own-loop] ';

function isResizeObserverLoopMessage(message) {
  return RO_LOOP_RE.test(String(message || ''));
}

// `new ResizeObserver` 的呼叫端 stack frame（不含包裝層本身）→ 來源分類。
//   own     ＝ 本專案原始碼（dev server 下以 /src/ 提供）
//   library ＝ node_modules（Vite 預打包在 /node_modules/.vite/deps/）
//   other   ＝ 其餘（測試自己 page.evaluate 建的、瀏覽器擴充…）
function observerOrigin(callerFrame) {
  const s = String(callerFrame || '');
  if (/\/node_modules\//.test(s)) return 'library';
  if (/\/src\//.test(s)) return 'own';
  return 'other';
}

// 注入頁面的部分。addInitScript 只帶得進函式原始碼，所以 observerOrigin 以字串傳入。
function pageGuard({ originSrc, tag }) {
  const Orig = window.ResizeObserver;
  if (typeof Orig !== 'function' || Orig.__roGuarded) return;
  const observerOrigin = new Function('return (' + originSrc + ')')();
  // observer → { origin, caller, targets: Map<Element, {w,h}|null> }（null＝還沒送過）
  const registry = new Map();
  const state = { loops: [] };
  window.__roGuard = state;

  const describe = (el) =>
    el.tagName.toLowerCase() +
    (typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/).filter((c) => !/^m_/.test(c)).slice(0, 3).join('.')
      : '');

  class GuardedResizeObserver extends Orig {
    constructor(callback) {
      // 第一個 frame 是這個 constructor，第二個才是呼叫端。V8 的 stack 開頭多一行
      // "Error"、Firefox 沒有，先濾掉再數。
      const frames = (new Error().stack || '')
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s && !/^Error\b/.test(s));
      const caller = frames[1] || '';
      const info = { origin: observerOrigin(caller), caller, targets: new Map() };
      super((entries, obs) => {
        for (const e of entries) {
          const box = e.borderBoxSize && e.borderBoxSize[0];
          if (box && info.targets.has(e.target)) {
            info.targets.set(e.target, { w: box.inlineSize, h: box.blockSize });
          }
        }
        return callback(entries, obs);
      });
      registry.set(this, info);
    }
    observe(target, options) {
      const info = registry.get(this);
      if (info && !info.targets.has(target)) info.targets.set(target, null);
      return super.observe(target, options);
    }
    unobserve(target) {
      const info = registry.get(this);
      if (info) info.targets.delete(target);
      return super.unobserve(target);
    }
    disconnect() {
      const info = registry.get(this);
      if (info) info.targets.clear();
      return super.disconnect();
    }
  }
  GuardedResizeObserver.__roGuarded = true;
  window.ResizeObserver = GuardedResizeObserver;

  window.addEventListener('error', (ev) => {
    if (!/ResizeObserver loop/.test(ev.message || '')) return;
    const pending = [];
    for (const info of registry.values()) {
      for (const [el, last] of info.targets) {
        // offsetWidth/Height ＝ 不受 transform 影響的 border box（RO 的 borderBoxSize 同義）；
        // SVG 等沒有 offset* 的目標跳過。四捨五入誤差容忍 1px。
        if (typeof el.offsetWidth !== 'number') continue;
        const w = el.isConnected ? el.offsetWidth : 0;
        const h = el.isConnected ? el.offsetHeight : 0;
        const changed = last
          ? Math.abs(w - last.w) > 1 || Math.abs(h - last.h) > 1
          : w > 0 || h > 0;
        if (!changed) continue;
        pending.push({
          origin: info.origin,
          caller: info.caller,
          target: describe(el),
          from: last ? Math.round(last.w) + 'x' + Math.round(last.h) : 'unsent',
          to: w + 'x' + h,
        });
      }
    }
    state.loops.push(pending);
    const own = pending.filter((p) => p.origin === 'own');
    if (own.length) console.error(tag + JSON.stringify(own));
  });
}

// Node 端：裝進頁面，並把「我們自己的 observer 沒送到」轉成 soft 失敗（不中斷流程，
// 但該 test 會紅，訊息列出 observer 建立位置與目標）。
// failOnOwnLoop:false 只給守護自己的 spec 用（它要刻意製造 own loop 再讀 window.__roGuard）。
async function installResizeObserverGuard(page, { failOnOwnLoop = true } = {}) {
  const { expect } = require('@playwright/test');
  if (failOnOwnLoop) page.on('console', (msg) => {
    const text = msg.text();
    if (!text.startsWith(OWN_LOOP_TAG)) return;
    const own = JSON.parse(text.slice(OWN_LOOP_TAG.length));
    try {
      expect
        .soft(own, '本專案的 ResizeObserver 造成 layout 迴圈（見 tests/e2e/helpers/resize_observer_guard.js）')
        .toEqual([]);
    } catch {
      // test 已結束才收到（頁面收尾時）：沒有 testInfo 可記，忽略。
    }
  });
  await page.addInitScript(pageGuard, {
    originSrc: observerOrigin.toString(),
    tag: OWN_LOOP_TAG,
  });
}

module.exports = {
  isResizeObserverLoopMessage,
  observerOrigin,
  installResizeObserverGuard,
  OWN_LOOP_TAG,
};
