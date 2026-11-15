// 稍後閱讀跨裝置同步（src/js/read_later_sync.js，docs/recent-articles.md「稍後閱讀同步」）：
//   - 每篇各自 last-writer-wins（mt），刪除留墓碑 ⇒ 「B 刪了 A 也消失」，A 不會再把它傳回去；
//   - 上限 50 篇：超過的最舊那篇變墓碑（跟使用者刪一樣同步出去）；墓碑過期／超量就回收；
//   - 兩台裝置照同一個規則輪流同步 ⇒ 收斂到同一份；
//   - 舊版本機的 later 陣列遷移成 map。
// 控制器接線（RecentArticles＋假雲端）在 tests/unit/recent_articles.test.jsx「稍後閱讀同步」。
import {
  READ_LATER_LIMIT,
  READ_LATER_TOMBSTONE_MS,
  READ_LATER_TOMBSTONE_LIMIT,
  readLaterKey,
  normalizeReadLaterMap,
  newerEntry,
  mergeReadLater,
  trimReadLater,
  liveReadLater,
  planReadLaterUpload,
  readLaterMapFromList,
} from "../../src/js/read_later_sync";

const e = (aid, mt, extra) =>
  Object.assign({ board: "Stock", aid, title: "t" + aid, at: mt, mt }, extra || {});
const k = (aid) => "stock:" + aid;
const map = (...entries) => Object.fromEntries(entries.map((x) => [readLaterKey(x.board, x.aid), x]));

test("key：看板小寫:AID；不合法 ⇒ null", () => {
  expect(readLaterKey("Stock", "1g8znzQ3")).toBe("stock:1g8znzQ3");
  expect(readLaterKey("bad board", "1g8znzQ3")).toBe(null);
  expect(readLaterKey("Stock", "short")).toBe(null);
});

test("normalize：壞資料、key 對不上的丟掉；mt 缺 ⇒ 用 at；del 只認 true", () => {
  const raw = {
    [k("1aaaaaaa")]: { board: "Stock", aid: "1aaaaaaa", title: "x", at: 5 },
    [k("1bbbbbbb")]: { board: "Stock", aid: "1bbbbbbb", at: 1, mt: 2, del: "yes" },
    "stock:wrongkey": { board: "Stock", aid: "1ccccccc", at: 1 },
    [k("1dddddddd")]: "garbage",
  };
  expect(normalizeReadLaterMap(raw)).toEqual({
    [k("1aaaaaaa")]: { board: "Stock", aid: "1aaaaaaa", title: "x", at: 5, mt: 5 },
    [k("1bbbbbbb")]: { board: "Stock", aid: "1bbbbbbb", title: "", at: 1, mt: 2 },
  });
  expect(normalizeReadLaterMap([1, 2])).toEqual({});
  expect(normalizeReadLaterMap(null)).toEqual({});
});

test("誰贏：mt 新的；一樣新時活的贏墓碑、有標題的贏沒標題的", () => {
  const live = e("1aaaaaaa", 5);
  const dead = e("1aaaaaaa", 6, { del: true });
  expect(newerEntry(live, dead)).toBe(dead);
  expect(newerEntry(dead, live)).toBe(dead);
  const deadSame = e("1aaaaaaa", 5, { del: true });
  expect(newerEntry(deadSame, live)).toBe(live);
  const noTitle = e("1aaaaaaa", 5, { title: "" });
  expect(newerEntry(noTitle, live)).toBe(live);
  expect(newerEntry(null, live)).toBe(live);
});

test("B 刪了 ⇒ A 合併後也消失，而且 A 不會把它傳回去", () => {
  const a = map(e("1aaaaaaa", 10), e("1bbbbbbb", 11));
  const cloud = map(e("1aaaaaaa", 20, { del: true }), e("1bbbbbbb", 11));
  const merged = trimReadLater(mergeReadLater(a, cloud), 30);
  expect(liveReadLater(merged).map((x) => x.aid)).toEqual(["1bbbbbbb"]);
  expect(planReadLaterUpload(merged, cloud, 30)).toBe(null);
});

test("A 加了 ⇒ 上傳 set；雲端那筆比較新 ⇒ 不傳", () => {
  const cloud = map(e("1aaaaaaa", 50));
  const local = map(e("1aaaaaaa", 40), e("1bbbbbbb", 60));
  expect(planReadLaterUpload(local, cloud, 70)).toEqual({ set: { [k("1bbbbbbb")]: e("1bbbbbbb", 60) }, del: [] });
});

test("刪了又加回來（mt 更新）贏過舊墓碑", () => {
  const cloud = map(e("1aaaaaaa", 50, { del: true }));
  const local = map(e("1aaaaaaa", 60));
  const merged = mergeReadLater(local, cloud);
  expect(liveReadLater(merged).map((x) => x.aid)).toEqual(["1aaaaaaa"]);
  expect(planReadLaterUpload(local, cloud, 70).set[k("1aaaaaaa")].del).toBeUndefined();
});

test("上限：超過 50 篇 ⇒ 最舊的變墓碑（mt＝now），會同步出去", () => {
  const entries = Array.from({ length: READ_LATER_LIMIT + 2 }, (_, i) => e("1" + String(i).padStart(7, "a"), 100 + i));
  const m = trimReadLater(map(...entries), 1000);
  const live = liveReadLater(m);
  expect(live).toHaveLength(READ_LATER_LIMIT);
  expect(live[live.length - 1].at).toBe(102);
  const dropped = Object.values(m).filter((x) => x.del);
  expect(dropped.map((x) => x.at).sort()).toEqual([100, 101]);
  expect(dropped.every((x) => x.mt === 1000)).toBe(true);
});

test("墓碑回收：過期的拿掉，雲端也跟著 del；超量只留最新的", () => {
  const now = READ_LATER_TOMBSTONE_MS + 1000;
  const old = e("1aaaaaaa", 1, { del: true });
  const fresh = e("1bbbbbbb", now - 10, { del: true });
  const m = trimReadLater(map(old, fresh), now);
  expect(Object.keys(m)).toEqual([k("1bbbbbbb")]);
  expect(planReadLaterUpload(m, map(old, fresh), now)).toEqual({ set: {}, del: [k("1aaaaaaa")] });

  const many = Array.from({ length: READ_LATER_TOMBSTONE_LIMIT + 3 }, (_, i) =>
    e("2" + String(i).padStart(7, "a"), 1000 + i, { del: true }),
  );
  const t = trimReadLater(map(...many), 5000);
  expect(Object.keys(t)).toHaveLength(READ_LATER_TOMBSTONE_LIMIT);
  expect(Object.values(t).some((x) => x.mt === 1000)).toBe(false);
});

// 兩台裝置各自增刪、輪流跟同一份雲端同步，直到雲端不再變：兩台的清單一模一樣。
test("兩台輪流同步 ⇒ 收斂到同一份清單", () => {
  let cloud = {};
  const sync = (local, now) => {
    const merged = trimReadLater(mergeReadLater(local, cloud), now);
    const plan = planReadLaterUpload(merged, cloud, now);
    if (plan) {
      cloud = Object.assign({}, cloud, plan.set);
      plan.del.forEach((x) => delete cloud[x]);
    }
    return merged;
  };
  let a = map(e("1aaaaaaa", 10), e("1bbbbbbb", 11));
  let b = map(e("1ccccccc", 12));
  a = sync(a, 20);
  b = sync(b, 21);
  // B 刪掉 A 加的那篇；A 同時（離線）加了一篇新的
  b = Object.assign({}, b, { [k("1aaaaaaa")]: e("1aaaaaaa", 30, { del: true }) });
  a = Object.assign({}, a, { [k("1ddddddd")]: e("1ddddddd", 31) });
  for (let i = 0; i < 3; i++) {
    a = sync(a, 40 + i);
    b = sync(b, 50 + i);
  }
  const ids = (m) => liveReadLater(m).map((x) => x.aid);
  expect(ids(a)).toEqual(["1ddddddd", "1ccccccc", "1bbbbbbb"]);
  expect(ids(b)).toEqual(ids(a));
});

test("舊版 later 陣列遷移：mt＝at，重複的留第一筆，壞資料丟掉", () => {
  const out = readLaterMapFromList([
    { board: "Stock", aid: "1aaaaaaa", title: "x", at: 5 },
    { board: "Stock", aid: "1aaaaaaa", title: "dup", at: 9 },
    { board: "bad board", aid: "1bbbbbbb", at: 1 },
  ]);
  expect(out).toEqual({ [k("1aaaaaaa")]: { board: "Stock", aid: "1aaaaaaa", title: "x", at: 5, mt: 5 } });
  expect(readLaterMapFromList(undefined)).toEqual({});
});
