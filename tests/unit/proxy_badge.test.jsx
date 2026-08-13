// 連結旁的代理狀態徽章。三態：無徽章／經過代理（未命中）／經過代理且命中。
//
// 「none 完全不渲染」是硬契約：代理沒生效時（含 fail-open 退回直連）畫面必須與這個
// 功能不存在時逐字相同，不可留下空的 span 去撐等寬格線。

import { render, act } from "@testing-library/react";
import ProxyBadge from "../../src/components/Row/ProxyBadge";
import {
  ingestEntryForTest,
  reportProxyLoad,
  resetProxyStatusForTest,
} from "../../src/js/proxy_status";
import {
  resetImgurProxyConfig,
  setImgurProxyConfig,
} from "../../src/js/imgur_proxy";

const BASE = "https://worker.example.dev";
const HREF = "https://imgur.com/abc123";
const URL_A = `${BASE}/abc123.jpg`;
const NOW_SEC = Math.floor(Date.now() / 1000);

const entry = (stampSec) => ({
  name: URL_A,
  initiatorType: "img",
  transferSize: 40000,
  encodedBodySize: 39700,
  serverTiming: [{ name: "pttproxy", description: String(stampSec) }],
});

const badge = (c) => c.querySelector(".proxyBadge");

describe("ProxyBadge", () => {
  beforeEach(() => {
    resetProxyStatusForTest();
    setImgurProxyConfig({ enabled: true, base: BASE });
  });
  afterEach(() => {
    resetProxyStatusForTest();
    resetImgurProxyConfig();
  });

  test("狀態 none → 不渲染任何節點", () => {
    const { container } = render(<ProxyBadge href={HREF} />);
    expect(container.innerHTML).toBe("");
  });

  test("經過代理但未命中 → ◇，只有 .proxyBadge", () => {
    const { container } = render(<ProxyBadge href={HREF} />);
    act(() => {
      reportProxyLoad(HREF, URL_A);
      ingestEntryForTest(entry(NOW_SEC));
    });
    expect(badge(container).textContent).toBe("◇");
    expect(badge(container).classList.contains("proxyBadge--cache")).toBe(false);
    expect(badge(container).getAttribute("title")).toContain("未命中");
  });

  test("代理快取命中 → ◆，加上 .proxyBadge--cache", () => {
    const { container } = render(<ProxyBadge href={HREF} />);
    act(() => {
      reportProxyLoad(HREF, URL_A);
      ingestEntryForTest(entry(NOW_SEC - 86400));
    });
    expect(badge(container).textContent).toBe("◆");
    expect(badge(container).classList.contains("proxyBadge--cache")).toBe(true);
    expect(badge(container).getAttribute("title")).toContain("命中");
  });

  test("退回直連 → 維持不渲染", () => {
    const { container } = render(<ProxyBadge href={HREF} />);
    act(() => {
      reportProxyLoad(HREF, "https://i.imgur.com/abc123.jpg");
    });
    expect(container.innerHTML).toBe("");
  });

  test("不同 href 的載入不會互相沾染", () => {
    const { container } = render(<ProxyBadge href="https://imgur.com/other" />);
    act(() => {
      reportProxyLoad(HREF, URL_A);
      ingestEntryForTest(entry(NOW_SEC));
    });
    expect(container.innerHTML).toBe("");
  });
});
