// 非導覽操作完成後自動切回好讀（pref enableListNativeAutoResume，2026-09-03）。
//
// 兩半：
//   L1 A 類鍵（原地重繪：[ ] = \ + - < > , . { } t）走**凍結交易**，全程不切原生
//   L2 B 類鍵（開 prompt／進子畫面／換一份清單）切原生，操作完成、畫面靜下來之後
//      由**靜置探針**（resume-probe）自動切回好讀
//
// 靜置的三個洞（RESUME_QUIET_MS 的來源，不是體感旋鈕）：
//   洞 1 PTT 還在等輸入的畫面被誤判 → classifyListScreen 的 curX<=1 已擋住（不變量 N9）
//   洞 2 命令還在線上就判定       → queue.inFlightKind
//   洞 3 一個回應 settle 兩次      → 時鐘從 max(server 活動, 使用者送 byte) 起算
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ListSession, transitionListSession } from "../../src/js/list_session";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures", "replay", "cchat-list.page.json"),
    "utf8"
  )
);
const listRows = fixture.pageScreens[0]; // 真實 C_Chat 一頁的 24 列

const PREF_KEY = "pttchrome.pref.v1";
function setPrefs(values) {
  window.localStorage.setItem(PREF_KEY, JSON.stringify({ values }));
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

// 一個「真的會被 classifyListScreen 判成 clean-list」的畫面：直接用錄製檔那一頁。
// screen 是 stub（量不到 DOM ⇒ _isPosVisible 恆真 ⇒ 不排 reveal），所以任何
// setListScrollTop 的呼叫都是「動了捲動錨」的證據（不變量 N6）。
function makeSession({ rows = listRows, curY = 3, curX = 1 } = {}) {
  const enqueued = [];
  const banners = [];
  const scrollWrites = [];
  const view = {
    hideCursor() {},
    showCursor() {},
    resetListAccumulation() {},
    setListLoading() {},
    flashListHint: (m) => banners.push(m),
    blacklist: new Set(),
    titleBlacklist: [],
    chh: 20,
    componentScreen: {
      setListScrollTop: (px) => scrollWrites.push(px),
      getListScrollTop: () => 0,
    },
  };
  const screen = { rows: rows.slice(), curY, curX };
  const termBuf = {
    rows: 24,
    cols: 80,
    listLines: [],
    listLineNums: [],
    lineChangeds: new Array(24).fill(false),
    changed: false,
    startedEasyReading: false,
    getRowText: (r) => screen.rows[r] || "",
    isUnicolor: () => true,
    get cur_x() {
      return screen.curX;
    },
    get cur_y() {
      return screen.curY;
    },
    addEventListener() {},
    notify() {},
  };
  const queue = {
    idle: true,
    inFlightKind: null,
    flush() {},
    flushPending() {},
    flushPendingKind() {},
    enqueue: (cmd) => enqueued.push(cmd),
    onSettle: () => null,
  };
  const s = new ListSession({ conn: { send() {} } }, view, termBuf, queue);
  return { s, enqueued, banners, queue, screen, scrollWrites, termBuf };
}

// 停泊在 'passthrough' hold（＝按了一個 B 類鍵、原生操作已經跑完）的狀態。
function parkedInNative(h, { boardName = null } = {}) {
  h.s.state = "functionMode";
  h.s._enterFunctionMode(); // 預設 hold = 'passthrough'
  h.s._boardName = boardName;
  return h;
}

beforeEach(() => {
  window.localStorage.clear();
  setPrefs({ enableEasyReadingList: true, enableListNativeAutoResume: true });
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
});

// ---------------------------------------------------------------------------
// reducer（純函式，全枚舉）
// ---------------------------------------------------------------------------

describe("reducer：functionMode × resume-probe", () => {
  const probe = (extra = {}) => ({
    type: "resume-probe",
    kind: "clean-list",
    holdReason: "passthrough",
    inFlightKind: null,
    consumed: false,
    boardNameMatch: false,
    landedNumInBuffer: false,
    hasNumberedRow: true,
    engageEligible: true,
    withinResumeGrace: false,
    ...extra,
  });

  test("條件全中 → 回 active（板名已被 _enterFunctionMode 清掉 ⇒ 一律 rebuild）", () => {
    expect(transitionListSession("functionMode", probe())).toEqual({
      next: "active",
      actions: ["resume-buffer", "rebuild"],
    });
  });

  test("板名相同且落點在緩衝（凍結交易保住了板名）→ 純 resume 快路徑", () => {
    expect(
      transitionListSession(
        "functionMode",
        probe({ boardNameMatch: true, landedNumInBuffer: true })
      )
    ).toEqual({ next: "active", actions: ["resume-buffer"] });
  });

  test("holdReason='external'（AID 跳文／長推文停泊）→ 永不回復（不變量 N1）", () => {
    expect(
      transitionListSession("functionMode", probe({ holdReason: "external" }))
    ).toEqual({ next: "functionMode", actions: [] });
  });

  test.each([
    ["命令還在線上（洞 2）", { inFlightKind: "native-key" }],
    ["畫面不是 clean-list（洞 1：PTT 還在等輸入）", { kind: "prompt" }],
    ["半繪／子畫面", { kind: "transient" }],
    ["無編號列（不變量 17：seed 不出錨點）", { hasNumberedRow: false }],
    ["母開關關掉／非 24 列終端", { engageEligible: false }],
    ["沒有停泊（frozen 交易借用 functionMode）", { holdReason: null }],
  ])("%s → stay 鏡像", (_label, extra) => {
    expect(transitionListSession("functionMode", probe(extra))).toEqual({
      next: "functionMode",
      actions: [],
    });
  });

  test("其他狀態收到 resume-probe 一律 stay（探針只在 functionMode 有意義）", () => {
    for (const st of ["idle", "active", "opening", "suspended"])
      expect(transitionListSession(st, probe())).toEqual({ next: st, actions: [] });
  });
});

describe("reducer：回復後的寬限窗（不變量 N4）", () => {
  const settle = (extra = {}) => ({
    type: "settle",
    kind: "transient",
    boardNameMatch: true,
    inFlightKind: null,
    consumed: false,
    landedNumInBuffer: true,
    holdReason: null,
    hasNumberedRow: true,
    engageEligible: true,
    withinResumeGrace: false,
    ...extra,
  });

  test("grace 內的 transient 殘餘幀 → stay（不得 banner、不得切原生）", () => {
    expect(
      transitionListSession("active", settle({ withinResumeGrace: true }))
    ).toEqual({ next: "active", actions: [] });
  });

  test("grace 外的 transient → 照舊自癒降級（catch-all 不得被廢掉）", () => {
    expect(transitionListSession("active", settle())).toEqual({
      next: "functionMode",
      actions: ["enter-function-mode"],
    });
  });
});

// ---------------------------------------------------------------------------
// 靜置探針（session 層，假時鐘）
// ---------------------------------------------------------------------------

describe("靜置探針：什麼時候才准回好讀", () => {
  test("停泊後靜置滿 250ms → 自動回 active", () => {
    const h = parkedInNative(makeSession());
    expect(h.s.state).toBe("functionMode");
    vi.advanceTimersByTime(300);
    expect(h.s.state).toBe("active");
    expect(h.s._renderMode).toBe("buffer");
    expect(h.s._holdReason).toBe(null);
  });

  test("靜置期間使用者又送了 byte → 重新計時，不得搶畫面", () => {
    const h = parkedInNative(makeSession());
    vi.advanceTimersByTime(200);
    h.s.noteNativeInput(); // 使用者在原生 prompt 上打字
    vi.advanceTimersByTime(200);
    expect(h.s.state).toBe("functionMode"); // 還沒滿 250ms
    vi.advanceTimersByTime(100);
    expect(h.s.state).toBe("active");
  });

  test("畫面不是 clean-list（子畫面／編輯器）→ 不回復", () => {
    const h = parkedInNative(makeSession());
    h.screen.rows = new Array(24).fill("說明畫面"); // 不是列表
    vi.advanceTimersByTime(1000);
    expect(h.s.state).toBe("functionMode");
  });

  test("PTT 在等輸入（游標停在提示字後面，curX 大）→ 不回復（洞 1／不變量 N9）", () => {
    // b_mark_read_unread 的 getdata prompt 畫在 row 22，游標停在提示字後面。
    // classifyListScreen 的 curX<=1 是唯一擋這件事的判準。
    const h = parkedInNative(makeSession());
    h.screen.curY = 22;
    h.screen.curX = 50;
    vi.advanceTimersByTime(1000);
    expect(h.s.state).toBe("functionMode");
  });

  test("命令還在線上 → 不回復（洞 2）；命令收掉之後才回", () => {
    const h = parkedInNative(makeSession());
    h.queue.inFlightKind = "native-key";
    vi.advanceTimersByTime(1000);
    expect(h.s.state).toBe("functionMode");
    h.queue.inFlightKind = null;
    vi.advanceTimersByTime(1000);
    expect(h.s.state).toBe("active");
  });

  test("holdReason='external' → 一次探針都不排（不變量 N1：不得截斷別人的序列）", () => {
    const h = makeSession();
    h.s.state = "active";
    h.s.beginExternalNavigation();
    expect(h.s._holdReason).toBe("external");
    expect(h.s._resumeProbe).toBe(null);
    vi.advanceTimersByTime(5000);
    expect(h.s.state).toBe("functionMode");
  });

  test("探針只讀不寫（不變量 N2）：不送 byte、不排命令", () => {
    const h = parkedInNative(makeSession());
    h.enqueued.length = 0;
    h.screen.rows = new Array(24).fill(""); // 判不出來的畫面
    vi.advanceTimersByTime(2000);
    expect(h.enqueued).toEqual([]);
  });

  test("回復當下要給提示（永不靜默換畫面，不變量 N7）", () => {
    const h = parkedInNative(makeSession());
    h.banners.length = 0;
    vi.advanceTimersByTime(300);
    expect(h.s.state).toBe("active");
    expect(h.banners.some((m) => m.includes("好讀"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// L1：A 類鍵的凍結交易
// ---------------------------------------------------------------------------

describe("A 類鍵（凍結交易）：全程不切原生", () => {
  function activeSession() {
    const h = makeSession();
    h.s.state = "active";
    h.s._renderMode = "buffer";
    h.s._boardName = "C_Chat";
    h.s._termBuf.listLineNums = [41, 42, 43];
    h.s._selectedNum = 42;
    return h;
  }

  test("按 ] → frozen（不是 native）＋ sync 腿 ＋ 保住 _boardName（不丟 cache）", () => {
    const h = activeSession();
    const e = keyEvent("]");
    h.s.onKeyDown(e);
    expect(e.defaultPrevented).toBe(true);
    expect(h.s.state).toBe("functionMode");
    expect(h.s._renderMode).toBe("frozen"); // **不得**是 'native'
    expect(h.s._boardName).toBe("C_Chat"); // 不變量 15 只對 B 類成立
    expect(h.s._holdReason).toBe(null); // 不是原生小旅行，沒有 hold
    expect(h.enqueued[0].kind).toBe("inplace-sync-jump");
  });

  test("落地採用真落點、回 buffer，而且**不動捲動錨**（不變量 N6）", () => {
    const h = activeSession();
    h.s._serverNum = 42; // 已同步 ⇒ 直送鍵
    h.s.onKeyDown(keyEvent("]"));
    const cmd = h.enqueued[0];
    expect(cmd.kind).toBe("native-inplace");
    expect(cmd.keys).toBe("]");
    expect(cmd.fullRepaint).toBe(true); // 保證必有一幀可判定
    const topBefore = h.s._topNum;
    h.scrollWrites.length = 0;
    // park 指紋落地（陷阱 T1：跳號腿之後底列是空的 ⇒ 不能要求 clean-list）
    const landed = {
      kind: "transient",
      rows: 24,
      curX: 0,
      curY: 7,
      cursorRowNum: 43,
      rowTexts: new Array(24).fill(""),
      nums: new Array(24).fill(null),
    };
    expect(cmd.expect(null, landed)).toBe(true);
    cmd.onDone();
    expect(h.s.state).toBe("active");
    expect(h.s._renderMode).toBe("buffer");
    expect(h.s._selectedNum).toBe(43);
    expect(h.s._serverNum).toBe(43);
    expect(h.s._topNum).toBe(topBefore); // 錨不動
    expect(h.scrollWrites).toEqual([]); // 沒有任何捲動位置被寫掉
  });

  test("expect 不可寫成 kind==='clean-list'（陷阱 T1）；游標不在 entry 區才算 miss", () => {
    const h = activeSession();
    h.s._serverNum = 42;
    h.s.onKeyDown(keyEvent("["));
    const cmd = h.enqueued[0];
    // 底列 prompt（游標在最後一列）＝還沒落地
    expect(
      cmd.expect(null, { kind: "prompt", rows: 24, curX: 0, curY: 23, cursorRowNum: null })
    ).toBe(false);
    // 落在置底列（cursorRowNum 為 null）但畫面是 clean-list ＝合法落點
    expect(
      cmd.expect(null, {
        kind: "clean-list",
        rows: 24,
        curX: 0,
        curY: 10,
        cursorRowNum: null,
      })
    ).toBe(true);
  });

  test("落點不在緩衝（跳到很遠的舊文）→ 退回 resume+rebuild（畫面本來就要換一份）", () => {
    const h = activeSession();
    h.s._serverNum = 42;
    let resets = 0;
    h.s._view.resetListAccumulation = () => resets++;
    h.s.onKeyDown(keyEvent("["));
    const cmd = h.enqueued[0];
    cmd.expect(null, {
      kind: "clean-list",
      rows: 24,
      curX: 0,
      curY: 5,
      cursorRowNum: 999,
      rowTexts: new Array(24).fill(""),
      nums: new Array(24).fill(null),
    });
    cmd.onDone();
    expect(h.s.state).toBe("active");
    expect(resets).toBeGreaterThanOrEqual(1);
  });

  test("逾時 → 顯性降級原生＋banner（不變量 N8，不得靜默停在凍結畫面）", () => {
    const h = activeSession();
    h.s._serverNum = 42;
    h.s.onKeyDown(keyEvent("="));
    h.banners.length = 0;
    h.enqueued[0].onFail("timeout");
    expect(h.s._renderMode).toBe("native");
    expect(h.s._holdReason).toBe("passthrough");
    expect(h.banners.some((m) => m.includes("逾時"))).toBe(true);
  });

  test("N8：expect 永不滿足時，凍結看門狗最終把畫面掉回原生＋banner", () => {
    const h = activeSession();
    h.s._serverNum = 42;
    h.s.onKeyDown(keyEvent("t"));
    expect(h.s._renderMode).toBe("frozen");
    h.banners.length = 0;
    vi.advanceTimersByTime(2600); // FROZEN_WATCHDOG_MS = 2500
    expect(h.s._renderMode).toBe("native");
    expect(h.banners.some((m) => m.includes("逾時"))).toBe(true);
    // 而且降級之後掛的是可自動解除的 hold ⇒ 畫面靜下來還會自己回好讀，
    // 「畫面永久凍住 / 鍵永久失效」在結構上不存在。
    expect(h.s._holdReason).toBe("passthrough");
    vi.advanceTimersByTime(400);
    expect(h.s.state).toBe("active");
  });

  test("Ctrl 組合（含 Ctrl-C ClearTagList）永遠是 B 類，不得混進 A 類", () => {
    // Ctrl-C 是 FULLUPDATE 但**只重畫當前那一頁** ⇒ 緩衝裡其他頁的 tag 標記會
    // 殘留，所以刻意不進 INPLACE_KEYS。結構上由 _classifyKey 的 e.ctrlKey 分支
    // 先攔下（在 A 類判斷之前），這裡守護那個順序不被調換。
    const h = activeSession();
    for (const k of ["c", "t", "p"])
      expect(h.s._classifyKey(keyEvent(k, { ctrlKey: true })).class).toBe(
        "passthrough"
      );
  });
});

// ---------------------------------------------------------------------------
// 逃生門：pref 關掉 ＝ 逐位元回到 2026-09-03 之前
// ---------------------------------------------------------------------------

describe("pref enableListNativeAutoResume 關掉", () => {
  beforeEach(() => {
    setPrefs({ enableEasyReadingList: true, enableListNativeAutoResume: false });
  });

  test("A 類鍵整組落回 passthrough（切原生＋代送，丟 cache）", () => {
    const h = makeSession();
    h.s.state = "active";
    h.s._renderMode = "buffer";
    h.s._boardName = "C_Chat";
    h.s._selectedNum = 42;
    h.s._serverNum = 42;
    h.s.onKeyDown(keyEvent("]"));
    expect(h.enqueued[0].kind).toBe("native-key"); // 不是 native-inplace
    expect(h.s._renderMode).toBe("native");
    expect(h.s._boardName).toBe(null); // 不變量 15：原生小旅行拋 cache
  });

  test("回復探針一次都沒排（不是「排了再在觸發時檢查」）", () => {
    const spy = vi.spyOn(globalThis, "setTimeout");
    const h = parkedInNative(makeSession());
    const armed = spy.mock.calls.length;
    vi.advanceTimersByTime(5000);
    expect(h.s._resumeProbe).toBe(null);
    expect(h.s.state).toBe("functionMode"); // 停在原生，同 2026-09-03 之前
    expect(spy.mock.calls.length).toBe(armed); // 之後也沒有再排
    spy.mockRestore();
  });

  test("切原生的提示維持舊措辭（留著新措辭比沒提示更糟）", () => {
    const h = makeSession();
    h.s.state = "active";
    h.s._renderMode = "buffer";
    h.s._selectedNum = null;
    h.s.onKeyDown(keyEvent("z"));
    expect(h.banners.some((m) => m.includes("開啟文章或離開看板後恢復好讀"))).toBe(
      true
    );
  });
});

describe("pref 開著時的提示措辭", () => {
  test("切原生時明說「操作完成後自動恢復」", () => {
    const h = makeSession();
    h.s.state = "active";
    h.s._renderMode = "buffer";
    h.s._selectedNum = null;
    h.s.onKeyDown(keyEvent("z"));
    expect(h.banners.some((m) => m.includes("操作完成後自動恢復"))).toBe(true);
  });
});
