// 迴歸守護（真實回報）：好讀模式的內嵌影片按播放器內建全螢幕、再退出後，
// 文章會滾到很後面——與「點圖放大/縮小跑掉」（16c5398）同一類：進全螢幕時
// <video> 被提到全螢幕層、原位高度塌陷 → 內容變短、scrollTop 被夾到新的
// maxScroll；退出後高度回來，捲動位置卻停在被夾過的值。
//
// 修法（見 ImagePreviewer.jsx 的 InlineVideo）：退出全螢幕後把該影片捲回視窗中央。
// 退出當下已拿不到「進場前的相對位置」，故不沿用 computeAnchoredScrollTop。

import { render } from "@testing-library/react";
import ImagePreviewer from "../../src/components/ImagePreviewer";

const setFullscreenElement = (el) => {
  Object.defineProperty(document, "fullscreenElement", {
    value: el,
    configurable: true,
    writable: true,
  });
  document.dispatchEvent(new Event("fullscreenchange"));
};

// jsdom 不做 layout（offsetTop/offsetHeight 恆 0），故偽造尺寸。
const fake = (el, props) => {
  for (const [k, v] of Object.entries(props)) {
    Object.defineProperty(el, k, { value: v, configurable: true });
  }
};

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

const setup = () => {
  const scroller = document.createElement("div");
  scroller.className = "main";
  const container = document.createElement("div");
  container.id = "mainContainer";
  scroller.appendChild(container);
  document.body.appendChild(scroller);

  render(
    <ImagePreviewer.Inline
      value={{ type: "video", src: "https://i.imgur.com/8MYpXhr.mp4" }}
    />,
    { container },
  );

  const video = container.querySelector("video");
  fake(container, { offsetTop: 0, offsetParent: null });
  fake(video, { offsetTop: 3000, offsetHeight: 400, offsetParent: container });
  fake(scroller, { clientHeight: 800, scrollHeight: 10000 });
  return { scroller, video };
};

describe("內嵌影片：退出全螢幕後把影片捲回視野", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    setFullscreenElement(null);
  });

  test("進全螢幕 → 退出 → 影片置中於視窗（不是停在被夾掉的位置）", async () => {
    const { scroller, video } = setup();
    scroller.scrollTop = 2800;

    setFullscreenElement(video);
    scroller.scrollTop = 0; // 全螢幕期間原位塌陷，捲動位置被夾掉
    setFullscreenElement(null);
    await nextFrame();

    // top - (viewportHeight - height) / 2 = 3000 - 200
    expect(scroller.scrollTop).toBe(2800);
  });

  test("別的元素全螢幕（本影片沒進過）→ 不得亂動捲動位置", async () => {
    const { scroller } = setup();
    scroller.scrollTop = 1234;

    setFullscreenElement(document.createElement("div"));
    setFullscreenElement(null);
    await nextFrame();

    expect(scroller.scrollTop).toBe(1234);
  });
});
