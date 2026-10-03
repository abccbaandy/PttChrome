// @unit-env browser
// 自動開圖的「讀取中」／「載入失敗」指示器：外框高度（含垂直 margin）必須是整數像素。
//
// 延遲載入會在視窗外 LAZY_MOUNT_MARGIN_PX 內預載。指示器出現（0 → 指示器）與被真圖取代
// （指示器 → 圖）時，視窗上方的總高各變一次；高度帶小數時 scroll anchoring 補償後的
// 捲動位置被對齊到整數 ⇒ 視窗內文字先差 +0.094px、圖載完再 −0.094px（實測字級 32：
// 指示器 74.09375px）。e2e 症狀守護在 tests/e2e/offline/easy_reading_longpost_perf.offline.spec.js
// （低機率、要並行壓力才重現），這裡用真 Chromium＋整份 main.css 決定性地鎖住成因。
//
// 標記與 src/components/ImagePreviewer.jsx 的 LoadingOverlay／錯誤提示一致（只量版面，
// 不需要 React）。
import css from "../../src/css/main.css?raw";

let style;
let host;

beforeAll(() => {
  style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
});

afterAll(() => {
  style.remove();
});

afterEach(() => {
  if (host) host.remove();
  host = null;
});

// flow-root 包住子元素的 margin ⇒ host 的高度＝指示器的外框高度（含上下 margin）。
function outerHeight(fontSizePx, html) {
  host = document.createElement("div");
  host.style.cssText = `display:flow-root;width:800px;font-size:${fontSizePx}px;`;
  host.innerHTML = html;
  document.body.appendChild(host);
  return host.getBoundingClientRect().height;
}

const LOADING =
  '<div class="previewLoading"><span class="previewSpinner"></span>' +
  '<span class="previewLoadingText">讀取中…</span>' +
  '<span class="previewLoadingBar"><span class="previewLoadingBarFill"></span></span></div>';
const ERROR = '<div class="previewError">圖片載入失敗，點擊重試</div>';

// 字級＝終端機 chh 的可能範圍（含非 20 倍數、會算出小數 em 的值）。
const FONT_SIZES = [];
for (let f = 12; f <= 48; ++f) FONT_SIZES.push(f);

describe("預覽指示器外框高度是整數像素", () => {
  test.each(FONT_SIZES)("讀取中 @ %ipx", (f) => {
    const h = outerHeight(f, LOADING);
    expect(h).toBeGreaterThan(0);
    expect(Number.isInteger(h), `高度 ${h}`).toBe(true);
  });

  test.each(FONT_SIZES)("載入失敗 @ %ipx", (f) => {
    const h = outerHeight(f, ERROR);
    expect(h).toBeGreaterThan(0);
    expect(Number.isInteger(h), `高度 ${h}`).toBe(true);
  });

  test("讀取中：spinner 與文字都裝得下（固定高度沒有裁掉內容）", () => {
    for (const f of FONT_SIZES) {
      outerHeight(f, LOADING);
      const box = host.querySelector(".previewLoading").getBoundingClientRect();
      for (const sel of [".previewSpinner", ".previewLoadingText"]) {
        const r = host.querySelector(sel).getBoundingClientRect();
        expect(r.top, `${sel} @ ${f}px`).toBeGreaterThanOrEqual(box.top - 0.5);
        expect(r.bottom, `${sel} @ ${f}px`).toBeLessThanOrEqual(box.bottom + 0.5);
      }
      host.remove();
      host = null;
    }
  });
});
