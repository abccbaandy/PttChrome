// 斷線重連後回到原處（src/js/reconnect_resume.js；docs/reading-record.md「斷線重連」）：
// 斷線那一刻要去哪（resumePlanFrom，純函式）＋什麼時候出發（登入後的主功能表）。
// 實際的鍵序列與落地還原在 aid_navigation.test.js「startResume」。
import { ReconnectResume, resumePlanFrom } from "../../src/js/reconnect_resume";
import { ReadingRecord } from "../../src/js/reading_record";

const LIST = {
  kind: "list",
  board: "C_Chat",
  mode: "plain",
  topNum: 353200,
  topPinnedKey: null,
  scrollFrac: 0,
  cursorNum: 353218
};
const ARTICLE = { kind: "article", board: "C_Chat", lineIndex: 37, atBottom: false, easy: true };
const POST = { board: "C_Chat", aid: "1gIeu-3A" };

describe("resumePlanFrom（斷線那一刻要回哪）", () => {
  test("在文章裡、知道本篇 AID ⇒ 回到那篇文章（帶書籤還原列）", () => {
    const bm = { article: ARTICLE, list: LIST };
    expect(resumePlanFrom(bm, POST)).toEqual({
      kind: "article",
      board: "C_Chat",
      aid: "1gIeu-3A",
      bookmark: bm
    });
  });

  test("在文章裡但問不到 AID ⇒ 退回那篇所在的列表，游標放回那篇（不用編號開文）", () => {
    const bm = { article: ARTICLE, list: LIST };
    expect(resumePlanFrom(bm, null)).toEqual({
      kind: "list",
      board: "C_Chat",
      num: 353218,
      bookmark: bm
    });
  });

  test("問不到 AID、而身後的列表是別的板 ⇒ 不回（那份列表不是這篇的）", () => {
    const bm = { article: { ...ARTICLE, board: "Android" }, list: LIST };
    expect(resumePlanFrom(bm, null)).toBeNull();
  });

  test("在文章列表 ⇒ 回到那個板，游標放回斷線前那篇", () => {
    const bm = { article: null, list: LIST };
    expect(resumePlanFrom(bm, null)).toEqual({
      kind: "list",
      board: "C_Chat",
      num: 353218,
      bookmark: bm
    });
  });

  test("搜尋結果／文摘（另一個編號空間）⇒ 回到該板完整列表，不帶編號、不還原視野", () => {
    const bm = { article: null, list: { ...LIST, mode: "select" } };
    const plan = resumePlanFrom(bm, null);
    expect(plan.kind).toBe("list");
    expect(plan.num).toBeNull();
    expect(plan.bookmark.list).toBeNull();
  });

  test("游標在置底文（沒有編號）⇒ 進板就停", () => {
    const plan = resumePlanFrom({ article: null, list: { ...LIST, cursorNum: null } }, null);
    expect(plan.num).toBeNull();
    expect(plan.bookmark.list).toEqual({ ...LIST, cursorNum: null });
  });

  test("主功能表／看板列表／站內信（沒有文章也沒有文章列表）⇒ 不回", () => {
    expect(resumePlanFrom({ article: null, list: null, boardList: { kind: "boardList" } }, null)).toBeNull();
    expect(resumePlanFrom({ article: { ...ARTICLE, board: null }, list: null }, null)).toBeNull();
    expect(resumePlanFrom(null, POST)).toBeNull();
  });
});

const MAIN_MENU = "【主功能表】                      批踢踢實業坊";

// 假 termBuf：row0 決定「是不是主功能表」，settle() 觸發 screenSettled。
function harness({ pageState = 3 } = {}) {
  const listeners = [];
  const termBuf = {
    rows: 24,
    cols: 80,
    pageState,
    row0: "",
    getRowText(row) {
      return row === 0 ? this.row0 : "";
    },
    addEventListener(type, fn) {
      if (type === "screenSettled") listeners.push(fn);
    }
  };
  const view = { _articleBoard: "C_Chat", currentLineIndex: () => 37 };
  const core = {
    connectState: 1,
    autoLogin: { stop: vi.fn() },
    deepLinkController: { pending: false, hasPending() { return this.pending; } },
    aidNavigation: {
      active: false,
      post: POST,
      currentPostAid() {
        return this.post;
      },
      startResume: vi.fn(() => true)
    },
    easyReading: { _enabled: true, _functionMode: false },
    listSession: { readingPosition: () => LIST }
  };
  core.readingRecord = new ReadingRecord(core);
  const rr = new ReconnectResume(core, view, termBuf);
  const settle = row0 => {
    termBuf.row0 = row0;
    for (const fn of listeners) fn();
  };
  return { rr, core, termBuf, settle };
}

describe("ReconnectResume（何時出發）", () => {
  test("登入過 → 斷線 → 重連登入回到主功能表 ⇒ 出發；先停 AutoLogin", () => {
    const h = harness();
    h.settle(MAIN_MENU); // 這條連線登入過
    h.rr.capture(false);
    expect(h.rr.hasPending()).toBe(true);
    // 重連中：登入流程的畫面不算「使用者走開了」
    h.settle("請輸入代號，或以 guest 參觀，或以 new 註冊:");
    expect(h.core.aidNavigation.startResume).not.toHaveBeenCalled();
    h.settle(MAIN_MENU);
    expect(h.core.autoLogin.stop).toHaveBeenCalled();
    expect(h.core.aidNavigation.startResume).toHaveBeenCalledTimes(1);
    const plan = h.core.aidNavigation.startResume.mock.calls[0][0];
    expect(plan).toMatchObject({ kind: "article", board: "C_Chat", aid: "1gIeu-3A" });
    // 書籤是斷線那一刻的閱讀紀錄
    expect(plan.bookmark.feature).toBe("reconnect-resume");
    expect(plan.bookmark.article).toMatchObject({ lineIndex: 37 });
    // 一次性
    h.settle(MAIN_MENU);
    expect(h.core.aidNavigation.startResume).toHaveBeenCalledTimes(1);
  });

  test("自己登出 ⇒ 不回去", () => {
    const h = harness();
    h.settle(MAIN_MENU);
    h.rr.capture(true);
    h.settle(MAIN_MENU);
    expect(h.core.aidNavigation.startResume).not.toHaveBeenCalled();
  });

  test("還沒登入就斷了（重連失敗）⇒ 保留上一份，之後登入成功仍回得去", () => {
    const h = harness();
    h.settle(MAIN_MENU);
    h.rr.capture(false);
    h.settle("請輸入代號");
    h.rr.capture(false); // 第二條連線沒登入就斷
    expect(h.rr.hasPending()).toBe(true);
    h.settle(MAIN_MENU);
    expect(h.core.aidNavigation.startResume).toHaveBeenCalledTimes(1);
  });

  test("從沒登入過（開站就斷）⇒ 沒有東西可回", () => {
    const h = harness();
    h.rr.capture(false);
    expect(h.rr.hasPending()).toBe(false);
  });

  test("沒連上就不出發（connectState 不是 1）", () => {
    const h = harness();
    h.settle(MAIN_MENU);
    h.rr.capture(false);
    h.core.connectState = 2;
    h.settle(MAIN_MENU);
    expect(h.core.aidNavigation.startResume).not.toHaveBeenCalled();
    expect(h.rr.hasPending()).toBe(true);
  });

  test("deep link 也在等登入 ⇒ 讓給它（使用者剛給的連結比較新）", () => {
    const h = harness();
    h.settle(MAIN_MENU);
    h.rr.capture(false);
    h.core.deepLinkController.pending = true;
    h.settle(MAIN_MENU);
    expect(h.core.aidNavigation.startResume).not.toHaveBeenCalled();
    expect(h.rr.hasPending()).toBe(false);
  });

  test("同一次 settle 已經有序列在跑（deep link 先跳了）⇒ 作廢", () => {
    const h = harness();
    h.settle(MAIN_MENU);
    h.rr.capture(false);
    h.core.aidNavigation.active = true;
    h.settle(MAIN_MENU);
    expect(h.core.aidNavigation.startResume).not.toHaveBeenCalled();
    expect(h.rr.hasPending()).toBe(false);
  });

  test("登入後使用者先走開了（不在主功能表）⇒ 作廢，之後回主功能表也不搶畫面", () => {
    const h = harness();
    h.settle(MAIN_MENU);
    h.rr.capture(false);
    h.core.connectState = 2; // 主功能表那一幀還沒出發（例如連線狀態還沒更新）
    h.settle(MAIN_MENU);
    h.core.connectState = 1;
    h.settle("【看板列表】");
    h.settle(MAIN_MENU);
    expect(h.core.aidNavigation.startResume).not.toHaveBeenCalled();
  });

  // 開關（pref reconnectResume，預設開）：替使用者送鍵的功能都要能關。
  describe("關掉「斷線重連回到原處」", () => {
    const prefs = (values) =>
      vi.stubGlobal("window", {
        localStorage: { getItem: () => JSON.stringify({ values }), setItem() {} }
      });
    afterEach(() => vi.unstubAllGlobals());

    test("斷線時是關的 ⇒ 不記、重連登入後一個鍵都不送", () => {
      prefs({ reconnectResume: false });
      const h = harness();
      h.settle(MAIN_MENU);
      h.rr.capture(false);
      expect(h.rr.hasPending()).toBe(false);
      h.settle(MAIN_MENU);
      expect(h.core.aidNavigation.startResume).not.toHaveBeenCalled();
      expect(h.core.autoLogin.stop).not.toHaveBeenCalled();
    });

    test("斷線後才關（重連途中）⇒ 也不出發", () => {
      const h = harness();
      h.settle(MAIN_MENU);
      h.rr.capture(false);
      expect(h.rr.hasPending()).toBe(true);
      prefs({ reconnectResume: false });
      h.settle(MAIN_MENU);
      expect(h.core.aidNavigation.startResume).not.toHaveBeenCalled();
      expect(h.rr.hasPending()).toBe(false);
    });

    test("預設是開的", () => {
      prefs({});
      const h = harness();
      h.settle(MAIN_MENU);
      h.rr.capture(false);
      h.settle(MAIN_MENU);
      expect(h.core.aidNavigation.startResume).toHaveBeenCalledTimes(1);
    });
  });

  test("在主功能表斷線 ⇒ 沒有東西可回", () => {
    const h = harness({ pageState: 0 });
    h.core.listSession.readingPosition = () => null;
    h.settle(MAIN_MENU);
    h.rr.capture(false);
    expect(h.rr.hasPending()).toBe(false);
  });
});
