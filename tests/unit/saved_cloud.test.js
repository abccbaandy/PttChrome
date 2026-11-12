// 本機收藏的清單同步到雲端（P70）：src/js/saved_cloud.js（純函式）＋saved_articles.js 的接線。
//
// 守護：
//   1. 只上雲摘要（看板、AID、標題、作者、存的時間），不帶內文；壞資料讀回來一律丟掉。
//   2. 「其他裝置存的」＝雲端有、這台沒存的。
//   3. 上傳計畫：這台比較新才蓋；剛刪的拿掉；滿了只擠掉比較舊、而且不是這台存的 ⇒ 好幾台一起超過上限
//      也會收斂，不會互相刪來刪去（模擬兩台輪流同步到穩定）。
//   4. 接線：同步關著（pref、沒登入、本機收藏關掉）⇒ 不上傳、不列「其他裝置存的」；存／刪會同步；
//      雲端狀態還沒到不上傳。
const prefOverride = vi.hoisted(() => ({}));
vi.mock("../../src/js/pref_storage", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, readEffectivePrefs: () => ({ ...real.readEffectivePrefs(), ...prefOverride }) };
});
import {
  CLOUD_SAVED_LIMIT,
  cloudKey,
  cloudEntryFromMeta,
  normalizeCloudSaved,
  othersFromCloud,
  planCloudUpload,
} from "../../src/js/saved_cloud";
import { SavedArticles } from "../../src/js/saved_articles";

const meta = (board, aid, savedAt, extra) => ({
  key: board.toLowerCase() + "/" + aid,
  board,
  aid,
  title: "[問卦] " + aid,
  author: "someone",
  url: "https://www.ptt.cc/bbs/x.html",
  lineCount: 99,
  comments: 3,
  savedAt,
  ...(extra || {}),
});
const aid = (n) => ("A" + String(n).padStart(7, "0")).slice(0, 8);
const entry = (board, id, savedAt) => cloudEntryFromMeta(meta(board, id, savedAt));
const mapOf = (...es) => Object.fromEntries(es.map((e) => [cloudKey(e.board, e.aid), e]));

describe("摘要與讀回", () => {
  test("只帶五個欄位，標題／作者截長", () => {
    const e = cloudEntryFromMeta(meta("Gossiping", "1gIeu-3A", 5, { title: "x".repeat(500) }));
    expect(Object.keys(e).sort()).toEqual(["aid", "author", "board", "savedAt", "title"]);
    expect(e.title.length).toBe(120);
    expect(cloudKey("Gossiping", "1gIeu-3A")).toBe("gossiping:1gIeu-3A");
  });

  test("看板或 AID 不合法 ⇒ null", () => {
    expect(cloudEntryFromMeta(meta("../x", "1gIeu-3A", 1))).toBeNull();
    expect(cloudEntryFromMeta(meta("Stock", "short", 1))).toBeNull();
    expect(cloudEntryFromMeta(null)).toBeNull();
  });

  test("雲端壞資料丟掉：不是 map、key 對不上內容、欄位壞掉", () => {
    const good = entry("Stock", "1g8znzQ3", 3);
    const raw = {
      "stock:1g8znzQ3": good,
      "stock:XXXXXXXX": entry("Stock", "1g8znzQ4", 1), // key 跟內容不符
      "bad:1g8znzQ5": { board: "../", aid: "1g8znzQ5" },
    };
    expect(normalizeCloudSaved(raw)).toEqual({ "stock:1g8znzQ3": good });
    expect(normalizeCloudSaved([good])).toEqual({});
    expect(normalizeCloudSaved(undefined)).toEqual({});
  });

  test("其他裝置存的＝雲端有、這台沒存的，新的在前", () => {
    const cloud = mapOf(entry("Stock", aid(1), 1), entry("Stock", aid(2), 3), entry("Tech_Job", aid(3), 2));
    const others = othersFromCloud(cloud, [meta("Stock", aid(1), 1)]);
    expect(others.map((e) => e.aid)).toEqual([aid(2), aid(3)]);
  });
});

describe("planCloudUpload", () => {
  test("這台有、雲端沒有 ⇒ set；雲端一樣或比較新 ⇒ 不動", () => {
    const local = [meta("Stock", aid(1), 5), meta("Stock", aid(2), 5), meta("Stock", aid(3), 5)];
    const cloud = mapOf(entry("Stock", aid(2), 5), entry("Stock", aid(3), 9));
    const plan = planCloudUpload({ cloud, localList: local });
    expect(Object.keys(plan.set)).toEqual([cloudKey("Stock", aid(1))]);
    expect(plan.del).toEqual([]);
    expect(planCloudUpload({ cloud: mapOf(...local.map((m) => cloudEntryFromMeta(m))), localList: local })).toBeNull();
  });

  test("同一篇兩台標題不同、存的時間一樣 ⇒ 都不蓋（不互蓋）", () => {
    const cloud = mapOf(cloudEntryFromMeta(meta("Stock", aid(1), 5, { title: "A" })));
    expect(planCloudUpload({ cloud, localList: [meta("Stock", aid(1), 5, { title: "B" })] })).toBeNull();
  });

  test("剛刪的 ⇒ del；雲端沒有的不寫", () => {
    const cloud = mapOf(entry("Stock", aid(1), 1));
    expect(planCloudUpload({ cloud, localList: [], removed: [cloudKey("Stock", aid(1))] })).toEqual({
      set: {},
      del: [cloudKey("Stock", aid(1))],
    });
    expect(planCloudUpload({ cloud, localList: [], removed: ["stock:ZZZZZZZZ"] })).toBeNull();
  });

  test("滿了：只擠掉比要加的更舊、不是這台存的；擠不掉就不上", () => {
    const full = [];
    for (let i = 0; i < CLOUD_SAVED_LIMIT; ++i) full.push(entry("Other", aid(i), 100 + i));
    const cloud = mapOf(...full);
    // 比雲端全部都舊 ⇒ 擠不掉、不上
    expect(planCloudUpload({ cloud, localList: [meta("Stock", aid(1), 1)] })).toBeNull();
    // 比較新 ⇒ 擠掉最舊的那篇
    const plan = planCloudUpload({ cloud, localList: [meta("Stock", aid(1), 1000)] });
    expect(plan.del).toEqual([cloudKey("Other", aid(0))]);
    expect(Object.keys(plan.set)).toEqual([cloudKey("Stock", aid(1))]);
    // 這台自己存的不會被擠掉
    const mine = [meta("Other", aid(0), 100), meta("Stock", aid(1), 1000)];
    expect(planCloudUpload({ cloud, localList: mine }).del).toEqual([cloudKey("Other", aid(1))]);
  });

  test("兩台各 200 篇、一起超過上限 ⇒ 輪流同步會停下來，雲端剛好是最新的 300 篇", () => {
    const a = [];
    const b = [];
    for (let i = 0; i < 200; ++i) {
      a.push(meta("BoardA", aid(i), 1000 + i * 2));
      b.push(meta("BoardB", aid(i), 1001 + i * 2));
    }
    let cloud = {};
    const apply = (plan) => {
      if (!plan) return false;
      cloud = { ...cloud };
      for (const k of plan.del) delete cloud[k];
      Object.assign(cloud, plan.set);
      return true;
    };
    let rounds = 0;
    for (; rounds < 50; ++rounds) {
      const changedA = apply(planCloudUpload({ cloud, localList: a }));
      const changedB = apply(planCloudUpload({ cloud, localList: b }));
      if (!changedA && !changedB) break;
    }
    expect(rounds).toBeLessThan(50);
    const keys = Object.keys(cloud);
    expect(keys.length).toBe(CLOUD_SAVED_LIMIT);
    const all = a.concat(b).sort((x, y) => y.savedAt - x.savedAt).slice(0, CLOUD_SAVED_LIMIT);
    expect(keys.sort()).toEqual(all.map((m) => cloudKey(m.board, m.aid)).sort());
  });
});

describe("SavedArticles 的雲端接線", () => {
  beforeEach(() => {
    for (const k of Object.keys(prefOverride)) delete prefOverride[k];
  });

  function setup({ signedIn = true, local = [] } = {}) {
    let list = local.slice();
    const store = {
      list: async () => list.slice(),
      remove: async (key) => {
        list = list.filter((m) => m.key !== key);
        return true;
      },
    };
    let push = null;
    const uploads = [];
    const cloud = {
      signedIn: () => signedIn,
      upload: async (plan) => {
        uploads.push(plan);
        return true;
      },
      subscribe: (cb) => {
        push = cb;
      },
    };
    const requests = [];
    const core = { deepLinkController: { request: (t, o) => (requests.push([t, o]), "navigating") } };
    const saved = new SavedArticles(core, store, cloud);
    return { saved, uploads, requests, push: (raw) => push(raw), store };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  test("收到雲端清單 ⇒ 把這台沒上雲的補上去；列出其他裝置存的", async () => {
    const t = setup({ local: [meta("Stock", aid(1), 5)] });
    await t.saved.refresh();
    t.push(mapOf(entry("Tech_Job", aid(2), 9)));
    await flush();
    expect(t.uploads).toHaveLength(1);
    expect(Object.keys(t.uploads[0].set)).toEqual([cloudKey("Stock", aid(1))]);
    expect(t.saved.others().map((e) => e.aid)).toEqual([aid(2)]);
  });

  test("點其他裝置存的 ⇒ deep link（不出「已跳至」）", async () => {
    const t = setup();
    t.push(mapOf(entry("Tech_Job", aid(2), 9)));
    expect(t.saved.openOther(t.saved.others()[0])).toBe(true);
    expect(t.requests).toEqual([[{ board: "Tech_Job", aid: aid(2) }, { quietLanding: true }]]);
  });

  test("在這台刪 ⇒ 雲端也拿掉（不會變成「其他裝置存的」）", async () => {
    const t = setup({ local: [meta("Stock", aid(1), 5)] });
    await t.saved.refresh();
    t.push(mapOf(entry("Stock", aid(1), 5)));
    await flush();
    expect(t.uploads).toHaveLength(0);
    await t.saved.remove("stock/" + aid(1));
    await flush();
    expect(t.uploads).toEqual([{ set: {}, del: [cloudKey("Stock", aid(1))] }]);
  });

  test("從雲端清單拿掉別台的 ⇒ 立刻不列、寫 del", async () => {
    const t = setup();
    t.push(mapOf(entry("Tech_Job", aid(2), 9)));
    await flush();
    await t.saved.removeOther(t.saved.others()[0]);
    expect(t.saved.others()).toEqual([]);
    expect(t.uploads).toEqual([{ set: {}, del: [cloudKey("Tech_Job", aid(2))] }]);
  });

  test.each([
    ["pref 關掉", { syncSavedArticles: false }, true],
    ["本機收藏關掉", { enableSavedArticles: false }, true],
    ["沒登入雲端同步", {}, false],
  ])("%s ⇒ 不上傳、不列其他裝置存的", async (_, prefs, signedIn) => {
    Object.assign(prefOverride, prefs);
    const t = setup({ signedIn, local: [meta("Stock", aid(1), 5)] });
    await t.saved.refresh();
    t.push(mapOf(entry("Tech_Job", aid(2), 9)));
    await flush();
    expect(t.uploads).toEqual([]);
    expect(t.saved.others()).toEqual([]);
  });

  test("雲端狀態還沒到 ⇒ 刪除不上傳（不知道雲端有什麼）", async () => {
    const t = setup({ local: [meta("Stock", aid(1), 5)] });
    await t.saved.refresh();
    await t.saved.remove("stock/" + aid(1));
    await flush();
    expect(t.uploads).toEqual([]);
  });
});
