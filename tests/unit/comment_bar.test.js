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
  commentBarGeometry,
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
  test("PTT 會把這次改成 →（作者本人／90 秒內）⇒ 退回", () => {
    expect(quickPushPlan({ ...OK, degraded: true }, { text: "推推", type: "push" }, MAX).reason).toBe("degraded");
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
    expect(commentBarGeometry({ mainRect, footerHeight: 20, innerHeight: 1000 })).toEqual({ left: 100, width: 800, bottom: 60 });
    // 手機換行版面 footer 收起：貼在終端機底（＝底部導覽上緣）
    expect(commentBarGeometry({ mainRect, footerHeight: 0, innerHeight: 1000 }).bottom).toBe(40);
  });
  // e2e mobile_bottom_overlay 抓到的：手機的 .main 因列高取整比可用高度高 5px，延伸到底部
  // 導覽列後面 ⇒ 只看 .main 下緣，推文列就壓在導覽列上 5px（按鈕下緣被切掉）。
  test("終端機延伸到底部浮層（導覽列／軟鍵盤）後面 ⇒ 推文列仍在浮層上面", () => {
    const mainRect = { left: 0, width: 412, bottom: 347 };
    expect(commentBarGeometry({ mainRect, footerHeight: 0, innerHeight: 390, bottomInset: 48 }).bottom).toBe(48);
    // 浮層比終端機下緣低 ⇒ 照舊貼終端機。
    expect(commentBarGeometry({ mainRect, footerHeight: 0, innerHeight: 390, bottomInset: 10 }).bottom).toBe(43);
  });
  test("量不到終端機 ⇒ null", () => {
    expect(commentBarGeometry({ mainRect: null, innerHeight: 1000 })).toBeNull();
    expect(commentBarGeometry({ mainRect: { left: 0, width: 0, bottom: 0 }, innerHeight: 1000 })).toBeNull();
  });
});

function makeCore(opts = {}) {
  const listeners = {};
  let pageState = opts.pageState == null ? 3 : opts.pageState;
  let lines = opts.lines || [[], []];
  const core = {
    mobile: !!opts.mobile,
    buf: {
      get pageState() {
        return pageState;
      },
      get pageLines() {
        return lines;
      },
      addEventListener: (name, fn) => (listeners[name] = fn),
    },
    easyReading: { _enabled: opts.easy !== false, _functionMode: !!opts.functionMode },
    view: {
      mainDisplay: { getBoundingClientRect: () => ({ left: 10, width: 640, bottom: 480 }) },
      lastRowDiv: { getBoundingClientRect: () => ({ height: 20 }) },
    },
  };
  const bar = new CommentBar(core);
  return {
    bar,
    core,
    settle: () => listeners.screenSettled(),
    setPageState: (s) => (pageState = s),
    setFunctionMode: (v) => (core.easyReading._functionMode = v),
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
    expect(bar.state).toEqual({ visible: true, left: 10, width: 640, bottom: 140, mobile: false });
  });
  test("手機也出現（底部導覽上方）", () => {
    const { bar, settle } = makeCore({ mobile: true });
    settle();
    expect(bar.state).toMatchObject({ visible: true, mobile: true });
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
  test("onChange 先給一次現況，之後只在變了才通知", () => {
    const t = makeCore();
    const seen = [];
    t.bar.onChange((s) => seen.push(s.visible));
    t.settle();
    t.settle();
    expect(seen).toEqual([false, true]);
  });
});
