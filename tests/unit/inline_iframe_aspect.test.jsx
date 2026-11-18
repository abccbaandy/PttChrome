// @unit-env browser
// 內嵌影片播放器（YouTube／Twitch clip）的框照影片比例：舊版固定 height:450px，手機寬 412px 時
// 16:9 影片只有 232px 高，上下各一條 ~110px 的黑邊（播放器自己 letterbox），佔掉快半個螢幕。
// 直式的 YouTube Shorts（9:16）反過來要高、不要撐滿寬度。
import { render } from "@testing-library/react";
import ImagePreviewer, { requestPreview } from "../../src/components/ImagePreviewer";

function mount(value, width) {
  const host = document.createElement("div");
  host.style.width = width + "px";
  document.body.appendChild(host);
  render(<ImagePreviewer.Inline value={value} />, { container: host });
  const box = host.querySelector("iframe").parentElement.getBoundingClientRect();
  return { w: Math.round(box.width), h: Math.round(box.height) };
}

describe("內嵌播放器框的比例", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  test("YouTube 一般影片在手機寬 412px ⇒ 16:9（232px 高），不是固定 450px", async () => {
    const value = await requestPreview("https://youtu.be/1m2KVNX4DhI?si=abc");
    expect(value.type).toBe("iframe");
    const { w, h } = mount(value, 412);
    expect(w).toBe(412);
    expect(h).toBe(232);
  });

  test("桌機寬 1200px ⇒ 寬度封頂 800、高 450（跟以前一樣）", async () => {
    const value = await requestPreview("https://www.youtube.com/watch?v=1m2KVNX4DhI");
    expect(mount(value, 1200)).toEqual({ w: 800, h: 450 });
  });

  test("Shorts（直式）⇒ 9:16、高度有上限，不撐滿寬度", async () => {
    const value = await requestPreview("https://youtube.com/shorts/1m2KVNX4DhI");
    const { w, h } = mount(value, 1200);
    expect(h).toBeLessThanOrEqual(640);
    expect(Math.abs(w / h - 9 / 16)).toBeLessThan(0.02);
  });

  test("Twitch clip ⇒ 16:9", async () => {
    const value = await requestPreview("https://clips.twitch.tv/SomeClipName-abc");
    expect(mount(value, 412)).toEqual({ w: 412, h: 232 });
  });
});
