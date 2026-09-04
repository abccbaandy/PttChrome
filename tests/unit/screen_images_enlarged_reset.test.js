// 好讀模式「進新文章卻是大圖」的回歸守護。
//
// 圖片尺寸完全由容器 class 決定（#mainContainer.imagesEnlarged .easyReadingImg），
// 而 class 的唯一寫入點是 ScreenController._setImagesEnlarged。換文章的重置一度
// 直接改 `this._imagesEnlarged = false` 欄位（去 React 化的回歸：React 時代 class
// 是 render 期由 state 推導的），欄位與 DOM 就此不同步 ⇒ 下一篇一開就是大圖、
// 第一次點圖是 no-op（toggle 到已存在的 class）、佔位盒還會把放大態高度記進
// "normal" 那一格造成永久假空白。
//
// 斷言一律鎖症狀（容器 class／sizeMode），不鎖 `_imagesEnlarged` 私有欄位——
// 欄位在 bug 版就已經是對的，鎖它一樣是綠的。
import { mountScreen, unmountAll } from "./helpers/mount_screen";
import { row, seg } from "./helpers/screen_fixtures";

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

// 內嵌預覽圖的替身：_onContainerClick 是掛在 container 上的委派 listener，
// 只認 tagName === "IMG" 且帶 .hyperLinkPreview 的 target。
function clickPreviewImage(entry) {
  const img = document.createElement("img");
  img.className = "hyperLinkPreview";
  entry.container.appendChild(img);
  img.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  img.remove();
}

const enlarged = (entry) => entry.container.classList.contains("imagesEnlarged");

test("點內嵌預覽圖切換成放大態", () => {
  const s = mountScreen(props(1, "第一篇"));
  expect(enlarged(s)).toBe(false);

  clickPreviewImage(s);
  expect(enlarged(s)).toBe(true);
  expect(s.controller._sizeMode()).toBe("enlarged");
});

test("換文章一律回到小圖（class 與 sizeMode 都要跟著重置）", () => {
  const s = mountScreen(props(1, "第一篇"));
  clickPreviewImage(s);
  expect(enlarged(s)).toBe(true);

  s.update(props(2, "第二篇"));
  expect(enlarged(s)).toBe(false);
  expect(s.controller._sizeMode()).toBe("normal");
});

test("同篇 page-down（articleId 不變）保留放大態", () => {
  const s = mountScreen(props(1, "第一篇"));
  clickPreviewImage(s);

  s.update(props(1, "第一篇 續"));
  expect(enlarged(s)).toBe(true);
  expect(s.controller._sizeMode()).toBe("enlarged");
});

test("換文章後第一次點圖就會放大，不是 no-op", () => {
  const s = mountScreen(props(1, "第一篇"));
  clickPreviewImage(s);
  s.update(props(2, "第二篇"));

  clickPreviewImage(s);
  expect(enlarged(s)).toBe(true);
  expect(s.controller._sizeMode()).toBe("enlarged");
});

test("繞過入口直接改欄位時，_setImagesEnlarged 仍會把 DOM 拉回同步", () => {
  // 防呆：早退守衛同時看 DOM 現況，欄位／DOM 一旦不同步就不得早退。
  const s = mountScreen(props(1, "第一篇"));
  clickPreviewImage(s);
  s.controller._imagesEnlarged = false; // 模擬繞過唯一入口

  s.controller._setImagesEnlarged(false);
  expect(enlarged(s)).toBe(false);
});
