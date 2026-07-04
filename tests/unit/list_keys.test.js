// 「[ ] 同標題跳文偶爾失效/亂跳」回歸：buffer 模式本地導航是零網路，server 端
// 真游標停在舊位置；[ ] t y 等相對命令 passthrough 後 server 從舊游標起算 → 亂跳。
// 修法：other 鍵放行前先送「選取序號\r」把真游標歸位（_syncServerCursor），
// 鍵本身照舊 passthrough（不 preventDefault）→ functionMode 鏡像。
import { ListSession } from "../../src/js/list_session";

function makeSession() {
  const sent = [];
  const core = { conn: { isConnected: true, send: (d) => sent.push(d) } };
  const view = {
    hideCursor() {},
    showCursor() {},
    resetListAccumulation() {},
    blacklist: new Set(),
    titleBlacklist: [],
  };
  const termBuf = {
    rows: 24,
    cols: 80,
    listLines: [],
    listLineNums: [],
    lineChangeds: new Array(24).fill(false),
    changed: false,
    addEventListener() {},
    notify() {},
  };
  const queue = {
    idle: true,
    inFlightKind: null,
    flush() {},
    enqueue() {},
    onSettle() {},
  };
  const s = new ListSession(core, view, termBuf, queue);
  return { s, sent };
}

function keyEvent(key) {
  const e = {
    key,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
  return e;
}

describe("ListSession other-key server 游標歸位（[ ] 亂跳回歸）", () => {
  test("active＋數字選取：按 [ → 先送『序號\\r』、鍵不 preventDefault、轉 functionMode", () => {
    const { s, sent } = makeSession();
    s.state = "active";
    s._selectedNum = 42;
    const e = keyEvent("[");
    s.onKeyDown(e);
    expect(sent).toEqual(["42\r"]);
    expect(e.defaultPrevented).toBe(false); // 鍵本身照舊 passthrough
    expect(s.state).toBe("functionMode");
  });

  test("pinned 選取（無序號）：other 鍵不送前綴", () => {
    const { s, sent } = makeSession();
    s.state = "active";
    s._selectedNum = null;
    s._selectedPinnedKey = "arrenwu|[公告] 板規";
    s.onKeyDown(keyEvent("]"));
    expect(sent).toEqual([]);
    expect(s.state).toBe("functionMode");
  });

  test("非相對命令的 other 鍵（← 離板 / q）不送前綴（live soak 回歸：前綴會多插一個列表回應，menu settle 卡 functionMode）", () => {
    const { s, sent } = makeSession();
    s.state = "active";
    s._selectedNum = 42;
    const e = keyEvent("ArrowLeft");
    s.onKeyDown(e);
    expect(sent).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
    expect(s.state).toBe("functionMode");
    s.state = "active";
    s.onKeyDown(keyEvent("q"));
    expect(sent).toEqual([]);
  });

  test("= 同標題首篇也送前綴", () => {
    const { s, sent } = makeSession();
    s.state = "active";
    s._selectedNum = 7;
    s.onKeyDown(keyEvent("="));
    expect(sent).toEqual(["7\r"]);
  });

  test("nav 鍵不送前綴（本地導航維持零網路）", () => {
    const { s, sent } = makeSession();
    s.state = "active";
    s._selectedNum = 42;
    const e = keyEvent("ArrowDown");
    s.onKeyDown(e);
    expect(sent).toEqual([]);
    expect(e.defaultPrevented).toBe(true);
    expect(s.state).toBe("active");
  });

  test("斷線時 other 鍵不送前綴（不丟例外）", () => {
    const { s, sent } = makeSession();
    s._core.conn.isConnected = false;
    s.state = "active";
    s._selectedNum = 42;
    s.onKeyDown(keyEvent("["));
    expect(sent).toEqual([]);
    expect(s.state).toBe("functionMode");
  });
});
