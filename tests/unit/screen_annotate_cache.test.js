// 好讀累積頁增量重算的判準（src/js/screen_annotate_cache.js）。
// 這層錯了會有兩種災難：判太鬆 ⇒ 換文章／缺頁自癒後沿用上一篇的標註；判太嚴 ⇒
// 退回每頁全量重算，效能問題原封不動。兩個方向都在這裡釘住。

import {
  reusablePrefix,
  isAppendOnly,
  annotationsKey,
  sameKey,
  mergeRunKey
} from "../../src/js/screen_annotate_cache";

// 列物件只比參考，內容無關緊要 —— 用最廉價的 sentinel。
const rows = n => Array.from({ length: n }, (_, i) => ({ id: i }));

describe("reusablePrefix / isAppendOnly", () => {
  test("純 append（好讀翻頁）：前綴 == 舊長度", () => {
    const prev = rows(5);
    const next = prev.concat(rows(3));
    expect(reusablePrefix(prev, next)).toBe(5);
    expect(isAppendOnly(prev, next)).toBe(true);
  });

  test("同一份陣列重繪（強制 redraw、pusher 高亮）也算 append", () => {
    const prev = rows(5);
    expect(isAppendOnly(prev, prev.slice())).toBe(true);
  });

  test("rebuild（換文章／Home 自癒重讀）：全新列物件 ⇒ 前綴 0", () => {
    const prev = rows(5);
    expect(reusablePrefix(prev, rows(5))).toBe(0);
    expect(isAppendOnly(prev, rows(5))).toBe(false);
  });

  test("中途換掉某一列（非 append）⇒ 不可重用", () => {
    const prev = rows(5);
    const next = prev.slice();
    next[3] = { id: 3 }; // 內容相同但是新物件
    expect(reusablePrefix(prev, next)).toBe(3);
    expect(isAppendOnly(prev, next)).toBe(false);
  });

  test("變短（列表視窗、functionMode 原生 24 列鏡像）⇒ 不可重用", () => {
    const prev = rows(30);
    expect(isAppendOnly(prev, prev.slice(0, 24))).toBe(false);
  });

  test("空的一邊不炸", () => {
    expect(reusablePrefix(null, rows(3))).toBe(0);
    expect(isAppendOnly(rows(3), null)).toBe(false);
    expect(isAppendOnly([], rows(3))).toBe(true);
  });
});

describe("annotationsKey / sameKey", () => {
  const onAidClick = () => {};
  const over = () => {};
  const out = () => {};
  const base = () => ({
    enhance: {
      blacklist: new Set(["bad"]),
      titleBlacklist: ["廣告"],
      showFloorNumbers: true,
      highlightAuthor: true,
      articleAuthor: "poster",
      selectedPusher: null,
      pageState: 3,
      autoFixUrl: true,
      bareDomainLink: true,
      easyReading: true,
      enableXMention: true,
      mergeSameAuthorComments: true,
      inListContext: false,
      listEasyReading: false,
      dropHidden: true,
      onAidClick
    },
    mergeCaption: null,
    captionAi: false,
    aiKeep: {},
    aiLink: {},
    aiFix: {},
    forceWidth: 16,
    enableLinkInlinePreview: true,
    enableLinkHoverPreview: false,
    onHyperLinkMouseOver: over,
    onHyperLinkMouseOut: out
  });

  test("同樣的輸入 ⇒ 同一把鑰匙（即使 Set/Array 是新建的）", () => {
    expect(sameKey(annotationsKey(base()), annotationsKey(base()))).toBe(true);
  });

  test("黑名單內容變了 ⇒ 失效（參考相同與否無關）", () => {
    const b = base();
    b.enhance.blacklist = new Set(["bad", "worse"]);
    expect(sameKey(annotationsKey(base()), annotationsKey(b))).toBe(false);
  });

  test("黑名單只是順序不同 ⇒ 仍算同一把（排序後比對）", () => {
    const a = base();
    a.enhance.blacklist = new Set(["a", "b"]);
    const b = base();
    b.enhance.blacklist = new Set(["b", "a"]);
    expect(sameKey(annotationsKey(a), annotationsKey(b))).toBe(true);
  });

  // 逐項守護：漏掉任何一個欄位就會出現「改了設定畫面不變」的鬼故事。
  test.each([
    ["showFloorNumbers", e => (e.showFloorNumbers = false)],
    ["highlightAuthor", e => (e.highlightAuthor = false)],
    ["articleAuthor", e => (e.articleAuthor = "other")],
    ["selectedPusher", e => (e.selectedPusher = "someone")],
    ["pageState", e => (e.pageState = 2)],
    ["autoFixUrl", e => (e.autoFixUrl = false)],
    ["bareDomainLink", e => (e.bareDomainLink = false)],
    ["easyReading", e => (e.easyReading = false)],
    ["enableXMention", e => (e.enableXMention = false)],
    ["mergeSameAuthorComments", e => (e.mergeSameAuthorComments = false)],
    ["inListContext", e => (e.inListContext = true)],
    ["listEasyReading", e => (e.listEasyReading = true)],
    ["dropHidden", e => (e.dropHidden = false)],
    ["titleBlacklist", e => (e.titleBlacklist = ["其他"])]
  ])("enhance.%s 變動 ⇒ 失效", (_name, mutate) => {
    const b = base();
    mutate(b.enhance);
    expect(sameKey(annotationsKey(base()), annotationsKey(b))).toBe(false);
  });

  test.each([
    ["mergeCaption", b => (b.mergeCaption = "imageFirst")],
    ["captionAi", b => (b.captionAi = true)],
    ["aiKeep", b => (b.aiKeep = { "k": 1 })],
    ["aiLink", b => (b.aiLink = { "d": false })],
    ["aiFix", b => (b.aiFix = { "f": true })],
    ["forceWidth", b => (b.forceWidth = 18)],
    ["enableLinkInlinePreview", b => (b.enableLinkInlinePreview = false)],
    ["enableLinkHoverPreview", b => (b.enableLinkHoverPreview = true)]
  ])("%s 變動 ⇒ 失效", (_name, mutate) => {
    const b = base();
    mutate(b);
    expect(sameKey(annotationsKey(base()), annotationsKey(b))).toBe(false);
  });

  // 這三個是閉包，字串化不了：AID 點擊會被包進 aids[].onClick、hover handler 會被
  // 包進 <a onMouseOver>，換了參考就得重建元素。
  test.each([
    ["onAidClick", b => (b.enhance.onAidClick = () => {})],
    ["onHyperLinkMouseOver", b => (b.onHyperLinkMouseOver = () => {})],
    ["onHyperLinkMouseOut", b => (b.onHyperLinkMouseOut = () => {})]
  ])("%s 換了參考 ⇒ 失效", (_name, mutate) => {
    const b = base();
    mutate(b);
    expect(sameKey(annotationsKey(base()), annotationsKey(b))).toBe(false);
  });

  test("currentHighlighted 刻意不在鑰匙裡（只影響兩列，由呼叫端逐列處理）", () => {
    const key = annotationsKey(base());
    expect(key.sig).not.toMatch(/highlight(ed)?\b/i);
  });

  test("沒有 enhance 也不炸", () => {
    expect(() => annotationsKey({})).not.toThrow();
    expect(sameKey(annotationsKey({}), annotationsKey({}))).toBe(true);
  });

  test("sameKey 對 null 保守回 false（寧可重算）", () => {
    expect(sameKey(null, annotationsKey(base()))).toBe(false);
    expect(sameKey(annotationsKey(base()), null)).toBe(false);
  });
});

describe("mergeRunKey", () => {
  test("同作者同列組 ⇒ 同一把", () => {
    expect(mergeRunKey({ userid: "a", rows: [3, 4, 5] })).toBe(
      mergeRunKey({ userid: "a", rows: [3, 4, 5] })
    );
  });

  test("run 往後長一列（推文邊界剛好被翻頁切開）⇒ 不同", () => {
    expect(mergeRunKey({ userid: "a", rows: [3, 4] })).not.toBe(
      mergeRunKey({ userid: "a", rows: [3, 4, 5] })
    );
  });

  test("換作者 ⇒ 不同", () => {
    expect(mergeRunKey({ userid: "a", rows: [3, 4] })).not.toBe(
      mergeRunKey({ userid: "b", rows: [3, 4] })
    );
  });

  test("列不連續（中間夾黑名單 hidden 列）也算進身分", () => {
    expect(mergeRunKey({ userid: "a", rows: [3, 5] })).not.toBe(
      mergeRunKey({ userid: "a", rows: [3, 4] })
    );
  });
});
