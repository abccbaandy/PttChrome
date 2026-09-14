// 列表好讀鍵盤合約（2026-07-10 起，2026-09-03 補 A/B 分類）：白名單＝導覽/開文/
// 跳號/離板；A 類鍵（[ ] = \ + - < > , . { } t，原地重繪）走凍結交易全程不切原生；
// 其餘 B 類鍵一律
// 「一鍵切原生」——有序號選取且 server 游標未同步時先序列化 native-sync-jump
//（buffer 本地導航零網路，真游標停在舊位置；jump＋key 不能同 tick 直送——pttbbs
// typeahead 會跳過重繪，協定 §2），完成後 enter-function-mode（原生 excursion，
// 不變量 15：拋 cache）＋raw 代送原鍵。舊 [ ] = / v / `/` 模擬交易與 airlock
// 兩段式（同鍵二連擊）皆退役。
import { ListSession, transitionListSession } from "../../src/js/list_session";

function makeSession() {
  const sent = [];
  const enqueued = [];
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
    // 靜置探針（非導覽操作完成後自動回好讀）會在 hold 期間量一次當下畫面，
    // 所以 stub 也要有 TermBuf 的畫面讀取介面（真的 TermBuf 一定有）。
    getRowText: () => "",
    isUnicolor: () => false,
    cur_x: 0,
    cur_y: 0,
    addEventListener() {},
    notify() {},
  };
  const queue = {
    idle: true,
    inFlightKind: null,
    flush() {
      this.flushed = (this.flushed || 0) + 1;
    },
    flushPending() {
      this.pendingFlushed = (this.pendingFlushed || 0) + 1;
    },
    flushPendingKind() {},
    hasKind: () => false,
    enqueue(cmd) {
      enqueued.push(cmd);
    },
    onSettle() {},
  };
  const s = new ListSession(core, view, termBuf, queue);
  return { s, sent, enqueued, queue };
}

function keyEvent(key, mods = {}) {
  return {
    key,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    ...mods,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
}

describe("ListSession 非白名單鍵一鍵切原生（[ ] = 沒反應回歸，2026-07-10）", () => {
  // 舊行為：[ ] = 走模擬 relative 交易（僅數字選取可用；pinned/無選取 noop 吞鍵，
  // 要再按一次 airlock）→「按了沒反應也沒讀取中」。新合約：非導覽白名單鍵一律
  // 「同步 server 游標（有序號且未同步時）→ 切原生鏡像 → 代送該鍵」——單按即生效。
  test("active＋數字選取未同步：按 z（B 類）→ preventDefault、先 sync-jump、完成後切原生＋代送 z", () => {
    const { s, sent, enqueued } = makeSession();
    s._view.flashListHint = () => {};
    s.state = "active";
    s._selectedNum = 42;
    const e = keyEvent("z");
    s.onKeyDown(e);
    // 鍵本身不得同 tick passthrough（sync 腿還在途，typeahead 會卡畫面）
    expect(e.defaultPrevented).toBe(true);
    expect(sent).toEqual([]);
    expect(s._renderMode).toBe("frozen"); // sync 腿期間不閃原生
    expect(enqueued.length).toBe(1);
    expect(enqueued[0].keys).toBe("42\r");
    expect(enqueued[0].kind).toBe("native-sync-jump");
    // sync 完成 → 切原生鏡像＋代送該鍵（走 queue：in-flight 吸收 settle，
    // 防 sync 落地的 clean-list settle 提早 resume——live soak race）
    enqueued[0].onDone();
    expect(s.state).toBe("functionMode");
    expect(s._renderMode).toBe("native");
    expect(sent).toEqual([]); // 不裸送
    expect(enqueued[1].kind).toBe("native-key");
    expect(enqueued[1].keys).toBe("z");
    expect(enqueued[1].expect()).toBe(true); // 任一 settle 即回應
    // 尾附 \f：PTT 完全忽略該鍵時是零 byte 零 settle，沒有它只能等 3s timeout。
    expect(enqueued[1].fullRepaint).toBe(true);
  });

  test("已同步（_serverNum===選取）→ 跳過 sync 腿，直接切原生＋代送", () => {
    const { s, sent, enqueued } = makeSession();
    s._view.flashListHint = () => {};
    s.state = "active";
    s._selectedNum = 7;
    s._serverNum = 7;
    s.onKeyDown(keyEvent("Z"));
    expect(s.state).toBe("functionMode");
    expect(enqueued.length).toBe(1); // 免 sync 腿，只有 native-key
    expect(enqueued[0].kind).toBe("native-key");
    expect(enqueued[0].keys).toBe("Z");
    expect(sent).toEqual([]);
  });

  test("pinned 選取（無序號）：a 無跳號可同步 → 直接切原生＋代送（不再 noop 吞鍵）", () => {
    const { s, sent, enqueued } = makeSession();
    s._view.flashListHint = () => {};
    s.state = "active";
    s._selectedNum = null;
    s._selectedPinnedKey = "arrenwu|[公告] 板規";
    const e = keyEvent("a");
    s.onKeyDown(e);
    expect(e.defaultPrevented).toBe(true);
    expect(s.state).toBe("functionMode");
    expect(enqueued.length).toBe(1);
    expect(enqueued[0].kind).toBe("native-key");
    expect(enqueued[0].keys).toBe("a");
    expect(sent).toEqual([]);
  });

  test("sync 腿失敗 → 仍切原生＋代送（降級路徑，不得無聲卡 frozen）", () => {
    const { s, sent, enqueued } = makeSession();
    s._view.flashListHint = () => {};
    s.state = "active";
    s._selectedNum = 42;
    s.onKeyDown(keyEvent("z"));
    enqueued[0].onFail("timeout");
    expect(s.state).toBe("functionMode");
    expect(s._renderMode).toBe("native");
    expect(enqueued[1].kind).toBe("native-key");
    expect(enqueued[1].keys).toBe("z");
  });

  test("←/q/e 離板 → v5 交易化：frozen＋先同步 server 游標再送離板鍵", () => {
    // pttbbs 離板記住的是 REAL cursor（getkeep）——本地導覽零網路，離板前不
    // sync 的話再進板落點會跳去 server 游標殘留的位置（2026-07-08 回報）。
    const { s, sent, enqueued } = makeSession();
    s.state = "active";
    s._selectedNum = 42; // 本地導覽後選取 ≠ server 游標（_serverNum null）
    const e = keyEvent("ArrowLeft");
    s.onKeyDown(e);
    expect(e.defaultPrevented).toBe(true);
    expect(sent).toEqual([]); // 不裸送——經 CommandQueue
    expect(s.state).toBe("functionMode");
    expect(s._renderMode).toBe("frozen");
    expect(enqueued.length).toBe(1);
    expect(enqueued[0].kind).toBe("leave-sync-jump");
    expect(enqueued[0].keys).toBe("42\r");
    // park 指紋（同 mark/relative sync 腿）
    expect(
      enqueued[0].expect(null, { cursorRowNum: 42, curY: 5, curX: 0, rows: 24 })
    ).toBe(true);
    // sync 完成 → 才送離板鍵
    enqueued[0].onDone();
    // _serverNum 在 leave 腿入列時清空（落點 menu/主列表重新教），不斷言
    expect(enqueued.length).toBe(2);
    expect(enqueued[1].kind).toBe("leave-board");
    expect(enqueued[1].keys).toBe("\x1b[D");
    // expect：menu（離板）或 clean-list（MODE_SELECT 退出/回列表）都算完成
    expect(enqueued[1].expect(null, { kind: "menu" })).toBe(true);
    expect(enqueued[1].expect(null, { kind: "clean-list" })).toBe(true);
    expect(enqueued[1].expect(null, { kind: "transient" })).toBe(false);
  });

  test("← 離板：server 游標已同步（_serverNum===選取）→ 跳過 sync 腿直送", () => {
    const { s, enqueued } = makeSession();
    s.state = "active";
    s._selectedNum = 42;
    s._serverNum = 42;
    s.onKeyDown(keyEvent("ArrowLeft"));
    expect(enqueued.length).toBe(1);
    expect(enqueued[0].kind).toBe("leave-board");
    expect(enqueued[0].keys).toBe("\x1b[D");
  });

  test("← 離板：pinned/無選取（num null）→ 無跳號可同步，直送離板鍵", () => {
    const { s, enqueued } = makeSession();
    s.state = "active";
    s._selectedNum = null;
    s.onKeyDown(keyEvent("q"));
    expect(enqueued.length).toBe(1);
    expect(enqueued[0].kind).toBe("leave-board");
  });

  test("← 離板：sync 腿失敗 → 不送離板鍵、顯性降級原生", () => {
    const { s, enqueued } = makeSession();
    const banners = [];
    s._view.showListBanner = (m) => banners.push(m);
    s.state = "active";
    s._selectedNum = 42;
    s.onKeyDown(keyEvent("ArrowLeft"));
    enqueued[0].onFail("timeout");
    expect(enqueued.length).toBe(1); // 離板鍵未入列
    expect(s._serverNum).toBeNull();
    expect(s._renderMode).toBe("native"); // 顯性降級，不靜默卡 frozen
  });

  test("nav 鍵不佇列不送（本地導航維持零網路）", () => {
    const { s, sent, enqueued } = makeSession();
    s.state = "active";
    s._selectedNum = 42;
    const e = keyEvent("ArrowDown");
    s.onKeyDown(e);
    expect(sent).toEqual([]);
    expect(enqueued).toEqual([]);
    expect(e.defaultPrevented).toBe(true);
    expect(s.state).toBe("active");
  });
});

describe("passthrough sync 腿期間 frozen（不得閃現原生畫面）", () => {
  test("按 [（未同步）sync 腿在途 → frozen、游標保持隱藏", () => {
    const { s } = makeSession();
    const calls = { hide: 0, show: 0 };
    s._view.flashListHint = () => {};
    s._view.hideCursor = () => calls.hide++;
    s._view.showCursor = () => calls.show++;
    s.state = "active";
    s._renderMode = "buffer";
    s._selectedNum = 42;
    s.onKeyDown(keyEvent("["));
    expect(s._renderMode).toBe("frozen"); // sync 完成前不閃原生
    expect(calls.show).toBe(0); // showCursor = 原生游標露出
  });

  test("frozen sync 腿期間按任意鍵 → 吞掉（preventDefault、不佇列不送）＋有讀取提示", () => {
    const { s, sent, enqueued } = makeSession();
    const hints = [];
    s._view.flashListHint = (m) => hints.push(m);
    s.state = "active";
    s._renderMode = "buffer";
    s._selectedNum = 42;
    s.onKeyDown(keyEvent("["));
    s.state = "functionMode"; // sync 腿在途（reducer 尚未 resume）
    const n = enqueued.length;
    const before = hints.length;
    const e = keyEvent("x");
    s.onKeyDown(e);
    expect(e.defaultPrevented).toBe(true);
    expect(enqueued.length).toBe(n);
    expect(sent).toEqual([]);
    // 交易在途吞鍵不得無聲（3 秒 timeout 窗內「按了沒反應」回歸）
    expect(hints.length).toBeGreaterThan(before);
  });

  test("opening（開文序列在途）吞鍵 → 有讀取提示（不得無聲）", () => {
    const { s } = makeSession();
    const hints = [];
    s._view.flashListHint = (m) => hints.push(m);
    s.state = "opening";
    const e = keyEvent("x");
    s.onKeyDown(e);
    expect(e.defaultPrevented).toBe(true);
    expect(hints.length).toBe(1);
  });

  test("← 離板同樣 frozen（v5 交易化：離板回應在途也不得閃現原生）", () => {
    const { s } = makeSession();
    s.state = "active";
    s._renderMode = "buffer";
    s._selectedNum = 42;
    s.onKeyDown(keyEvent("ArrowLeft"));
    expect(s.state).toBe("functionMode");
    expect(s._renderMode).toBe("frozen");
  });
});

describe("v5 互動封閉：keyClass 白名單枚舉＋未列鍵一鍵切原生", () => {
  // 枚舉即合約（docs/easy-reading-list.md §操作分類）：白名單＝導覽/開文/跳號/離板；
  // 其餘一律 passthrough（sync＋切原生＋代送），airlock 兩段式已退役。
  const WHITELIST_BEHAVIOR = [
    // [key, 預期 state, 預期佇列 kind（null=不佇列）]
    ["ArrowUp", "active", null],
    ["ArrowDown", "active", null],
    ["k", "active", null],
    ["j", "active", null],
    ["PageUp", "active", null],
    ["PageDown", "active", null],
    // 離板先同步 server 游標（pttbbs getkeep 記 REAL cursor，再進板落點才對）
    ["ArrowLeft", "functionMode", "leave-sync-jump"],
    ["q", "functionMode", "leave-sync-jump"],
    ["e", "functionMode", "leave-sync-jump"],
    // A 類鍵（原地重繪）→ 凍結交易：同樣先同步真游標，但腿名不同，而且**不切原生**
    ["[", "functionMode", "inplace-sync-jump"],
    ["]", "functionMode", "inplace-sync-jump"],
    ["=", "functionMode", "inplace-sync-jump"],
    ["t", "functionMode", "inplace-sync-jump"],
    // B 類鍵（開 prompt／進子畫面／換一份清單）→ passthrough：sync 後切原生再代送
    ["v", "functionMode", "native-sync-jump"],
    ["/", "functionMode", "native-sync-jump"],
    ["z", "functionMode", "native-sync-jump"],
    ["s", "functionMode", "native-sync-jump"],
  ];
  test.each(WHITELIST_BEHAVIOR)("白名單 %s → state=%s", (key, state, kind) => {
    const { s, enqueued } = makeSession();
    s._view.flashListHint = () => {};
    s.state = "active";
    s._selectedNum = 42;
    const e = keyEvent(key);
    s.onKeyDown(e);
    expect(e.defaultPrevented).toBe(true);
    expect(s.state).toBe(state);
    if (kind) expect(enqueued[0].kind).toBe(kind);
    else expect(enqueued).toEqual([]); // 空 buffer：nav 本地 no-op、零佇列
  });

  test("單按未列鍵完整流程：z → sync → 切原生＋代送＋提示（airlock 二連擊退役）", () => {
    const { s, sent, enqueued } = makeSession();
    const hints = [];
    s._view.flashListHint = (m) => hints.push(m);
    s.state = "active";
    s._renderMode = "buffer";
    s._selectedNum = 42;
    const e = keyEvent("z");
    s.onKeyDown(e);
    expect(e.defaultPrevented).toBe(true); // 代送模式：原事件不放行
    expect(enqueued[0].kind).toBe("native-sync-jump");
    enqueued[0].onDone();
    expect(s.state).toBe("functionMode");
    expect(s._renderMode).toBe("native");
    expect(enqueued[1].kind).toBe("native-key");
    expect(enqueued[1].keys).toBe("z");
    expect(hints.length).toBeGreaterThan(0); // 事後告知已切原生
  });

  // 2026-09-13 起 Ctrl 組合**也代送**（原本斷言「放行給原生鍵盤路徑、零命令」）：
  // 那條「不代送」路徑跳過 sync 腿，而 read.c 有一整組對真游標那列動作的 Ctrl 鍵
  //（Ctrl-Q/S/T/D）⇒ 查詢作者查到別人。詳見本檔末的 cursor-relative describe。
  test("Ctrl-P（發文）→ 一鍵切原生，並序列化代送 \\x10", () => {
    const { s, sent, enqueued } = makeSession();
    s._view.flashListHint = () => {};
    s.state = "active";
    s._selectedNum = 42;
    const e = keyEvent("p");
    e.ctrlKey = true;
    s.onKeyDown(e);
    expect(e.defaultPrevented).toBe(true); // 代送模式：原事件不放行，免得送兩次
    expect(enqueued[0].kind).toBe("native-sync-jump");
    enqueued[0].onDone();
    expect(enqueued[1].kind).toBe("native-key");
    expect(enqueued[1].keys).toBe("\x10");
    expect(sent).toEqual([]); // 走佇列，不裸送
    expect(s.state).toBe("functionMode");
    expect(s._renderMode).toBe("native");
  });

  test("剪貼簿組合鍵（Ctrl-C/A/V/X）放行給 app 層（不吞、不轉態）", () => {
    const { s } = makeSession();
    s.state = "active";
    for (const k of ["c", "a", "v", "x"]) {
      const e = keyEvent(k);
      e.ctrlKey = true;
      s.onKeyDown(e);
      expect(e.defaultPrevented).toBe(false);
      expect(s.state).toBe("active");
    }
  });

  test("Shift+Insert（貼上快捷鍵）同樣放行——preventDefault 會取消瀏覽器貼上", () => {
    // 回歸：Shift+Insert 不是 ctrl 組合 → 舊碼落 passthrough → preventDefault
    // ⇒ #t 收不到 paste 事件、App.onDOMPaste 永不觸發，PTT 只收到 keyEventToBytes
    // 產出的 \x1b[2~。畫面切原生但沒貼上東西，使用者得再貼第二次（那次才成功，
    // 因為此時 listRenderMode 已是 native、本 hook 根本不被呼叫）。
    const { s, sent, enqueued } = makeSession();
    s._view.flashListHint = () => {};
    s.state = "active";
    s._renderMode = "buffer";
    s._selectedNum = 42;
    const e = keyEvent("Insert");
    e.shiftKey = true;
    s.onKeyDown(e);
    expect(e.defaultPrevented).toBe(false);
    expect(s.state).toBe("active");
    expect(s._renderMode).toBe("buffer"); // 不因按鍵本身切原生
    expect(enqueued).toEqual([]); // 不得送 \x1b[2~
    expect(sent).toEqual([]);
  });

  test("反向守護：純 Insert（無 shift）仍是 passthrough 鍵", () => {
    const { s, enqueued } = makeSession();
    s._view.flashListHint = () => {};
    s.state = "active";
    s._selectedNum = 42;
    const e = keyEvent("Insert");
    s.onKeyDown(e);
    expect(e.defaultPrevented).toBe(true);
    expect(s.state).toBe("functionMode");
    expect(enqueued[0].kind).toBe("native-sync-jump");
  });

  test("v / `/`（舊 T2 模擬已拔除）→ 同 passthrough：sync 完成後代送、切原生", () => {
    // 已讀設定/標題搜尋改由原生畫面接手（單按切原生），模擬 prompt/overlay 退役。
    for (const key of ["v", "/"]) {
      const { s, sent, enqueued } = makeSession();
      s._view.flashListHint = () => {};
      s.state = "active";
      s._renderMode = "buffer";
      s._selectedNum = 42;
      s.onKeyDown(keyEvent(key));
      expect(enqueued[0].kind).toBe("native-sync-jump");
      expect(enqueued[0].keys).toBe("42\r");
      enqueued[0].onDone();
      expect(s.state).toBe("functionMode");
      expect(s._renderMode).toBe("native");
      expect(enqueued[1].kind).toBe("native-key");
      expect(enqueued[1].keys).toBe(key);
    }
  });

  test("select 清單離開（←）：leave onDone 清 _selectMode＋_boardName（回主列表必 rebuild）", () => {
    const { s, enqueued } = makeSession();
    s.state = "active";
    s._selectMode = true;
    s._boardName = "C_Chat";
    s.onKeyDown(keyEvent("ArrowLeft"));
    expect(enqueued[0].kind).toBe("leave-board");
    enqueued[0].onDone();
    expect(s._selectMode).toBe(false);
    expect(s._boardName).toBeNull();
  });

  test("T2 數字跳號：digit→輸入框（預填）→確認＝jump-number 交易→落地 rebuild；取消零 server", () => {
    const { s, enqueued } = makeSession();
    let inputArgs = null;
    let inputCb = null;
    s._view.promptListInput = (label, init, cb) => {
      inputArgs = { label, init };
      inputCb = cb;
    };
    s.state = "active";
    s._renderMode = "buffer";
    s.onKeyDown(keyEvent("5"));
    expect(s.state).toBe("active"); // 收參純本地
    expect(enqueued).toEqual([]);
    expect(inputArgs.init).toBe("5");
    inputCb("523");
    expect(s.state).toBe("functionMode");
    expect(s._renderMode).toBe("frozen");
    expect(enqueued[0].kind).toBe("jump-number");
    expect(enqueued[0].keys).toBe("523\r");
    // 落地（park 指紋）→ onDone rebuild 回 active/buffer
    expect(
      enqueued[0].expect(null, {
        rows: 24,
        curY: 5,
        curX: 0,
        cursorRowNum: 523,
        nums: new Array(24).fill(null),
        rowTexts: new Array(24).fill(""),
      })
    ).toBe(true);
    enqueued[0].onDone();
    expect(s.state).toBe("active");
    expect(s._renderMode).toBe("buffer");
    // 取消路徑
    const { s: s2, enqueued: q2 } = makeSession();
    let cb2 = null;
    s2._view.promptListInput = (l, i, cb) => (cb2 = cb);
    s2.state = "active";
    s2.onKeyDown(keyEvent("7"));
    cb2(null);
    expect(q2).toEqual([]);
    expect(s2.state).toBe("active");
  });

  test("交易前導只清 pending、保留 in-flight（sync 腿/←/Enter 開文——防 ownerless settle 誤配對）", () => {
    // live race：前導 flush() 砍掉 in-flight prefetch anchor → 其在線回應變
    // 無主 settle，提早滿足新交易的 expect（leave-board 吃掉 anchor 落地）。
    // 前導必須 flushPending（序列化修復），全量 flush 只准出現在退回原生鏡像
    // 的路徑（_enterFunctionMode/_handoffArticle/_cleanup——那裡沒有後續 expect）。
    // passthrough 的 sync 腿（[ v …）在途時同規則；sync 完成後的 enter-function-mode
    // 全量 flush 屬合法（之後無 expect），此處只驗「入列當下」。
    const begins = [
      ["[（A 類凍結交易）", (s) => s.onKeyDown(keyEvent("["))],
      ["v", (s) => s.onKeyDown(keyEvent("v"))],
      ["ArrowLeft", (s) => s.onKeyDown(keyEvent("ArrowLeft"))],
      ["Enter開文", (s) => s.onKeyDown(keyEvent("Enter"))],
    ];
    for (const [label, fire] of begins) {
      const { s, queue } = makeSession();
      s._view.flashListHint = () => {};
      s._view.promptListInput = () => {};
      s.state = "active";
      s._renderMode = "buffer";
      s._selectedNum = 42;
      fire(s);
      expect({ label, flushed: queue.flushed || 0 }).toEqual({ label, flushed: 0 });
      expect({ label, pendingFlushed: queue.pendingFlushed || 0 }).toEqual({
        label,
        pendingFlushed: 1,
      });
    }
  });

  test("點擊選取已移除（2026-07-08）：session 無點擊入口（buffer 點擊＝no-op）", () => {
    // 點擊只移選取、不開文，使用者認定無用；接線層（pttchrome.js mouse_click）
    // 在 buffer/frozen 一律吞掉點擊（防 useMouseBrowsing 對虛擬視窗座標發鍵）。
    const { s } = makeSession();
    expect(s.onClick).toBeUndefined();
  });
});

describe("passthrough 黏性原生（2026-07-10 UX：不自動彈回好讀）", () => {
  // 反覆按 [ ] 時「切原生→彈回好讀→再切原生」畫面閃動、圓點游標跳動，
  // 且高流量板的殘餘 settle 易誤觸 catch-all banner。合約：passthrough
  // 切原生後 HOLD——**clean-list settle 本身**一律 stay 鏡像。
  // 2026-09-03 起 hold 分兩種：'external'（AID 跳文／長推文停泊）永不自動解除；
  // 'passthrough' 由靜置探針（resume-probe，另見 list_native_resume.test.js）
  // 解除。這裡守護的是「settle 本身不得解除 hold」那一半 —— 少了它就會在
  // 「一個回應 settle 兩次」的半幀上採用到錯的游標落點。
  // 另：[ ] = 已改走 A 類凍結交易（根本不切原生），所以這裡改用 B 類鍵 z。
  function cleanList(boardName, num) {
    const rowTexts = new Array(24).fill("");
    const nums = new Array(24).fill(null);
    nums[5] = num;
    return {
      kind: "clean-list",
      boardName,
      rowTexts,
      nums,
      rows: 24,
      curY: 5,
      curX: 0,
      cursorRowNum: num,
    };
  }

  test("代送後的 clean-list settle → 停在原生鏡像（不彈回 buffer）", () => {
    const { s, enqueued } = makeSession();
    s._view.flashListHint = () => {};
    s.state = "active";
    s._renderMode = "buffer";
    s._boardName = "C_Chat";
    s._selectedNum = 42;
    s._termBuf.listLineNums = [41, 42, 43];
    s.onKeyDown(keyEvent("z"));
    enqueued[0].onDone(); // sync 完成 → 切原生＋native-key 入列
    enqueued[1].onDone && enqueued[1].onDone(); // key 回應完成
    // 原生操作完成後的列表重繪 settle → 必須 STAY（黏性；回好讀由靜置探針決定）
    const facts = cleanList("C_Chat", 87);
    s._dispatch(s._settleEvent(facts), facts);
    expect(s.state).toBe("functionMode");
    expect(s._renderMode).toBe("native");
    // 連按多次也不再切換模式（穩定停原生）
    const facts2 = cleanList("C_Chat", 90);
    s._dispatch(s._settleEvent(facts2), facts2);
    expect(s.state).toBe("functionMode");
  });

  test("開文 → 返回列表才解除 hold（resume＋rebuild：excursion 後 cache 不可信）", () => {
    const { s, enqueued } = makeSession();
    let resets = 0;
    s._view.flashListHint = () => {};
    s._view.resetListAccumulation = () => resets++;
    s.state = "active";
    s._renderMode = "buffer";
    s._boardName = "C_Chat";
    s._selectedNum = 42;
    s._termBuf.listLineNums = [41, 42, 43];
    s.onKeyDown(keyEvent("]"));
    enqueued[0].onDone();
    // 原生開文 → article settle → suspended（文章好讀接手、hold 解除）
    const articleFacts = { kind: "article", boardName: null, rowTexts: [], nums: [], rows: 24, curY: 23, curX: 0, cursorRowNum: null };
    s._dispatch(s._settleEvent(articleFacts), articleFacts);
    expect(s.state).toBe("suspended");
    // ← 返回列表 → resume；_boardName 已被 excursion 清空 → 必 rebuild
    const facts = cleanList("C_Chat", 87);
    s._dispatch(s._settleEvent(facts), facts);
    expect(s.state).toBe("active");
    expect(s._renderMode).toBe("buffer");
    expect(resets).toBeGreaterThanOrEqual(1);
  });

  test("離板 → menu settle → idle；重進板 clean-list → 重新 engage 不受 hold 影響", () => {
    const { s, enqueued } = makeSession();
    s._view.flashListHint = () => {};
    s.state = "active";
    s._selectedNum = 42;
    s.onKeyDown(keyEvent("z"));
    enqueued[0].onDone(); // 切原生（hold）
    const menuFacts = { kind: "menu", boardName: null, rowTexts: [], nums: [], rows: 24, curY: 5, curX: 0, cursorRowNum: null };
    s._dispatch(s._settleEvent(menuFacts), menuFacts);
    expect(s.state).toBe("idle");
    expect(s._holdReason).toBe(null); // cleanup 解除
  });
});

describe("native excursion 一律拋棄 cache（多輪搜尋/過濾汙染回歸，2026-07-10）", () => {
  // 症狀：movie 板 `/` 搜尋後再 Z（airlock→原生）過濾推文數，回列表時板名相同
  // ＋落點序號恰在舊 buffer 內 → 走 resume-buffer 不 rebuild → 舊搜尋條目混雜
  // 顯示（>15 篇、日期錯亂），點舊序號開文 jump expect 永遠不中 → timeout。
  // 合約：進 functionMode（原生 excursion——airlock/自癒/降級）＝清單不再可信，
  // 回 clean-list settle 必 rebuild（丟 view 層 _listNumMap 重建）。
  // 構造「同板名＋落點序號在舊 buffer 內」的 clean-list settle facts —— 修前
  // 這正是漏 rebuild 的組合。
  function cleanListFacts(boardName, num) {
    const rowTexts = new Array(24).fill("");
    const nums = new Array(24).fill(null);
    nums[5] = num;
    return {
      kind: "clean-list",
      boardName,
      rowTexts,
      nums,
      rows: 24,
      curY: 5,
      curX: 0,
      cursorRowNum: num,
    };
  }

  test("單按 Z 切原生（過濾情境）→ 開文返回後必 rebuild（丟舊 buffer）", () => {
    const { s, enqueued } = makeSession();
    let resets = 0;
    s._view.flashListHint = () => {};
    s._view.resetListAccumulation = () => resets++;
    s.state = "active";
    s._renderMode = "buffer";
    s._boardName = "movie";
    s._selectedNum = 42;
    s._termBuf.listLineNums = [41, 42, 43]; // 舊搜尋殘留 buffer
    s.onKeyDown(keyEvent("Z")); // 單按 → passthrough（sync→原生過濾）
    enqueued[0].onDone();
    expect(s.state).toBe("functionMode");
    // 黏性 hold：原生過濾完成的 clean-list settle 停在鏡像（不彈回）
    const facts = cleanListFacts("movie", 42);
    s._dispatch(s._settleEvent(facts), facts);
    expect(s.state).toBe("functionMode");
    // 開文 → 返回：hold 解除、_boardName 已清 → 必 rebuild，不得 merge 舊 buffer
    const articleFacts = { kind: "article", boardName: null, rowTexts: [], nums: [], rows: 24, curY: 23, curX: 0, cursorRowNum: null };
    s._dispatch(s._settleEvent(articleFacts), articleFacts);
    expect(s.state).toBe("suspended");
    s._dispatch(s._settleEvent(facts), facts);
    expect(s.state).toBe("active");
    expect(resets).toBeGreaterThanOrEqual(1); // 必 rebuild，不得只 resume
  });

  test("開文 timeout 自癒（open-timeout→functionMode）→ hold 停原生；開文返回後必 rebuild", () => {
    const { s } = makeSession();
    let resets = 0;
    s._view.resetListAccumulation = () => resets++;
    s._view.flashListHint = () => {};
    s.state = "opening";
    s._boardName = "movie";
    s._selectedNum = 42;
    s._termBuf.listLineNums = [41, 42, 43];
    s._dispatch({ type: "open-timeout" }, null);
    expect(s.state).toBe("functionMode");
    const facts = cleanListFacts("movie", 42);
    s._dispatch(s._settleEvent(facts), facts);
    expect(s.state).toBe("functionMode"); // 黏性
    const articleFacts = { kind: "article", boardName: null, rowTexts: [], nums: [], rows: 24, curY: 23, curX: 0, cursorRowNum: null };
    s._dispatch(s._settleEvent(articleFacts), articleFacts);
    s._dispatch(s._settleEvent(facts), facts);
    expect(s.state).toBe("active");
    expect(resets).toBeGreaterThanOrEqual(1);
  });

  test("反向守護：← 離板交易（frozen、保留 _boardName）回 clean-list 只 resume 不 rebuild", () => {
    // MODE_SELECT 退出/thread hop 落回列表：frozen 交易非原生 excursion，
    // 快路徑（resume-buffer only）不得退化成全 rebuild。
    const { s, enqueued } = makeSession();
    let resets = 0;
    s._view.resetListAccumulation = () => resets++;
    s.state = "active";
    s._renderMode = "buffer";
    s._boardName = "movie";
    s._selectedNum = 42;
    s._serverNum = 42; // 已同步 → 直送離板鍵
    s._termBuf.listLineNums = [41, 42, 43];
    s.onKeyDown(keyEvent("ArrowLeft"));
    expect(s.state).toBe("functionMode");
    enqueued[0].onDone(); // leave-board 完成（落回 clean-list）
    const facts = cleanListFacts("movie", 43);
    s._dispatch(s._settleEvent(facts), facts);
    expect(s.state).toBe("active");
    expect(resets).toBe(0);
  });
});

describe("functionMode clean-list settle 的 in-flight 吸收（相對命令配對期間不彈回）", () => {
  const settle = (kind, extra = {}) => ({
    type: "settle",
    kind,
    boardNameMatch: true,
    inFlightKind: null,
    landedNumInBuffer: true,
    engageEligible: false,
    hasNumberedRow: true,
    ...extra,
  });
  test("in-flight（native-sync-jump）→ stay 鏡像", () => {
    expect(
      transitionListSession(
        "functionMode",
        settle("clean-list", { inFlightKind: "native-sync-jump" })
      )
    ).toEqual({ next: "functionMode", actions: [] });
  });
  test("配對完成（無 in-flight、無 hold——leave/jump 交易）→ resume 採用落點游標", () => {
    expect(transitionListSession("functionMode", settle("clean-list"))).toEqual({
      next: "active",
      actions: ["resume-buffer"],
    });
  });
  test.each(["passthrough", "external"])(
    "holdReason=%s → clean-list settle 一律 stay 鏡像（settle 本身不解除 hold）",
    (holdReason) => {
      expect(
        transitionListSession("functionMode", settle("clean-list", { holdReason }))
      ).toEqual({ next: "functionMode", actions: [] });
    }
  );
});

describe("無字元實體鍵不得觸發原生 excursion（Caps Lock/F2「畫面跑掉」回歸，2026-08）", () => {
  // 舊行為：CapsLock/F 鍵等落 _classifyKey 的 default → passthrough →
  // _beginNativePassthrough 的 bytes==null 分支 → 跳過 cursor sync 腿直接
  // _enterFunctionMode()：畫面瞬間換成 server 真實 24 行（通常停在背景 prefetch
  // 的遠處頁面）＝「畫面跑掉」，還黏性 hold＋丟 cache（不變量 15）。而該分支假設的
  // 「事件放行給原生鍵盤路徑自己送」對這些鍵不成立（TermKeyboard._onKeyDown 對
  // KeyMap miss 且 key.length!==1 一律回 false）⇒ server 完全沒動，純損失。
  // 新合約：keyEventToBytes(e)==null ＝ 這個鍵送不出任何 byte ＝ keyClass 'ignore'，
  // 吞掉不轉態。
  const DEAD_KEYS = ["CapsLock", "F2", "F8", "F12", "NumLock", "ScrollLock"];
  test.each(DEAD_KEYS)("%s → 完全不動好讀狀態（不切原生、不丟 cache）", (key) => {
    const { s, sent, enqueued, queue } = makeSession();
    const hints = [];
    s._view.flashListHint = (m) => hints.push(m);
    s.state = "active";
    s._renderMode = "buffer";
    s._boardName = "C_Chat";
    s._selectedNum = 42;
    s._serverNum = 7; // 未同步：舊碼會在這裡跳過 sync 腿直切原生
    const e = keyEvent(key);
    s.onKeyDown(e);
    expect(s.state).toBe("active");
    expect(s._renderMode).toBe("buffer"); // 畫面不得換成 server 鏡像
    expect(s._holdReason).toBe(null);
    expect(s._boardName).toBe("C_Chat"); // 不變量 15 的拋 cache 不該被誤觸
    expect(s._selectedNum).toBe(42);
    expect(sent).toEqual([]);
    expect(enqueued).toEqual([]);
    expect(queue.flushed).toBeUndefined();
    expect(hints).toEqual([]); // 不該冒出「已切至原生」
    // 刻意不 preventDefault：F12 開發者工具/CapsLock 的 OS 行為留給瀏覽器，
    // 反正原生鍵盤路徑對它們也送不出 byte。
    expect(e.defaultPrevented).toBe(false);
  });

  test("Ctrl+Shift 組合（送不出 byte）同樣 ignore，不做原生 excursion", () => {
    const { s, sent, enqueued } = makeSession();
    s._view.flashListHint = () => {};
    s.state = "active";
    s._renderMode = "buffer";
    s._selectedNum = 42;
    const e = keyEvent("X", { ctrlKey: true, shiftKey: true });
    s.onKeyDown(e);
    expect(s.state).toBe("active");
    expect(s._renderMode).toBe("buffer");
    expect(sent).toEqual([]);
    expect(enqueued).toEqual([]);
  });

  test("反向守護：Ctrl-P（發文，CtrlShiftMap 有對應）仍是 passthrough 切原生", () => {
    // 這條守的是「別把有 bytes 的 Ctrl 組合誤判成 T0 ignore」。代送與否見上面那條
    // 與本檔末的 cursor-relative describe（2026-09-13 起代送）。
    const { s, enqueued } = makeSession();
    s._view.flashListHint = () => {};
    s.state = "active";
    s._selectedNum = 42;
    s._serverNum = 42; // 真游標已同步 ⇒ 免 sync 腿，只剩代送那一腿
    const e = keyEvent("p", { ctrlKey: true });
    s.onKeyDown(e);
    expect(s.state).toBe("functionMode");
    expect(s._renderMode).toBe("native");
    expect(e.defaultPrevented).toBe(true);
    expect(enqueued.length).toBe(1);
    expect(enqueued[0].keys).toBe("\x10");
  });
});

describe("read.c 導覽同義鍵＝本地導覽零 server（空白鍵「畫面跑掉」回歸，2026-08）", () => {
  // pttbbs mbbsd/read.c:858-902 的列表導覽鍵表：
  //   ' ' / KEY_PGDN / 'N' / Ctrl-F   → 下一頁
  //   KEY_PGUP / 'P' / Ctrl-B         → 上一頁
  //   'p' / 'k' / KEY_UP              → 上移一列
  //   'n' / 'j' / KEY_DOWN            → 下移一列
  //   KEY_END / '$'                   → 底端
  // 舊碼白名單只收方向鍵/j/k/PageUp/PageDown/Home/End，其餘同義鍵有 bytes ⇒ 走
  // 完整 passthrough（sync 腿→切原生→代送）：使用者只想翻頁卻被丟去原生鏡像。
  // Ctrl-F/Ctrl-B 刻意不納入（維持 Ctrl 組合與瀏覽器快捷鍵的既有分界）。
  const SYNONYMS = [
    [" ", "pgdn", "PageDown"],
    ["N", "pgdn", "PageDown"],
    ["P", "pgup", "PageUp"],
    ["n", "down", "ArrowDown"],
    ["p", "up", "ArrowUp"],
    ["$", "end", "End"],
  ];
  test.each(SYNONYMS)("%s ＝ 本地導覽 %s（等同 %s）", (key, op, canonical) => {
    const { s, sent, enqueued } = makeSession();
    s._view.flashListHint = () => {};
    s.state = "active";
    s._renderMode = "buffer";
    s._boardName = "C_Chat";
    s._selectedNum = 42;
    s._serverNum = 7; // 未同步：passthrough 會在這裡起 sync 腿
    const ops = [];
    s._moveSelection = (o) => ops.push(o);
    const e = keyEvent(key);
    s.onKeyDown(e);
    expect(ops).toEqual([op]);
    // 與正典鍵逐項等價
    const ref = makeSession();
    ref.s._view.flashListHint = () => {};
    ref.s.state = "active";
    ref.s._renderMode = "buffer";
    ref.s._selectedNum = 42;
    ref.s._serverNum = 7;
    const refOps = [];
    ref.s._moveSelection = (o) => refOps.push(o);
    ref.s.onKeyDown(keyEvent(canonical));
    expect(ops).toEqual(refOps);
    // 零 server、不切原生、不丟 cache
    expect(sent).toEqual([]);
    expect(enqueued).toEqual([]);
    expect(s.state).toBe("active");
    expect(s._renderMode).toBe("buffer");
    expect(s._boardName).toBe("C_Chat");
    expect(e.defaultPrevented).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cursor-relative 的 Ctrl / Alt 組合鍵必須先同步真游標
// （2026-09-13 回報「查詢作者會跑去其它文章」，錄製檔 ptt-debug-20260913-184532）
// ---------------------------------------------------------------------------
//
// 症狀：好讀列表按 `a` 搜作者 → 選一篇 → Ctrl-Q 查到**別人**；按 ← 退出後選取也跟著
// 跑到那個人的文章上。
//
// 根因：舊碼 `_beginNativePassthrough` 開頭寫死 `e.ctrlKey ? null : keyEventToBytes(e)`
// ⇒ 所有 Ctrl 組合強制落 `bytes == null` 分支（切原生、放行給原生鍵盤路徑），而那條
// 分支**不經過 `_beginPassthroughBytes`，也就跳過了裡面的 native-sync-jump 腿**。
// 好讀列表的 T1 導覽零網路，真游標通常停在背景 prefetch 的落點 ⇒ server 對錯的那列
// 動作。錄製檔 #t=5926 是裸送的 "^Q"（前面沒有任何 queue.enqueue），#t=5940 回應畫面
// 就是另一位作者的 my_query。
//
// PTT 端佐證（pttbbs mbbsd/read.c:904）——**對真游標那一列**動作：
//     case Ctrl('Q'):
//         mode = my_query(headers[locmem->crs_ln - locmem->top_ln].owner);
// 同類還有 read.c:911 Ctrl('S')、:957 Ctrl('T') TagThread、:970 Ctrl('D')。
//
// keyEventToBytes 的 ctrlKey 分支本來就算得出 bytes（CtrlShiftMap，Ctrl-Q → \x11），
// 所以舊註解「not resendable / can't serialize a key we don't own」的前提早已不成立。
describe("cursor-relative Ctrl／Alt 組合鍵先同步真游標（查詢作者跑掉，2026-09-13）", () => {
  test("Ctrl-Q（查詢作者）→ 先 native-sync-jump，落地後才代送 \\x11", () => {
    const { s, sent, enqueued } = makeSession();
    s._view.flashListHint = () => {};
    s.state = "active";
    s._renderMode = "buffer";
    s._selectedNum = 42;
    s._serverNum = 7; // 真游標落在別處（背景 prefetch 帶走的）
    const e = keyEvent("q", { ctrlKey: true });
    s.onKeyDown(e);

    // 代送模式：原事件不放行（放行＝原生鍵盤路徑裸送，就是這個 bug）
    expect(e.defaultPrevented).toBe(true);
    expect(sent).toEqual([]);
    expect(enqueued[0].kind).toBe("native-sync-jump");
    expect(enqueued[0].keys).toBe("42\r");

    enqueued[0].onDone();
    expect(s.state).toBe("functionMode");
    expect(s._renderMode).toBe("native");
    expect(enqueued[1].kind).toBe("native-key");
    expect(enqueued[1].keys).toBe("\x11");
    // 尾附 \f 的契約照舊（PTT 忽略某鍵時零 byte 零 settle，沒有它只能等滿 3s）
    expect(enqueued[1].fullRepaint).toBe(true);
    expect(sent).toEqual([]);
  });

  test("Ctrl-Q：真游標已在選取上 → 免 sync 腿，直接代送（快路徑不回歸）", () => {
    const { s, sent, enqueued } = makeSession();
    s._view.flashListHint = () => {};
    s.state = "active";
    s._renderMode = "buffer";
    s._selectedNum = 42;
    s._serverNum = 42;
    const e = keyEvent("q", { ctrlKey: true });
    s.onKeyDown(e);

    expect(e.defaultPrevented).toBe(true);
    expect(enqueued.length).toBe(1);
    expect(enqueued[0].kind).toBe("native-key");
    expect(enqueued[0].keys).toBe("\x11");
    expect(sent).toEqual([]);
  });

  test("Ctrl 組合的 bytes 不得過 u2b：Ctrl-] 送 charCode 221，與原生鍵盤路徑同一個 byte", () => {
    // CtrlShiftMap 的 '[' / '\\' / ']' 是 219/220/221（upstream 拿 keyCode 當 char
    // code 的老 bug，本次不修），都 > 127 ⇒ 若沿用非 Ctrl 鍵那條 u2b 轉碼，會被當成
    // Unicode 字元做 Big5 轉碼，送出跟 TermKeyboard 不一樣的 byte。
    const { s, enqueued } = makeSession();
    s._view.flashListHint = () => {};
    s.state = "active";
    s._renderMode = "buffer";
    s._selectedNum = 42;
    s._serverNum = 42;
    s.onKeyDown(keyEvent("]", { ctrlKey: true }));

    expect(enqueued.length).toBe(1);
    expect(enqueued[0].keys).toBe(String.fromCharCode(221));
  });

  test("Alt 重映射鍵 Alt-T（＝^T TagThread，read.c:957）同樣走 sync → 代送", () => {
    // Alt remap（Alt＝PTT 的 Ctrl，全 26 字母，見 term_keyboard）是**本 app 自己造
    // 的送鍵入口**，不是瀏覽器快捷鍵 ⇒ 與 Ctrl 組合同級。
    // 舊碼 onKeyDown 開頭 `if (clipboard || e.altKey || e.metaKey) return;` 把它整個
    // early-return 掉：連原生鏡像都不切就由 TermKeyboard 裸送，比 Ctrl 那條更隱蔽
    //（好讀畫面完全不動，server 狀態卻已改變）。
    const { s, sent, enqueued } = makeSession();
    s._view.flashListHint = () => {};
    s.state = "active";
    s._renderMode = "buffer";
    s._selectedNum = 42;
    s._serverNum = 7;
    const e = keyEvent("t", { altKey: true });
    s.onKeyDown(e);

    expect(e.defaultPrevented).toBe(true);
    expect(sent).toEqual([]);
    expect(enqueued[0].kind).toBe("native-sync-jump");
    enqueued[0].onDone();
    expect(enqueued[1].kind).toBe("native-key");
    expect(enqueued[1].keys).toBe("\x14"); // ^T
    expect(s._renderMode).toBe("native");
  });

  test("反向守護：非字母的 Alt 組合仍整個放行給瀏覽器", () => {
    // Alt remap 只涵蓋 26 個字母。數字、方向鍵這類 Alt 組合仍是瀏覽器／OS 的
    //（Alt+← 是上一頁），維持早退：不轉態、不 preventDefault、零命令。
    // 註：Alt-F 以前在這裡，但 26 字母 remap 之後它是 ^F，已移到正向案例。
    for (const [key, code] of [
      ["5", "Digit5"],
      ["ArrowLeft", "ArrowLeft"],
    ]) {
      const { s, sent, enqueued } = makeSession();
      s._view.flashListHint = () => {};
      s.state = "active";
      s._renderMode = "buffer";
      s._selectedNum = 42;
      const e = keyEvent(key, { altKey: true, code });
      s.onKeyDown(e);

      expect(e.defaultPrevented).toBe(false);
      expect(s.state).toBe("active");
      expect(s._renderMode).toBe("buffer");
      expect(sent).toEqual([]);
      expect(enqueued).toEqual([]);
    }
  });

  test("反向守護：Alt-Shift-T／Ctrl-Alt-T 不是 remap 鍵，照樣放行", () => {
    // 條件必須與 TermKeyboard._onKeyDown 的 alt 分支對齊（!ctrl && alt && !shift），
    // 否則兩條路徑會漂移：這裡接手了，原生那邊卻不送 ⇒ 按鍵變啞巴。
    for (const mods of [
      { altKey: true, shiftKey: true },
      { altKey: true, ctrlKey: true },
    ]) {
      const { s, sent, enqueued } = makeSession();
      s._view.flashListHint = () => {};
      s.state = "active";
      s._renderMode = "buffer";
      s._selectedNum = 42;
      const e = keyEvent("t", mods);
      s.onKeyDown(e);
      expect(e.defaultPrevented).toBe(false);
      expect(s.state).toBe("active");
      expect(sent).toEqual([]);
      expect(enqueued).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Alt＝PTT 的 Ctrl，全 26 字母（2026-09）。列表好讀底下每一顆都必須走 passthrough
// 的 cursor-sync 腿 —— Ctrl 鍵有一票是對「真游標那一列」動作的（docs §11.7），
// 好讀的選取列與 server 游標不同步時裸送就會對錯的文章生效。
// ---------------------------------------------------------------------------
describe("Alt remap 全 26 字母（列表好讀）", () => {
  function activeSession() {
    const r = makeSession();
    r.s._view.flashListHint = () => {};
    r.s.state = "active";
    r.s._renderMode = "buffer";
    r.s._selectedNum = 42;
    r.s._serverNum = 7; // 與選取列不同步 ⇒ 必須先跑 sync 腿
    return r;
  }

  const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

  test("26 個字母都走 sync → 代送對應控制碼 → 切原生鏡像", () => {
    LETTERS.forEach((L, i) => {
      const { s, sent, enqueued } = activeSession();
      const e = keyEvent(L.toLowerCase(), { altKey: true, code: "Key" + L });
      s.onKeyDown(e);

      expect(e.defaultPrevented).toBe(true);
      expect(sent).toEqual([]); // 不得裸送上線
      expect(enqueued[0].kind).toBe("native-sync-jump");
      enqueued[0].onDone();
      expect(enqueued[1].kind).toBe("native-key");
      expect(enqueued[1].keys).toBe(String.fromCharCode(i + 1));
      expect(s._renderMode).toBe("native");
    });
  });

  test("j/k/n/p 不得變成本地移游標 —— altRemap 攔截必須排在 _classifyKey 之前", () => {
    // 這四顆同時也是導覽白名單的同義鍵（read.c 的 ↑↓ 同義鍵）。順序一反，
    // Alt+J 就會變成「本地把游標往下移一格」而不是送 ^J 給 PTT，而且完全無聲。
    for (const [key, code, out] of [
      ["j", "KeyJ", "\x0a"],
      ["k", "KeyK", "\x0b"],
      ["n", "KeyN", "\x0e"],
      ["p", "KeyP", "\x10"],
    ]) {
      const { s, enqueued } = activeSession();
      const before = s._selectedNum;
      s.onKeyDown(keyEvent(key, { altKey: true, code }));

      expect(s._selectedNum).toBe(before); // 游標沒被本地移動
      expect(enqueued[0].kind).toBe("native-sync-jump");
      enqueued[0].onDone();
      expect(enqueued[1].keys).toBe(out);
    }
  });

  test("Alt+M（＝\\r）走代送，不是序列化開文", () => {
    // ^M 是 Enter 的控制碼別名（vtkbd.h:86-88）。與 Ctrl+M 同路：走原生鏡像開文，
    // 不經 {class:'open'} 的序列化交易。既有行為，這裡釘住不要漂掉。
    const { s, enqueued } = activeSession();
    s.onKeyDown(keyEvent("m", { altKey: true, code: "KeyM" }));

    expect(enqueued[0].kind).toBe("native-sync-jump");
    enqueued[0].onDone();
    expect(enqueued[1].kind).toBe("native-key");
    expect(enqueued[1].keys).toBe("\r");
    // 不得出現序列化開文那條路
    expect(enqueued.some((c) => c.kind === "open")).toBe(false);
  });

  test("Alt+C/A/V/X 不被剪貼簿白名單早退吃掉", () => {
    // clipboard 判定寫的是 `e.ctrlKey && !e.altKey` ⇒ Alt 版必須落到 remap 這條。
    // 有人日後把 `!e.altKey` 拿掉，這四顆就會靜默變回「複製／全選／貼上／剪下」。
    for (const [L, out] of [
      ["C", "\x03"],
      ["A", "\x01"],
      ["V", "\x16"],
      ["X", "\x18"],
    ]) {
      const { s, sent, enqueued } = activeSession();
      const e = keyEvent(L.toLowerCase(), { altKey: true, code: "Key" + L });
      s.onKeyDown(e);

      expect(e.defaultPrevented).toBe(true);
      expect(sent).toEqual([]);
      expect(enqueued[0].kind).toBe("native-sync-jump");
      enqueued[0].onDone();
      expect(enqueued[1].keys).toBe(out);
    }
  });

  test("macOS 形態（e.key 失真／dead key）在 session 層同樣接得住", () => {
    // 這層以前只測過 key:'t' 的 Windows 形態 ⇒ mac 是盲區。session 自己呼叫
    // altRemapCharCode，少了 e.code 就會整條啞掉。
    for (const [key, code, out] of [
      ["√", "KeyV", "\x16"],
      ["Dead", "KeyE", "\x05"], // ⌥E 是組合重音的 dead key
      ["ß", "KeyS", "\x13"], // 'ß'.toUpperCase() === 'SS'，只有 code 救得了
      ["µ", "KeyM", "\x0d"], // 'µ'.toUpperCase() 是希臘 Μ，不是 ASCII M
    ]) {
      const { s, enqueued } = activeSession();
      const e = keyEvent(key, { altKey: true, code });
      s.onKeyDown(e);

      expect(e.defaultPrevented).toBe(true);
      expect(enqueued[0].kind).toBe("native-sync-jump");
      enqueued[0].onDone();
      expect(enqueued[1].keys).toBe(out);
    }
  });

  test("已同步時免 sync 腿，直接代送", () => {
    const { s, enqueued } = activeSession();
    s._serverNum = 42; // 與選取列一致
    s.onKeyDown(keyEvent("w", { altKey: true, code: "KeyW" }));

    expect(enqueued.length).toBe(1);
    expect(enqueued[0].kind).toBe("native-key");
    expect(enqueued[0].keys).toBe("\x17");
  });
});
