// 長推文輸入框（src/components/ContextMenu/LongPushModal.jsx）。
//
// 守三件會直接害到使用者的事：
//   1. 即時則數：使用者要能在按下去之前知道「這會變成幾則推文」
//   2. 非 Big5 字元（emoji）要先講清楚會被略過，而且交出去的內容必須是**已過濾**的
//      —— u2b 對它們回 '\xFF\xFD'，0xFF 是 telnet IAC 而 telnet.js 不做跳脫
//   3. 超過 20 則要先問一次（PTT 有推文冷卻，整段可能跑好幾分鐘）
import { render, screen, fireEvent, act } from "@testing-library/react";
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
  const tree = (show) => (
    <MantineProvider>
      <LongPushModal
        show={show}
        maxBytes={props.maxBytes || 20}
        onHide={props.onHide || (() => {})}
        onConfirm={onConfirm}
        imageUpload={props.imageUpload}
      />
    </MantineProvider>
  );
  const utils = render(tree(props.show === undefined ? true : props.show));
  return { ...utils, onConfirm, show: (v) => utils.rerender(tree(v)) };
};

// 假的 ImageUploadController：只要 setInsertTarget／clearInsertTarget／enabled／
// tryClipboardImage／openFilePicker 這幾個 modal 真的會碰到的方法。
const fakeUpload = (over = {}) => ({
  enabled: () => true,
  setInsertTarget: vi.fn(),
  clearInsertTarget: vi.fn(),
  tryClipboardImage: vi.fn(() => false),
  openFilePicker: vi.fn(),
  ...over,
});

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

// 圖片上傳：上傳完的網址要插進**這個 Textarea**，不是複製到剪貼簿、更不是送給
// PTT（此時底下的畫面是文章列表，每個字元都會變成快捷鍵）。
describe("圖片上傳插入目標", () => {
  test("開著時註冊目標、關掉時清掉同一個目標", () => {
    const imageUpload = fakeUpload();
    const { show } = renderModal({ imageUpload });
    expect(imageUpload.setInsertTarget).toHaveBeenCalledTimes(1);
    const target = imageUpload.setInsertTarget.mock.calls[0][0];
    expect(typeof target.insert).toBe("function");

    show(false);
    expect(imageUpload.clearInsertTarget).toHaveBeenCalledTimes(1);
    // 傳自己回去：避免「A 關閉時把後開的 B 清掉」。
    expect(imageUpload.clearInsertTarget.mock.calls[0][0]).toBe(target);
  });

  test("enableImageUpload 關閉時不註冊（否則判成 target 卻沒東西可插）", () => {
    const imageUpload = fakeUpload({ enabled: () => false });
    renderModal({ imageUpload });
    expect(imageUpload.setInsertTarget).not.toHaveBeenCalled();
  });

  test("插在游標處，不是尾端", () => {
    const imageUpload = fakeUpload();
    renderModal({ imageUpload });
    type("前面後面");
    const el = textarea();
    el.selectionStart = 2;
    el.selectionEnd = 2;
    const target = imageUpload.setInsertTarget.mock.calls[0][0];
    act(() => target.insert("https://i.urusai.cc/ab.png"));
    expect(textarea().value).toBe("前面 https://i.urusai.cc/ab.png 後面");
  });

  test("插入後即時則數重算", () => {
    const imageUpload = fakeUpload();
    renderModal({ imageUpload, maxBytes: 20 });
    type("安安");
    const before = segmentsText();
    const target = imageUpload.setInsertTarget.mock.calls[0][0];
    act(() => target.insert("https://i.urusai.cc/ab.png"));
    // 網址 26 bytes 比上限（20）長 ⇒ 一定會多切出好幾則。
    expect(segmentsText()).not.toBe(before);
    expect(textarea().value).toContain("https://i.urusai.cc/ab.png");
  });

  test("Textarea 的貼上轉給 tryClipboardImage（截圖直接 Ctrl+V）", () => {
    const imageUpload = fakeUpload();
    renderModal({ imageUpload });
    fireEvent.paste(textarea(), { clipboardData: { files: [], items: [] } });
    expect(imageUpload.tryClipboardImage).toHaveBeenCalled();
  });

  test("「插入圖片」按鈕開檔案選擇器", () => {
    const imageUpload = fakeUpload();
    renderModal({ imageUpload });
    fireEvent.click(
      screen.getByRole("button", { name: i18n("longPushModal_uploadImage") }),
    );
    expect(imageUpload.openFilePicker).toHaveBeenCalled();
  });

  test("關閉上傳功能時不出現「插入圖片」按鈕", () => {
    renderModal({ imageUpload: fakeUpload({ enabled: () => false }) });
    expect(
      screen.queryByRole("button", { name: i18n("longPushModal_uploadImage") }),
    ).toBeNull();
  });
});

// URL 比單則上限還長時只能硬切（PTT 沒有「不切」這個選項）⇒ 事先告知，但
// **不擋送出**：二次確認是給「會跑好幾分鐘」用的，這裡攔下來反而礙事。
describe("網址過長警告", () => {
  const LONG_URL = "https://i.urusai.cc/abcdefgh.png"; // 32 bytes

  test("網址比上限長 → 出警告，但送出鍵仍可按", () => {
    renderModal({ maxBytes: 20 });
    type("看這個 " + LONG_URL);
    expect(document.body.textContent).toContain(
      i18n("longPushModal_urlTooLong"),
    );
    expect(
      screen.getByRole("button", { name: i18n("longPushModal_confirm") }),
    ).not.toBeDisabled();
  });

  test("網址塞得下就不出警告", () => {
    renderModal({ maxBytes: 40 });
    type("看這個 " + LONG_URL);
    expect(document.body.textContent).not.toContain(
      i18n("longPushModal_urlTooLong"),
    );
  });

  test("沒有網址時不出警告", () => {
    renderModal({ maxBytes: 4 });
    type("測".repeat(30));
    expect(document.body.textContent).not.toContain(
      i18n("longPushModal_urlTooLong"),
    );
  });
});
