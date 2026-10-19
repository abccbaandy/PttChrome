// 說明選單好讀（src/js/help_menu.js）。鎖的是：
//   - 指紋：row 0「操作說明 (Help)」＋ row 1 欄位列 ＋ 底列 caption「操作說明」；任一失配 ⇒
//     不是說明選單（認不出 ⇒ 原生）；項目列任一解析不了 ⇒ 整張不認；
//   - 好讀開著且起點是第 1 頁 ⇒ 開彈窗並自動 PgDn 補頁（一次一個在途），合併成一份清單；
//   - 點第 t 項 ⇒ Home → PgDn×⌊t/每頁⌋ → ↓×餘數 → Enter（與游標在哪無關）；
//   - 離開＝q、小天使＝h、原生畫面＝收彈窗（補過頁就 Home 回第 1 頁）；送出之後的說明幀不再彈；
//   - 好讀關著 ⇒ 一個鍵都不送。
// 實錄：使用者錄製檔 2026-10-18（我的最愛按 h，80×28，兩頁）——好讀模式沒接手。
import {
  parseHelpMenuScreen,
  parseHelpItemRow,
  splitHelpKeys,
  helpSelectKeys,
  mergeHelpPages,
  HelpMenuController,
  helpMenuPopupEnabled,
  KEY_HOME,
  KEY_PGDN,
  KEY_DOWN,
  FETCH_TIMEOUT_MS,
} from "../../src/js/help_menu";
import { boardEntryArms } from "../../src/js/board_note_skip";
import { DEFAULT_PREFS, effectivePrefs } from "../../src/js/pref_storage";
import { HELP_FAV_PAGE1, HELP_FAV_PAGE2 } from "./fixtures/help_menu_rows";

const BOARD_LIST = [
  "【看板列表】                     批踢踢實業坊                    看板《EZsoft》",
  "[y]列出全部 [→]進入 [s]找看板 [/]搜尋 [c]新文章 [S]排序 [PgUp]上頁 [PgDn]下頁",
  "   編號   看  板       類別   中   文   敘   述                 … 板   主",
  ">     1   Android      系統 ◎[Android] 請盡量加上文章[分類]     3 albb0920",
  ...Array.from({ length: 23 }, () => ""),
  " 我的最愛  (a)增加看板 (d)刪除 (g)新增目錄 (M)移動位置 (v)已讀/未讀    (h)說明",
];

describe("parseHelpMenuScreen（實錄畫面）", () => {
  test("第 1 頁：caption、頁碼、小天使、25 項、游標在第一項", () => {
    const p = parseHelpMenuScreen(HELP_FAV_PAGE1);
    expect(p).not.toBeNull();
    expect(p.caption).toBe("我的最愛");
    expect(p.page).toBe(1);
    expect(p.totalPages).toBe(2);
    expect(p.angel).toBe(true);
    expect(p.items).toHaveLength(25);
    expect(p.cursorIndex).toBe(0);
    expect(p.items[0]).toEqual({ keysText: "h/H", keys: ["h", "H"], label: "說明", help: "顯示操作說明" });
    // 名稱裡有括號、說明裡有頓號
    expect(p.items.find((i) => i.keysText === "→/Enter/r/l")).toMatchObject({
      label: "進入",
      help: "進入選取的看板或目錄",
    });
    // 只有鍵沒有名稱
    expect(p.items.find((i) => i.keysText === "m/z")).toMatchObject({
      label: "",
      help: "將看板加入或移出最愛",
    });
  });

  test("第 2 頁：10 項，空白列之後是 footer", () => {
    const p = parseHelpMenuScreen(HELP_FAV_PAGE2);
    expect(p.page).toBe(2);
    expect(p.items).toHaveLength(10);
    expect(p.items.find((i) => i.keysText === "^Z")).toMatchObject({
      label: "隨處切換(ZA)",
      help: "快速切換到文章列表、分類、信箱、使用者名單等",
    });
  });

  test("看板列表不是說明選單", () => {
    expect(parseHelpMenuScreen(BOARD_LIST)).toBeNull();
  });

  // 突變矩陣：真實畫面 × 逐一破壞指紋要素 ⇒ 一律不認（認不出 ⇒ 原生）。
  const mutate = (rows, i, text) => rows.map((r, j) => (j === i ? text : r));
  const last = HELP_FAV_PAGE1.length - 1;
  test.each([
    ["row 0 少了「操作說明 (Help)」", mutate(HELP_FAV_PAGE1, 0, "【我的最愛】                    批踢踢實業坊")],
    ["row 1 欄位列不對", mutate(HELP_FAV_PAGE1, 1, "  按鍵                          說明")],
    ["底列不是說明 footer", mutate(HELP_FAV_PAGE1, last, " 我的最愛  (a)增加看板 (h)說明")],
    ["項目列不是 (鍵) 形狀", mutate(HELP_FAV_PAGE1, 5, "  這不是說明項")],
    ["空白列之後又有內容", mutate(HELP_FAV_PAGE2, 20, "  (x) 多出來的        說明")],
    ["頁碼超過總頁數", mutate(HELP_FAV_PAGE1, last, " 操作說明  [第 3/2 頁] (Enter)執行  (q/←)離開")],
  ])("%s", (_name, rows) => {
    expect(parseHelpMenuScreen(rows)).toBeNull();
  });

  test("單頁（沒有頁碼、沒有小天使）", () => {
    const rows = [
      "【文章閱讀】                    操作說明 (Help)",
      "  按鍵 / 標籤                   功能說明",
      "> (q/←) 離開                  回到列表",
      "  (/) 搜尋                      搜尋字串",
      "",
      " 操作說明 (↑)上移 (↓)下移 (Enter)執行                                (q/←)離開",
    ];
    const p = parseHelpMenuScreen(rows);
    expect(p).toMatchObject({ caption: "文章閱讀", page: 1, totalPages: 1, angel: false });
    expect(p.items.map((i) => i.keys)).toEqual([["q", "←"], ["/"]]);
  });
});

describe("小工具", () => {
  test("splitHelpKeys：`/` 鍵本身", () => {
    expect(splitHelpKeys("/")).toEqual(["/"]);
    expect(splitHelpKeys("a//")).toEqual(["a", "/"]);
    expect(splitHelpKeys("PgUp/P/b/^B")).toEqual(["PgUp", "P", "b", "^B"]);
  });

  test("parseHelpItemRow：游標記號", () => {
    expect(parseHelpItemRow("> (h/H) 說明                    顯示操作說明").cursor).toBe(true);
    expect(parseHelpItemRow("  (h/H) 說明                    顯示操作說明").cursor).toBe(false);
    expect(parseHelpItemRow("  沒有括號")).toBeNull();
  });

  test("helpSelectKeys：Home → PgDn → ↓ → Enter", () => {
    expect(helpSelectKeys(0, 0, 1)).toBe(KEY_HOME + "\r");
    expect(helpSelectKeys(3, 0, 1)).toBe(KEY_HOME + KEY_DOWN.repeat(3) + "\r");
    expect(helpSelectKeys(27, 25, 2)).toBe(KEY_HOME + KEY_PGDN + KEY_DOWN.repeat(2) + "\r");
    expect(helpSelectKeys(25, 25, 2)).toBe(KEY_HOME + KEY_PGDN + "\r");
  });

  test("mergeHelpPages：依頁序、以身分去重、缺頁就停", () => {
    const a = { keysText: "a", label: "A", keys: ["a"], help: "" };
    const b = { keysText: "b", label: "B", keys: ["b"], help: "" };
    const c = { keysText: "c", label: "C", keys: ["c"], help: "" };
    expect(mergeHelpPages(new Map([[1, [a, b]], [2, [b, c]]]), 2)).toEqual([a, b, c]);
    expect(mergeHelpPages(new Map([[2, [c]]]), 2)).toEqual([]);
  });
});

// 假 TermBuf：只需要 addEventListener（控制器在建構時掛 settle）；畫面由 noteScreen 直餵。
function makeController(opts = {}) {
  const sent = [];
  const timers = [];
  const core = { commandQueue: { inFlightKind: opts.busy ? "brd-native-key" : null } };
  const ctrl = new HelpMenuController(core, { addEventListener() {} }, {
    send: (b) => sent.push(b),
    enabled: () => opts.enabled !== false,
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout: (id) => {
      if (timers[id - 1]) timers[id - 1].fn = null;
    },
  });
  const changes = [];
  ctrl.onChange = (s) => changes.push(s);
  const fire = (ms) => {
    for (const t of timers.splice(0)) if (t.fn && (ms == null || t.ms === ms)) t.fn();
  };
  return { ctrl, core, sent, changes, fire };
}

describe("HelpMenuController", () => {
  test("錄製檔流程：第 1 頁 ⇒ 開彈窗＋送 PgDn；第 2 頁 ⇒ 合併 35 項、不再送", () => {
    const { ctrl, sent, changes } = makeController();
    ctrl.noteScreen(parseHelpMenuScreen(HELP_FAV_PAGE1));
    expect(ctrl.phase).toBe("open");
    expect(sent).toEqual([KEY_PGDN]);
    expect(changes.at(-1)).toMatchObject({ open: true, caption: "我的最愛", angel: true, loading: true });
    expect(changes.at(-1).items).toHaveLength(25);

    ctrl.noteScreen(parseHelpMenuScreen(HELP_FAV_PAGE2));
    expect(sent).toEqual([KEY_PGDN]);
    const s = changes.at(-1);
    expect(s.loading).toBe(false);
    expect(s.items).toHaveLength(35);
    expect(s.items[25].keysText).toBe("↓/n/j");
  });

  test("點第 2 頁的「^U 線上使用者」⇒ Home＋PgDn＋↓×8＋Enter，之後的說明幀不再彈", () => {
    const { ctrl, sent, changes } = makeController();
    ctrl.noteScreen(parseHelpMenuScreen(HELP_FAV_PAGE1));
    ctrl.noteScreen(parseHelpMenuScreen(HELP_FAV_PAGE2));
    const items = changes.at(-1).items;
    const idx = items.findIndex((i) => i.keysText === "^U");
    expect(idx).toBe(33);
    sent.length = 0;
    expect(ctrl.select(idx)).toBe(true);
    expect(sent).toEqual([KEY_HOME + KEY_PGDN + KEY_DOWN.repeat(8) + "\r"]);
    expect(changes.at(-1).open).toBe(false);
    // Home／PgDn 途中的說明幀
    ctrl.noteScreen(parseHelpMenuScreen(HELP_FAV_PAGE1));
    expect(changes.at(-1).open).toBe(false);
    expect(sent).toHaveLength(1);
    // 離開說明選單 ⇒ 回到 idle，下一次 h 照常接手
    ctrl.noteScreen(null);
    expect(ctrl.phase).toBe("idle");
    ctrl.noteScreen(parseHelpMenuScreen(HELP_FAV_PAGE1));
    expect(ctrl.phase).toBe("open");
  });

  test("離開＝q、小天使＝h", () => {
    const a = makeController();
    a.ctrl.noteScreen(parseHelpMenuScreen(HELP_FAV_PAGE1));
    a.sent.length = 0;
    a.ctrl.close();
    expect(a.sent).toEqual(["q"]);
    const b = makeController();
    b.ctrl.noteScreen(parseHelpMenuScreen(HELP_FAV_PAGE1));
    b.sent.length = 0;
    b.ctrl.callAngel();
    expect(b.sent).toEqual(["h"]);
  });

  test("原生畫面：收彈窗；補過頁 ⇒ Home 回第 1 頁；直到離開都不再彈", () => {
    const { ctrl, sent, changes } = makeController();
    ctrl.noteScreen(parseHelpMenuScreen(HELP_FAV_PAGE1));
    ctrl.noteScreen(parseHelpMenuScreen(HELP_FAV_PAGE2));
    sent.length = 0;
    ctrl.showNative();
    expect(sent).toEqual([KEY_HOME]);
    expect(changes.at(-1).open).toBe(false);
    ctrl.noteScreen(parseHelpMenuScreen(HELP_FAV_PAGE1));
    expect(ctrl.phase).toBe("native");
    expect(sent).toEqual([KEY_HOME]);
  });

  test("好讀關著 ⇒ 不接管、一個鍵都不送", () => {
    const { ctrl, sent, changes } = makeController({ enabled: false });
    ctrl.noteScreen(parseHelpMenuScreen(HELP_FAV_PAGE1));
    expect(ctrl.phase).toBe("native");
    expect(sent).toEqual([]);
    expect(changes).toEqual([]);
  });

  test("第一張就不是第 1 頁 ⇒ 不接管", () => {
    const { ctrl, sent } = makeController();
    ctrl.noteScreen(parseHelpMenuScreen(HELP_FAV_PAGE2));
    expect(ctrl.phase).toBe("native");
    expect(sent).toEqual([]);
  });

  test("佇列有命令在途 ⇒ PgDn 延後，線路空了才送", () => {
    const { ctrl, core, sent, fire } = makeController({ busy: true });
    ctrl.noteScreen(parseHelpMenuScreen(HELP_FAV_PAGE1));
    expect(ctrl.phase).toBe("open");
    expect(sent).toEqual([]);
    core.commandQueue.inFlightKind = null;
    fire();
    expect(sent).toEqual([KEY_PGDN]);
  });

  test("PgDn 沒回應 ⇒ 逾時後只列已拿到的頁，不重送", () => {
    const { ctrl, sent, changes, fire } = makeController();
    ctrl.noteScreen(parseHelpMenuScreen(HELP_FAV_PAGE1));
    fire(FETCH_TIMEOUT_MS);
    expect(changes.at(-1)).toMatchObject({ open: true, loading: false });
    expect(changes.at(-1).items).toHaveLength(25);
    ctrl.noteScreen(parseHelpMenuScreen(HELP_FAV_PAGE1));
    expect(sent).toEqual([KEY_PGDN]);
  });

  test("說明選單被別的畫面取代（server 端離開）⇒ 彈窗關掉", () => {
    const { ctrl, changes } = makeController();
    ctrl.noteScreen(parseHelpMenuScreen(HELP_FAV_PAGE1));
    ctrl.noteScreen(null);
    expect(ctrl.phase).toBe("idle");
    expect(changes.at(-1).open).toBe(false);
  });
});

describe("跳過進板畫面不被說明選單誤 arm", () => {
  // 錄製檔實錄：說明選單 row 0 是「【我的最愛】」，被當成看板列表；點 ^U 那一項送的
  // ↓×8＋⏎ 讓 boardNoteSkip arm 了（boardNoteSkip.arm @6924）。
  test("說明選單上的 ↓…⏎ 不 arm；看板列表上的 ⏎ 照舊 arm", () => {
    expect(boardEntryArms(HELP_FAV_PAGE1, KEY_DOWN.repeat(8) + "\r")).toBe(false);
    expect(boardEntryArms(HELP_FAV_PAGE1, "\r")).toBe(false);
    expect(boardEntryArms(BOARD_LIST, "\r")).toBe(true);
  });
});

describe("開關：好讀總開關＋說明選單自己的子開關", () => {
  test("預設開（兩個都開 ⇒ 接管）", () => {
    expect(DEFAULT_PREFS.enableHelpMenuPopup).toBe(true);
    expect(helpMenuPopupEnabled(effectivePrefs({ ...DEFAULT_PREFS }))).toBe(true);
  });

  test("任一個關 ⇒ 原生", () => {
    expect(helpMenuPopupEnabled({ ...DEFAULT_PREFS, enableHelpMenuPopup: false })).toBe(false);
    expect(helpMenuPopupEnabled({ ...DEFAULT_PREFS, enableEasyReading: false })).toBe(false);
  });

  test("安全模式 ⇒ 原生（各項設定不動）", () => {
    expect(helpMenuPopupEnabled(effectivePrefs({ ...DEFAULT_PREFS, nativeSafeMode: true }))).toBe(false);
  });

  test("控制器預設讀生效偏好：子開關關掉 ⇒ 一個鍵都不送", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => JSON.stringify({ values: { enableHelpMenuPopup: false } }),
        setItem() {},
      },
    });
    try {
      const sent = [];
      const ctrl = new HelpMenuController({ commandQueue: {} }, { addEventListener() {} }, {
        send: (b) => sent.push(b),
      });
      ctrl.noteScreen(parseHelpMenuScreen(HELP_FAV_PAGE1));
      expect(ctrl.phase).toBe("native");
      expect(sent).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
