import React from "react";
import ImagePreviewer, { requestPreview } from "./ImagePreviewer";
import {
  LAZY_MEDIA_SELECTOR,
  LAZY_MOUNT_MARGIN_PX,
  LAZY_UNMOUNT_MARGIN_PX,
  nextLazyState,
  recordSlotAspect,
  recordSlotHeight,
  slotMinHeight,
} from "../js/lazy_media";

// 好讀自動開圖的延遲載入外殼。決策與門檻在 src/js/lazy_media.js（純邏輯、unit
// 守護），這裡只負責觀察與掛載/卸載。
//
// 關鍵：**沒進入視野就連 requestPreview() 都不呼叫** —— 它一被呼叫就開始解析網址
// （imgur 無副檔名的還會發兩個 HEAD 探測），單純給 <img> 加 loading="lazy" 攔不到。
//
// 兩個共用的 IntersectionObserver（root ＝ viewport；.main 的裁切會被算進交集，
// 所以捲出捲動容器的列自然回報 isIntersecting=false）：
//   near — rootMargin LAZY_MOUNT_MARGIN_PX  → 相交即掛載
//   far  — rootMargin LAZY_UNMOUNT_MARGIN_PX → 不相交即卸載（釋放已解碼的點陣圖）
// 兩個邊界之間是遲滯區，避免在邊界來回捲動時反覆重載。
const callbacks = new WeakMap();
let nearObserver = null;
let farObserver = null;

// 目前的圖片尺寸模式（點圖放大／縮小，Screen.jsx 的 imagesEnlarged）。佔位盒的高度
// 是分模式各記一筆的，故要知道當下是哪一種（見 lazy_media.recordSlotHeight）。
//
// 走 context 而非 prop：Screen 對 <Row> 有 element 快取（交回同一個 element 物件讓
// React 走 bailout），新 prop 傳不進來；context consumer 即使父層 bailout 仍會被排程
// 更新。日後若有別的「會改圖片尺寸」的狀態（如圖文合併的欄寬），併進這個值即可。
export const PreviewSizeModeContext = React.createContext("normal");

// 媒體載入完成／尺寸改變時把高度記進當下模式那一格，這樣「還沒在這個模式下卸載過」
// 的圖也有高度可用（見 lazy_media.recordSlotHeight 的時機說明）。
let sizeObserver = null;
const sizeCallbacks = new WeakMap();

export const lazyPreviewSupported = () =>
  typeof IntersectionObserver === "function";

const sizeObserverSupported = () => typeof ResizeObserver === "function";

// slot 裡有沒有**已經佔到版面**的媒體。單純 querySelector 不夠：FallbackImage 在載入
// 完成前就已經把 <img> 放進 DOM（只是 display:none）並疊一層「讀取中…」指示器，這時
// 量到的是指示器的高度，記進去會變成假空白（同 recordSlotHeight 註解裡的 65px 實例）。
function hasLoadedMedia(el) {
  const media = el.querySelectorAll(LAZY_MEDIA_SELECTOR);
  for (let i = 0; i < media.length; ++i) {
    if (media[i].offsetHeight > 0) return true;
  }
  return false;
}

// 媒體的原尺寸。<img> 是 naturalWidth/Height、<video> 是 videoWidth/Height；
// <iframe> 沒有原尺寸（回 0），那種 slot 只能靠分模式記的高度。
function measureIntrinsic(el) {
  const media = el.querySelectorAll(LAZY_MEDIA_SELECTOR);
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
// 把 module 級的 observer 丟掉重建。
export function resetLazyObserversForTest() {
  nearObserver = null;
  farObserver = null;
  sizeObserver = null;
}

export const LazyInlinePreview = React.memo(function LazyInlinePreview({
  href,
}) {
  // 不支援 IntersectionObserver（jsdom／很舊的環境）⇒ 直接照舊立即掛載，
  // 行為與這個功能不存在時完全相同。
  const supported = lazyPreviewSupported();
  const [mounted, setMounted] = React.useState(!supported);
  // { [sizeMode]: height }：各尺寸模式下實測到的內容高度。null ＝ 都還沒量過。
  const [pinned, setPinned] = React.useState(null);
  // { w, h }：媒體原尺寸，卸載期間拿來擺同比例的替身盒（見下方 ghost）。
  const [aspect, setAspect] = React.useState(null);
  const slotRef = React.useRef(null);
  // observer callback 的 effect deps 只有 [supported]（不因 state 重掛），直接閉包
  // 會讀到建立當下的舊模式 ⇒ 用 ref 每次 render 同步最新值。
  const sizeMode = React.useContext(PreviewSizeModeContext);
  const sizeModeRef = React.useRef(sizeMode);
  sizeModeRef.current = sizeMode;
  // 兩個 observer 各自回報一半的事實，合起來才是決策輸入 —— 存在 ref 裡，
  // 這樣 callback 不必因為 state 改變而重掛。
  const factsRef = React.useRef({
    mounted: !supported,
    near: false,
    far: false,
  });
  factsRef.current.mounted = mounted;

  React.useEffect(() => {
    if (!supported) return undefined;
    const el = slotRef.current;
    if (!el) return undefined;
    ensureObservers();
    // 抓住**這次**用的 observer 交給 cleanup：module 級的變數可能已經被換掉
    // （測試的 resetLazyObserversForTest），unobserve 不能靠讀當下的模組狀態。
    const nearObs = nearObserver;
    const farObs = farObserver;
    callbacks.set(el, (kind, isIntersecting) => {
      const facts = factsRef.current;
      if (kind === "near") facts.near = isIntersecting;
      else facts.far = !isIntersecting;
      const action = nextLazyState(facts);
      if (action === "mount") {
        facts.mounted = true;
        setMounted(true);
      } else if (action === "unmount") {
        // 先量再卸：卸載後高度歸零，這個值就拿不到了。
        // 同時確認 slot 內是不是**真的**有媒體：只有「讀取中…」指示器／載入失敗
        // 提示／非媒體網址時，量到的高度不是內容高度，釘住它會變成永久空白
        // （recordSlotHeight 的註解有實例）。
        const measured = el.offsetHeight;
        const hasMedia = !!el.querySelector(LAZY_MEDIA_SELECTOR);
        setPinned((prev) =>
          recordSlotHeight(prev, sizeModeRef.current, measured, hasMedia),
        );
        if (hasMedia) {
          const it = measureIntrinsic(el);
          setAspect((prev) => recordSlotAspect(prev, it.count, it.w, it.h));
        }
        facts.mounted = false;
        setMounted(false);
      }
    });
    nearObs.observe(el);
    farObs.observe(el);
    return () => {
      callbacks.delete(el);
      nearObs.unobserve(el);
      farObs.unobserve(el);
    };
  }, [supported]);

  // 媒體載入完成／點圖切換模式造成的尺寸改變都會走這裡，把新高度記進**當下模式**
  // 那一格。少了這一手，只有「在該模式下卸載過」的圖才有高度，而使用者的典型動線
  // （normal 看幾張 → 點放大 → 往下捲才卸載）永遠不會替 normal 那格留值 ⇒ 切回去
  // 佔位盒塌陷、往上捲時圖一張張撐開把閱讀位置往下推（症狀：捲一捲就跳頁）。
  React.useEffect(() => {
    if (!sizeObserverSupported()) return undefined;
    const el = slotRef.current;
    if (!el) return undefined;
    ensureSizeObserver();
    const obs = sizeObserver;
    sizeCallbacks.set(el, () => {
      const loaded = hasLoadedMedia(el);
      // 量 slot 自己（與卸載路徑同一把尺，含圖片的 margin、相簿的多張圖）。
      // 這個模式還沒有記錄時 min-height 不會套用 ⇒ 量到的就是純內容高度；已有記錄
      // 時 offsetHeight 至多等於那個值，寫回去也是同值（recordSlotHeight 會 bail out）。
      setPinned((prev) =>
        recordSlotHeight(prev, sizeModeRef.current, el.offsetHeight, loaded),
      );
      if (!loaded) return;
      const it = measureIntrinsic(el);
      setAspect((prev) => recordSlotAspect(prev, it.count, it.w, it.h));
    });
    obs.observe(el);
    return () => {
      sizeCallbacks.delete(el);
      obs.unobserve(el);
    };
  }, []);

  const minHeight = slotMinHeight(pinned, sizeMode);
  return (
    <div
      ref={slotRef}
      className="inlinePreviewSlot"
      style={minHeight ? { minHeight } : undefined}
    >
      {/* 卸載期間的替身盒：套的是**跟真圖同一組** .easyReadingImg 規則
          （max-width/max-height、放大態的 width:100%），只多給原尺寸 ——
          於是高度由 CSS 自己算出來，與真圖逐像素相同，兩種模式都準，也不必在 JS
          裡複製任何 CSS 常數。--ghost-w 走 CSS 變數而非 inline width：inline 樣式
          會蓋過放大態的 width:100%，變數則讓那條規則照常勝出。 */}
      {!mounted && aspect && (
        <div
          className="easyReadingImg inlinePreviewGhost"
          style={{
            "--ghost-w": `${aspect.w}px`,
            aspectRatio: `${aspect.w} / ${aspect.h}`,
          }}
        />
      )}
      {mounted && (
        <ImagePreviewer
          request={requestPreview(href)}
          component={ImagePreviewer.Inline}
        />
      )}
    </div>
  );
});

export default LazyInlinePreview;
