// @unit-env browser
// real-input: tests/e2e/offline/message_inbox.offline.spec.js
//   （page.mouse；本檔手捏事件只測分支邏輯，見 tests/unit/e2e_real_input.test.js）
// 水球收件匣的外殼（src/components/MessageInbox）。鎖：
//  1. 還沒收到任何一則就不畫；收到後鈴鐺帶未讀數，點開列出（新的在前）、未讀清零；
//  2. mousedown preventDefault（不搶 #t 焦點）、滑鼠事件不外洩到 window；
//  3. 點清單外面收起、清空鈕把鈴鐺一起收掉；
//  4. 桌機浮動版／手機 App Bar 內嵌版只畫其中一個；文章工具側欄展開時讓到它左邊。
import { render, fireEvent, act } from "@testing-library/react";
import { MessageInbox as InboxView } from "../../src/components/MessageInbox";
import {
  MessageInbox,
  MESSAGE_INBOX_ID,
  isMessageInboxTarget
} from "../../src/js/message_inbox";
import { u2b } from "../../src/js/string_util";
import { setupI18n } from "../../src/js/i18n";
import { loadBig5Tables } from "./helpers/load_big5_tables";

beforeAll(() => {
  loadBig5Tables();
  setupI18n();
});

const wire = (from, msg) =>
  u2b("\x1b[1;33;46m★" + from + "\x1b[0;1;37;45m " + msg + " \x1b[m");
const root = () => document.getElementById(MESSAGE_INBOX_ID);
const q = (sel) => document.querySelector(sel);

function fakeApp(extra) {
  return { messageInbox: new MessageInbox({}), mobile: false, ...extra };
}

test("沒收到就不畫；收到後鈴鐺帶未讀數，點開列出、未讀清零", () => {
  const app = fakeApp();
  render(<InboxView pttchrome={app} />);
  expect(root()).toBeNull();
  act(() => {
    app.messageInbox.noteData(wire("aaa", "第一則"));
    app.messageInbox.noteData(wire("bbb", "第二則"));
  });
  expect(root()).not.toBeNull();
  expect(q("[data-inbox-unread]").textContent).toBe("2");
  expect(q(".inboxPanel")).toBeNull();
  fireEvent.click(q("[data-inbox-bell]"));
  const items = [...document.querySelectorAll(".inboxItem")];
  expect(items.map((li) => li.querySelector(".inboxFrom").textContent)).toEqual([
    "bbb",
    "aaa"
  ]);
  expect(items[0].querySelector(".inboxText").textContent).toBe("第二則");
  expect(q("[data-inbox-unread]")).toBeNull();
});

test("不搶焦點、滑鼠事件不外洩；#messageInbox 被 App 的滑鼠入口認得", () => {
  const app = fakeApp();
  render(<InboxView pttchrome={app} />);
  act(() => app.messageInbox.noteData(wire("aaa", "嗨")));
  const onWindow = vi.fn();
  window.addEventListener("mousedown", onWindow);
  window.addEventListener("click", onWindow);
  try {
    const bell = q("[data-inbox-bell]");
    const down = fireEvent.mouseDown(bell);
    expect(down).toBe(false); // preventDefault
    fireEvent.click(bell);
    expect(onWindow).not.toHaveBeenCalled();
    expect(isMessageInboxTarget(q(".inboxText"))).toBe(true);
    expect(isMessageInboxTarget(document.body)).toBe(false);
  } finally {
    window.removeEventListener("mousedown", onWindow);
    window.removeEventListener("click", onWindow);
  }
});

test("點外面收起；清空把鈴鐺一起收掉", () => {
  const app = fakeApp();
  render(<InboxView pttchrome={app} />);
  act(() => app.messageInbox.noteData(wire("aaa", "嗨")));
  fireEvent.click(q("[data-inbox-bell]"));
  expect(q(".inboxPanel")).not.toBeNull();
  fireEvent.mouseDown(document.body);
  expect(q(".inboxPanel")).toBeNull();
  fireEvent.click(q("[data-inbox-bell]"));
  fireEvent.click(q("[data-inbox-clear]"));
  expect(root()).toBeNull();
});

test("桌機只畫浮動版、手機只畫 App Bar 內嵌版", () => {
  const desk = fakeApp();
  const a = render(
    <>
      <InboxView pttchrome={desk} />
      <InboxView pttchrome={desk} inline />
    </>
  );
  act(() => desk.messageInbox.noteData(wire("aaa", "嗨")));
  expect(document.querySelectorAll("#" + MESSAGE_INBOX_ID)).toHaveLength(1);
  expect(root().classList.contains("messageInboxInline")).toBe(false);
  a.unmount();

  const phone = fakeApp({ mobile: true });
  render(
    <>
      <InboxView pttchrome={phone} />
      <InboxView pttchrome={phone} inline />
    </>
  );
  act(() => phone.messageInbox.noteData(wire("aaa", "嗨")));
  expect(document.querySelectorAll("#" + MESSAGE_INBOX_ID)).toHaveLength(1);
  expect(root().classList.contains("messageInboxInline")).toBe(true);
});

test("文章工具側欄展開時讓到它左邊", () => {
  let toolsFn = null;
  const app = fakeApp({
    articleTools: {
      onChange(fn) {
        toolsFn = fn;
        fn({ visible: false, width: 0, collapsed: false });
        return () => {};
      }
    }
  });
  render(<InboxView pttchrome={app} />);
  act(() => app.messageInbox.noteData(wire("aaa", "嗨")));
  expect(root().style.right).toBe("8px");
  act(() => toolsFn({ visible: true, width: 300, collapsed: false }));
  expect(root().style.right).toBe("308px");
  act(() => toolsFn({ visible: true, width: 300, collapsed: true }));
  expect(root().style.right).toBe("8px");
});
