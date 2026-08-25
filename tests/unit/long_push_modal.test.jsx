// 長推文輸入框（src/components/ContextMenu/LongPushModal.jsx）。
//
// 守三件會直接害到使用者的事：
//   1. 即時則數：使用者要能在按下去之前知道「這會變成幾則推文」
//   2. 非 Big5 字元（emoji）要先講清楚會被略過，而且交出去的內容必須是**已過濾**的
//      —— u2b 對它們回 '\xFF\xFD'，0xFF 是 telnet IAC 而 telnet.js 不做跳脫
//   3. 超過 20 則要先問一次（PTT 有推文冷卻，整段可能跑好幾分鐘）
import { render, screen, fireEvent } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { loadBig5Tables } from "./helpers/load_big5_tables";
import LongPushModal from "../../src/components/ContextMenu/LongPushModal";
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
// Mantine 的 Textarea autosize 會掛在 document.fonts 的 loadingdone 上（等字體
// 載完重算高度），jsdom 沒有 FontFaceSet ⇒ 不補會在 mount 就 throw。
if (!document.fonts)
  Object.defineProperty(document, "fonts", {
    value: { addEventListener() {}, removeEventListener() {} },
    configurable: true,
  });

beforeAll(() => {
  loadBig5Tables();
  setupI18n();
});

const renderModal = (props = {}) => {
  const onConfirm = props.onConfirm || vi.fn();
  const utils = render(
    <MantineProvider>
      <LongPushModal
        show
        maxBytes={props.maxBytes || 20}
        onHide={props.onHide || (() => {})}
        onConfirm={onConfirm}
      />
    </MantineProvider>,
  );
  return { ...utils, onConfirm };
};

const textarea = () => document.querySelector('[name="longPushText"]');
const type = (value) => fireEvent.change(textarea(), { target: { value } });
const submit = () =>
  fireEvent.submit(textarea().closest("form"));
const segmentsText = () =>
  screen.getByTestId("longPushSegments").textContent;

describe("即時則數", () => {
  test("空白時是 0 則、送出鍵停用", () => {
    renderModal();
    expect(segmentsText()).toContain("0");
    expect(
      screen.getByRole("button", { name: i18n("longPushModal_confirm") }),
    ).toBeDisabled();
  });

  test("依 Big5 byte 上限算出則數", () => {
    renderModal({ maxBytes: 20 });
    type("測".repeat(30)); // 60 bytes，20 bytes/則（段末全形讓 1 byte）
    expect(segmentsText()).toContain("4");
  });
});

describe("非 Big5 字元", () => {
  test("提示會被略過，而且交出去的內容已經濾掉了", () => {
    const { onConfirm } = renderModal();
    type("好耶🎉");
    expect(document.body.textContent).toContain("🎉");
    submit();
    expect(onConfirm).toHaveBeenCalledWith({ text: "好耶", type: "push" });
  });
});

describe("推文類型", () => {
  test("預設是「推」", () => {
    const { onConfirm } = renderModal();
    type("安安");
    submit();
    expect(onConfirm.mock.calls[0][0].type).toBe("push");
  });

  test("可以改成噓", () => {
    const { onConfirm } = renderModal();
    type("安安");
    fireEvent.click(screen.getByText(i18n("longPushModal_typeBoo")));
    submit();
    expect(onConfirm.mock.calls[0][0].type).toBe("boo");
  });
});

describe("超過 20 則的二次確認", () => {
  test("第一次送出只跳警示、不真的送；再按一次才送", () => {
    const { onConfirm } = renderModal({ maxBytes: 4 });
    type("測".repeat(30)); // 4 bytes/則 ⇒ 遠超過 20 則
    submit();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: i18n("longPushModal_confirmAnyway") }),
    ).toBeTruthy();

    submit();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  test("確認後又改內容 → 確認重新算數（不會一路送出去）", () => {
    const { onConfirm } = renderModal({ maxBytes: 4 });
    type("測".repeat(30));
    submit(); // 進入確認狀態
    type("測".repeat(40)); // 則數變了
    submit();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test("20 則以內直接送", () => {
    const { onConfirm } = renderModal({ maxBytes: 20 });
    type("測".repeat(30));
    submit();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
