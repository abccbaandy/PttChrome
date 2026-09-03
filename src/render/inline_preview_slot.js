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
//
// ---- 疊層佔位：DOM 結構與硬不變量（2026-09）----
// 每個 slot 固定長這樣：
//   .inlinePreviewSlot        display:grid（靜態 CSS，runtime 永不寫 inline style）
//     .inlinePreviewContent   React root／真圖／讀取中指示器都在這層
//     .inlinePreviewSpacer    佔位高度（min-height）＋卸載期／載入中的替身盒
// 兩層疊在同一個 grid area ⇒ slot 高度 = **max**(內容, 佔位)，不是相加。
//
// **硬不變量：`.inlinePreviewSlot` 與 `.inlinePreviewContent` 在 runtime 一律不得被
// 寫 inline style。** 它們是捲動錨點的祖先（讀者停在圖片中間時錨點就在這裡面），
// 改動 min-height/height/padding/margin/position/transform 任一項都會命中 CSS Scroll
// Anchoring 的 suppression trigger ⇒ 瀏覽器當幀放棄補償上方內容的高度變化 ⇒ 讀者被
// 整整推走一次塌陷量。實測 438px ＝ 一次 PgUp 的 76.6%，兩張圖就吃掉一整次 PgUp
// （使用者回報「多圖時 PgUp 捲不上去、甚至來回跳」的根因）。佔位高度一律寫在
// spacer（**兄弟**節點，不是祖先）上。同理不要在捲動期間對 .main 寫 transform。
// 長頁的捲動位置全部交給瀏覽器內建的 scroll anchoring —— 實測它在 .main 上涵蓋得比
// 自己算更全面（連 transform:scale 與整批節點重建都涵蓋）。
//
// 疊層還順帶收掉兩個坑：
//   1. **掛載當下不再塌陷**：舊版 mount() 先拿掉替身盒、再放進「讀取中」指示器
//      （494 → 56），現在替身盒住在 spacer 裡，取 max ⇒ 全程維持原高度，直到真圖
//      佔到版面才讓位（syncGhost 的判準因此從「有沒有掛載」改成「內容裡有沒有真的
//      佔到版面的媒體」）。
//   2. 量內容高度不必再「拿掉自己的 min-height 再放回去」：content 永遠沒有 inline
//      style，量到的就是純內容高度，舊版那種「過期偏大的值自我增強成永久假空白」
//      的路徑隨結構消失。
//
// ---- 量測結果為什麼要放 module 級（2026-08）----
// pinned/aspect 原本只活在 slot 的閉包裡，節點被 disposeNode 收掉就一起沒了。可是
// **任何會改動 annotationsKey 的操作都走全量重建**（AI 校正逐筆回填最頻繁，一篇文章
// 數十次；還有圖文並排、黑名單、樓號、字級…）⇒ 重建出來的 slot 是全新物件、
// 佔位高度歸零 ⇒ 整份長頁的圖片佔位盒同時塌陷，再等 IntersectionObserver → mount
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
  slotFloorHeight,
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
  // 疊層佔位（見檔頭）：content 放真內容、spacer 放佔位高度與替身盒，兩層疊在同一個
  // grid area ⇒ slot 高度取 max。**node 與 content 一輩子不得有 inline style。**
  const node = el("div", { class: "inlinePreviewSlot" });
  const content = el("div", { class: "inlinePreviewContent" });
  const spacer = el("div", { class: "inlinePreviewSpacer" });
  node.appendChild(content);
  node.appendChild(spacer);

  // 同一個 href 之前量過的話直接接手（見檔頭「量測結果為什麼要放 module 級」）。
  const memo = recallSize(href);

  const state = {
    mounted: false,
    // { [sizeMode]: height }：各尺寸模式下實測到的內容高度。null ＝ 都還沒量過。
    pinned: memo ? memo.pinned : null,
    // { w, h }：媒體原尺寸，真圖還沒佔到版面時拿來擺同比例的替身盒。
    aspect: memo ? memo.aspect : null,
    sizeMode,
    destroyed: false,
  };
  // 兩個 observer 各自回報一半的事實，合起來才是決策輸入。
  const facts = { mounted: !supported, near: false, far: false };

  let ghost = null;
  // 目前這個替身盒是用哪組原尺寸建的（recordSlotAspect 值沒變就回同一個物件，
  // 所以比參考即可）。syncGhost 每次尺寸回報都會跑，靠它 bail out 免得反覆重建。
  let ghostAspect = null;

  // 佔位高度**只寫 spacer**（兄弟節點）。寫 node/content 會抑制瀏覽器的捲動補償，
  // 見檔頭硬不變量。用 min-height 而非 height：spacer 裡還可能有替身盒，兩者取大。
  function applyFloorHeight() {
    const floor = slotFloorHeight(state.pinned, state.sizeMode);
    // slotFloorHeight 回的是數字；補 px。
    if (floor) spacer.style.minHeight = `${floor}px`;
    else spacer.style.removeProperty("min-height");
  }

  function removeGhost() {
    if (ghost) {
      ghost.remove();
      ghost = null;
      ghostAspect = null;
    }
  }

  // 真圖還沒佔到版面時的替身盒：套的是**跟真圖同一組** .easyReadingImg 規則（max-width/
  // max-height、放大態的 width:100%），只多給原尺寸 —— 於是高度由 CSS 自己算出來，
  // 與真圖逐像素相同，兩種模式都準，也不必在 JS 裡複製任何 CSS 常數。--ghost-w 走
  // CSS 變數而非 inline width：inline 樣式會蓋過放大態的 width:100%，變數則讓那條
  // 規則照常勝出。
  function syncGhost() {
    // 判準是「內容裡有沒有**真的佔到版面**的媒體」，不是「有沒有掛載」：掛載到圖片
    // 真的畫出來之間還隔著解析網址＋下載＋解碼（imgur 台灣連線常 stall，產品端又
    // 沒有載入 timeout），那段期間 content 只有 56px 的「讀取中」指示器。替身盒留在
    // spacer 裡頂著，slot 高度才不會在 mount 當幀塌陷 438px。
    // 替身盒只在量到過 aspect（＝真的載出過媒體、有原尺寸）時才存在，所以
    // 「非媒體連結」與「從沒載成功過的圖」不會因此留下假空白。
    // 沒掛載時不必查 DOM：內容層必然是空的（unmountFrom 同步清掉 React 的節點）。
    const want =
      state.aspect && (!state.mounted || !hasLoadedMedia(content))
        ? state.aspect
        : null;
    if (!want) {
      removeGhost();
      return;
    }
    if (ghost && ghostAspect === want) return;
    removeGhost();
    ghost = el("div", {
      class: "easyReadingImg inlinePreviewGhost",
      style: {
        "--ghost-w": `${want.w}px`,
        aspectRatio: `${want.w} / ${want.h}`,
      },
    });
    ghostAspect = want;
    spacer.appendChild(ghost);
  }

  // 量到的東西一律回寫 memo，下一次重建才接得住。
  function remember() {
    rememberSize(href, state.pinned, state.aspect);
  }

  function mount() {
    if (state.mounted || state.destroyed) return;
    state.mounted = true;
    renderInto(
      content,
      React.createElement(ImagePreviewer, {
        request: requestPreview(href),
        component: ImagePreviewer.Inline,
      }),
    );
    // 替身盒**不在這裡拿掉**：真圖佔到版面之前它還得繼續頂著（見 syncGhost）。
    syncGhost();
    applyFloorHeight();
  }

  function unmount() {
    if (!state.mounted) return;
    state.mounted = false;
    unmountFrom(content);
    syncGhost();
    applyFloorHeight();
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
      const measured = content.offsetHeight;
      const hasMedia = !!content.querySelector(LAZY_MEDIA_SELECTOR);
      const prevPinned = state.pinned;
      const prevAspect = state.aspect;
      state.pinned = recordSlotHeight(
        state.pinned,
        state.sizeMode,
        measured,
        hasMedia,
      );
      if (hasMedia) {
        const it = measureIntrinsic(content);
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
    const loaded = hasLoadedMedia(content);
    const prevPinned = state.pinned;
    const prevAspect = state.aspect;
    state.pinned = recordSlotHeight(
      state.pinned,
      state.sizeMode,
      content.offsetHeight,
      loaded,
    );
    applyFloorHeight();
    if (loaded) {
      const it = measureIntrinsic(content);
      state.aspect = recordSlotAspect(state.aspect, it.count, it.w, it.h);
    }
    // 真圖一佔到版面就讓替身盒退場（loaded=false 時它得繼續頂著）。
    syncGhost();
    if (state.pinned !== prevPinned || state.aspect !== prevAspect) remember();
  }

  // memo 命中 ⇒ 這個節點在**第一幀**就要有高度，不能等 observer 回報（那是下一個
  // task 以後的事，中間會先畫出一幀塌陷 —— 正是本次要修掉的症狀）。
  if (memo) {
    applyFloorHeight();
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
    // 觀察 **content** 而不是 slot：疊層之後 slot 高度取 max，spacer 撐著的時候
    // 「讀取中 56px → 真圖 494px」不會改變 slot 高度 ⇒ 觀察 slot 就永遠收不到那次
    // 回報，實測高度也就永遠記不進 pinned。
    sizeCallbacks.set(content, onResize);
    obs.observe(content);
    sizeTeardown.set(node, () => {
      sizeCallbacks.delete(content);
      obs.unobserve(content);
    });
  }

  return {
    el: node,
    setSizeMode(mode) {
      if (state.sizeMode === mode || state.destroyed) return;
      state.sizeMode = mode;
      applyFloorHeight();
    },
    // 版面寬度變了 ⇒ 這個 slot 的 pinned 也過期。規則同
    // invalidateInlinePreviewHeights：有替身盒可頂就丟掉，沒有就留著當最佳猜測。
    invalidatePinned() {
      if (state.destroyed || !state.pinned || !state.aspect) return;
      state.pinned = null;
      remember();
      applyFloorHeight();
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
        unmountFrom(content);
      }
    },
  };
}
