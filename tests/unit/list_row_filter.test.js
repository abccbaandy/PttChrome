// 文章列表「使用者看不到哪幾列」的唯一判準（src/js/list_row_filter.js、docs/list-row-filter.md）。
// 列表列照 pttbbs bbs.c#readdoent 的欄位手寫：%7d 序號、空白、type、推文數、日期、作者 %-13.12s、標題。
import {
  blacklistHit,
  isHiddenListText,
  hiddenReason,
  listFilterOf,
  filterSummary,
} from "../../src/js/list_row_filter";
import { parseBlacklist, parseTitleBlacklist } from "../../src/js/comment_parse";
import { visibleListIndices } from "../../src/js/list_session";

const row = (num, author, title, o = {}) =>
  String(num).padStart(7) + " " + (o.type || "+") + (o.push || " 5") + " 9/01 " + author.padEnd(13).slice(0, 13) + (o.mark || "□") + " " + title;

const ALICE = row(101, "alice", "[閒聊] 早安");
const BOB = row(102, "Bob", "[問題] 有人抽獎嗎");
const DELETED = row(103, "-", "(本文已被刪除) [someone]", { mark: "□" });
const LOCKED = row(104, "carol", "[公告] 鎖起來", { push: "--", mark: "鎖" });
const HEADER = "   編號    日 期 作  者       文  章  標  題                       人氣:123";

describe("blacklistHit", () => {
  test("作者精確比對（不分大小寫）", () => {
    expect(blacklistHit(BOB, parseBlacklist("BOB"), [])).toEqual({ by: "author" });
    expect(blacklistHit(BOB, parseBlacklist("bo"), [])).toBeNull();
  });
  test("標題關鍵字子字串比對，回報命中的關鍵字", () => {
    expect(blacklistHit(BOB, new Set(), parseTitleBlacklist("抽獎"))).toEqual({ by: "title", keyword: "抽獎" });
  });
  test("作者先比", () => {
    expect(blacklistHit(BOB, parseBlacklist("bob"), parseTitleBlacklist("抽獎"))).toEqual({ by: "author" });
  });
  test("沒有名單／空列 ⇒ null", () => {
    expect(blacklistHit(BOB, null, null)).toBeNull();
    expect(blacklistHit("", parseBlacklist("bob"), [])).toBeNull();
  });
});

describe("isHiddenListText／hiddenReason：列表好讀藏起來的列", () => {
  const bl = parseBlacklist("bob");
  test("刪除文、鎖文、黑名單", () => {
    expect(hiddenReason(DELETED, null, null)).toBe("deleted");
    expect(hiddenReason(LOCKED, null, null)).toBe("locked");
    expect(hiddenReason(BOB, bl, null)).toBe("author");
    expect(hiddenReason(BOB, null, parseTitleBlacklist("抽獎"))).toBe("title");
    expect(hiddenReason(ALICE, bl, null)).toBeNull();
    for (const t of [DELETED, LOCKED, BOB]) expect(isHiddenListText(t, bl, null)).toBe(true);
    expect(isHiddenListText(ALICE, bl, null)).toBe(false);
  });
  test("不是列表形的列一律可見（表頭含關鍵字也不藏）", () => {
    expect(isHiddenListText(HEADER, null, parseTitleBlacklist("標  題"))).toBe(false);
    expect(hiddenReason(HEADER, null, parseTitleBlacklist("標  題"))).toBeNull();
  });
  test("列表好讀的導覽（visibleListIndices）吃的就是這一份", () => {
    const texts = [ALICE, BOB, DELETED, LOCKED];
    const expected = texts.map((t, i) => (isHiddenListText(t, bl, null) ? null : i)).filter((i) => i != null);
    expect(visibleListIndices(texts, bl, null)).toEqual(expected);
    expect(expected).toEqual([0]);
  });
});

test("listFilterOf／filterSummary：讀 view 當下的名單", () => {
  const view = { blacklist: parseBlacklist("Bob\ncarol"), titleBlacklist: parseTitleBlacklist("抽獎") };
  expect(listFilterOf(view)).toEqual({ blacklist: view.blacklist, titleKeywords: view.titleBlacklist });
  expect(listFilterOf(null)).toEqual({ blacklist: null, titleKeywords: null });
  expect(filterSummary(view)).toEqual({ authors: ["bob", "carol"], titleKeywords: ["抽獎"] });
  expect(filterSummary({})).toEqual({ authors: [], titleKeywords: [] });
});
