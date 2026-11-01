// 好讀文章底部常駐推文列（src/js/comment_bar.js、docs/long-push.md「底部常駐推文列」）：
//   - 探路回來之後直接送，還是退回長推文輸入框（quickPushPlan）；
//   - 什麼時候出現（只在好讀文章、長推文與本功能都開著、不在安全模式）、畫在哪。
const prefOverride = vi.hoisted(() => ({}));
vi.mock("../../src/js/pref_storage", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, readEffectivePrefs: () => ({ ...real.readEffectivePrefs(), ...prefOverride }) };
});
import { DEFAULT_PREFS, NATIVE_SAFE_MODE_KEYS, effectivePrefs } from "../../src/js/pref_storage";
import {
  CommentBar,
  commentBarEnabled,
  commentBarFolded,
  commentBarGeometry,
  commentBarCounter,
  commentBarMaxBytes,
  quickPushPlan,
  QUICK_PUSH_MAX_SEGMENTS,
} from "../../src/js/comment_bar";
import { pushMaxBytes } from "../../src/js/long_push";
import { loadBig5Tables } from "./helpers/load_big5_tables";

beforeAll(() => loadBig5Tables());

const MAX = pushMaxBytes({ userId: "testuser" });
const OK = { blocked: false, maxBytes: MAX, booAllowed: true, degraded: false };

describe("quickPushPlan：探路回來直接送，或退回輸入框讓使用者看一眼", () => {
  test("一般推文 ⇒ 直接送，內容原樣", () => {
    expect(quickPushPlan(OK, { text: "推推", type: "push" }, MAX)).toEqual({ direct: true, reason: "ok", text: "推推" });
    expect(quickPushPlan(OK, { text: "補充", type: "arrow" }, MAX).direct).toBe(true);
    expect(quickPushPlan(OK, { text: "不推", type: "boo" }, MAX).direct).toBe(true);
  });
  // PTT 自己就會改成 →（bbs.c：作者本人／90 秒內連推，原生也不多問）⇒ 照送。
  // 回歸：連推第二則時跳出長推文輸入框，要再按一次送出。
  test("PTT 會把這次改成 →（作者本人／90 秒內）⇒ 照樣直接送，不退回", () => {
    for (const type of ["push", "boo", "arrow"])
      expect(quickPushPlan({ ...OK, degraded: true }, { text: "推推", type }, MAX)).toEqual({
        direct: true,
        reason: "ok",
        text: "推推",
      });
    // 小天使匿名板也是型別選單被跳過的那一支（degraded＋angel）。
    expect(quickPushPlan({ ...OK, degraded: true, angel: true }, { text: "推推", type: "push" }, MAX).direct).toBe(true);
  });
  test("禁噓板選了噓 ⇒ 退回（送 2 會被當成預設的推）；選推照送", () => {
    const noBoo = { ...OK, booAllowed: false };
    expect(quickPushPlan(noBoo, { text: "不推", type: "boo" }, MAX).reason).toBe("noBoo");
    expect(quickPushPlan(noBoo, { text: "推推", type: "push" }, MAX).direct).toBe(true);
  });
  test("有 Big5 收不下的字會被濾掉 ⇒ 退回（輸入框那裡會標出來）", () => {
    expect(quickPushPlan(OK, { text: "推 😀", type: "push" }, MAX).reason).toBe("dropped");
  });
  test(`超過 ${QUICK_PUSH_MAX_SEGMENTS} 則 ⇒ 退回（輸入框有二次確認）；剛好 ${QUICK_PUSH_MAX_SEGMENTS} 則照送`, () => {
    const per = Math.floor(MAX / 2); // 全形字一個 2 bytes
    const at = "測".repeat(per * QUICK_PUSH_MAX_SEGMENTS);
    expect(quickPushPlan(OK, { text: at, type: "push" }, MAX).direct).toBe(true);
    expect(quickPushPlan(OK, { text: at + "測".repeat(per), type: "push" }, MAX).reason).toBe("tooMany");
  });
  test("只有空白 ⇒ 不送", () => {
    expect(quickPushPlan(OK, { text: "   ", type: "push" }, MAX).direct).toBe(false);
  });
});

describe("commentBarEnabled", () => {
  test("預設開，而且從屬於長推文總開關", () => {
    expect(DEFAULT_PREFS.enableCommentBar).toBe(true);
    expect(commentBarEnabled(DEFAULT_PREFS)).toBe(true);
    expect(commentBarEnabled({ ...DEFAULT_PREFS, enableLongPush: false })).toBe(false);
    expect(commentBarEnabled({ ...DEFAULT_PREFS, enableCommentBar: false })).toBe(false);
  });
  test("會替使用者送鍵 ⇒ 在安全模式名單內，安全模式開著就不出現", () => {
    expect(NATIVE_SAFE_MODE_KEYS).toContain("enableCommentBar");
    expect(commentBarEnabled(effectivePrefs({ ...DEFAULT_PREFS, nativeSafeMode: true }))).toBe(false);
  });
});

describe("commentBarGeometry", () => {
  test("同終端機寬、貼在好讀 footer 之上；bottom 是距視窗底", () => {
    const mainRect = { left: 100.4, width: 800, bottom: 960 };
    expect(commentBarGeometry({ mainRect, footerTop: 940, innerHeight: 1000 })).toEqual({ left: 100, width: 800, bottom: 60 });
    // 手機換行版面 footer 收起：貼在終端機底（＝底部導覽上緣）
    expect(commentBarGeometry({ mainRect, innerHeight: 1000 }).bottom).toBe(40);
  });
  // footer 疊在格線最後一列、不在 .main 最下緣（.main 比格線高 10px）：1280×720 時 .main
  // 下緣在 730、footer 在 690～720。舊算法（.main 下緣扣 footer 高）把列放在 700，壓住狀態列 10px。
  test("footer 不貼 .main 最下緣 ⇒ 照 footer 上緣排，不壓到狀態列", () => {
    const mainRect = { left: 35, width: 1210, bottom: 730 };
    expect(commentBarGeometry({ mainRect, footerTop: 690, innerHeight: 720 }).bottom).toBe(30);
  });
  // e2e mobile_bottom_overlay 抓到的：手機的 .main 因列高取整比可用高度高 5px，延伸到底部
  // 導覽列後面 ⇒ 只看 .main 下緣，推文列就壓在導覽列上 5px（按鈕下緣被切掉）。
  test("終端機延伸到底部浮層（導覽列／軟鍵盤）後面 ⇒ 推文列仍在浮層上面", () => {
    const mainRect = { left: 0, width: 412, bottom: 347 };
    expect(commentBarGeometry({ mainRect, innerHeight: 390, bottomInset: 48 }).bottom).toBe(48);
    // 浮層比終端機下緣低 ⇒ 照舊貼終端機。
    expect(commentBarGeometry({ mainRect, innerHeight: 390, bottomInset: 10 }).bottom).toBe(43);
  });
  test("量不到終端機 ⇒ null", () => {
    expect(commentBarGeometry({ mainRect: null, innerHeight: 1000 })).toBeNull();
    expect(commentBarGeometry({ mainRect: { left: 0, width: 0, bottom: 0 }, innerHeight: 1000 })).toBeNull();
  });
});

describe("commentBarCounter：推文列打字時的「剩 N 字／會分成 N 則」", () => {
  test("空的（含只有空白）⇒ 不顯示", () => {
    expect(commentBarCounter("", MAX)).toBeNull();
    expect(commentBarCounter("   ", MAX)).toBeNull();
  });
  test("一則放得下 ⇒ 還能打幾個全形字（半形算半個，捨去）", () => {
    // MAX = 37 byte（IP 板、帳號 8 字）
    expect(MAX).toBe(37);
    expect(commentBarCounter("推推", MAX)).toEqual({ segments: 1, remaining: 16 });
    expect(commentBarCounter("abc", MAX)).toEqual({ segments: 1, remaining: 17 });
    expect(commentBarCounter("a".repeat(37), MAX)).toEqual({ segments: 1, remaining: 0 });
  });
  test("放不下 ⇒ 會分成幾則，則數與長推文送出時的分段同一支", () => {
    expect(commentBarCounter("a".repeat(38), MAX)).toEqual({ segments: 2, remaining: 0 });
    expect(commentBarCounter("好".repeat(40), MAX).segments).toBe(3);
  });
  test("PTT 畫不出來的字（emoji）不算：送出前本來就會被濾掉", () => {
    expect(commentBarCounter("😀", MAX)).toBeNull();
    expect(commentBarCounter("推😀", MAX)).toEqual({ segments: 1, remaining: 17 });
  });
});

describe("commentBarMaxBytes：從這篇的推文列認 IP 欄／對齊推文", () => {
  const ip = "推 someone: 好文 1.2.3.4 10/23 12:34";
  const noIp = "推 someone: 好文 10/23 12:34";
  const aligned = "推 someone     : 好文 10/23 12:34";
  test("沒有推文 ⇒ 同長推文輸入框的保守預估（當 IP 板）", () => {
    expect(commentBarMaxBytes([], "testuser")).toBe(pushMaxBytes({ userId: "testuser" }));
  });
  test("非 IP 板 ⇒ 多 15 byte（不會把一則顯示成兩則）", () => {
    expect(commentBarMaxBytes([noIp], "testuser")).toBe(52);
    expect(commentBarMaxBytes([noIp, ip], "testuser")).toBe(37);
  });
  test("對齊推文板 ⇒ 帳號一律扣 12", () => {
    expect(commentBarMaxBytes([aligned], "testuser")).toBe(48);
  });
});

function makeCore(opts = {}) {
  const listeners = {};
  let pageState = opts.pageState == null ? 3 : opts.pageState;
  let lines = opts.lines || [[], []];
  const sheets = [];
  const core = {
    mobile: !!opts.mobile,
    // 同 App.registerSheetDismiss／dismissTopSheet（系統返回先收最上面的 sheet）。
    registerSheetDismiss: (fn) => {
      sheets.push(fn);
      return () => {
        const i = sheets.lastIndexOf(fn);
        if (i >= 0) sheets.splice(i, 1);
      };
    },
    buf: {
      get pageState() {
        return pageState;
      },
      get pageLines() {
        return lines;
      },
      cols: 80,
      getRowText: (r, s, e, acc) => String((acc || lines)[r]),
      addEventListener: (name, fn) => (listeners[name] = fn),
    },
    easyReading: { _enabled: opts.easy !== false, _functionMode: !!opts.functionMode },
    view: {
      _selfId: opts.selfId || null,
      mainDisplay: { getBoundingClientRect: () => ({ left: 10, width: 640, bottom: 480 }) },
      lastRowDiv: { getBoundingClientRect: () => ({ top: 460, height: 20 }) },
    },
  };
  const bar = new CommentBar(core);
  return {
    bar,
    core,
    settle: () => listeners.screenSettled(),
    setPageState: (s) => (pageState = s),
    setFunctionMode: (v) => (core.easyReading._functionMode = v),
    sheets,
    back: () => (sheets.length ? (sheets[sheets.length - 1](), true) : false),
  };
}

let store;
beforeEach(() => {
  store = new Map();
  vi.stubGlobal("window", {
    innerHeight: 600,
    addEventListener: () => {},
    getComputedStyle: () => ({ display: "block" }),
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CommentBar：何時出現、畫在哪", () => {
  test("好讀文章 ⇒ 出現，同終端機寬、貼在 footer 上面", () => {
    const { bar, settle } = makeCore();
    settle();
    expect(bar.state).toEqual({
      visible: true,
      available: true,
      folded: false,
      expanded: false,
      left: 10,
      width: 640,
      bottom: 140,
      mobile: false,
      counter: true,
      prefill: null,
      focusN: 0,
    });
  });
  test("手機收合關掉 ⇒ 手機也常駐（底部導覽上方）", () => {
    prefOverride.mobileCommentBarFold = false;
    try {
      const { bar, settle } = makeCore({ mobile: true });
      settle();
      expect(bar.state).toMatchObject({ visible: true, mobile: true, folded: false });
    } finally {
      delete prefOverride.mobileCommentBarFold;
    }
  });
  test.each([
    ["原生 pmore（好讀關）＝認不出 ⇒ 原生", { easy: false }],
    ["好讀的功能鍵模式／長推文送出中的原生鏡像", { functionMode: true }],
    ["文章列表", { pageState: 2 }],
    ["累積頁是空的", { lines: [] }],
  ])("%s ⇒ 不出現", (_l, opts) => {
    const { bar, settle } = makeCore(opts);
    settle();
    expect(bar.state.visible).toBe(false);
  });
  test("送出時切進原生鏡像 ⇒ 收起；回到好讀 ⇒ 再出現", () => {
    const t = makeCore();
    t.settle();
    t.setFunctionMode(true);
    t.settle();
    expect(t.bar.state.visible).toBe(false);
    t.setFunctionMode(false);
    t.settle();
    expect(t.bar.state.visible).toBe(true);
  });
  test.each([
    ["本功能關", { enableCommentBar: false }],
    ["長推文總開關關", { enableLongPush: false }],
  ])("%s ⇒ 下一次 settle 收起", (_l, override) => {
    const t = makeCore();
    t.settle();
    Object.assign(prefOverride, override);
    try {
      t.settle();
      expect(t.bar.state.visible).toBe(false);
    } finally {
      for (const k of Object.keys(override)) delete prefOverride[k];
    }
  });
  test("預填（回覆這則）：列出現時才收，每次請求序號遞增；列沒出現 ⇒ 不收、回 false", () => {
    const t = makeCore({ pageState: 2 });
    t.settle();
    expect(t.bar.prefill({ type: "arrow", text: "abc " })).toBe(false);
    expect(t.bar.state.prefill).toBe(null);
    t.setPageState(3);
    t.settle();
    expect(t.bar.prefill({ type: "arrow", text: "abc " })).toBe(true);
    expect(t.bar.state.prefill).toEqual({ type: "arrow", text: "abc ", n: 1 });
    // 同一個人再按一次也要重新填（使用者可能改過字）⇒ 序號不同。
    t.bar.prefill({ type: "arrow", text: "abc " });
    expect(t.bar.state.prefill.n).toBe(2);
  });

  test("onChange 先給一次現況，之後只在變了才通知", () => {
    const t = makeCore();
    const seen = [];
    t.bar.onChange((s) => seen.push(s.visible));
    t.settle();
    t.settle();
    expect(seen).toEqual([false, true]);
  });
});

describe("推文列計數（pref commentBarCounter）", () => {
  test("預設開、不送鍵 ⇒ 不在安全模式名單；關掉 ⇒ state.counter 為 false", () => {
    expect(DEFAULT_PREFS.commentBarCounter).toBe(true);
    expect(NATIVE_SAFE_MODE_KEYS).not.toContain("commentBarCounter");
    const { bar, settle } = makeCore();
    settle();
    expect(bar.state.counter).toBe(true);
    prefOverride.commentBarCounter = false;
    try {
      settle();
      expect(bar.state.counter).toBe(false);
    } finally {
      delete prefOverride.commentBarCounter;
    }
  });
  test("maxBytes 用自己的帳號＋這篇推文列認出的 IP 欄；累積頁長了才重掃", () => {
    const lines = ["標題", "內文", "推 someone: 好文 10/23 12:34"];
    const { bar, core } = makeCore({ lines, selfId: "testuser" });
    expect(bar.maxBytes()).toBe(52);
    lines.push("推 other: 嗯 1.2.3.4 10/23 12:35");
    expect(bar.maxBytes()).toBe(37);
    core.view._selfId = "ab";
    expect(bar.maxBytes()).toBe(43);
  });
});

describe("手機收合：推文列收進底部導覽（pref mobileCommentBarFold）", () => {
  test("預設開；只在手機收合，桌機不受影響", () => {
    expect(DEFAULT_PREFS.mobileCommentBarFold).toBe(true);
    expect(commentBarFolded({ mobileCommentBarFold: true }, true)).toBe(true);
    expect(commentBarFolded({ mobileCommentBarFold: true }, false)).toBe(false);
    expect(commentBarFolded({ mobileCommentBarFold: false }, true)).toBe(false);
    // 只決定列怎麼出現、不送鍵 ⇒ 不在安全模式名單。
    expect(NATIVE_SAFE_MODE_KEYS).not.toContain("mobileCommentBarFold");
  });
  test("手機好讀文章：平常收著（available 但不畫）；桌機照常駐", () => {
    const m = makeCore({ mobile: true });
    m.settle();
    expect(m.bar.state).toMatchObject({ visible: false, available: true, folded: true, expanded: false });
    const d = makeCore();
    d.settle();
    expect(d.bar.state).toMatchObject({ visible: true, folded: false });
  });
  test("expand ⇒ 展開並要求聚焦；之後的 settle 不會把它收回去", () => {
    const t = makeCore({ mobile: true });
    t.settle();
    expect(t.bar.expand()).toBe(true);
    expect(t.bar.state).toMatchObject({ visible: true, expanded: true, focusN: 1 });
    t.settle();
    expect(t.bar.state).toMatchObject({ visible: true, expanded: true });
  });
  test("collapse（送出／離開輸入框／收鍵盤）⇒ 收回", () => {
    const t = makeCore({ mobile: true });
    t.settle();
    t.bar.expand();
    t.bar.collapse();
    expect(t.bar.state).toMatchObject({ visible: false, expanded: false, available: true });
    expect(t.sheets).toHaveLength(0);
  });
  test("系統返回 ⇒ 先收推文列（不送 ←）；收起後返回就不再被它吃掉", () => {
    const t = makeCore({ mobile: true });
    t.settle();
    t.bar.expand();
    expect(t.back()).toBe(true);
    expect(t.bar.state).toMatchObject({ visible: false, expanded: false });
    expect(t.back()).toBe(false);
  });
  test("離開文章（列表）⇒ 收回、返回登記解除；回到文章時仍是收著", () => {
    const t = makeCore({ mobile: true });
    t.settle();
    t.bar.expand();
    t.setPageState(2);
    t.settle();
    expect(t.bar.state).toMatchObject({ visible: false, available: false, expanded: false });
    expect(t.sheets).toHaveLength(0);
    t.setPageState(3);
    t.settle();
    expect(t.bar.state).toMatchObject({ visible: false, available: true, expanded: false });
  });
  test("不在好讀文章 ⇒ expand 回 false、不登記返回（導覽的推文照原生送 X）", () => {
    const t = makeCore({ mobile: true, pageState: 2 });
    t.settle();
    expect(t.bar.expand()).toBe(false);
    expect(t.bar.state.visible).toBe(false);
    expect(t.sheets).toHaveLength(0);
  });
  test("預填（回覆這則）在收合中 ⇒ 先展開再填", () => {
    const t = makeCore({ mobile: true });
    t.settle();
    expect(t.bar.prefill({ type: "arrow", text: "abc " })).toBe(true);
    expect(t.bar.state).toMatchObject({ visible: true, expanded: true, prefill: { type: "arrow", text: "abc ", n: 1 } });
  });
  test("展開中把收合關掉（設定改了）⇒ 常駐，返回登記解除", () => {
    const t = makeCore({ mobile: true });
    t.settle();
    t.bar.expand();
    prefOverride.mobileCommentBarFold = false;
    try {
      t.settle();
      expect(t.bar.state).toMatchObject({ visible: true, folded: false, expanded: false });
      expect(t.sheets).toHaveLength(0);
    } finally {
      delete prefOverride.mobileCommentBarFold;
    }
  });
});
