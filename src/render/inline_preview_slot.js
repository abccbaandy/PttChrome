// 好讀自動開圖的延遲載入佔位盒（原 src/components/LazyInlinePreview.jsx 的純 JS 版）。
//
// 決策與門檻仍在 src/js/lazy_media.js（純函式、unit 守護，一字未改），這裡只負責
// 觀察與掛載/卸載。
//
// 關鍵：**沒進入視野就連 requestPreview() 都不呼叫** —— 它一被呼叫就開始解析網址
// （imgur 無副檔名的還會發兩個 HEAD 探測），單純給 <img> 加 loading="lazy" 攔不到。
//
// 兩個共用的 IntersectionObserver（root ＝ viewport；.main 的裁切會被算進交集，
// 所以捲出捲動容器的列自然回報 isIntersecting=false）：
//   near — rootMargin LAZY_MOUNT_MARGIN_PX  → 相交即掛載
//   far  — rootMargin LAZY_UNMOUNT_MARGIN_PX → 不相交即卸載（釋放已解碼的點陣圖）
// 兩個邊界之間是遲滯區，避免在邊界來回捲動時反覆重載。
//
// **ImagePreviewer 仍是 React**（唯一留在核心畫面裡的 React 葉子島）：一張圖進視野
// 才開一個 root、捲遠就 unmount，同時存活的數量是「視野內」等級，不在每幀熱路徑上。
// 佔位盒本身（含替身盒 ghost）是純 JS —— 它每一列都有，才是熱路徑。
// 替身盒與 previewer 在舊版就是互斥的（`!mounted && ghost` / `mounted && previewer`），
// 所以 React root 可以直接開在 slot 節點上，DOM 結構與舊版逐字相同。
//
// ---- 量測結果為什麼要放 module 級（2026-08）----
// pinned/aspect 原本只活在 slot 的閉包裡，節點被 disposeNode 收掉就一起沒了。可是
// **任何會改動 annotationsKey 的操作都走全量重建**（AI 校正逐筆回填最頻繁，一篇文章
// 數十次；還有圖文並排、黑名單、樓號、字級…）⇒ 重建出來的 slot 是全新物件、
// minHeight 歸零 ⇒ 整份長頁的圖片佔位盒同時塌陷，再等 IntersectionObserver → mount
// → onLoad → ResizeObserver 這串非同步流程才撐回來（症狀：閃爍、閱讀位置往下跳）。
// 所以量到的東西改存在以 href 為鍵的 module 級 memo，重建的 slot 第一幀就有高度。
//
// memo 存兩種量測，**有效範圍不同**，不可混為一談：
//   aspect（媒體原尺寸）— 與版面寬度**無關**。替身盒套的是跟真圖同一組 CSS
//     （.easyReadingImg + --ghost-w + aspect-ratio），寬度換了高度自己會跟著算對
//     （含 .mergedImageCol 的窄欄）⇒ 可以無條件跨重建、跨文章重用。
//   pinned（分尺寸模式的實測高度）— 只在**版面寬度不變**時成立。字級／視窗 resize
//     與圖文並排切換都會改寬度 ⇒ 由 invalidateInlinePreviewHeights() 清掉（見該函式）。
import React from "react";
import ImagePreviewer, { requestPreview } from "../components/ImagePreviewer";
import { renderInto, unmountFrom } from "../js/react_root";
import { el } from "./dom";
import {
  LAZY_MEDIA_SELECTOR,
  LAZY_MOUNT_MARGIN_PX,
  LAZY_UNMOUNT_MARGIN_PX,
  nextLazyState,
  recordSlotAspect,
  recordSlotHeight,
  slotMinHeight,
} from "../js/lazy_media";

const callbacks = new WeakMap();
let nearObserver = null;
let farObserver = null;

// 媒體載入完成／尺寸改變時把高度記進當下模式那一格，這樣「還沒在這個模式下卸載過」
// 的圖也有高度可用（見 lazy_media.recordSlotHeight 的時機說明）。
let sizeObserver = null;
const sizeCallbacks = new WeakMap();

// 每個 slot 節點的解除觀察函式（destroy 用）。
const slotTeardown = new WeakMap();
const sizeTeardown = new WeakMap();

// ---------------------------------------------------------------- 量測 memo
// href → { pinned, aspect }。跨 slot 重建、跨文章保留（同一張圖再看到就直接有正確
// 佔位）。Map 的插入順序即 LRU 順序：命中時 delete+set 刷新，超過上限刪最舊的。
const sizeMemo = new Map();
export const SIZE_MEMO_MAX = 500;

function recallSize(href) {
  const entry = sizeMemo.get(href);
  if (!entry) return null;
  sizeMemo.delete(href);
  sizeMemo.set(href, entry);
  return entry;
}

function rememberSize(href, pinned, aspect) {
  let entry = sizeMemo.get(href);
  if (entry) {
    sizeMemo.delete(href);
    entry.pinned = pinned;
    entry.aspect = aspect;
  } else {
    entry = { pinned: pinned, aspect: aspect };
  }
  sizeMemo.set(href, entry);
  if (sizeMemo.size > SIZE_MEMO_MAX) {
    sizeMemo.delete(sizeMemo.keys().next().value);
  }
}

// 版面寬度改變了（字級／視窗 resize、圖文並排切換）⇒ pinned 全部過期。
// **只清有 aspect 的那些**：那些 slot 的替身盒能在新寬度下自己算出正確高度，交給它
// 更準；沒有 aspect 的（iframe、相簿）留著舊值當最佳猜測 —— iframe 是固定
// height:450px，本來就與寬度無關，丟掉只換來一次無謂的塌陷。
// 呼叫端是 render/screen.js#notifyLayoutChanged（同時廣播給存活中的 slot）。
export function invalidateInlinePreviewHeights() {
  for (const entry of sizeMemo.values()) {
    if (entry.aspect) entry.pinned = null;
  }
}

export const lazyPreviewSupported = () =>
  typeof IntersectionObserver === "function";

const sizeObserverSupported = () => typeof ResizeObserver === "function";

// slot 裡有沒有**已經佔到版面**的媒體。單純 querySelector 不夠：FallbackImage 在載入
// 完成前就已經把 <img> 放進 DOM（只是 display:none）並疊一層「讀取中…」指示器，這時
// 量到的是指示器的高度，記進去會變成假空白（同 recordSlotHeight 註解裡的 65px 實例）。
function hasLoadedMedia(node) {
  const media = node.querySelectorAll(LAZY_MEDIA_SELECTOR);
  for (let i = 0; i < media.length; ++i) {
    if (media[i].offsetHeight > 0) return true;
  }
  return false;
}

// 內容高度。**量之前一定要先拿掉自己的 inline min-height**：offsetHeight 會被它墊高，
// 於是一個過期偏大的值（memo 帶進來的、或版面寬度變了以後的）會被原封不動地再記錄
// 一次 ⇒ 自我增強的永久假空白，而且愈量愈黏。同一個 task 內拿掉再補回，中間不會有
// 畫面被畫出來。
function measureContentHeight(node) {
  const had = node.style.minHeight;
  if (!had) return node.offsetHeight;
  node.style.removeProperty("min-height");
  const h = node.offsetHeight;
  node.style.minHeight = had;
  return h;
}

// 媒體的原尺寸。<img> 是 naturalWidth/Height、<video> 是 videoWidth/Height；
// <iframe> 沒有原尺寸（回 0），那種 slot 只能靠分模式記的高度。
function measureIntrinsic(node) {
  const media = node.querySelectorAll(LAZY_MEDIA_SELECTOR);
  if (media.length !== 1) return { count: media.length, w: 0, h: 0 };
  const m = media[0];
  return {
    count: 1,
    w: m.naturalWidth || m.videoWidth || 0,
    h: m.naturalHeight || m.videoHeight || 0,
  };
}

function ensureObservers() {
  if (nearObserver || !lazyPreviewSupported()) return;
  const dispatch = (kind) => (entries) => {
    for (let i = 0; i < entries.length; ++i) {
      const cb = callbacks.get(entries[i].target);
      if (cb) cb(kind, entries[i].isIntersecting);
    }
  };
  nearObserver = new IntersectionObserver(dispatch("near"), {
    rootMargin: LAZY_MOUNT_MARGIN_PX + "px 0px",
  });
  farObserver = new IntersectionObserver(dispatch("far"), {
    rootMargin: LAZY_UNMOUNT_MARGIN_PX + "px 0px",
  });
}

function ensureSizeObserver() {
  if (sizeObserver || !sizeObserverSupported()) return;
  sizeObserver = new ResizeObserver((entries) => {
    for (let i = 0; i < entries.length; ++i) {
      const cb = sizeCallbacks.get(entries[i].target);
      if (cb) cb();
    }
  });
}

// 測試用逃生門：jsdom 沒有 IntersectionObserver，測試會注入一個假的，之後必須能
// 把 module 級的 observer 丟掉重建。量測 memo 同為 module 級狀態，一併清掉 ——
// 既有測試都已在 beforeEach/afterEach 呼叫它，跨測試隔離因此自動成立。
export function resetLazyObserversForTest() {
  nearObserver = null;
  farObserver = null;
  sizeObserver = null;
  sizeMemo.clear();
}

// 一個佔位盒。回傳的 slot 由 renderer（screen.js）持有；列被換掉時**必須**呼叫
// destroy()，否則 observer 與 React root 都會留著（純 JS 化唯一新增的洩漏面，
// tests/unit/render_dispose.test.js 守）。
//
// sizeMode（"normal" | "enlarged"）原本走 React context（Screen 的 imagesEnlarged），
// 純 JS 版改由 ScreenController 對存活中的 slot 逐一 setSizeMode()。
export function createInlinePreviewSlot(href, sizeMode = "normal") {
  const supported = lazyPreviewSupported();
  const node = el("div", { class: "inlinePreviewSlot" });

  // 同一個 href 之前量過的話直接接手（見檔頭「量測結果為什麼要放 module 級」）。
  const memo = recallSize(href);

  const state = {
    mounted: false,
    // { [sizeMode]: height }：各尺寸模式下實測到的內容高度。null ＝ 都還沒量過。
    pinned: memo ? memo.pinned : null,
    // { w, h }：媒體原尺寸，卸載期間拿來擺同比例的替身盒。
    aspect: memo ? memo.aspect : null,
    sizeMode,
    destroyed: false,
  };
  // 兩個 observer 各自回報一半的事實，合起來才是決策輸入。
  const facts = { mounted: !supported, near: false, far: false };

  let ghost = null;

  function applyMinHeight() {
    const minHeight = slotMinHeight(state.pinned, state.sizeMode);
    // slotMinHeight 回的是數字；補 px（舊版靠 React 的 style 物件自動補）。
    if (minHeight) node.style.minHeight = `${minHeight}px`;
    else node.style.removeProperty("min-height");
  }

  function removeGhost() {
    if (ghost) {
      ghost.remove();
      ghost = null;
    }
  }

  // 卸載期間的替身盒：套的是**跟真圖同一組** .easyReadingImg 規則（max-width/
  // max-height、放大態的 width:100%），只多給原尺寸 —— 於是高度由 CSS 自己算出來，
  // 與真圖逐像素相同，兩種模式都準，也不必在 JS 裡複製任何 CSS 常數。--ghost-w 走
  // CSS 變數而非 inline width：inline 樣式會蓋過放大態的 width:100%，變數則讓那條
  // 規則照常勝出。
  function syncGhost() {
    const want = !state.mounted && state.aspect;
    if (!want) {
      removeGhost();
      return;
    }
    removeGhost();
    ghost = el("div", {
      class: "easyReadingImg inlinePreviewGhost",
      style: {
        "--ghost-w": `${state.aspect.w}px`,
        aspectRatio: `${state.aspect.w} / ${state.aspect.h}`,
      },
    });
    node.appendChild(ghost);
  }

  // 量到的東西一律回寫 memo，下一次重建才接得住。
  function remember() {
    rememberSize(href, state.pinned, state.aspect);
  }

  function mount() {
    if (state.mounted || state.destroyed) return;
    state.mounted = true;
    removeGhost();
    renderInto(
      node,
      React.createElement(ImagePreviewer, {
        request: requestPreview(href),
        component: ImagePreviewer.Inline,
      }),
    );
    applyMinHeight();
  }

  function unmount() {
    if (!state.mounted) return;
    state.mounted = false;
    unmountFrom(node);
    syncGhost();
    applyMinHeight();
  }

  function onIntersect(kind, isIntersecting) {
    if (state.destroyed) return;
    if (kind === "near") facts.near = isIntersecting;
    else facts.far = !isIntersecting;
    const action = nextLazyState(facts);
    if (action === "mount") {
      facts.mounted = true;
      mount();
    } else if (action === "unmount") {
      // 先量再卸：卸載後高度歸零，這個值就拿不到了。同時確認 slot 內是不是**真的**
      // 有媒體：只有「讀取中…」指示器／載入失敗提示／非媒體網址時，量到的高度不是
      // 內容高度，釘住它會變成永久空白（recordSlotHeight 的註解有實例）。
      const measured = measureContentHeight(node);
      const hasMedia = !!node.querySelector(LAZY_MEDIA_SELECTOR);
      const prevPinned = state.pinned;
      const prevAspect = state.aspect;
      state.pinned = recordSlotHeight(
        state.pinned,
        state.sizeMode,
        measured,
        hasMedia,
      );
      if (hasMedia) {
        const it = measureIntrinsic(node);
        state.aspect = recordSlotAspect(state.aspect, it.count, it.w, it.h);
      }
      if (state.pinned !== prevPinned || state.aspect !== prevAspect)
        remember();
      facts.mounted = false;
      unmount();
    }
  }

  // 媒體載入完成／點圖切換模式造成的尺寸改變都會走這裡，把新高度記進**當下模式**
  // 那一格。少了這一手，只有「在該模式下卸載過」的圖才有高度，而使用者的典型動線
  // （normal 看幾張 → 點放大 → 往下捲才卸載）永遠不會替 normal 那格留值 ⇒ 切回去
  // 佔位盒塌陷、往上捲時圖一張張撐開把閱讀位置往下推（症狀：捲一捲就跳頁）。
  function onResize() {
    if (state.destroyed) return;
    const loaded = hasLoadedMedia(node);
    const prevPinned = state.pinned;
    const prevAspect = state.aspect;
    state.pinned = recordSlotHeight(
      state.pinned,
      state.sizeMode,
      measureContentHeight(node),
      loaded,
    );
    applyMinHeight();
    if (loaded) {
      const it = measureIntrinsic(node);
      state.aspect = recordSlotAspect(state.aspect, it.count, it.w, it.h);
      syncGhost();
    }
    if (state.pinned !== prevPinned || state.aspect !== prevAspect) remember();
  }

  // memo 命中 ⇒ 這個節點在**第一幀**就要有高度，不能等 observer 回報（那是下一個
  // task 以後的事，中間會先畫出一幀塌陷 —— 正是本次要修掉的症狀）。
  if (memo) {
    applyMinHeight();
    syncGhost();
  }

  if (supported) {
    ensureObservers();
    // 抓住**這次**用的 observer 交給 destroy：module 級的變數可能已經被換掉
    // （測試的 resetLazyObserversForTest），unobserve 不能靠讀當下的模組狀態。
    const nearObs = nearObserver;
    const farObs = farObserver;
    callbacks.set(node, onIntersect);
    nearObs.observe(node);
    farObs.observe(node);
    slotTeardown.set(node, () => {
      callbacks.delete(node);
      nearObs.unobserve(node);
      farObs.unobserve(node);
    });
  } else {
    // 不支援 IntersectionObserver（jsdom／很舊的環境）⇒ 直接照舊立即掛載，
    // 行為與這個功能不存在時完全相同。
    mount();
  }

  if (sizeObserverSupported()) {
    ensureSizeObserver();
    const obs = sizeObserver;
    sizeCallbacks.set(node, onResize);
    obs.observe(node);
    sizeTeardown.set(node, () => {
      sizeCallbacks.delete(node);
      obs.unobserve(node);
    });
  }

  return {
    el: node,
    setSizeMode(mode) {
      if (state.sizeMode === mode || state.destroyed) return;
      state.sizeMode = mode;
      applyMinHeight();
    },
    // 版面寬度變了 ⇒ 這個 slot 的 pinned 也過期。規則同
    // invalidateInlinePreviewHeights：有替身盒可頂就丟掉，沒有就留著當最佳猜測。
    invalidatePinned() {
      if (state.destroyed || !state.pinned || !state.aspect) return;
      state.pinned = null;
      remember();
      applyMinHeight();
      syncGhost();
    },
    destroy() {
      if (state.destroyed) return;
      state.destroyed = true;
      const t1 = slotTeardown.get(node);
      if (t1) {
        t1();
        slotTeardown.delete(node);
      }
      const t2 = sizeTeardown.get(node);
      if (t2) {
        t2();
        sizeTeardown.delete(node);
      }
      if (state.mounted) {
        state.mounted = false;
        unmountFrom(node);
      }
    },
  };
}
