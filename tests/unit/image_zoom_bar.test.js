// @vitest-environment jsdom
// real-input: tests/e2e/offline/image_zoom.offline.spec.js
//   （真滑鼠點倍率列；本檔手捏事件只測分支邏輯，見 tests/unit/e2e_real_input.test.js）
// 內嵌預覽圖上的倍率列「－ 100% ＋」（src/render/inline_preview_slot.js）。
//
// 倍率本身住在 ScreenController（tests/unit/screen_image_zoom.test.js），這裡守 slot 端：
// 何時長出來、按鈕派發什麼事件、標籤／disabled 跟著 sizeMode 走、生命週期收得乾淨。
// 假 observer 的手法照抄 tests/unit/image_gray_toggle.test.js。
import { setupI18n } from "../../src/js/i18n";
import { setDiagSink } from "../../src/js/diag";
import {
  createInlinePreviewSlot,
  resetLazyObserversForTest,
} from "../../src/render/inline_preview_slot";

class FakeIO {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const sizeObservers = [];
class FakeRO {
  constructor(cb) {
    this.cb = cb;
    this.targets = new Set();
    sizeObservers.push(this);
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
  emit() {
    this.cb(
      Array.from(this.targets).map((target) => ({ target })),
      this,
    );
  }
}
const resized = () => sizeObservers[sizeObservers.length - 1];

const liveSlots = [];
function mountSlot(href, sizeMode) {
  const slot = createInlinePreviewSlot(href, sizeMode);
  document.body.appendChild(slot.el);
  liveSlots.push(slot);
  return slot;
}

const contentOf = (slotEl) => slotEl.querySelector(".inlinePreviewContent");
const barOf = (slotEl) => slotEl.querySelector(".previewZoomBar");
const btn = (slotEl, cls) => slotEl.querySelector(`.previewZoomBar > .${cls}`);

function fake(node, prop, value) {
  Object.defineProperty(node, prop, { configurable: true, value });
}

function addLoadedImage(slotEl, { width = 640, height = 480, top = 0 } = {}) {
  const img = document.createElement("img");
  img.className = "easyReadingImg hyperLinkPreview";
  fake(img, "offsetWidth", width);
  fake(img, "offsetHeight", height);
  fake(img, "offsetTop", top);
  fake(contentOf(slotEl), "offsetHeight", height);
  fake(contentOf(slotEl), "offsetTop", 0);
  contentOf(slotEl).appendChild(img);
  return img;
}

const HREF = "https://i.imgur.com/zoomaaa.jpg";
setupI18n();

describe("內嵌預覽圖的倍率列", () => {
  beforeEach(() => {
    sizeObservers.length = 0;
    resetLazyObserversForTest();
    global.IntersectionObserver = FakeIO;
    global.ResizeObserver = FakeRO;
  });

  afterEach(() => {
    while (liveSlots.length) {
      const s = liveSlots.pop();
      s.destroy();
      s.el.remove();
    }
    delete global.IntersectionObserver;
    delete global.ResizeObserver;
    resetLazyObserversForTest();
  });

  test("圖還沒畫出來 ⇒ 沒有倍率列", () => {
    const slot = mountSlot(HREF).el;
    resized().emit();
    expect(barOf(slot)).toBeNull();
  });

  test("單張圖佈局完成 ⇒ 長出倍率列，量下圖片上緣位置", () => {
    const slot = mountSlot(HREF).el;
    addLoadedImage(slot, { width: 500, top: 7 });
    resized().emit();
    const bar = barOf(slot);
    expect(bar).not.toBeNull();
    expect(bar.parentElement).toBe(slot);
    expect(bar.style.getPropertyValue("--img-top")).toBe("7px");
    expect(btn(slot, "previewZoomLabel").textContent).toBe("100%");
    for (const c of ["previewZoomOut", "previewZoomLabel", "previewZoomIn"]) {
      expect(btn(slot, c).getAttribute("type")).toBe("button");
      expect(btn(slot, c).title).toBeTruthy();
    }
  });

  test("相簿（多張圖）⇒ 不長倍率列", () => {
    const slot = mountSlot(HREF).el;
    addLoadedImage(slot);
    addLoadedImage(slot);
    resized().emit();
    expect(barOf(slot)).toBeNull();
  });

  test("按鈕派發 bubbling previewzoom（－=-1、標籤=0、＋=+1），click 本身不冒泡", () => {
    const slot = mountSlot(HREF).el;
    const img = addLoadedImage(slot);
    resized().emit();

    const got = [];
    let clicks = 0;
    const onZoom = (e) => got.push(e.detail);
    const onClick = () => ++clicks;
    document.body.addEventListener("previewzoom", onZoom);
    document.body.addEventListener("click", onClick);
    try {
      for (const c of ["previewZoomOut", "previewZoomLabel", "previewZoomIn"])
        btn(slot, c).dispatchEvent(
          new window.MouseEvent("click", { bubbles: true, cancelable: true }),
        );
    } finally {
      document.body.removeEventListener("previewzoom", onZoom);
      document.body.removeEventListener("click", onClick);
    }
    expect(got.map((d) => d.dir)).toEqual([-1, 0, 1]);
    expect(got[0].img).toBe(img);
    // click 冒到容器就會誤觸「點圖一鍵放大」。
    expect(clicks).toBe(0);
  });

  test("按下不搶終端機焦點（mousedown 被 preventDefault）", () => {
    const slot = mountSlot(HREF).el;
    addLoadedImage(slot);
    resized().emit();
    const ev = new window.MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    btn(slot, "previewZoomIn").dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  test("標籤與 disabled 跟著 sizeMode 走", () => {
    const handle = mountSlot(HREF);
    addLoadedImage(handle.el);
    resized().emit();

    handle.setSizeMode("zoom@1.25");
    expect(btn(handle.el, "previewZoomLabel").textContent).toBe("125%");

    handle.setSizeMode("zoom@4");
    expect(btn(handle.el, "previewZoomIn").disabled).toBe(true);
    expect(btn(handle.el, "previewZoomOut").disabled).toBe(false);

    handle.setSizeMode("zoom@0.5");
    expect(btn(handle.el, "previewZoomOut").disabled).toBe(true);
    expect(btn(handle.el, "previewZoomIn").disabled).toBe(false);
  });

  test("以倍率態建立的 slot，一長出來標籤就是該倍率", () => {
    const slot = mountSlot(HREF, "zoom@1.5").el;
    addLoadedImage(slot);
    resized().emit();
    expect(btn(slot, "previewZoomLabel").textContent).toBe("150%");
  });

  // 錄製檔要看得到佔位盒的高度軌跡（ptt-debug-20260928-181323 什麼都沒錄到）。
  test("錄製中：尺寸回報記一筆 preview.slot（含 href、模式與各層高度）", () => {
    const got = [];
    setDiagSink((tag, info) => got.push({ tag, info }));
    try {
      const slot = mountSlot(HREF, "zoom@1.5").el;
      addLoadedImage(slot, { height: 480 });
      resized().emit();
    } finally {
      setDiagSink(null);
    }
    const ev = got.find((e) => e.tag === "preview.slot" && e.info.ev === "resize");
    expect(ev).toBeTruthy();
    expect(ev.info).toMatchObject({ href: HREF, mode: "zoom@1.5", content: 480 });
  });

  test("destroy() ⇒ 倍率列跟著消失；slot 與 content 仍零 inline style", () => {
    const handle = mountSlot(HREF);
    addLoadedImage(handle.el);
    resized().emit();
    expect(handle.el.getAttribute("style")).toBeNull();
    expect(contentOf(handle.el).getAttribute("style")).toBeNull();
    handle.destroy();
    expect(barOf(handle.el)).toBeNull();
  });
});
