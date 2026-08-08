// 斷線提示（ConnectionAlert）掛在 window capture 階段的 keydown 攔截器。
//
// 回歸守護（實際回報：PTT 維護期間開設定頁，欄位完全打不了字）：原本的攔截器對
// **所有**按鍵無條件 preventDefault + stopImmediatePropagation，理由是「斷線狀態下
// 不該有任何後續動作」——但它連設定對話框裡的輸入框都一起吃掉，而且在對話框裡按
// Enter 會意外觸發重連。PTT 平常很少斷線，所以這個 bug 一直沒被發現。
//
// 正確界線：要擋的是**終端機**的鍵盤輸入（走隱藏 input #t，見 term_view.js），
// 不是整個網頁的 UI。對話框／選單／表單元素一律放行。
import { render, fireEvent, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import ConnectionAlert from "../../src/components/ConnectionAlert";
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

const onDismiss = vi.fn();

const mountAlert = () =>
  render(
    <MantineProvider>
      <ConnectionAlert onDismiss={onDismiss} />
    </MantineProvider>,
  );

// 終端機的鍵盤入口（index.html 的隱藏 input#t）。
const mountTerminalInput = () => {
  const t = document.createElement("input");
  t.id = "t";
  document.body.appendChild(t);
  return t;
};

// 設定對話框：Mantine Modal 渲染在 portal 且 root 帶 role="dialog"。
const mountDialogInput = () => {
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  const input = document.createElement("input");
  input.name = "proxyUrl";
  dialog.appendChild(input);
  document.body.appendChild(dialog);
  return input;
};

beforeAll(() => setupI18n());
beforeEach(() => {
  onDismiss.mockClear();
  document.body.innerHTML = "";
});

describe("斷線提示：終端機按鍵照擋", () => {
  test("隱藏 input#t 上的按鍵被攔下（不可漏進終端機）", () => {
    const t = mountTerminalInput();
    mountAlert();
    // fireEvent 回 false ＝ 事件被 preventDefault。
    expect(fireEvent.keyDown(t, { key: "a", keyCode: 65 })).toBe(false);
  });

  test("終端機上按 Enter → 重新連線", () => {
    const t = mountTerminalInput();
    mountAlert();
    fireEvent.keyDown(t, { key: "Enter", keyCode: 13 });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test("沒有焦點（body）時的按鍵一樣被攔下", () => {
    mountAlert();
    expect(fireEvent.keyDown(document.body, { key: "a", keyCode: 65 })).toBe(
      false,
    );
  });
});

// 這一組就是回報的症狀。
describe("斷線提示：其他 UI 的按鍵必須放行", () => {
  test("設定對話框的輸入框仍能打字", () => {
    const input = mountDialogInput();
    mountAlert();
    expect(fireEvent.keyDown(input, { key: "a", keyCode: 65 })).toBe(true);
  });

  test("在設定對話框裡按 Enter 不會觸發重新連線", () => {
    const input = mountDialogInput();
    mountAlert();
    fireEvent.keyDown(input, { key: "Enter", keyCode: 13 });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  test("對話框內的方向鍵／Tab（Select、分頁切換要用）也放行", () => {
    const input = mountDialogInput();
    mountAlert();
    for (const [key, keyCode] of [
      ["ArrowDown", 40],
      ["Tab", 9],
      ["Backspace", 8],
    ]) {
      expect(fireEvent.keyDown(input, { key, keyCode })).toBe(true);
    }
  });

  // 斷線提示自己的按鈕不在放行清單內 → Enter 仍走「重新連線」那條路（本來就想要）。
  test("斷線提示自己的重新連線按鈕仍能觸發重連", async () => {
    mountAlert();
    const btn = await screen.findByRole("button", {
      name: i18n("alert_connectionReconnect"),
    });
    fireEvent.keyDown(btn, { key: "Enter", keyCode: 13 });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
