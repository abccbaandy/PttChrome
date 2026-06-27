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
import ImagePreviewer from "../../src/components/ImagePreviewer";

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
    jest.runOnlyPendingTimers();
  });
};

describe("FallbackImage 載入失敗重試 + 可見錯誤態", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

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
      jest.runOnlyPendingTimers();
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

  test("載入成功 → 隱藏讀取動畫並顯示圖片", () => {
    const { container } = renderInline();
    fireEvent.load(img(container));
    expect(loading(container)).toBe(0);
    expect(img(container)).not.toBeNull();
    expect(img(container).style.display).not.toBe("none");
  });
});
