// 自動開圖的接線守護。好讀模式的文章頁走 ScreenController（enableLinkInlinePreview）
// → buildRow → link_segment，替每個超連結掛一個延遲載入佔位盒；佔位盒在視野內時
// 掛上 <ImagePreviewer component={Inline}>。曾經回歸過：term_view 傳
// enableLinkInlinePreview=false，所有內嵌圖片就靜默消失，這裡守那條鏈。
//
// jsdom 沒有 IntersectionObserver ⇒ 佔位盒立即掛載（lazyPreviewSupported() 為
// false 的行為，與這個功能不存在時相同）。一般圖片網址的 resolver 鏈是
// Promise.resolve({type:"image"})，在同步斷言之後的 microtask 才 resolve ⇒ 斷言當下
// ImagePreviewer 還是 undefined → Inline 畫 <LoadingOverlay>（.previewLoading）。
// 數那些節點：一個掛上的 inline ImagePreviewer 一個。

import { mountScreen, mountRow, unmountAll } from "./helpers/mount_screen";
import { requestPreview } from "../../src/components/ImagePreviewer";

const COLOR = {
  fg: 7,
  bg: 0,
  blink: false,
  equals(o) {
    return o === this;
  },
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
    getColor: () => COLOR,
  }));
}

const IMG_URL = "http://example.com/a.jpg";

afterEach(unmountAll);

// 掛載後立刻數載入指示器（一個掛上的 inline ImagePreviewer 一個），再讓 resolver
// 鏈跨兩輪 macrotask 沉澱。指示器數量在掛載當下就固定（value 還是 undefined），
// 所以沉澱不會改變結果。
async function countPreviews(mounted) {
  const n = mounted.container.querySelectorAll(".previewLoading").length;
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return n;
}

describe("inline image preview wiring", () => {
  test("一列 enableLinkInlinePreview=true → 每個連結一個 inline ImagePreviewer", async () => {
    expect(
      await countPreviews(
        mountRow({
          chars: urlRow(IMG_URL),
          row: 0,
          enableLinkInlinePreview: true,
        }),
      ),
    ).toBe(1);
  });

  test("一列 enableLinkInlinePreview=false → 沒有 inline 預覽", async () => {
    expect(
      await countPreviews(
        mountRow({
          chars: urlRow(IMG_URL),
          row: 0,
          enableLinkInlinePreview: false,
        }),
      ),
    ).toBe(0);
  });

  // ScreenController 是兩個模式共用的單一渲染路徑；驗證它把旗標往下傳到每一列
  // （這正是上游那次好讀回歸打斷的接線）。
  test("ScreenController 把 enableLinkInlinePreview 傳給每一列", async () => {
    expect(
      await countPreviews(
        mountScreen({
          lines: [urlRow(IMG_URL)],
          forceWidth: 20,
          enableLinkInlinePreview: true,
          enableLinkHoverPreview: false,
        }),
      ),
    ).toBe(1);
    expect(
      await countPreviews(
        mountScreen({
          lines: [urlRow(IMG_URL)],
          forceWidth: 20,
          enableLinkInlinePreview: false,
          enableLinkHoverPreview: false,
        }),
      ),
    ).toBe(0);
  });
});

// 進文章報錯回歸：requestPreview 在掛載期就建立 promise，不可預覽的一般連結
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
