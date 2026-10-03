// @unit-env browser
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


const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

// 真版面（unit-browser）：視窗 800px，影片前面 3000px、後面 6000px 的內容，影片本身 400px。
const block = (h) => {
  const el = document.createElement("div");
  el.style.height = h + "px";
  return el;
};

const setup = () => {
  const scroller = document.createElement("div");
  scroller.className = "main";
  scroller.style.cssText = "height: 800px; overflow-y: auto";
  const container = document.createElement("div");
  container.id = "mainContainer";
  container.style.position = "relative";
  const host = document.createElement("div");
  container.append(block(3000), host, block(6000));
  scroller.appendChild(container);
  document.body.appendChild(scroller);

  render(
    <ImagePreviewer.Inline
      value={{ type: "video", src: "https://i.imgur.com/8MYpXhr.mp4" }}
    />,
    { container: host },
  );

  const video = container.querySelector("video");
  video.style.cssText += "; display: block; height: 400px";
  return { scroller, video };
};

// 影片中心離視窗中心多遠（px）。
const offCenter = (scroller, video) => {
  const s = scroller.getBoundingClientRect();
  const v = video.getBoundingClientRect();
  return Math.abs(v.top + v.height / 2 - (s.top + s.height / 2));
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

    expect(offCenter(scroller, video)).toBeLessThanOrEqual(1);
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
