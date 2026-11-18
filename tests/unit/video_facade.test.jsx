// @unit-env browser
// P109 文章裡的 YouTube／Twitch clip 先放縮圖，點了才載播放器。
// 一個 YouTube 播放器開起來約 1.2 MB，縮圖約 17 KB：沒點之前畫面上不能有任何播放器 iframe。
import { render } from "@testing-library/react";
import ImagePreviewer, { requestPreview } from "../../src/components/ImagePreviewer";
import {
  autoplaySrc,
  youtubePoster,
  needsVideoFacade,
  activateVideo,
  setVideoThumbFirst,
  _resetVideoFacadeForTest,
} from "../../src/js/video_facade";

function mount(value, width = 412) {
  const host = document.createElement("div");
  host.style.width = width + "px";
  document.body.appendChild(host);
  const r = render(<ImagePreviewer.Inline value={value} />, { container: host });
  return { host, unmount: r.unmount };
}

const boxSize = (host) => {
  const b = host.querySelector("[data-video-box]").getBoundingClientRect();
  return { w: Math.round(b.width), h: Math.round(b.height) };
};

describe("video_facade 純邏輯", () => {
  beforeEach(() => _resetVideoFacadeForTest());

  test("YouTube 縮圖是固定路徑", () => {
    expect(youtubePoster("1m2KVNX4DhI")).toBe(
      "https://i.ytimg.com/vi/1m2KVNX4DhI/hqdefault.jpg",
    );
  });

  test("自動播放：YouTube 保留起始秒數再加 autoplay=1，Twitch 保留 parent 加 autoplay=true", () => {
    const yt = new URL(autoplaySrc("https://www.youtube.com/embed/abc?start=30"));
    expect(yt.searchParams.get("start")).toBe("30");
    expect(yt.searchParams.get("autoplay")).toBe("1");
    const tw = new URL(
      autoplaySrc("https://clips.twitch.tv/embed?clip=X&parent=localhost"),
    );
    expect(tw.searchParams.get("parent")).toBe("localhost");
    expect(tw.searchParams.get("autoplay")).toBe("true");
  });

  test("點過的不再放縮圖；關掉開關一律不放", () => {
    const src = "https://www.youtube.com/embed/abc";
    expect(needsVideoFacade(src)).toBe(true);
    activateVideo(src);
    expect(needsVideoFacade(src)).toBe(false);
    expect(needsVideoFacade("https://www.youtube.com/embed/other")).toBe(true);
    setVideoThumbFirst(false);
    expect(needsVideoFacade("https://www.youtube.com/embed/other")).toBe(false);
  });
});

describe("內嵌播放器先放縮圖", () => {
  beforeEach(() => _resetVideoFacadeForTest());
  afterEach(() => {
    document.body.innerHTML = "";
  });

  test("YouTube：沒點之前沒有 iframe，只有縮圖＋播放鈕，框跟播放器一樣大", async () => {
    const value = await requestPreview("https://youtu.be/1m2KVNX4DhI?t=42");
    const { host } = mount(value);
    expect(host.querySelector("iframe")).toBeNull();
    const btn = host.querySelector("button[data-video-facade]");
    expect(btn).not.toBeNull();
    expect(host.querySelector("img.videoFacadePoster").getAttribute("src")).toBe(
      "https://i.ytimg.com/vi/1m2KVNX4DhI/hqdefault.jpg",
    );
    // 手機寬 412 ⇒ 16:9 的 232px（跟播放器框同一個規則，換的時候不跳）。
    expect(boxSize(host)).toEqual({ w: 412, h: 232 });
  });

  test("點了換成播放器、帶 autoplay，框大小不變", async () => {
    const value = await requestPreview("https://youtu.be/1m2KVNX4DhI?t=42");
    const { host } = mount(value);
    const before = boxSize(host);
    host.querySelector("button[data-video-facade]").click();
    await vi.waitFor(() => expect(host.querySelector("iframe")).not.toBeNull());
    const src = new URL(host.querySelector("iframe").getAttribute("src"));
    expect(src.pathname).toBe("/embed/1m2KVNX4DhI");
    expect(src.searchParams.get("start")).toBe("42");
    expect(src.searchParams.get("autoplay")).toBe("1");
    expect(host.querySelector("iframe").getAttribute("allow")).toContain("autoplay");
    expect(host.querySelector("[data-video-facade]")).toBeNull();
    expect(boxSize(host)).toEqual(before);
  });

  test("點過的那支重掛（好讀整份重建）直接是播放器，不再變回縮圖、也不自動播", async () => {
    const value = await requestPreview("https://youtu.be/1m2KVNX4DhI");
    const first = mount(value);
    first.host.querySelector("button[data-video-facade]").click();
    await vi.waitFor(() => expect(first.host.querySelector("iframe")).not.toBeNull());
    first.unmount();
    const again = mount(value);
    const iframe = again.host.querySelector("iframe");
    expect(iframe).not.toBeNull();
    expect(new URL(iframe.getAttribute("src")).searchParams.get("autoplay")).toBeNull();
  });

  test("Twitch clip：沒有縮圖網址也先放播放鈕（深色底）", async () => {
    const value = await requestPreview("https://clips.twitch.tv/SomeClipName-abc");
    const { host } = mount(value);
    expect(host.querySelector("iframe")).toBeNull();
    expect(host.querySelector("button[data-video-facade]")).not.toBeNull();
    expect(host.querySelector("img.videoFacadePoster")).toBeNull();
    expect(boxSize(host)).toEqual({ w: 412, h: 232 });
  });

  test("開關關掉 ⇒ 跟以前一樣直接嵌播放器（不帶 autoplay）", async () => {
    setVideoThumbFirst(false);
    const value = await requestPreview("https://www.youtube.com/watch?v=1m2KVNX4DhI");
    const { host } = mount(value);
    const iframe = host.querySelector("iframe");
    expect(iframe).not.toBeNull();
    expect(host.querySelector("[data-video-facade]")).toBeNull();
    expect(new URL(iframe.getAttribute("src")).searchParams.get("autoplay")).toBeNull();
  });
});
