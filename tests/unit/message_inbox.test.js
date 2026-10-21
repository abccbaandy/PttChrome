// @unit-env browser
// 水球收件匣（src/js/message_inbox.js）：每包都解析、跨包接續、重畫去重、斷線清空、
// pref 關掉就不收。格式同 string_util.parseWaterball（mbbsd/kaede.c#outmsg 的水球列、
// doupdate 的廣播列），這裡鎖的是「收件匣怎麼收」。
import {
  scanMessages,
  isRepaint,
  latestSender,
  MessageInbox,
  newMailOnScreen,
  INBOX_LIMIT,
  REPAINT_WINDOW_MS,
  CARRY_LIMIT
} from "../../src/js/message_inbox";
import { u2b } from "../../src/js/string_util";
import { DEFAULT_PREFS, writeValues } from "../../src/js/pref_storage";
import { loadBig5Tables } from "./helpers/load_big5_tables";
import { setupI18n, i18n } from "../../src/js/i18n";

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

describe("回覆（只代按使用者自己會按的 Ctrl+R）", () => {
  const make = () => {
    const sent = [];
    const inbox = new MessageInbox({
      view: { sendKeyAsUser: (key, mods) => sent.push([key, mods]) }
    });
    return { inbox, sent };
  };

  test("最新一位寄件人的水球：送一下 Ctrl+R、收起清單", () => {
    const { inbox, sent } = make();
    inbox.noteData(wire("aaa", "一"));
    inbox.noteData(wire("bbb", "二"));
    inbox.noteData(wire("bbb", "三"));
    inbox.setOpen(true);
    const [newest, older] = inbox.state.items;
    expect(inbox.canReply(newest)).toBe(true);
    expect(inbox.canReply(older)).toBe(true); // 同一位寄件人的舊水球也是回他
    expect(inbox.reply(older)).toBe(true);
    expect(sent).toEqual([["r", { ctrlKey: true }]]);
    expect(inbox.state.open).toBe(false);
  });

  test("廣播不能回；不是最新一位的寄件人也能回（換人交給 waterball_reply）", () => {
    const { inbox, sent } = make();
    inbox.noteData(wire("aaa", "一"));
    inbox.noteData(broadcast("系統訊息"));
    inbox.noteData(wire("bbb", "二"));
    const aaa = inbox.state.items.find((i) => i.from === "aaa");
    const sys = inbox.state.items.find((i) => i.kind === "broadcast");
    expect(inbox.canReply(aaa)).toBe(true);
    expect(inbox.canReply(sys)).toBe(false);
    expect(inbox.reply(sys)).toBe(false);
    // 沒有 buf 就認不了畫面 ⇒ 不開始、一個鍵都不送
    expect(inbox.reply(aaa)).toBe(false);
    expect(sent).toEqual([]);
  });

  test("回不是最新一位的寄件人：按 ^R 直到原生回覆畫面選中他", () => {
    const sent = [];
    const buf = Object.assign(new EventTarget(), { rows: 24, screen: [] });
    buf.getRowText = (i) => buf.screen[i] || "";
    const show = (rows) => {
      buf.screen = rows;
      buf.dispatchEvent(new CustomEvent("screenSettled"));
    };
    const inbox = new MessageInbox({
      buf,
      view: { sendKeyAsUser: (key, mods) => sent.push([key, mods]) }
    });
    inbox.noteData(wire("aaa", "一"));
    inbox.noteData(wire("bbb", "二"));
    inbox.setOpen(true);
    expect(inbox.reply(inbox.state.items.find((i) => i.from === "aaa"))).toBe(true);
    expect(inbox.state.open).toBe(false);
    expect(sent).toHaveLength(1);
    // 一對一模式：第一下停在 bbb ⇒ 再按一下；換到 aaa ⇒ 停手
    show(["丟bbb:", "                             ↑反擊對象↓ "]);
    expect(sent).toHaveLength(2);
    show(["丟aaa:", "                             ↑反擊對象↓ "]);
    show(["丟bbb:", "                             ↑反擊對象↓ "]);
    expect(sent).toEqual([["r", { ctrlKey: true }], ["r", { ctrlKey: true }]]);
  });

  test("最新一則是廣播時，最新一位寄件人仍是最後丟水球的人", () => {
    const { inbox } = make();
    inbox.noteData(wire("aaa", "一"));
    inbox.noteData(broadcast("系統訊息"));
    expect(latestSender(inbox.state.items)).toBe("aaa");
    expect(latestSender([])).toBeNull();
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

  test("中間夾一則廣播，水球重畫仍認得（一般模式第一下 ^R 會把最新水球再畫一次）", () => {
    const inbox = make();
    inbox.noteData(wire("aaa", "一"));
    inbox.noteData(broadcast("系統訊息"));
    inbox.noteData(wire("aaa", "一"));
    expect(inbox.state.items.map((i) => i.kind)).toEqual(["broadcast", "waterball"]);
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

// 新信提示：mbbsd/menu.c#redraw_title 在 ISNEWMAIL 時把標題列中段換成「你有新信件」。
describe("新信提示", () => {
  const MENU = "【主功能表】                    批踢踢實業坊";
  const MENU_MAIL = "【主功能表】        你有新信件        批踢踢實業坊";
  const LIST_MAIL = "【板主:someone】      你有新信件      看板《Test》";
  let now;
  let settled;
  let row0;
  let pageState;
  const make = () =>
    new MessageInbox(
      {
        buf: {
          getRowText: () => row0,
          get pageState() {
            return pageState;
          },
          addEventListener: (name, fn) => name === "screenSettled" && (settled = fn)
        }
      },
      { now: () => now }
    );
  const show = (text, ps = 1) => {
    row0 = text;
    pageState = ps;
    settled();
  };
  beforeAll(() => setupI18n());
  beforeEach(() => {
    now = 1000;
  });

  test("認得出的標題列", () => {
    expect(newMailOnScreen(MENU_MAIL, 1)).toBe(true);
    expect(newMailOnScreen(LIST_MAIL, 2)).toBe(true);
    expect(newMailOnScreen(MENU, 1)).toBe(false);
    // 文章（pageState 3）、沒有標題列的畫面 ⇒ 不知道。
    expect(newMailOnScreen(MENU_MAIL, 3)).toBe(null);
    expect(newMailOnScreen("請按任意鍵繼續    你有新信件", 0)).toBe(null);
    expect(newMailOnScreen("", 0)).toBe(null);
  });

  test("由無變有收一則；一直亮著不重收；中間看不到標題列也不重收", () => {
    const inbox = make();
    show(MENU);
    expect(inbox.state.items).toEqual([]);
    show(MENU_MAIL);
    expect(inbox.state.items).toEqual([
      expect.objectContaining({ kind: "mail", text: i18n("inbox_newMail"), at: 1000 })
    ]);
    expect(inbox.state.unread).toBe(1);
    show("作者  someone 看板 Test", 3);
    show(LIST_MAIL, 2);
    show(MENU_MAIL);
    expect(inbox.state.items).toHaveLength(1);
  });

  test("讀完信（提示消失）再來一封 ⇒ 再收一則", () => {
    const inbox = make();
    show(MENU_MAIL);
    show(MENU);
    now += 60000;
    show(MENU_MAIL);
    expect(inbox.state.items.map((i) => i.at)).toEqual([61000, 1000]);
  });

  test("登入時就有新信 ⇒ 第一個看得到標題列的畫面收一則", () => {
    const inbox = make();
    show(MENU_MAIL);
    expect(inbox.state.items).toHaveLength(1);
  });

  test("不算最新寄件人（回覆鈕只給水球）", () => {
    const inbox = make();
    inbox.noteData(wire("aaa", "一"));
    show(MENU_MAIL);
    expect(latestSender(inbox.state.items)).toBe("aaa");
    expect(inbox.canReply(inbox.state.items[0])).toBe(false);
  });

  test("斷線清空後，還亮著的提示在新連線再收一則", () => {
    const inbox = make();
    show(MENU_MAIL);
    inbox.reset();
    show(MENU_MAIL);
    expect(inbox.state.items).toHaveLength(1);
  });

  test("pref 關掉就不收", () => {
    setPrefs({ enableMessageInbox: false });
    const inbox = make();
    show(MENU_MAIL);
    expect(inbox.state.items).toEqual([]);
  });
});
