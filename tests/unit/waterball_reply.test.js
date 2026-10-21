// 水球收件匣回覆「最新一位以外的寄件人」（src/js/waterball_reply.js）。
// 畫面照 mbbsd/wmsg.c 的版型寫（讀碼，見檔頭）：
//   一對一模式 ofo_my_write：row 0 `丟<id>:`、row 1 col 29 「 ↑反擊對象↓ 」、row 2 起名單。
//   一般模式：第一下 row 0 `訊息傳過去: `；第二下起 row 1 回顧面板標題、row 2 分頁、
//   row 3 起最近的水球（選中那則行首 `>`）。
import {
  classifyReplyScreen,
  nextReplyStep,
  startWaterballReply,
  MAX_SWITCH_STEPS,
  STEP_TIMEOUT_MS,
} from "../../src/js/waterball_reply";

const OFO_LIST = "                             ↑反擊對象↓ ";
const ofo = (id) => [`丟${id}:`, OFO_LIST, "                            > aaa", "                              bbb"];
const firstDefault = () => ["訊息傳過去: ", "", "", "★bbb 二"];
const PANEL_TITLE = "───────訊─息─回─顧──用[Ctrl-R Tab/S-Tab Ctrl-F Ctrl-G]鍵切換───";
const panel = (selectedIdx, senders) => [
  "訊息傳過去: ",
  PANEL_TITLE,
  "  全部   bbb          aaa",
  ...senders.map((id, i) => (i === selectedIdx ? ">" : " ") + id + " 訊息內容" + i),
  "───────────────────────────────────────",
];

describe("classifyReplyScreen", () => {
  test("一對一模式：row 0 的對象", () => {
    expect(classifyReplyScreen(ofo("bbb"))).toEqual({ mode: "ofo", selected: "bbb", panel: false });
  });

  test("一般模式第一下：還沒有回顧面板", () => {
    expect(classifyReplyScreen(firstDefault())).toEqual({ mode: "default", selected: null, panel: false });
  });

  test("一般模式回顧面板：行首 > 那則的寄件人", () => {
    expect(classifyReplyScreen(panel(1, ["bbb", "aaa", "ccc"]))).toEqual({
      mode: "default",
      selected: "aaa",
      panel: true,
    });
  });

  test.each([
    ["文章內文剛好有「丟xxx:」但沒有反擊對象名單", ["丟aaa: 這是內文", "作者 someone"]],
    ["一般畫面", ["【主功能表】", "", ""]],
    ["小天使的提示（不是 PROMPT_OFO／PROMPT_TO）", ["問小天使: ", OFO_LIST]],
    ["提示不在行首", [" 訊息傳過去: ", PANEL_TITLE, "", ">aaa x"]],
    ["回顧面板看不到選中的那則", panel(-1, ["bbb", "aaa"])],
    ["兩列都像選中", ["訊息傳過去: ", PANEL_TITLE, "", ">aaa x", ">bbb y"]],
  ])("認不出：%s", (_name, rows) => {
    expect(classifyReplyScreen(rows)).toBeNull();
  });
});

describe("nextReplyStep", () => {
  test("對上了就停手", () => {
    expect(nextReplyStep({ mode: "ofo", selected: "aaa" }, "aaa", "bbb", 1)).toBe("done");
    expect(nextReplyStep({ mode: "default", selected: "aaa", panel: true }, "aaa", "bbb", 2)).toBe("done");
  });

  test("一般模式第一下：對象是最新一位才算對上，否則再按（開回顧面板）", () => {
    const first = { mode: "default", selected: null, panel: false };
    expect(nextReplyStep(first, "bbb", "bbb", 0)).toBe("done");
    expect(nextReplyStep(first, "aaa", "bbb", 0)).toBe("next");
  });

  test("換滿一輪還找不到 ⇒ 停手", () => {
    expect(nextReplyStep({ mode: "ofo", selected: "bbb" }, "aaa", "bbb", MAX_SWITCH_STEPS - 1)).toBe("next");
    expect(nextReplyStep({ mode: "ofo", selected: "bbb" }, "aaa", "bbb", MAX_SWITCH_STEPS)).toBe("stop");
  });

  test("認不出 ⇒ 等（不送鍵）", () => {
    expect(nextReplyStep(null, "aaa", "bbb", 0)).toBe("wait");
  });
});

describe("startWaterballReply", () => {
  function setup() {
    const sent = [];
    const buf = Object.assign(new EventTarget(), { rows: 24, screen: [] });
    buf.getRowText = (i) => buf.screen[i] || "";
    const show = (rows) => {
      buf.screen = rows;
      buf.dispatchEvent(new CustomEvent("screenSettled"));
    };
    const view = { sendKeyAsUser: (k, m) => sent.push(k + (m && m.ctrlKey ? "^" : "")) };
    const ends = [];
    return { buf, view, sent, show, ends, onEnd: (o) => ends.push(o) };
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("一般模式：第一下 → 開回顧面板 → 往舊的選到 aaa 為止", () => {
    const t = setup();
    startWaterballReply({ buf: t.buf, view: t.view }, "aaa", "bbb", { onEnd: t.onEnd });
    expect(t.sent).toEqual(["r^"]);
    t.show(firstDefault());
    expect(t.sent).toHaveLength(2);
    t.show(panel(0, ["bbb", "ccc", "aaa"]));
    t.show(panel(1, ["bbb", "ccc", "aaa"]));
    t.show(panel(2, ["bbb", "ccc", "aaa"]));
    expect(t.sent).toHaveLength(4);
    expect(t.ends).toEqual(["done"]);
    // 結束後不再理畫面
    t.show(panel(0, ["bbb", "ccc", "aaa"]));
    expect(t.sent).toHaveLength(4);
  });

  test("一對一模式：換到對象為止", () => {
    const t = setup();
    startWaterballReply({ buf: t.buf, view: t.view }, "ccc", "aaa", { onEnd: t.onEnd });
    t.show(ofo("aaa"));
    t.show(ofo("bbb"));
    t.show(ofo("ccc"));
    expect(t.sent).toEqual(["r^", "r^", "r^"]);
    expect(t.ends).toEqual(["done"]);
  });

  test("按下第一下時先停一次舊畫面（好讀切原生鏡像）：不送鍵，等 PTT 的回應", () => {
    const t = setup();
    startWaterballReply({ buf: t.buf, view: t.view }, "aaa", "bbb", { onEnd: t.onEnd });
    t.show(["作者 someone 看板 Test", "標題 hello"]);
    expect(t.sent).toEqual(["r^"]);
    t.show(ofo("aaa"));
    expect(t.ends).toEqual(["done"]);
  });

  test("一直認不出（例如小天使提示）⇒ 逾時收手，一個鍵都不多送", () => {
    const t = setup();
    startWaterballReply({ buf: t.buf, view: t.view }, "aaa", "bbb", { onEnd: t.onEnd });
    t.show(["問小天使: ", OFO_LIST]);
    vi.advanceTimersByTime(STEP_TIMEOUT_MS);
    expect(t.ends).toEqual(["timeout"]);
    expect(t.sent).toEqual(["r^"]);
  });

  test("對象不在名單裡（離線、超過回顧則數）⇒ 換滿一輪就停手", () => {
    const t = setup();
    startWaterballReply({ buf: t.buf, view: t.view }, "zzz", "aaa", { onEnd: t.onEnd });
    for (let i = 0; i < 20 && !t.ends.length; i++) t.show(ofo(i % 2 ? "bbb" : "aaa"));
    expect(t.ends).toEqual(["stop"]);
    expect(t.sent).toHaveLength(MAX_SWITCH_STEPS + 1);
  });

  test("按了沒有反應（名單只有一人時 ofo_switch_user 不重畫）⇒ 逾時收手", () => {
    const t = setup();
    startWaterballReply({ buf: t.buf, view: t.view }, "aaa", "bbb", { onEnd: t.onEnd });
    t.show(ofo("bbb"));
    expect(t.sent).toHaveLength(2);
    vi.advanceTimersByTime(STEP_TIMEOUT_MS);
    expect(t.ends).toEqual(["timeout"]);
    expect(t.sent).toHaveLength(2);
  });

  test("cancel：之後的畫面不再送鍵", () => {
    const t = setup();
    const cancel = startWaterballReply({ buf: t.buf, view: t.view }, "aaa", "bbb", { onEnd: t.onEnd });
    cancel();
    t.show(ofo("bbb"));
    expect(t.sent).toEqual(["r^"]);
    expect(t.ends).toEqual(["cancel"]);
  });
});
