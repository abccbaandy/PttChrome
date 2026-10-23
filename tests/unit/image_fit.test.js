// 預覽圖載「剛好夠用」的縮圖（pref imageFitScreen，js/image_fit.js）。
//
// 鎖的行為：
//   1. 挑到的縮圖框 ≥ 顯示框（裝置像素）⇒ 顯示出來跟原圖一樣；量不到就載原圖。
//   2. 顯示框常數跟 main.css 的 .easyReadingImg 一致（CSS 改了這裡要跟著改）。
//   3. 縮圖候選：代理該尺寸 → 直連該尺寸 → 整串原圖候選墊底。
//   4. 功能關（模組預設）時 twimg descriptor 跟以前逐字相同；開了才多帶 fit。
import fs from "node:fs";
import path from "node:path";
import {
  pickFitSize,
  previewNeededPx,
  PREVIEW_MAX_WIDTH_EM,
  PREVIEW_MAX_HEIGHT_EM,
  setImageFitEnabled,
  setFullResWanted,
  isFullResWanted,
  subscribeFullRes,
  resetImageFitForTest,
} from "../../src/js/image_fit";
import {
  TWIMG_FIT_SIZES,
  twimgSizedCandidates,
  twimgCandidates,
  setImageProxyConfig,
  resetImageProxyConfig,
} from "../../src/js/image_proxy";
import { resolveSrcToImageUrl } from "../../src/components/ImagePreviewer";

const ID = "HSWhvjqbMAIr5Ux";
const TW = `https://pbs.twimg.com/media/${ID}`;
const PROXY = "https://proxy.example.dev";

afterEach(() => {
  resetImageFitForTest();
  resetImageProxyConfig();
});

describe("顯示框 → 縮圖尺寸", () => {
  test("桌機：39em 寬；DPR 1 ⇒ medium、DPR 2 ⇒ large、DPR 3 ⇒ 原圖", () => {
    const base = { emPx: 20, containerWidth: 1600, reflow: false };
    expect(previewNeededPx({ ...base, dpr: 1 })).toBe(780);
    expect(pickFitSize(previewNeededPx({ ...base, dpr: 1 }), TWIMG_FIT_SIZES)).toBe("medium");
    expect(pickFitSize(previewNeededPx({ ...base, dpr: 2 }), TWIMG_FIT_SIZES)).toBe("large");
    expect(pickFitSize(previewNeededPx({ ...base, dpr: 3 }), TWIMG_FIT_SIZES)).toBeNull();
  });

  test("手機好讀（reflow）：寬度上限是容器寬", () => {
    // 393 CSS px 寬、DPR 2.75、字 12px：寬 393×2.75=1081 > 高 19×12×2.75=627 ⇒ medium（1200）
    const need = previewNeededPx({ emPx: 12, containerWidth: 393, reflow: true, dpr: 2.75 });
    expect(need).toBe(1081);
    expect(pickFitSize(need, TWIMG_FIT_SIZES)).toBe("medium");
  });

  test("高度框比寬度框大時以高度為準（直式圖不能糊）", () => {
    // 窄容器 200px、字 20px：19em=380 > 200
    expect(previewNeededPx({ emPx: 20, containerWidth: 200, reflow: true, dpr: 1 })).toBe(380);
  });

  test("框剛好等於需求也算夠；量不到（字級 0、DPR 缺）⇒ 原圖", () => {
    expect(pickFitSize(680, TWIMG_FIT_SIZES)).toBe("small");
    expect(pickFitSize(681, TWIMG_FIT_SIZES)).toBe("medium");
    expect(pickFitSize(previewNeededPx({ emPx: 0, containerWidth: 400, reflow: false, dpr: 1 }), TWIMG_FIT_SIZES)).toBeNull();
    expect(pickFitSize(previewNeededPx({ emPx: 16, containerWidth: 0, reflow: true, dpr: 1 }), TWIMG_FIT_SIZES)).toBeNull();
    expect(pickFitSize(NaN, TWIMG_FIT_SIZES)).toBeNull();
  });

  test("顯示框常數與 main.css 的 .easyReadingImg 一致", () => {
    const css = fs.readFileSync(path.resolve(__dirname, "../../src/css/main.css"), "utf8");
    const block = /\n\.easyReadingImg \{([^}]*)\}/.exec(css);
    expect(block).not.toBeNull();
    expect(block[1]).toMatch(new RegExp(`max-width:\\s*${PREVIEW_MAX_WIDTH_EM}em`));
    expect(block[1]).toMatch(new RegExp(`max-height:\\s*${PREVIEW_MAX_HEIGHT_EM}em`));
  });
});

describe("twimg 縮圖候選", () => {
  test("代理關：直連該尺寸 → 原圖四候選", () => {
    expect(twimgSizedCandidates(ID, "jpg", "medium", undefined)).toEqual([
      `${TW}.jpg:medium`,
      ...twimgCandidates(ID, "jpg", undefined),
    ]);
  });

  test("代理開：代理該尺寸 → 直連該尺寸 → 代理原圖 → 直連原圖", () => {
    const cfg = { enabled: true, base: PROXY, sites: {} };
    const out = twimgSizedCandidates(ID, "png", "small", cfg);
    expect(out.slice(0, 3)).toEqual([
      `${PROXY}/twimg/small/${ID}.png`,
      `${TW}.png:small`,
      `${PROXY}/twimg/orig/${ID}.png`,
    ]);
    expect(out).toEqual([...out.slice(0, 2), ...twimgCandidates(ID, "png", cfg)]);
  });
});

describe("resolver：功能開了才帶 fit", () => {
  const resolve = (src) => resolveSrcToImageUrl({ src });

  test("關（模組預設）：descriptor 跟以前逐字相同", async () => {
    const out = await resolve(`${TW}.jpg`);
    expect(out).not.toHaveProperty("fit");
  });

  test("開：src／srcset 仍是原圖，fit 由小到大列出三種尺寸", async () => {
    setImageProxyConfig({ enabled: true, base: PROXY });
    setImageFitEnabled(true);
    const out = await resolve(`${TW}.jpg`);
    expect(out.src).toBe(`${PROXY}/twimg/orig/${ID}.jpg`);
    expect(out.fit.map(([n, box]) => [n, box])).toEqual(TWIMG_FIT_SIZES);
    expect(out.fit[1][2][0]).toBe(`${PROXY}/twimg/medium/${ID}.jpg`);
  });

  test("imgur 不帶 fit（imgur 縮圖會放大小圖、去掉透明）", async () => {
    setImageFitEnabled(true);
    const out = await resolve("https://i.imgur.com/ofT90A6.jpg");
    expect(out).not.toHaveProperty("fit");
  });
});

describe("要原圖的旗標", () => {
  test("只在值變了才通知", () => {
    const fn = vi.fn();
    const off = subscribeFullRes(fn);
    setFullResWanted(false);
    expect(fn).not.toHaveBeenCalled();
    setFullResWanted(true);
    setFullResWanted(true);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(isFullResWanted()).toBe(true);
    off();
    setFullResWanted(false);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
