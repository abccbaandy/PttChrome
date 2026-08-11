// 好讀自動開圖的延遲載入／遠離卸載（src/components/LazyInlinePreview.jsx ＋
// src/js/lazy_media.js）。
//
// 背景：好讀把整篇累積成一長頁並對每個連結掛 inline 預覽。實錄的 EZsoft 長文有
// 287 個圖片連結，舊行為是一累積到就全部解析＋下載＋解碼、到離開文章前永不釋放
// —— 已解碼的點陣圖是「記憶體吃滿」的最大宗。
//
// 這裡守護的重點是**連 requestPreview() 都不能先呼叫**：它一被呼叫就開始解析網址
// （imgur 無副檔名的還會發兩個 HEAD 探測），所以單純給 <img> 加 loading="lazy"
// 沒有用，延遲必須做在整個預覽元件的掛載上。

import { render, act } from "@testing-library/react";
import {
  nextLazyState,
  nextSlotHeight,
  LAZY_MOUNT_MARGIN_PX,
  LAZY_UNMOUNT_MARGIN_PX,
} from "../../src/js/lazy_media";

const spies = vi.hoisted(() => ({ requestPreview: 0 }));

vi.mock("../../src/components/ImagePreviewer", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    requestPreview: (href) => {
      ++spies.requestPreview;
      return actual.requestPreview(href);
    },
  };
});

const { default: LazyInlinePreview, resetLazyObserversForTest } = await import(
  "../../src/components/LazyInlinePreview"
);

// 假 IntersectionObserver：記下每個 root margin 建立的 observer，測試自己決定
// 什麼時候回報相交/不相交。
const observers = [];
class FakeIO {
  constructor(cb, opts) {
    this.cb = cb;
    this.rootMargin = opts && opts.rootMargin;
    this.targets = new Set();
    observers.push(this);
  }
  observe(el) {
    this.targets.add(el);
  }
  unobserve(el) {
    this.targets.delete(el);
  }
  disconnect() {
    this.targets.clear();
  }
  emit(isIntersecting) {
    act(() => {
      this.cb(
        Array.from(this.targets).map((target) => ({ target, isIntersecting })),
        this,
      );
    });
  }
}

const near = () =>
  observers.find((o) => o.rootMargin.startsWith(String(LAZY_MOUNT_MARGIN_PX)));
const far = () =>
  observers.find((o) => o.rootMargin.startsWith(String(LAZY_UNMOUNT_MARGIN_PX)));

describe("nextLazyState / nextSlotHeight（純決策）", () => {
  test("尚未掛載且接近視野 ⇒ mount", () => {
    expect(nextLazyState({ mounted: false, near: true, far: false })).toBe(
      "mount",
    );
  });
  test("已掛載且遠離視野 ⇒ unmount", () => {
    expect(nextLazyState({ mounted: true, near: false, far: true })).toBe(
      "unmount",
    );
  });
  test("遲滯區（離開視野但還沒到卸載邊界）⇒ keep", () => {
    expect(nextLazyState({ mounted: true, near: false, far: false })).toBe(
      "keep",
    );
  });
  test("尚未掛載又還沒接近 ⇒ keep（不會為了卸載而掛載）", () => {
    expect(nextLazyState({ mounted: false, near: false, far: true })).toBe(
      "keep",
    );
  });
  test("卸載邊界必須遠大於掛載邊界，否則會來回重載", () => {
    expect(LAZY_UNMOUNT_MARGIN_PX).toBeGreaterThan(LAZY_MOUNT_MARGIN_PX * 2);
  });
  test("量不到高度（還沒載完就被捲過去）⇒ 保留舊值，不要歸零", () => {
    expect(nextSlotHeight(320, 0, true)).toBe(320);
    expect(nextSlotHeight(320, 480, true)).toBe(480);
  });
  // 使用者實測（ptt-debug-20260812-010606）：每篇文章「※ 文章網址」那行底下都多出
  // 一塊約 65px 的空白，推文區被往下推。成因＝該行的 URL（PTT 文章 HTML 頁，不是
  // 媒體）也掛了預覽 slot，捲過去時顯示「讀取中…」指示器，判定非媒體後內容消失，
  // 但卸載當下量到的正是那個指示器的高度 → 被釘進 min-height 變成永久空白。
  // 釘高度的唯一正當理由是「真的有媒體、卸載後會塌陷」；loading/error/非媒體都不算。
  test("卸載時 slot 內沒有真媒體（讀取中／載入失敗／根本不是媒體）⇒ 不得釘高度", () => {
    expect(nextSlotHeight(0, 65, false)).toBe(0);
    // 已經釘過的真實高度不因一次 no-media 量測被覆寫
    expect(nextSlotHeight(570, 65, false)).toBe(570);
  });
});

describe("LazyInlinePreview（掛載/卸載）", () => {
  const HREF = "https://i.imgur.com/abcdefg.jpg";

  beforeEach(() => {
    observers.length = 0;
    spies.requestPreview = 0;
    resetLazyObserversForTest();
    global.IntersectionObserver = FakeIO;
  });

  afterEach(() => {
    delete global.IntersectionObserver;
    resetLazyObserversForTest();
  });

  test("還沒進入視野 ⇒ 佔位盒是空的，且 requestPreview 一次都沒被呼叫", () => {
    const { container } = render(<LazyInlinePreview href={HREF} />);
    const slot = container.querySelector(".inlinePreviewSlot");
    expect(slot).not.toBeNull();
    expect(slot.children.length).toBe(0);
    expect(spies.requestPreview).toBe(0);
  });

  test("接近視野 ⇒ 掛上預覽（此時才解析網址）", () => {
    const { container } = render(<LazyInlinePreview href={HREF} />);
    near().emit(true);
    expect(spies.requestPreview).toBe(1);
    expect(container.querySelector(".inlinePreviewSlot").children.length)
      .toBeGreaterThan(0);
  });

  // jsdom 沒有排版也沒有網路：offsetHeight 恆為 0，ImagePreviewer 也停在「讀取中」。
  // 釘高度的前提是「slot 內真的有媒體、卸載後會塌陷」，所以要複現該情境就得把兩件
  // 事都做出來：偽造高度 ＋ 放一個真媒體節點（React 只管自己 render 的 children，
  // 手動 append 的節點不會被卸載動作移除，正好模擬「圖已經載出來了」）。
  function fakeLoadedMedia(slot, height) {
    Object.defineProperty(slot, "offsetHeight", {
      configurable: true,
      value: height,
    });
    const img = document.createElement("img");
    img.className = "easyReadingImg hyperLinkPreview";
    slot.appendChild(img);
    return img;
  }

  test("遠離視野 ⇒ 卸載，並把卸載前的高度釘進佔位盒（閱讀位置不位移）", () => {
    const { container } = render(<LazyInlinePreview href={HREF} />);
    near().emit(true);
    const slot = container.querySelector(".inlinePreviewSlot");
    const img = fakeLoadedMedia(slot, 420);
    far().emit(false);
    img.remove(); // 媒體隨卸載消失
    expect(slot.children.length).toBe(0);
    expect(slot.style.minHeight).toBe("420px");
  });

  test("捲回來 ⇒ 重新掛載，佔位高度保留", () => {
    const { container } = render(<LazyInlinePreview href={HREF} />);
    const slot = container.querySelector(".inlinePreviewSlot");
    near().emit(true);
    const img = fakeLoadedMedia(slot, 420);
    far().emit(false);
    img.remove();
    expect(slot.children.length).toBe(0);
    far().emit(true); // 回到卸載邊界之內
    near().emit(true);
    expect(slot.children.length).toBeGreaterThan(0);
    expect(slot.style.minHeight).toBe("420px");
  });

  // 症狀級回歸（使用者實測：每篇文章推文區前面多一塊空白）。
  // 「※ 文章網址」那行的 URL 是 PTT 文章 HTML 頁，不是媒體：捲過去只會顯示
  // 「讀取中…」指示器，判定後內容消失。卸載時**不得**把那個指示器的高度釘住，
  // 否則變成永久假空白，而且非媒體連結永遠不會再長出內容來填它。
  test("非媒體連結（slot 內只有讀取中指示器）卸載 ⇒ 不留 min-height", () => {
    const { container } = render(
      <LazyInlinePreview href="https://www.ptt.cc/bbs/ask/M.1786465191.A.DBD.html" />,
    );
    near().emit(true);
    const slot = container.querySelector(".inlinePreviewSlot");
    // 「讀取中…」指示器撐出的高度（實測 65px），slot 內沒有任何媒體元素。
    Object.defineProperty(slot, "offsetHeight", {
      configurable: true,
      value: 65,
    });
    expect(slot.querySelector("img, video, iframe")).toBeNull();
    far().emit(false);
    expect(slot.style.minHeight).toBe("");
  });

  test("遲滯：只是離開視野（還在卸載邊界內）不卸載", () => {
    const { container } = render(<LazyInlinePreview href={HREF} />);
    const slot = container.querySelector(".inlinePreviewSlot");
    near().emit(true);
    near().emit(false); // 捲出視野，但 far 仍相交
    expect(slot.children.length).toBeGreaterThan(0);
  });

  test("環境沒有 IntersectionObserver ⇒ 立即掛載（行為與沒這功能時相同）", () => {
    delete global.IntersectionObserver;
    resetLazyObserversForTest();
    const { container } = render(<LazyInlinePreview href={HREF} />);
    expect(spies.requestPreview).toBe(1);
    expect(container.querySelector(".inlinePreviewSlot").children.length)
      .toBeGreaterThan(0);
  });
});
