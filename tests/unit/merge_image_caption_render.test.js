// 好讀「圖左字右合併」的渲染接線守護（仿 screen_dropHidden.test.js）：
//   - 合併狀態是 renderer 的內部 state（浮動按鈕切換）：開啟時翻譯行從頂層消失、
//     搬進所屬圖行的 .mergedCaptionCol；data-row 保留絕對 index。
//   - 右欄寬度動態＝最寬翻譯行欄數（半形1/全形2）換算像素（不換行）。
//   - articleId 變（換文章/退出再進）→ 合併狀態重置回關（regression：曾為
//     session-sticky，換到沒按鈕的文章後關不掉）。
//   - 按鈕條件：easyReading + 文章頁 + ≥2 個「圖＋說明」塊。
import { mountScreen, unmountAll } from "./helpers/mount_screen";

afterEach(unmountAll);

const COLOR = {
  fg: 7,
  bg: 0,
  blink: false,
  equals(o) {
    return o === this;
  },
};

function cell(c) {
  return {
    ch: c,
    isLeadByte: false,
    isStartOfURL: () => false,
    isEndOfURL: () => false,
    getFullURL: () => null,
    getColor: () => COLOR,
  };
}
const line = (str) => str.split("").map(cell);

const lines = [
  line("前導文字"), // 0
  line("https://i.imgur.com/aaa111.jpg"), // 1 圖1
  line("翻譯一"), // 2
  line("翻譯二二二"), // 3（最寬：10 欄）
  line("https://i.imgur.com/bbb222.jpg"), // 4 圖2
  line("第二段翻譯"), // 5
  line("--"), // 6
  line("推 someuser: 讚 06/13 12:01"), // 7
];

const bbslines = (c) => Array.from(c.querySelectorAll('[data-type="bbsline"]'));
const dataRows = (c) =>
  bbslines(c).map((n) => parseInt(n.getAttribute("data-row"), 10));
const FORCE_WIDTH = 20;

const enhanceFor = ({ easyReading = true, articleId = 1 } = {}) => ({
  pageState: 3,
  easyReading,
  dropHidden: true,
  articleId,
});

function renderScreen(opts) {
  return mountScreen({ lines: lines, forceWidth: FORCE_WIDTH, enableLinkInlinePreview: false, enableLinkHoverPreview: false, enhance: enhanceFor(opts) });
}

describe("圖文合併 render", () => {
  test("預設關：無 wrapper；點按鈕合併：翻譯行進 .mergedCaptionCol、data-row 保留、右欄寬度動態", () => {
    const { container: c } = renderScreen({});
    // 預設關閉、按鈕存在。
    expect(c.querySelectorAll(".mergedImageBlock").length).toBe(0);
    const btn = c.querySelector("#mergeImageCaptionBtn");
    expect(btn).not.toBeNull();

    btn.click();
    expect(c.querySelectorAll(".mergedImageBlock").length).toBe(2);
    // 全部 8 列都在（沒有行被丟掉），絕對 index 不變。
    expect(dataRows(c).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // 翻譯行 2,3 在圖1 的右欄；5 在圖2 的右欄。
    const cols = c.querySelectorAll(".mergedCaptionCol");
    expect(
      Array.from(cols[0].querySelectorAll("[data-row]")).map((n) =>
        parseInt(n.getAttribute("data-row"), 10),
      ),
    ).toEqual([2, 3]);
    expect(
      Array.from(cols[1].querySelectorAll("[data-row]")).map((n) =>
        parseInt(n.getAttribute("data-row"), 10),
      ),
    ).toEqual([5]);
    // 翻譯行不在頂層。
    // c 就是 #mainContainer（mountScreen 直接回 controller 的容器）。
    const topLevelIdx = Array.from(c.querySelectorAll(":scope > span")).map((n) =>
      parseInt(n.querySelector("[data-row]").getAttribute("data-row"), 10),
    );
    expect(topLevelIdx).toEqual([0, 6, 7]);
    // 右欄寬度＝(最寬 10 欄 / 2 + 1) × forceWidth = 120px（不換行）。
    expect(cols[0].style.width).toBe(`${(10 / 2 + 1) * FORCE_WIDTH}px`);

    // 再點一次 → 切「上文下圖」：圖行之前的文字歸該圖右欄。
    c.querySelector("#mergeImageCaptionBtn").click();
    expect(c.querySelectorAll(".mergedImageBlock").length).toBe(2);
    const cols2 = c.querySelectorAll(".mergedCaptionCol");
    expect(
      Array.from(cols2[0].querySelectorAll("[data-row]")).map((n) =>
        parseInt(n.getAttribute("data-row"), 10),
      ),
    ).toEqual([0]); // 前導文字 → 圖1
    expect(
      Array.from(cols2[1].querySelectorAll("[data-row]")).map((n) =>
        parseInt(n.getAttribute("data-row"), 10),
      ),
    ).toEqual([2, 3]); // 翻譯一/二 → 圖2
    expect(dataRows(c).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

    // 第三次點 → 還原關閉。
    c.querySelector("#mergeImageCaptionBtn").click();
    expect(c.querySelectorAll(".mergedImageBlock").length).toBe(0);
    expect(dataRows(c)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  test("純上文下圖文章：imageFirst 塊數 <2 但 captionFirst ≥2 → 按鈕仍顯示", () => {
    const captionFirstLines = [
      line("第一張翻譯"), // 0
      line("https://i.imgur.com/aaa111.jpg"), // 1
      line("第二張翻譯"), // 2
      line("https://i.imgur.com/bbb222.jpg"), // 3
    ];
    const { container: c } = mountScreen({ lines: captionFirstLines, forceWidth: FORCE_WIDTH, enableLinkInlinePreview: false, enableLinkHoverPreview: false, enhance: enhanceFor({}) });
    const btn = c.querySelector("#mergeImageCaptionBtn");
    expect(btn).not.toBeNull();
    // imageFirst 只有 1 塊（圖2 之後無字）→ 第一次點只合併 1 塊。
    btn.click();
    expect(c.querySelectorAll(".mergedImageBlock").length).toBe(1);
    // 第二次點 → captionFirst 合併 2 塊。
    c.querySelector("#mergeImageCaptionBtn").click();
    expect(c.querySelectorAll(".mergedImageBlock").length).toBe(2);
  });

  test("articleId 變（換文章）→ 合併狀態重置回關", () => {
    const screen = renderScreen({ articleId: 1 });
    const c = screen.container;
    c.querySelector("#mergeImageCaptionBtn").click();
    expect(c.querySelectorAll(".mergedImageBlock").length).toBe(2);
    screen.update({ lines, forceWidth: FORCE_WIDTH, enableLinkInlinePreview: false, enableLinkHoverPreview: false, enhance: enhanceFor({ articleId: 2 }) });
    expect(c.querySelectorAll(".mergedImageBlock").length).toBe(0);
  });

  test("非好讀模式：不分組、無按鈕", () => {
    const { container: c } = renderScreen({ easyReading: false });
    expect(c.querySelectorAll(".mergedImageBlock").length).toBe(0);
    expect(c.querySelector("#mergeImageCaptionBtn")).toBeNull();
  });

  test("塊數 <2 → 無按鈕", () => {
    const { container: c } = mountScreen({
      lines: [lines[1], lines[2]], // 只有一塊
      forceWidth: FORCE_WIDTH,
      enableLinkInlinePreview: false,
      enableLinkHoverPreview: false,
      enhance: enhanceFor({}),
    });
    expect(c.querySelector("#mergeImageCaptionBtn")).toBeNull();
  });
});
