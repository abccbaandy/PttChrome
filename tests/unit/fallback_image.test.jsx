// Regression for the "自動開圖載入失敗靜默塌掉" bug (per-domain transient host
// failure, e.g. i.urusai.cc rate-limit/hotlink): the old FallbackImage advanced
// on a single onError and rendered `false` once candidates ran out — no loading
// animation, no image, no error — indistinguishable from "沒在讀取". New behaviour:
// each candidate is retried with backoff (loading animation persists), and when
// everything is exhausted a clickable ".previewError" is shown instead of nothing.
//
// Exercised through the real inline render path ImagePreviewer.Inline → FallbackImage
// (jsdom, no network; <img> load/error are fired manually).

import { render, fireEvent, act } from "@testing-library/react";
import ImagePreviewer, {
  PreviewHrefContext,
} from "../../src/components/ImagePreviewer";

// ESM 的具名匯入是 live binding，`vi.spyOn(模組命名空間)` 在這裡不可靠 → 直接 mock。
// ImagePreviewer 只用到 reportProxyLoad 這一個匯出。
const { reportProxyLoad } = vi.hoisted(() => ({ reportProxyLoad: vi.fn() }));
vi.mock("../../src/js/proxy_status", () => ({ reportProxyLoad }));

const Inline = ImagePreviewer.Inline;
const IMG = "http://example.com/a.jpg";

// A single-candidate image descriptor (the common generic-host case).
const renderInline = () => render(<Inline value={{ src: IMG }} />);

const loading = (c) => c.querySelectorAll(".previewLoading").length;
const errorBox = (c) => c.querySelector(".previewError");
const img = (c) => c.querySelector("img");

// Error the current <img>, then run the backoff timer so the retry remounts it.
const errorAndFlushBackoff = (c) => {
  fireEvent.error(img(c));
  act(() => {
    vi.runOnlyPendingTimers();
  });
};

describe("FallbackImage 載入失敗重試 + 可見錯誤態", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("初始：顯示讀取動畫 + 隱藏 img，無錯誤態", () => {
    const { container } = renderInline();
    expect(loading(container)).toBe(1);
    expect(img(container)).not.toBeNull();
    expect(errorBox(container)).toBeNull();
  });

  test("載入失敗 → 退避重試期間讀取動畫不消失（不誤判為沒在讀取）", () => {
    const { container } = renderInline();
    fireEvent.error(img(container));
    // 退避計時中：仍是讀取動畫，尚未進失敗態。
    expect(loading(container)).toBe(1);
    expect(errorBox(container)).toBeNull();
    // 計時到 → 重掛 img 再次嘗試，動畫仍在。
    act(() => {
      vi.runOnlyPendingTimers();
    });
    expect(loading(container)).toBe(1);
    expect(img(container)).not.toBeNull();
  });

  test("候選 + 重試全部耗盡 → 顯示可點擊的『載入失敗』，而非靜默空白", () => {
    const { container } = renderInline();
    // 單一候選：第 1、2 次 error 走退避重試，第 3 次 error 耗盡 → 失敗態。
    errorAndFlushBackoff(container); // retry 1
    errorAndFlushBackoff(container); // retry 2
    fireEvent.error(img(container)); // 用罄 → 前進候選，無下一個 → failed
    expect(errorBox(container)).not.toBeNull();
    expect(errorBox(container).textContent).toContain("載入失敗");
    expect(loading(container)).toBe(0);
    expect(img(container)).toBeNull();
  });

  test("點擊失敗提示 → 重新開跑（回到讀取動畫 + img）", () => {
    const { container } = renderInline();
    errorAndFlushBackoff(container);
    errorAndFlushBackoff(container);
    fireEvent.error(img(container));
    expect(errorBox(container)).not.toBeNull();

    fireEvent.click(errorBox(container));
    expect(errorBox(container)).toBeNull();
    expect(loading(container)).toBe(1);
    expect(img(container)).not.toBeNull();
  });

  // imgur 的 webp 優先（見 imgur_webp_resolver.test.jsx）就是靠這條路徑保底：
  // webp 衍生檔不存在時第一候選會 onError，必須自動退到原副檔名而不是顯示失敗。
  test("第一候選用罄 → 換下一候選（webp 失敗退回原圖的保底路徑）", () => {
    const A = "https://i.imgur.com/abc123.webp";
    const B = "https://i.imgur.com/abc123.jpeg";
    const { container } = render(
      <Inline value={{ type: "image", src: A, srcset: [A, B] }} />,
    );
    expect(img(container).getAttribute("src")).toBe(A);

    errorAndFlushBackoff(container); // retry 1（同候選）
    errorAndFlushBackoff(container); // retry 2（同候選）
    expect(img(container).getAttribute("src")).toBe(A);

    fireEvent.error(img(container)); // 重試用罄 → 前進到下一候選
    expect(img(container).getAttribute("src")).toBe(B);
    expect(loading(container)).toBe(1); // 仍在讀取，不是失敗態
    expect(errorBox(container)).toBeNull();
  });

  test("載入成功 → 隱藏讀取動畫並顯示圖片", () => {
    const { container } = renderInline();
    fireEvent.load(img(container));
    expect(loading(container)).toBe(0);
    expect(img(container)).not.toBeNull();
    expect(img(container).style.display).not.toBe("none");
  });
});

// 連結旁的代理狀態徽章要知道「哪一個候選真的載入成功」，而知道這件事的只有這裡的
// onLoad。href 走 PreviewHrefContext 進來（LazyInlinePreview 提供）。
describe("FallbackImage 回報代理狀態", () => {
  const HREF = "https://imgur.com/abc123";
  const PROXIED = "https://worker.example.dev/abc123.webp";
  const DIRECT = "https://i.imgur.com/abc123.jpg";

  beforeEach(() => {
    vi.useFakeTimers();
    reportProxyLoad.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  const renderWithHref = (value, href) =>
    render(
      <PreviewHrefContext.Provider value={href}>
        <Inline value={value} />
      </PreviewHrefContext.Provider>,
    );

  test("回報實際成功的候選（第一候選就成功）", () => {
    const { container } = renderWithHref(
      { type: "image", src: PROXIED, srcset: [PROXIED, DIRECT] },
      HREF,
    );
    fireEvent.load(img(container));
    expect(reportProxyLoad).toHaveBeenCalledWith(HREF, PROXIED);
  });

  // fail-open：代理候選掛了退到 i.imgur.com。回報的必須是**直連那個**，
  // 分類才會是 none（無徽章），而不是沿用第一候選誤標成「經過代理」。
  test("退回直連候選 → 回報的是直連位址", () => {
    const { container } = renderWithHref(
      { type: "image", src: PROXIED, srcset: [PROXIED, DIRECT] },
      HREF,
    );
    errorAndFlushBackoff(container); // retry 1（同候選）
    errorAndFlushBackoff(container); // retry 2（同候選）
    fireEvent.error(img(container)); // 用罄 → 前進到直連候選
    expect(img(container).getAttribute("src")).toBe(DIRECT);

    fireEvent.load(img(container));
    expect(reportProxyLoad).toHaveBeenCalledWith(HREF, DIRECT);
  });

  // hover 預覽沒有 Provider（context 預設 null）：不回報，也不能炸。
  test("無 href context（hover 預覽路徑）→ 不回報且不丟例外", () => {
    const { container } = renderInline();
    expect(() => fireEvent.load(img(container))).not.toThrow();
    expect(reportProxyLoad).not.toHaveBeenCalled();
  });
});
