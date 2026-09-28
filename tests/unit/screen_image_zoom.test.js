// 好讀「整頁圖片倍率」的控制器行為（src/render/screen.js）。
//
// 倍率列的按鈕住在佔位盒裡，按下去是派發 bubbling 的 `previewzoom` CustomEvent，
// 由 ScreenController 掛在容器上的 listener 接住。這裡直接派發同一個事件，斷言
// 症狀（容器 class／--img-zoom／sizeMode），不鎖私有欄位。
//
// 與一鍵放大（imagesEnlarged）的關係：放大態優先、倍率保留；縮回來時回到原倍率。
import { mountScreen, unmountAll } from "./helpers/mount_screen";
import { row, seg } from "./helpers/screen_fixtures";
import { setDiagSink } from "../../src/js/diag";

afterEach(() => unmountAll());

const ENHANCE = {
  blacklist: new Set(),
  titleBlacklist: [],
  showFloorNumbers: false,
  mergeSameAuthorComments: false,
  highlightAuthor: false,
  articleAuthor: null,
  selectedPusher: null,
  autoFixUrl: false,
  bareDomainLink: false,
  enableXMention: false,
  pageState: 3,
  easyReading: true,
  onAidClick: null,
  dropHidden: false,
  inListContext: false,
};

const props = (articleId, text) => ({
  lines: [row(seg(text))],
  enhance: Object.assign({}, ENHANCE, { articleId }),
  enableLinkInlinePreview: false,
  enableLinkHoverPreview: false,
});

function zoom(entry, dir) {
  const span = document.createElement("span");
  entry.container.appendChild(span);
  span.dispatchEvent(
    new window.CustomEvent("previewzoom", { bubbles: true, detail: { dir } }),
  );
  span.remove();
}

function clickPreviewImage(entry) {
  const img = document.createElement("img");
  img.className = "hyperLinkPreview";
  entry.container.appendChild(img);
  img.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  img.remove();
}

const zoomed = (s) => s.container.classList.contains("imagesZoomed");
const enlarged = (s) => s.container.classList.contains("imagesEnlarged");
const zoomVar = (s) => s.container.style.getPropertyValue("--img-zoom");

test("＋ 一格：容器進倍率態，--img-zoom 與 sizeMode 跟上", () => {
  const s = mountScreen(props(1, "第一篇"));
  expect(zoomed(s)).toBe(false);

  zoom(s, 1);
  expect(zoomed(s)).toBe(true);
  expect(zoomVar(s)).toBe("1.25");
  expect(s.controller._sizeMode()).toBe("zoom@1.25");

  zoom(s, -1);
  expect(zoomed(s)).toBe(false);
  expect(s.controller._sizeMode()).toBe("normal");
});

test("點百分比標籤（dir 0）回 100%", () => {
  const s = mountScreen(props(1, "第一篇"));
  zoom(s, 1);
  zoom(s, 1);
  zoom(s, 0);
  expect(zoomed(s)).toBe(false);
  expect(s.controller._sizeMode()).toBe("normal");
});

test("一鍵放大不受影響：放大態優先，縮回來回到原倍率", () => {
  const s = mountScreen(props(1, "第一篇"));
  zoom(s, 1);

  clickPreviewImage(s);
  expect(enlarged(s)).toBe(true);
  expect(zoomed(s)).toBe(false);
  expect(s.controller._sizeMode()).toBe("enlarged");

  clickPreviewImage(s);
  expect(enlarged(s)).toBe(false);
  expect(zoomed(s)).toBe(true);
  expect(s.controller._sizeMode()).toBe("zoom@1.25");
});

test("存活中的佔位盒收到新的 sizeMode", () => {
  const s = mountScreen(props(1, "第一篇"));
  const modes = [];
  const fakeSlot = { setSizeMode: (m) => modes.push(m), destroy() {} };
  s.controller._liveSlots.add(fakeSlot);

  zoom(s, 1);
  expect(modes).toEqual(["zoom@1.25"]);
  s.controller._liveSlots.delete(fakeSlot);
});

test("同篇 page-down 保留倍率，換文章重置為 100%", () => {
  const s = mountScreen(props(1, "第一篇"));
  zoom(s, 1);

  s.update(props(1, "第一篇 續"));
  expect(zoomed(s)).toBe(true);

  s.update(props(2, "第二篇"));
  expect(zoomed(s)).toBe(false);
  expect(s.controller._sizeMode()).toBe("normal");

  // 換文章後第一次按 ＋ 從 100% 起算。
  zoom(s, 1);
  expect(s.controller._sizeMode()).toBe("zoom@1.25");
});

test("錄製中：尺寸模式切換記一筆 image.size", () => {
  const s = mountScreen(props(1, "第一篇"));
  const got = [];
  setDiagSink((tag, info) => got.push({ tag, info }));
  try {
    zoom(s, 1);
    clickPreviewImage(s);
  } finally {
    setDiagSink(null);
  }
  expect(
    got.filter((e) => e.tag === "image.size").map((e) => e.info.mode),
  ).toEqual(["zoom@1.25", "enlarged"]);
});
