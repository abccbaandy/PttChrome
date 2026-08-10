import React from "react";
import ImagePreviewer, { requestPreview } from "./ImagePreviewer";
import {
  LAZY_MOUNT_MARGIN_PX,
  LAZY_UNMOUNT_MARGIN_PX,
  nextLazyState,
  nextSlotHeight,
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

export const lazyPreviewSupported = () =>
  typeof IntersectionObserver === "function";

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

// 測試用逃生門：jsdom 沒有 IntersectionObserver，測試會注入一個假的，之後必須能
// 把 module 級的 observer 丟掉重建。
export function resetLazyObserversForTest() {
  nearObserver = null;
  farObserver = null;
}

export const LazyInlinePreview = React.memo(function LazyInlinePreview({
  href,
}) {
  // 不支援 IntersectionObserver（jsdom／很舊的環境）⇒ 直接照舊立即掛載，
  // 行為與這個功能不存在時完全相同。
  const supported = lazyPreviewSupported();
  const [mounted, setMounted] = React.useState(!supported);
  const [slotHeight, setSlotHeight] = React.useState(0);
  const slotRef = React.useRef(null);
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
        const measured = el.offsetHeight;
        setSlotHeight((prev) => nextSlotHeight(prev, measured));
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

  return (
    <div
      ref={slotRef}
      className="inlinePreviewSlot"
      style={slotHeight ? { minHeight: slotHeight } : undefined}
    >
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
