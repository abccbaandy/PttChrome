// 長推文推不出去時的錯誤框（src/components/ContextMenu/LongPushErrorModal.jsx）。
//
// 這支守的是本功能最重要的一條規矩：**PTT 說的話原文照錄**。
// PTT 的擋人訊息會隨站方設定與版本變（「無法推文: <reason>」的 reason 更是動態
// 的），任何硬寫的對照表都會在改版那天靜默壞掉、讓使用者看到一句與 PTT 無關的話。
// 所以這裡逐字比對，順便釘住「這句話是誰說的」那行標示。
//
// 第二條：剩餘內容**不自動進剪貼簿**（舊版偷偷 doCopy ⇒ 無聲蓋掉使用者手上的東西），
// 要讀得回來、要按了才複製。
import { render, screen, fireEvent } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import LongPushErrorModal from "../../src/components/ContextMenu/LongPushErrorModal";
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
window.ResizeObserver =
  window.ResizeObserver ||
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
window.scrollTo = window.scrollTo || (() => {});
if (!document.fonts)
  Object.defineProperty(document, "fonts", {
    value: { addEventListener() {}, removeEventListener() {} },
    configurable: true,
  });

beforeAll(() => setupI18n());

const renderModal = (error, extra = {}) => {
  const onCopy = extra.onCopy || vi.fn();
  const onHide = extra.onHide || vi.fn();
  render(
    <MantineProvider>
      <LongPushErrorModal error={error} onHide={onHide} onCopy={onCopy} />
    </MantineProvider>,
  );
  return { onCopy, onHide };
};

const PTT_BLOCKED = {
  blocked: true,
  phase: "preflight",
  source: "ptt",
  message: "無法推文: 權限不足",
  sent: 0,
  rest: "",
};

describe("PTT 的訊息", () => {
  test.each([
    "抱歉, 禁止推薦",
    "無法推文: 權限不足",
    "未達看板發文限制: 您的文章數不足",
    // 沒看過的新訊息照樣原文轉達 —— 這正是不 hardcode 的重點。
    "未來才會有的新規則: 這台 client 沒看過",
  ])("原文照錄：%s", (message) => {
    renderModal({ ...PTT_BLOCKED, message });
    expect(screen.getByTestId("longPushErrorMessage").textContent).toBe(message);
  });

  test("標明是 PTT 說的", () => {
    renderModal(PTT_BLOCKED);
    expect(screen.getByTestId("longPushErrorSource").textContent).toBe(
      i18n("longPushError_sourcePtt"),
    );
  });

  test("本程式自己的判斷要標成不同來源（使用者該做的事完全不同）", () => {
    renderModal({
      ...PTT_BLOCKED,
      source: "client",
      message: "PTT 沒有回應",
      reason: "timeout",
    });
    expect(screen.getByTestId("longPushErrorSource").textContent).toBe(
      i18n("longPushError_sourceClient"),
    );
    expect(document.body.textContent).toContain("timeout");
  });
});

describe("已送出幾則", () => {
  test("一則都還沒送 → 不提「無法收回」", () => {
    renderModal(PTT_BLOCKED);
    expect(screen.getByTestId("longPushErrorSent").textContent).toBe(
      i18n("longPushError_sentNone"),
    );
    expect(document.body.textContent).not.toContain(
      i18n("longPushError_noRecall"),
    );
  });

  test("送出途中中止 → 說清楚送了幾則、而且收不回來", () => {
    renderModal({
      blocked: true,
      phase: "sending",
      source: "ptt",
      message: "抱歉, 禁止推薦",
      sent: 3,
      rest: "還沒送出的那段",
    });
    expect(screen.getByTestId("longPushErrorSent").textContent).toContain("3");
    expect(document.body.textContent).toContain(i18n("longPushError_noRecall"));
  });
});

describe("剩餘內容", () => {
  const WITH_REST = {
    blocked: true,
    phase: "sending",
    source: "client",
    message: "畫面已變更",
    sent: 1,
    rest: "第二段\n第三段",
  };

  test("讀得回來（唯讀，可選取）", () => {
    renderModal(WITH_REST);
    const box = document.querySelector('[name="longPushRest"]');
    expect(box.value).toBe(WITH_REST.rest);
    expect(box.readOnly).toBe(true);
  });

  test("按了才複製，而且複製的是完整內容", () => {
    const { onCopy } = renderModal(WITH_REST);
    // 純顯示的階段不可以碰剪貼簿。
    expect(onCopy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(i18n("longPushError_copyRest")));
    expect(onCopy).toHaveBeenCalledWith(WITH_REST.rest);
  });

  test("沒有剩餘內容時不畫空的框與複製鈕", () => {
    renderModal(PTT_BLOCKED);
    expect(document.querySelector('[name="longPushRest"]')).toBeNull();
    expect(screen.queryByText(i18n("longPushError_copyRest"))).toBeNull();
  });
});

describe("標題與關閉", () => {
  test.each([
    ["preflight", "longPushError_title"],
    ["sending", "longPushError_titleSending"],
    ["cancelled", "longPushError_titleCancelled"],
  ])("phase=%s → %s", (phase, key) => {
    renderModal({ ...PTT_BLOCKED, phase });
    expect(screen.getByText(i18n(key))).toBeTruthy();
  });

  test("關閉鈕走 onHide", () => {
    const { onHide } = renderModal(PTT_BLOCKED);
    fireEvent.click(screen.getByText(i18n("longPushError_close")));
    expect(onHide).toHaveBeenCalled();
  });

  test("error 為 null 時整個框不存在", () => {
    renderModal(null);
    expect(screen.queryByTestId("longPushErrorMessage")).toBeNull();
  });
});
