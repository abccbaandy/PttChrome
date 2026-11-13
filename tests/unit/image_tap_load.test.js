// @unit-env browser
// 行動網路「點了才開圖」（src/js/image_load_gate.js ＋ src/render/inline_preview_slot.js）。
//
// 守的是省流量的承諾本身：閘門成立時，**連 requestPreview() 都不能呼叫**（它一被呼叫就開始
// 解析網址、imgur 還會發 HEAD 探測），只放一顆按鈕；點一下只開那張、長按（contextmenu）
// 本篇全部恢復成一般的延遲自動開；換文章重置；Wi-Fi 回來全部恢復；看過的圖不收回。
//
// IntersectionObserver／ResizeObserver 用替身（手法同 lazy_inline_preview.test.js）。
// 長按在這裡是手捏 contextmenu 測分支；真事件（真右鍵，與觸控長按同一個 contextmenu、
// 同一條 #BBSWindow capture 傳播路徑）在下面那支 e2e。
// real-input: tests/e2e/offline/image_tap_load.offline.spec.js

import { setupI18n } from "../../src/js/i18n";
import { LAZY_MOUNT_MARGIN_PX } from "../../src/js/lazy_media";
import {
  _resetImageLoadGateForTest,
  imageLoadGateActive,
  resetImageUnlocks,
  setNetworkMetered,
  setTapToLoadEnabled,
} from "../../src/js/image_load_gate";

const spies = vi.hoisted(() => ({ requested: [] }));

vi.mock("../../src/components/ImagePreviewer", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    // 永不 resolve：不連網，畫面停在「讀取中」就足以證明掛載了。
    requestPreview: (href) => {
      spies.requested.push(href);
      return new Promise(() => {});
    },
  };
});

const { createInlinePreviewSlot, resetLazyObserversForTest } = await import(
  "../../src/render/inline_preview_slot"
);

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
  emit(isIntersecting, only) {
    this.cb(
      Array.from(this.targets)
        .filter((t) => !only || t === only)
        .map((target) => ({ target, isIntersecting })),
      this,
    );
  }
}
class FakeRO {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const near = () =>
  observers.find((o) => o.rootMargin.startsWith(String(LAZY_MOUNT_MARGIN_PX)));

const liveSlots = [];
function mountSlot(href) {
  const slot = createInlinePreviewSlot(href, "normal");
  document.body.appendChild(slot.el);
  liveSlots.push(slot);
  return slot;
}
function destroySlots() {
  while (liveSlots.length) {
    const s = liveSlots.pop();
    s.destroy();
    s.el.remove();
  }
}

const btnOf = (slot) => slot.el.querySelector(".previewTapLoad");
const IMG_A = "https://example.com/tap-a.jpg";
const IMG_B = "https://example.com/tap-b.png";
const ARTICLE_URL = "https://www.ptt.cc/bbs/Test/M.1700000000.A.123.html";

setupI18n();

beforeEach(() => {
  observers.length = 0;
  spies.requested.length = 0;
  resetLazyObserversForTest();
  _resetImageLoadGateForTest();
  globalThis.IntersectionObserver = FakeIO;
  globalThis.ResizeObserver = FakeRO;
});

afterEach(() => {
  destroySlots();
  delete globalThis.IntersectionObserver;
  delete globalThis.ResizeObserver;
  resetLazyObserversForTest();
  _resetImageLoadGateForTest();
});

describe("閘門關（預設／Wi-Fi／非 App）", () => {
  test("照舊：進視野就掛載，沒有按鈕", () => {
    const slot = mountSlot(IMG_A);
    expect(btnOf(slot)).toBeNull();
    near().emit(true);
    expect(spies.requested).toEqual([IMG_A]);
  });

  test("pref 關掉 ⇒ 行動網路也照常自動開", () => {
    setTapToLoadEnabled(false);
    setNetworkMetered(true);
    expect(imageLoadGateActive()).toBe(false);
    const slot = mountSlot(IMG_A);
    expect(btnOf(slot)).toBeNull();
    near().emit(true);
    expect(spies.requested).toEqual([IMG_A]);
  });
});

describe("行動網路", () => {
  beforeEach(() => setNetworkMetered(true));

  test("圖片連結 ⇒ 第一幀就有開圖按鈕；進視野也不解析網址", () => {
    const slot = mountSlot(IMG_A);
    const btn = btnOf(slot);
    expect(btn).not.toBeNull();
    expect(btn.getAttribute("type")).toBe("button");
    expect(btn.textContent).toBe("▶ 開圖（長按：全篇開圖）");
    // 是 slot 的直屬 grid item（content 是 React root 的容器，不放進去）。
    expect(btn.parentElement).toBe(slot.el);
    // 全域右鍵／長按選單要讓開的標記（ContextMenu 'own'）。
    expect(btn.hasAttribute("data-own-contextmenu")).toBe(true);
    near().emit(true);
    expect(spies.requested).toEqual([]);
  });

  test("一般網頁連結（開不出預覽）⇒ 不給按鈕", () => {
    const slot = mountSlot(ARTICLE_URL);
    expect(btnOf(slot)).toBeNull();
  });

  test("點一下 ⇒ 只開這張；別張還是按鈕", () => {
    const a = mountSlot(IMG_A);
    const b = mountSlot(IMG_B);
    near().emit(true);
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    btnOf(a).dispatchEvent(ev);
    expect(spies.requested).toEqual([IMG_A]);
    expect(btnOf(a)).toBeNull();
    expect(btnOf(b)).not.toBeNull();
  });

  test("點擊不冒泡到容器（點圖放大委派／終端機滑鼠路徑）", () => {
    const slot = mountSlot(IMG_A);
    const outer = vi.fn();
    document.body.addEventListener("click", outer);
    try {
      btnOf(slot).click();
    } finally {
      document.body.removeEventListener("click", outer);
    }
    expect(outer).not.toHaveBeenCalled();
  });

  test("點了但還沒進視野 ⇒ 不掛載（解鎖後照一般的延遲載入）", () => {
    const slot = mountSlot(IMG_A);
    btnOf(slot).click();
    expect(btnOf(slot)).toBeNull();
    expect(spies.requested).toEqual([]);
    near().emit(true);
    expect(spies.requested).toEqual([IMG_A]);
  });

  test("長按（contextmenu）⇒ 全篇解鎖：視野內的開、之後新建的也不再有按鈕", () => {
    const a = mountSlot(IMG_A);
    const b = mountSlot(IMG_B);
    near().emit(true, a.el); // 只有 a 在視野附近
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    btnOf(a).dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true); // 不出原生選單
    expect(btnOf(a)).toBeNull();
    expect(btnOf(b)).toBeNull();
    expect(spies.requested).toEqual([IMG_A]);
    // 往下捲到 b 才載（全篇開圖不是一次全下載）。
    near().emit(true, b.el);
    expect(spies.requested).toEqual([IMG_A, IMG_B]);
    // 同篇 page-down 累積出新的列。
    expect(btnOf(mountSlot("https://example.com/tap-c.gif"))).toBeNull();
  });

  test("整份重建（同篇）⇒ 點開過的那張不再變回按鈕", () => {
    const a = mountSlot(IMG_A);
    btnOf(a).click();
    destroySlots();
    expect(btnOf(mountSlot(IMG_A))).toBeNull();
    expect(btnOf(mountSlot(IMG_B))).not.toBeNull();
  });

  test("換文章（resetImageUnlocks）⇒ 解鎖與全篇開圖都重置", () => {
    const a = mountSlot(IMG_A);
    btnOf(a).dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
    destroySlots();
    resetImageUnlocks();
    expect(btnOf(mountSlot(IMG_A))).not.toBeNull();
    expect(btnOf(mountSlot(IMG_B))).not.toBeNull();
  });

  test("換回 Wi-Fi ⇒ 按鈕全收、視野內的照常開", () => {
    const a = mountSlot(IMG_A);
    near().emit(true);
    expect(spies.requested).toEqual([]);
    setNetworkMetered(false);
    expect(btnOf(a)).toBeNull();
    expect(spies.requested).toEqual([IMG_A]);
  });

  test("閘門成立時不撐出圖片的佔位高度（只有一顆按鈕）", () => {
    const slot = mountSlot(IMG_A);
    const spacer = slot.el.querySelector(".inlinePreviewSpacer");
    expect(spacer.style.minHeight).toBe("");
    expect(slot.el.querySelector(".inlinePreviewGhost")).toBeNull();
  });

  test("destroy 之後閘門變化不再碰它", () => {
    const slot = mountSlot(IMG_A);
    destroySlots();
    setNetworkMetered(false);
    setNetworkMetered(true);
    expect(btnOf(slot)).toBeNull();
    expect(spies.requested).toEqual([]);
  });
});

describe("Wi-Fi 時已經開過的圖", () => {
  test("切到行動網路 ⇒ 眼前的圖不收回，重建後也不變回按鈕", () => {
    const a = mountSlot(IMG_A);
    near().emit(true);
    expect(spies.requested).toEqual([IMG_A]);
    setNetworkMetered(true);
    expect(btnOf(a)).toBeNull();
    destroySlots();
    expect(btnOf(mountSlot(IMG_A))).toBeNull();
    // 沒看過的照樣要點。
    expect(btnOf(mountSlot(IMG_B))).not.toBeNull();
  });
});
