// Rendering test for inline image preview wiring (the "自動開圖" feature). In easy
// reading the article page is drawn via <Screen enableLinkInlinePreview> → <Row> →
// LinkSegmentBuilder, which pushes an <ImagePreviewer component={Inline}> next to
// every hyperlink. A regression where term_view passed enableLinkInlinePreview=false
// silently dropped all inline images, so this guards the Screen→Row→builder path.
//
// @testing-library/react under jsdom (no network): for a plain image URL the
// resolver chain is Promise.resolve({type:"image"}) — no fetch / new Image() — and
// resolves in a microtask AFTER the synchronous render()/assert. So at assert time
// ImagePreviewer's value is still undefined → Inline renders <LoadingOverlay>
// (.previewLoading). We count those nodes: one per mounted inline ImagePreviewer.

import { render, act, fireEvent } from "@testing-library/react";
import Screen from "../../src/components/Screen";
import Row from "../../src/components/Row";
import { requestPreview } from "../../src/components/ImagePreviewer";
import {
  ingestEntryForTest,
  resetProxyStatusForTest,
} from "../../src/js/proxy_status";
import {
  resetImgurProxyConfig,
  setImgurProxyConfig,
} from "../../src/js/imgur_proxy";

const COLOR = {
  fg: 7,
  bg: 0,
  blink: false,
  equals(o) {
    return o === this;
  }
};

// A row of cells spelling out a single hyperlink: first cell is start-of-URL, last
// is end-of-URL, getFullURL returns the whole link (how TermBuf marks URL runs).
function urlRow(url) {
  return url.split("").map((c, i) => ({
    ch: c,
    isLeadByte: false,
    isStartOfURL: () => i === 0,
    isEndOfURL: () => i === url.length - 1,
    getFullURL: () => url,
    getColor: () => COLOR
  }));
}

const IMG_URL = "http://example.com/a.jpg";

// Count the loading overlays present right after mount (one per inline
// ImagePreviewer), then let the resolver promise chain settle inside act() so the
// trailing async setState doesn't log a "not wrapped in act" warning. The overlay
// count is fixed at mount (value still undefined), so flushing doesn't change it.
async function countPreviews(element) {
  const { container } = render(element);
  const n = container.querySelectorAll(".previewLoading").length;
  // Drain the resolver promise chain (of → resolveSrcToImageUrl → handle*) across
  // a couple of macrotasks so the trailing async setState lands inside act().
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  return n;
}

describe("inline image preview wiring", () => {
  test("Row with enableLinkInlinePreview=true → one inline ImagePreviewer per link", async () => {
    expect(
      await countPreviews(<Row chars={urlRow(IMG_URL)} row={0} enableLinkInlinePreview={true} />)
    ).toBe(1);
  });

  test("Row with enableLinkInlinePreview=false → no inline preview", async () => {
    expect(
      await countPreviews(<Row chars={urlRow(IMG_URL)} row={0} enableLinkInlinePreview={false} />)
    ).toBe(0);
  });

  // Screen is the single render path both modes use; verify it forwards the flag to
  // Row (this is exactly the wiring the easy-reading regression broke upstream).
  test("Screen forwards enableLinkInlinePreview to its rows", async () => {
    expect(
      await countPreviews(
        <Screen
          lines={[urlRow(IMG_URL)]}
          forceWidth={20}
          enableLinkInlinePreview={true}
          enableLinkHoverPreview={false}
        />
      )
    ).toBe(1);
    expect(
      await countPreviews(
        <Screen
          lines={[urlRow(IMG_URL)]}
          forceWidth={20}
          enableLinkInlinePreview={false}
          enableLinkHoverPreview={false}
        />
      )
    ).toBe(0);
  });
});

// 原生 24 列模式不掛 inline 預覽，hover 預覽是唯一會觸發載入的路徑 ⇒ 代理狀態徽章
// 要在原生模式出現，Screen 就必須把 href 用 PreviewHrefContext 傳進 OnHover。
// 功能引入時只有 LazyInlinePreview 有 Provider，原生模式的徽章**永遠**不會出現，
// 而 README／docs 都宣稱會 —— 這條守的就是那個接線。
describe("hover 預覽 → 代理狀態徽章接線", () => {
  const BASE = "https://worker.example.dev";
  const HOVER_URL = `${BASE}/abc123.jpg`;

  beforeEach(() => {
    resetProxyStatusForTest();
    setImgurProxyConfig({ enabled: true, base: BASE });
  });
  afterEach(() => {
    resetProxyStatusForTest();
    resetImgurProxyConfig();
  });

  test("hover 載入成功且計時項顯示走過代理 → 該連結旁出現徽章", async () => {
    // jsdom 的 new Image() 不會真的載入，而 resolveWithImageDOM 要等它 onload 才
    // resolve（hover 專屬的量高度步驟）→ 沒有這個替身就永遠停在讀取指示器。
    const OrigImage = globalThis.Image;
    globalThis.Image = class {
      constructor() {
        this.height = 100;
      }
      set src(v) {
        this._src = v;
        setTimeout(() => this.onload && this.onload(), 0);
      }
      get src() {
        return this._src;
      }
    };
    try {
      const { container } = render(
        <Screen
          lines={[urlRow(HOVER_URL)]}
          forceWidth={80}
          enableLinkInlinePreview={false}
          enableLinkHoverPreview={true}
        />,
      );
      await act(async () => {
        fireEvent.mouseOver(container.querySelector("a"));
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));
      });

      const hoverImg = container.querySelector("img");
      expect(hoverImg).not.toBeNull();
      act(() => {
        fireEvent.load(hoverImg);
        ingestEntryForTest({
          name: HOVER_URL,
          initiatorType: "img",
          startTime: 1,
          transferSize: 40000,
          encodedBodySize: 39700,
          serverTiming: [
            {
              name: "pttproxy",
              description: String(Math.floor(Date.now() / 1000)),
            },
          ],
        });
      });
      expect(container.querySelector(".proxyBadge")).not.toBeNull();
    } finally {
      globalThis.Image = OrigImage;
    }
  });
});

// 進文章報錯回歸：requestPreview 在 render 期就建立 promise，不可預覽的一般連結
// （default resolver）立即 reject("Unimplemented")，而 <ImagePreviewer> 的
// rejection handler 要等 useEffect（commit 後）才掛上 —— 中間會觸發
// unhandledrejection（dev overlay 彈 ERROR）。requestPreview 必須在建立時就標記
// handled，且消費端仍照常收到 reject。
describe("requestPreview 不可預覽連結不產生 unhandled rejection", () => {
  test("建立後放置一輪 event loop：無 unhandledRejection；消費端仍收到 reject", async () => {
    const events = [];
    const onUnhandled = (reason) => events.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const p = requestPreview("https://example.com/not-media-page.html");
      // 故意先不掛 handler，跨一輪 macrotask 讓 node 有機會回報 unhandled。
      await new Promise((res) => setTimeout(res, 0));
      await new Promise((res) => setTimeout(res, 0));
      expect(events).toEqual([]);
      // 消費端照常收到 reject（ImagePreviewer 的 state.error 路徑不變）。
      await expect(p).rejects.toThrow("Unimplemented");
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });
});
