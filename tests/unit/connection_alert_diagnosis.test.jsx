// @unit-env browser
// 斷線提示的診斷結果呈現（診斷邏輯本身見 connection_probe.test.js）。
//   origin      ⇒ 「Origin 偽裝設定不正確或未設定」＋設定教學連結＋「改用 Proxy？」
//   unreachable ⇒ PTT／網路問題；不問 proxy（proxy 也探測失敗，開了沒用）
//   沒給 diagnose（或結果 null／disconnected）⇒ 維持原本只有重連的樣子
import { render, fireEvent, screen, act } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import ConnectionAlert from "../../src/components/ConnectionAlert";
import { ORIGIN_SETUP_URL } from "../../src/js/connection_probe";
import { setupI18n, i18n } from "../../src/js/i18n";

window.matchMedia =
  window.matchMedia ||
  (() => ({
    matches: false,
    media: "",
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

const mount = (props) =>
  render(
    <MantineProvider>
      <ConnectionAlert onDismiss={() => {}} {...props} />
    </MantineProvider>,
  );

beforeAll(() => setupI18n());
beforeEach(() => {
  document.body.innerHTML = "";
});

test("診斷中顯示檢查訊息；origin ⇒ 設定提示＋教學連結＋proxy 詢問", async () => {
  const d = deferred();
  const onEnableProxy = vi.fn();
  mount({ diagnose: () => d.promise, onEnableProxy });

  expect(
    await screen.findByText(i18n("alert_connectionChecking")),
  ).toBeTruthy();

  await act(async () => d.resolve("origin"));

  expect(screen.getByText(i18n("alert_connectionOriginBad"))).toBeTruthy();
  const link = screen.getByRole("link", {
    name: i18n("alert_connectionOriginHelp"),
  });
  expect(link.getAttribute("href")).toBe(ORIGIN_SETUP_URL);
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toMatch(/noopener/);
  expect(screen.queryByText(i18n("alert_connectionChecking"))).toBeNull();

  expect(screen.getByText(i18n("alert_connectionProxyAsk"))).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: i18n("alert_connectionProxyYes") }),
  );
  expect(onEnableProxy).toHaveBeenCalledTimes(1);
});

test("origin 下選「否」⇒ proxy 詢問收起，設定提示與重連仍在", async () => {
  mount({ diagnose: async () => "origin", onEnableProxy: vi.fn() });
  fireEvent.click(
    await screen.findByRole("button", {
      name: i18n("alert_connectionProxyNo"),
    }),
  );
  expect(screen.queryByText(i18n("alert_connectionProxyAsk"))).toBeNull();
  expect(
    screen.queryByRole("button", { name: i18n("alert_connectionProxyYes") }),
  ).toBeNull();
  expect(screen.getByText(i18n("alert_connectionOriginBad"))).toBeTruthy();
  expect(
    screen.getByRole("button", { name: i18n("alert_connectionReconnect") }),
  ).toBeTruthy();
});

test("unreachable ⇒ 說明 PTT 連不上，且不問 proxy", async () => {
  mount({ diagnose: async () => "unreachable", onEnableProxy: vi.fn() });
  expect(
    await screen.findByText(i18n("alert_connectionUnreachable")),
  ).toBeTruthy();
  expect(screen.queryByText(i18n("alert_connectionOriginBad"))).toBeNull();
  expect(
    screen.queryByRole("button", { name: i18n("alert_connectionProxyYes") }),
  ).toBeNull();
});

test("結果 null／disconnected ⇒ 只有原本的重連提示", async () => {
  for (const verdict of [null, "disconnected"]) {
    document.body.innerHTML = "";
    const { unmount } = mount({
      diagnose: async () => verdict,
      onEnableProxy: vi.fn(),
    });
    await screen.findByRole("button", {
      name: i18n("alert_connectionReconnect"),
    });
    await act(async () => {});
    expect(screen.queryByText(i18n("alert_connectionChecking"))).toBeNull();
    expect(screen.queryByText(i18n("alert_connectionOriginBad"))).toBeNull();
    expect(screen.queryByText(i18n("alert_connectionUnreachable"))).toBeNull();
    unmount();
  }
});

test("提示關掉後診斷才回來 ⇒ 不噴 React 警告", async () => {
  const d = deferred();
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const { unmount } = mount({ diagnose: () => d.promise });
  unmount();
  await act(async () => d.resolve("origin"));
  expect(err).not.toHaveBeenCalled();
  err.mockRestore();
});
