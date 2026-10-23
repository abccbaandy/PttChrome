// @unit-env browser
// 預覽圖縮圖 → 原圖（js/image_fit.js、ImagePreviewer 的 InlineImage／useFullResUpgrade）。
//
// 鎖的症狀：
//   1. 有 fit 的預覽依顯示框挑縮圖（不是原圖）；量不到顯示框（沒有 #mainContainer）就載原圖。
//   2. 使用者放大（點圖放大／倍率 > 100%）⇒ 同一個 <img> 換成原圖，中途不回讀取動畫。
//   3. 原圖載不到 ⇒ 留在縮圖，不進「載入失敗」。
//   4. ScreenController 的放大／倍率真的會推「要原圖」旗標。
// 圖一律用 data: SVG（真 Chromium 真的 load／error，不手捏事件、不連網）。
import { render, waitFor, act } from "@testing-library/react";
import ImagePreviewer from "../../src/components/ImagePreviewer";
import {
  isFullResWanted,
  resetImageFitForTest,
  setFullResWanted,
} from "../../src/js/image_fit";
import { mountScreen, unmountAll } from "./helpers/mount_screen";
import { row, seg } from "./helpers/screen_fixtures";

const Inline = ImagePreviewer.Inline;
const svg = (w) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${w}"/>`,
  )}`;
const SMALL = svg(68);
const MEDIUM = svg(120);
const LARGE = svg(204);
const FULL = svg(300);
const BROKEN = "data:image/png;base64,AAAA";

const descriptor = (full = [FULL]) => ({
  type: "image",
  src: full[0],
  srcset: full,
  fit: [
    ["small", 680, [SMALL, ...full]],
    ["medium", 1200, [MEDIUM, ...full]],
    ["large", 2048, [LARGE, ...full]],
  ],
});

let host;
const mountContainer = (fontPx) => {
  host = document.createElement("div");
  host.id = "mainContainer";
  host.style.fontSize = `${fontPx}px`;
  host.style.width = "1600px";
  document.body.appendChild(host);
};

afterEach(() => {
  if (host) host.remove();
  host = null;
  resetImageFitForTest();
  unmountAll();
});

const img = (c) => c.querySelector("img");
const loading = (c) => c.querySelectorAll(".previewLoading").length;

test("依顯示框挑縮圖：39em×16px×DPR", () => {
  mountContainer(16);
  const need = 39 * 16 * window.devicePixelRatio;
  const expected = need <= 680 ? SMALL : need <= 1200 ? MEDIUM : need <= 2048 ? LARGE : FULL;
  const { container } = render(<Inline value={descriptor()} />);
  expect(img(container).getAttribute("src")).toBe(expected);
});

test("量不到顯示框（沒有 #mainContainer）⇒ 原圖", () => {
  const { container } = render(<Inline value={descriptor()} />);
  expect(img(container).getAttribute("src")).toBe(FULL);
});

test("沒有 fit（功能關／非 twimg）⇒ 跟以前一樣載 srcset", () => {
  mountContainer(16);
  const { container } = render(<Inline value={{ type: "image", src: FULL, srcset: [FULL] }} />);
  expect(img(container).getAttribute("src")).toBe(FULL);
});

test("放大 ⇒ 同一個 <img> 換成原圖，中途不回讀取動畫", async () => {
  mountContainer(10); // 390 px ⇒ 一定挑得到縮圖
  const { container } = render(<Inline value={descriptor()} />);
  const before = img(container);
  expect(before.getAttribute("src")).not.toBe(FULL);
  await waitFor(() => expect(loading(container)).toBe(0));

  act(() => setFullResWanted(true));
  await waitFor(() => expect(img(container).getAttribute("src")).toBe(FULL));
  expect(img(container)).toBe(before);
  expect(loading(container)).toBe(0);

  // 縮回來不換回縮圖（原圖已經在手上）。
  act(() => setFullResWanted(false));
  expect(img(container).getAttribute("src")).toBe(FULL);
});

test("原圖載不到 ⇒ 留在縮圖，不出現載入失敗", async () => {
  mountContainer(10);
  const { container } = render(<Inline value={descriptor([BROKEN])} />);
  const thumb = img(container).getAttribute("src");
  await waitFor(() => expect(loading(container)).toBe(0));
  act(() => setFullResWanted(true));
  // 等背景那張原圖試完（data: 解碼失敗是同一輪事件迴圈內的事），再確認還是縮圖。
  await new Promise((r) => setTimeout(r, 50));
  expect(img(container).getAttribute("src")).toBe(thumb);
  expect(container.querySelector(".previewError")).toBeNull();
});

describe("ScreenController 推「要原圖」旗標", () => {
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
  const props = (articleId) => ({
    lines: [row(seg("內文"))],
    enhance: Object.assign({}, ENHANCE, { articleId }),
    enableLinkInlinePreview: false,
    enableLinkHoverPreview: false,
  });
  // 倍率列按鈕派發的是我們自己的 CustomEvent（同 screen_image_zoom.test.js）。
  const zoom = (s, dir) =>
    s.container.dispatchEvent(
      new window.CustomEvent("previewzoom", { bubbles: true, detail: { dir } }),
    );

  test("倍率 > 100% 要原圖；縮小或回 100% 不要；換文章重置", () => {
    const s = mountScreen(props(1));
    expect(isFullResWanted()).toBe(false);
    zoom(s, -1);
    expect(isFullResWanted()).toBe(false);
    zoom(s, 0);
    zoom(s, 1);
    expect(isFullResWanted()).toBe(true);
    zoom(s, 0);
    expect(isFullResWanted()).toBe(false);
    zoom(s, 1);
    s.update(props(2));
    expect(isFullResWanted()).toBe(false);
  });

  test("點圖放大（放大態）要原圖，縮回不要", () => {
    const s = mountScreen(props(1));
    s.controller._setImagesEnlarged(true);
    expect(isFullResWanted()).toBe(true);
    s.controller._setImagesEnlarged(false);
    expect(isFullResWanted()).toBe(false);
  });
});
