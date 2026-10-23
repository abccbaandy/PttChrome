// 搜尋狀態列（src/js/search_status.js、docs/article-search.md「搜尋狀態列」）：
//   - 畫面認法：只有搜尋結果（MODE_SELECT）才算，文摘／完整列表／認不出 ⇒ 不顯示；
//   - 條件記憶：只有彈窗送出且 PTT 收下的才記；看到完整列表就忘；原生 prompt 下的條件 ⇒ 只說「搜尋結果」；
//   - ✕／＋條件 只替使用者按 ← 與 /（走鍵盤同一條分派）。
const prefOverride = vi.hoisted(() => ({}));
vi.mock("../../src/js/pref_storage", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, readEffectivePrefs: () => ({ ...real.readEffectivePrefs(), ...prefOverride }) };
});
import { DEFAULT_PREFS, NATIVE_SAFE_MODE_KEYS } from "../../src/js/pref_storage";
import {
  SearchStatus,
  searchListMode,
  nextSearchMemory,
  rememberSubmitted,
} from "../../src/js/search_status";

const ROWS = 24;
function screen({ title = "【板主:test】                看板《Test》", footer = " 文章列表  (y)回應(X)推文", bottom } = {}) {
  const t = new Array(ROWS).fill("");
  t[0] = title;
  t[1] = "[←]離開 [→]閱讀 [^P]發表文章";
  t[2] = "  編號    日 期 作  者       文  章  標  題";
  t[3] = "     1 + 9/01 someone      □ [閒聊] 測試";
  t[ROWS - 1] = bottom != null ? bottom : footer;
  return t;
}
const SELECT = { title: "【板主:test】                系列《Test》", footer: " 系列文章  (y)回應(X)推文" };
const DIGEST = { title: "【板主:test】                文摘《Test》", footer: " 文摘列表  (y)回應(X)推文" };

describe("searchListMode：只認得出來的才算", () => {
  test("新版 caption：系列文章＝搜尋結果、文摘列表＝文摘、文章列表＝完整列表", () => {
    expect(searchListMode(screen(SELECT))).toBe("select");
    expect(searchListMode(screen(DIGEST))).toBe("digest");
    expect(searchListMode(screen())).toBe("plain");
  });
  test("舊版 caption「文章選讀」：靠標題列右段；右段被省略 ⇒ 判不出來", () => {
    expect(searchListMode(screen({ title: SELECT.title, footer: " 文章選讀  (y)回應" }))).toBe("select");
    expect(searchListMode(screen({ footer: " 文章選讀  (y)回應" }))).toBe("plain");
    expect(searchListMode(screen({ title: "【板主:test】", footer: " 文章選讀  (y)回應" }))).toBeNull();
  });
  test("不是文章列表（信箱、看板列表、底列是 prompt）⇒ null", () => {
    expect(searchListMode(screen({ footer: " 信件列表  (y)回信" }))).toBeNull();
    expect(searchListMode(screen({ footer: " 看板列表  (c)新文章" }))).toBeNull();
    expect(searchListMode(screen({ bottom: "搜尋標題: Re" }))).toBeNull();
    expect(searchListMode(screen({ ...SELECT, title: "【主功能表】" }))).toBeNull();
  });
});

describe("條件記憶", () => {
  test("從完整列表搜 ⇒ 新的一串；從搜尋結果搜 ⇒ 增加條件", () => {
    let m = rememberSubmitted(null, "plain", "title", "Re");
    expect(m).toEqual({ known: true, conds: [{ kind: "title", text: "Re" }], fresh: true });
    m = rememberSubmitted(m, "select", "author", "abc");
    expect(m.conds).toEqual([
      { kind: "title", text: "Re" },
      { kind: "author", text: "abc" },
    ]);
  });
  test("在不是彈窗進去的搜尋結果裡加條件 ⇒ 條件不完整（known=false）", () => {
    expect(rememberSubmitted(null, "select", "title", "Re").known).toBe(false);
    const unknown = { known: false, conds: [] };
    expect(rememberSubmitted(unknown, "select", "title", "Re")).toBe(unknown);
  });
  test("看板搜尋（s）不是篩選，不記", () => {
    expect(rememberSubmitted(null, "plain", "board", "Test")).toBeNull();
  });
  test("看到完整列表就忘；原生搜尋 prompt ⇒ 只知道在搜尋結果裡", () => {
    const m = { known: true, conds: [{ kind: "title", text: "Re" }] };
    expect(nextSearchMemory(m, { mode: "plain" })).toBeNull();
    expect(nextSearchMemory(m, { mode: "select" })).toBe(m);
    expect(nextSearchMemory(m, { mode: null })).toBe(m);
    expect(nextSearchMemory(m, { mode: null, nativePrompt: true })).toEqual({ known: false, conds: [] });
  });
  test("剛記下（fresh）：搜尋前那張完整列表還在畫面上不算離開；看過別的畫面之後才算", () => {
    const m = { known: true, conds: [{ kind: "title", text: "Re" }], fresh: true };
    expect(nextSearchMemory(m, { mode: "plain" })).toBe(m);
    const seen = nextSearchMemory(m, { mode: null }); // 沒結果時的 vmsg
    expect(seen).toEqual({ known: true, conds: m.conds });
    expect(nextSearchMemory(seen, { mode: "plain" })).toBeNull();
  });
});

function makeCore(rows) {
  const listeners = {};
  let t = rows;
  const sent = [];
  const core = {
    mobile: false,
    searchInFlight: false,
    buf: {
      rows: ROWS,
      cols: 80,
      pageState: 2,
      cur_x: 0,
      cur_y: 3,
      getRowText: (r) => t[r] || "",
      isCursorOnInputField: () => false,
      addEventListener: (name, fn) => (listeners[name] = fn),
    },
    view: {
      mainDisplay: { getBoundingClientRect: () => ({ left: 100, right: 900, top: 0, width: 800 }) },
      sendKeyAsUser: (k) => sent.push(k),
    },
  };
  const ctl = new SearchStatus(core);
  return {
    ctl,
    core,
    sent,
    show: (next, curY) => {
      t = next;
      if (curY != null) core.buf.cur_y = curY;
      listeners.screenSettled();
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("window", { innerWidth: 1000, addEventListener: () => {} });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SearchStatus 控制器", () => {
  test("預設開；只替使用者按鍵 ⇒ 不在安全模式名單", () => {
    expect(DEFAULT_PREFS.enableSearchStatus).toBe(true);
    expect(NATIVE_SAFE_MODE_KEYS).not.toContain("enableSearchStatus");
  });

  test("完整列表／文摘不出現；搜尋結果出現在終端機右上角", () => {
    const { ctl, show } = makeCore(screen());
    show(screen());
    expect(ctl.state.visible).toBe(false);
    show(screen(DIGEST));
    expect(ctl.state.visible).toBe(false);
    show(screen(SELECT));
    expect(ctl.state).toMatchObject({ visible: true, board: "Test", conds: null, right: 100, top: 0 });
  });

  test("彈窗送出、PTT 收下 ⇒ 顯示條件；加條件累加；回到完整列表就忘", () => {
    const { ctl, show } = makeCore(screen());
    show(screen());
    ctl.beginSearch("title", "Re")();
    show(screen(SELECT), 3);
    expect(ctl.state.conds).toEqual([{ kind: "title", text: "Re" }]);
    const more = ctl.beginSearch("author", "abc");
    more();
    show(screen(SELECT));
    expect(ctl.state.conds.map((c) => c.kind)).toEqual(["title", "author"]);
    show(screen());
    show(screen(SELECT));
    expect(ctl.state.conds).toBeNull();
  });

  test("彈窗送出的那一趟 prompt 不算原生搜尋（searchInFlight）", () => {
    const { ctl, core, show } = makeCore(screen());
    show(screen());
    const done = ctl.beginSearch("title", "Re");
    core.searchInFlight = true;
    show(screen({ bottom: "搜尋標題: " }), ROWS - 1);
    done();
    core.searchInFlight = false;
    show(screen(SELECT), 3);
    expect(ctl.state.conds).toEqual([{ kind: "title", text: "Re" }]);
  });

  test("有人在原生 prompt 加了條件 ⇒ 只顯示「搜尋結果」，不顯示不完整的條件", () => {
    const { ctl, show } = makeCore(screen());
    show(screen());
    ctl.beginSearch("title", "Re")();
    show(screen(SELECT));
    show(screen({ ...SELECT, bottom: "增加條件 作者: " }), ROWS - 1);
    show(screen(SELECT), 3);
    expect(ctl.state).toMatchObject({ visible: true, conds: null });
  });

  test("搜尋沒結果（PTT 退回完整列表）⇒ 不顯示、也不留條件", () => {
    const { ctl, show } = makeCore(screen());
    show(screen());
    ctl.beginSearch("title", "zzz")();
    show(screen({ bottom: " ◆ 沒有找到符合的文章 [按任意鍵繼續]" }), ROWS - 1);
    show(screen(), 3);
    expect(ctl.state.visible).toBe(false);
    show(screen(SELECT));
    expect(ctl.state.conds).toBeNull();
  });

  test("開關關掉 ⇒ 不出現；文章裡（pageState 3）不出現", () => {
    const { ctl, core, show } = makeCore(screen(SELECT));
    prefOverride.enableSearchStatus = false;
    try {
      show(screen(SELECT));
      expect(ctl.state.visible).toBe(false);
    } finally {
      delete prefOverride.enableSearchStatus;
    }
    core.buf.pageState = 3;
    show(screen(SELECT));
    expect(ctl.state.visible).toBe(false);
  });

  test("✕ ＝替使用者按 ←；＋條件＝替使用者按 /", () => {
    const { ctl, sent } = makeCore(screen(SELECT));
    ctl.leave();
    ctl.addCondition();
    expect(sent).toEqual(["ArrowLeft", "/"]);
  });
});
