// @unit-env browser
// 水球收件匣（src/js/message_inbox.js）：每包都解析、跨包接續、重畫去重、斷線清空、
// pref 關掉就不收。格式同 string_util.parseWaterball（mbbsd/kaede.c#outmsg 的水球列、
// doupdate 的廣播列），這裡鎖的是「收件匣怎麼收」。
import {
  scanMessages,
  isRepaint,
  MessageInbox,
  INBOX_LIMIT,
  REPAINT_WINDOW_MS,
  CARRY_LIMIT
} from "../../src/js/message_inbox";
import { u2b } from "../../src/js/string_util";
import { DEFAULT_PREFS, writeValues } from "../../src/js/pref_storage";
import { loadBig5Tables } from "./helpers/load_big5_tables";

beforeAll(() => loadBig5Tables());

// 線上觀察的變體（[0;1;37;45m），文字走真的 Big5 位元組。
const wire = (from, msg) =>
  u2b("\x1b[1;33;46m★" + from + "\x1b[0;1;37;45m " + msg + " \x1b[m\x1b[K");
const broadcast = (msg) => u2b("\x1b[24;01H\x1b[1;37;45m" + msg + "\x1b[m");

function setPrefs(patch) {
  writeValues({ ...DEFAULT_PREFS, ...patch });
}

afterEach(() => {
  window.localStorage.removeItem("pttchrome.pref.v1");
});

describe("scanMessages", () => {
  test("一包裡的水球（Big5 位元組）", () => {
    const r = scanMessages("", "\x1b[H" + wire("someuser", "你好嗎") + "\x1b[5;1H");
    expect(r.messages).toEqual([
      { kind: "waterball", from: "someuser", text: "你好嗎" }
    ]);
    expect(r.carry).toBe("");
  });

  test("一包裡有兩則就收兩則，照收到的順序", () => {
    const r = scanMessages("", wire("aaa", "一") + "xx" + wire("bbb", "二"));
    expect(r.messages.map((m) => m.from)).toEqual(["aaa", "bbb"]);
  });

  test("廣播／系統訊息", () => {
    const r = scanMessages("", broadcast("系統將於十分鐘後維護"));
    expect(r.messages).toEqual([
      { kind: "broadcast", from: "", text: "系統將於十分鐘後維護" }
    ]);
  });

  test("水球被切在兩包（連中文字的兩個 byte 都被切開）也收得到", () => {
    const full = wire("someuser", "你好嗎");
    // 切在「好」的 lead／trail 中間。
    const cut = full.indexOf(u2b("好")) + 1;
    const a = scanMessages("", "\x1b[2J" + full.slice(0, cut));
    expect(a.messages).toEqual([]);
    expect(a.carry).not.toBe("");
    const b = scanMessages(a.carry, full.slice(cut) + "\x1b[3;1H");
    expect(b.messages).toEqual([
      { kind: "waterball", from: "someuser", text: "你好嗎" }
    ]);
    expect(b.carry).toBe("");
  });

  test("已收尾但不是水球的開頭不留到下一包", () => {
    const r = scanMessages("", "\x1b[1;33;46m 標題 \x1b[m");
    expect(r.messages).toEqual([]);
    expect(r.carry).toBe("");
  });

  test("沒收尾的開頭太長就不是水球，不留", () => {
    const r = scanMessages("", "\x1b[1;33;46m" + "x".repeat(CARRY_LIMIT + 10));
    expect(r.carry).toBe("");
  });

  test("一般畫面資料不收", () => {
    const r = scanMessages("", u2b("\x1b[1;37;44m 【主功能表】 \x1b[m\x1b[24;1H 你好"));
    expect(r.messages).toEqual([]);
  });
});

describe("isRepaint", () => {
  const last = { kind: "waterball", from: "a", text: "嗨", at: 1000 };
  test("同人同字、時間窗內＝重畫", () => {
    expect(isRepaint(last, { kind: "waterball", from: "a", text: "嗨" }, 2000)).toBe(true);
  });
  test("字不同、人不同、超過時間窗都不是", () => {
    expect(isRepaint(last, { kind: "waterball", from: "a", text: "哈" }, 2000)).toBe(false);
    expect(isRepaint(last, { kind: "waterball", from: "b", text: "嗨" }, 2000)).toBe(false);
    expect(
      isRepaint(last, { kind: "waterball", from: "a", text: "嗨" }, 1000 + REPAINT_WINDOW_MS)
    ).toBe(false);
  });
});

describe("MessageInbox", () => {
  let now;
  const make = () => new MessageInbox({}, { now: () => now });
  beforeEach(() => {
    now = 1000;
  });

  test("收到的水球新的在前、未讀數累加；打開清零", () => {
    const inbox = make();
    const seen = [];
    inbox.onChange((s) => seen.push(s));
    inbox.noteData(wire("aaa", "一"));
    now += 1000;
    inbox.noteData(wire("bbb", "二"));
    expect(inbox.state.items.map((i) => i.from)).toEqual(["bbb", "aaa"]);
    expect(inbox.state.items[0].at).toBe(2000);
    expect(inbox.state.unread).toBe(2);
    inbox.setOpen(true);
    expect(inbox.state.unread).toBe(0);
    // 開著的時候收到的不算未讀。
    inbox.noteData(wire("ccc", "三"));
    expect(inbox.state.unread).toBe(0);
    expect(inbox.state.items).toHaveLength(3);
    expect(seen.length).toBeGreaterThan(1);
  });

  test("重畫（^L 把還在畫面上的水球列再送一次）不重複收", () => {
    const inbox = make();
    inbox.noteData(wire("aaa", "一"));
    now += 5000;
    inbox.noteData("\x1b[H\x1b[2J" + wire("aaa", "一"));
    expect(inbox.state.items).toHaveLength(1);
    expect(inbox.state.unread).toBe(1);
  });

  test("最多留 INBOX_LIMIT 則", () => {
    const inbox = make();
    for (let i = 0; i < INBOX_LIMIT + 5; i++) inbox.noteData(wire("u" + i, "m" + i));
    expect(inbox.state.items).toHaveLength(INBOX_LIMIT);
    expect(inbox.state.items[0].from).toBe("u" + (INBOX_LIMIT + 4));
  });

  test("斷線（reset）清空，包括沒收尾的半則", () => {
    const inbox = make();
    inbox.noteData(wire("aaa", "一"));
    const full = wire("bbb", "二");
    inbox.noteData(full.slice(0, 15));
    inbox.reset();
    expect(inbox.state.items).toEqual([]);
    expect(inbox.state.unread).toBe(0);
    // 下一條連線收到的後半段不會跟上一條的前半段拼起來。
    inbox.noteData(full.slice(15));
    expect(inbox.state.items).toEqual([]);
  });

  test("清空", () => {
    const inbox = make();
    inbox.noteData(wire("aaa", "一"));
    inbox.setOpen(true);
    inbox.clear();
    expect(inbox.state).toMatchObject({ items: [], unread: 0, open: false });
  });

  test("pref 關掉就不收，已收的也收掉", () => {
    const inbox = make();
    inbox.noteData(wire("aaa", "一"));
    setPrefs({ enableMessageInbox: false });
    inbox.noteData(wire("bbb", "二"));
    expect(inbox.state.items).toEqual([]);
  });

  test("安全模式不影響（不送鍵的功能）", () => {
    setPrefs({ nativeSafeMode: true });
    const inbox = make();
    inbox.noteData(wire("aaa", "一"));
    expect(inbox.state.items).toHaveLength(1);
  });
});
