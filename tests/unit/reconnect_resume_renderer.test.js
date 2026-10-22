// @unit-env browser
// APK 被系統回收（renderer／process）後回到原處（src/js/reconnect_resume.js 的存檔分支；
// docs/android-app.md「renderer 被回收」）：切到背景（'pttandroid:stop'）存「斷線的話要回哪」，
// 重建的頁面（config.restored）開機接回，登入回主功能表後照常出發。
import {
  ReconnectResume,
  planFromSnapshot,
  SNAPSHOT_KEY,
  SNAPSHOT_MAX_AGE_MS
} from "../../src/js/reconnect_resume";
import { ReadingRecord } from "../../src/js/reading_record";
import { STOP_EVENT } from "../../src/js/android_bridge";
import { DEFAULT_PREFS, writeValues } from "../../src/js/pref_storage";

const LIST = {
  kind: "list",
  board: "C_Chat",
  mode: "plain",
  topNum: 353200,
  topPinnedKey: null,
  scrollFrac: 0,
  cursorNum: 353218
};
const POST = { board: "C_Chat", aid: "1gIeu-3A" };
const MAIN_MENU = "【主功能表】                      批踢踢實業坊";

function harness() {
  const listeners = [];
  const termBuf = {
    rows: 24,
    cols: 80,
    pageState: 3,
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
    deepLinkController: { hasPending: () => false },
    aidNavigation: {
      active: false,
      currentPostAid: () => POST,
      startResume: vi.fn(() => true)
    },
    easyReading: { _enabled: true, _functionMode: false },
    listSession: { readingPosition: () => LIST }
  };
  core.readingRecord = new ReadingRecord(core);
  const rr = new ReconnectResume(core, view, termBuf);
  const settle = (row0) => {
    termBuf.row0 = row0;
    for (const fn of listeners) fn();
  };
  return { rr, core, settle };
}

function asApk({ restored = false } = {}) {
  window.__PTT_ANDROID__ = { version: "1", site: "x", restored };
}

const stored = () => JSON.parse(window.localStorage.getItem(SNAPSHOT_KEY));

afterEach(() => {
  delete window.__PTT_ANDROID__;
  window.localStorage.removeItem(SNAPSHOT_KEY);
  window.localStorage.removeItem("pttchrome.pref.v1");
});

describe("切到背景時存檔", () => {
  test("登入後在文章裡切到背景 ⇒ 存「回到那篇」（不動記憶體裡的待回目標）", () => {
    asApk();
    const h = harness();
    h.settle(MAIN_MENU);
    h.rr.saveSnapshot();
    const snap = stored();
    expect(snap.plan).toMatchObject({ kind: "article", board: "C_Chat", aid: "1gIeu-3A" });
    expect(snap.plan.bookmark.article).toMatchObject({ lineIndex: 37 });
    expect(Date.now() - snap.at).toBeLessThan(5000);
    expect(h.rr.hasPending()).toBe(false);
  });

  test("原生的 'pttandroid:stop' 事件接到存檔", () => {
    asApk();
    const h = harness();
    h.settle(MAIN_MENU);
    window.dispatchEvent(new CustomEvent(STOP_EVENT));
    expect(stored().plan.kind).toBe("article");
  });

  test("還沒登入／斷線中／關掉功能 ⇒ 清掉舊存檔", () => {
    asApk();
    const h = harness();
    window.localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ at: Date.now(), plan: {} }));
    h.rr.saveSnapshot(); // 還沒登入
    expect(window.localStorage.getItem(SNAPSHOT_KEY)).toBeNull();

    h.settle(MAIN_MENU);
    h.core.connectState = 2;
    h.rr.saveSnapshot();
    expect(window.localStorage.getItem(SNAPSHOT_KEY)).toBeNull();

    h.core.connectState = 1;
    writeValues({ ...DEFAULT_PREFS, reconnectResume: false, resumeLastPlace: false });
    h.rr.saveSnapshot();
    expect(window.localStorage.getItem(SNAPSHOT_KEY)).toBeNull();
  });
});

describe("重建後開機接回", () => {
  function saveFromOldPage() {
    asApk();
    const old = harness();
    old.settle(MAIN_MENU);
    old.rr.saveSnapshot();
  }

  test("原生說是回收後重建的 ⇒ 接回，登入回主功能表後出發；存檔用掉就清", () => {
    saveFromOldPage();
    asApk({ restored: true });
    const h = harness();
    expect(h.rr.hasPending()).toBe(true);
    expect(window.localStorage.getItem(SNAPSHOT_KEY)).toBeNull();
    h.settle("請輸入代號，或以 guest 參觀，或以 new 註冊:");
    expect(h.core.aidNavigation.startResume).not.toHaveBeenCalled();
    h.settle(MAIN_MENU);
    expect(h.core.aidNavigation.startResume).toHaveBeenCalledTimes(1);
    expect(h.core.aidNavigation.startResume.mock.calls[0][0]).toMatchObject({
      kind: "article",
      board: "C_Chat",
      aid: "1gIeu-3A"
    });
  });

  test("一般開 App（不是重建）、開站回到上次的地方關著 ⇒ 不接回，舊存檔丟掉", () => {
    saveFromOldPage();
    writeValues({ ...DEFAULT_PREFS, resumeLastPlace: false });
    asApk({ restored: false });
    const h = harness();
    expect(h.rr.hasPending()).toBe(false);
    expect(window.localStorage.getItem(SNAPSHOT_KEY)).toBeNull();
  });

  test("功能關掉 ⇒ 重建也不接回", () => {
    saveFromOldPage();
    writeValues({ ...DEFAULT_PREFS, reconnectResume: false, resumeLastPlace: false });
    asApk({ restored: true });
    expect(harness().rr.hasPending()).toBe(false);
  });

  test("不是 APK（瀏覽器）、開站回到上次的地方關著 ⇒ 不接回、讀過的存檔丟掉", () => {
    writeValues({ ...DEFAULT_PREFS, resumeLastPlace: false });
    window.localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ at: Date.now(), plan: { kind: "list", board: "C_Chat" } }));
    expect(harness().rr.hasPending()).toBe(false);
    expect(window.localStorage.getItem(SNAPSHOT_KEY)).toBeNull();
  });
});

describe("planFromSnapshot", () => {
  const plan = { kind: "article", board: "C_Chat", aid: "1gIeu-3A", bookmark: {} };
  test("時間窗內、形狀對 ⇒ 回待回目標", () => {
    expect(planFromSnapshot({ at: 1000, plan }, 2000)).toBe(plan);
  });
  test("太舊、時間在未來、形狀不對 ⇒ null", () => {
    expect(planFromSnapshot({ at: 0, plan }, SNAPSHOT_MAX_AGE_MS + 1)).toBeNull();
    expect(planFromSnapshot({ at: 5000, plan }, 1000)).toBeNull();
    expect(planFromSnapshot({ at: 1000, plan: { ...plan, aid: null } }, 2000)).toBeNull();
    expect(planFromSnapshot({ at: 1000, plan: { ...plan, kind: "x" } }, 2000)).toBeNull();
    expect(planFromSnapshot({ at: 1000, plan: { ...plan, board: "" } }, 2000)).toBeNull();
    expect(planFromSnapshot(null, 2000)).toBeNull();
    expect(planFromSnapshot({ plan }, 2000)).toBeNull();
  });
});
