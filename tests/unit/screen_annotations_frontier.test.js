// 好讀累積長頁增量標註的「前沿快路徑」（src/js/screen_annotations.js 的 fastFrom ／
// annotationFrontier，docs/easy-reading.md「長頁分塊」支柱 C）。
//
// 快路徑讓每頁只算前沿之後的列：前綴的最終標註（含推文合併、跨行網址的裝飾）整段
// 沿用上一幀的物件。它最怕的是**前沿算錯**——某個跨列耦合其實會被新列改到前沿之前的
// 列，結果就是靜默畫出過期的標註（推文合併少一則、跨行網址斷掉、文末補白不消失）。
// 所以這裡用「固定種子的隨機文章 × 隨機頁長逐頁 append」逐幀對照「同一份 lines 從頭
// 全量算」，任何一幀任何一列不同就紅。素材刻意把每一種跨列耦合都放到頁邊界附近：
//   同作者推文 run 跨頁、黑名單列夾在 run 中間（透明）、推文區裡的非推文列（斷 run）、
//   內文跨行網址鏈（兩列與三列）、文末空白列（手機補白）、AI 候選（裸網域／灰色修復）、
//   圖文塊（前言段）。
// 另外鎖兩件事：快路徑真的有走到（否則這支測試等於只測了全量路徑），以及前綴
// 真的是上一幀同一批物件（renderer 的節點快路徑靠這個身分）。
import { row, seg, color } from "./helpers/screen_fixtures";
import { computeAnnotations } from "../../src/js/screen_annotations";
import { spliceShape } from "../../src/js/screen_annotate_cache";

// 決定性 PRNG（mulberry32）。
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MAXCOL = 77; // pmoreMaxCol(80)
const pad80 = (s) => row(seg(s.padEnd(80).slice(0, 80)));
const push = (type, uid, text, mm) =>
  row(seg(type + " " + uid + ": " + text, color(2, 0)), seg("  08/09 22:" + mm));
// 真實 PTT 推文的形狀：時間戳靠右，最後一格剛好落在 maxcol（是 URL 字元）。這種列對
// 跨行網址偵測是 skip 列，前沿不可因為它「寫滿 maxcol」就當成還開著的網址鏈
// （回歸：真 app 裡每一則推文都把前沿拉回第一則推文，快路徑從不生效）。
const pushFull = (type, uid, text, mm) => {
  const head = type + " " + uid + ": " + text;
  let cols = 0;
  for (const ch of head) cols += ch.charCodeAt(0) > 0x7f ? 2 : 1; // 全形 2 欄
  return row(
    seg(head, color(2, 0)),
    seg(" ".repeat(Math.max(1, MAXCOL + 1 - 11 - cols)) + "08/09 22:" + mm),
  );
};

// 一條被切成 k 列的內文網址：左片段收在 maxcol，中段整列寫滿，末段不滿。
function wrappedUrl(r, k) {
  const out = [];
  const left = "https://www.ptt.cc/bbs/Test/M.17880" + Math.floor(r() * 1e5) + ".A.";
  out.push(pad80(" ".repeat(MAXCOL + 1 - left.length) + left));
  for (let i = 0; i < k - 2; ++i) out.push(pad80("x".repeat(MAXCOL + 1)));
  out.push(pad80("ABC.html"));
  return out;
}

function makeArticle(seed, total, fullPush = false) {
  const r = rng(seed);
  const rows = [
    pad80("作者  poster (暱稱) 看板  Test"),
    pad80("標題  [測試] 前沿快路徑"),
    pad80("時間  Sat Aug  9 22:00:00 2026"),
    pad80(""),
  ];
  // 前言段：圖＋說明（圖文塊）、跨行網址、裸網域
  for (let i = 0; i < 3; ++i) {
    rows.push(pad80("https://i.imgur.com/cap" + i + ".jpg"));
    rows.push(pad80("說明第 " + i + " 段"));
    rows.push(pad80(""));
  }
  rows.push(...wrappedUrl(r, 2));
  rows.push(pad80("看看 example.com 這個站"));
  rows.push(pad80("--"));
  rows.push(pad80("※ 發信站: 批踢踢實業坊(ptt.cc), 來自: 1.2.3.4"));
  const authors = ["alpha1", "alpha1", "beta22", "badguy", "gamma3", "poster"];
  let uid = "alpha1";
  let i = 0;
  while (rows.length < total) {
    const x = r();
    const mm = String((i++ % 59) + 1).padStart(2, "0");
    if (fullPush) {
      // 整段都是真實形狀的推文（含黑名單）：最接近一般熱門文的推文區。
      if (r() < 0.4) uid = authors[Math.floor(r() * authors.length)];
      rows.push(pushFull(r() < 0.8 ? "推" : "→", uid, "留言 " + i, mm));
    } else if (x < 0.55) {
      // 同作者機率高 ⇒ run 會跨頁
      if (r() < 0.4) uid = authors[Math.floor(r() * authors.length)];
      const t = r() < 0.08 ? "看 example.org 吧" : r() < 0.05 ? "https: //i.imgur.com/fx" + i + ".png" : "留言 " + i;
      rows.push((fullPush || r() < 0.5 ? pushFull : push)(r() < 0.8 ? "推" : "→", uid, t, mm));
    } else if (x < 0.62) {
      rows.push(push("推", "badguy", "黑名單 " + i, mm));
    } else if (x < 0.72) {
      rows.push(pad80("edit reply line " + i));
    } else if (x < 0.8) {
      rows.push(...wrappedUrl(r, r() < 0.5 ? 2 : 3));
    } else if (x < 0.9) {
      rows.push(pad80(""));
    } else {
      rows.push(push("推", uid, "接續 " + i, mm));
    }
  }
  return rows.slice(0, total);
}

const enhanceFor = (o) => ({
  blacklist: new Set(["badguy"]),
  titleBlacklist: [],
  showFloorNumbers: true,
  highlightAuthor: true,
  articleAuthor: "poster",
  autoFixUrl: o.autoFixUrl,
  bareDomainLink: true,
  enableXMention: true,
  mergeSameAuthorComments: o.merge,
  commentCards: o.cards,
  pageState: 3,
  easyReading: true,
  dropHidden: true,
  stableRows: true,
  articleId: 1,
});

// 序列化：函式（onClick 閉包、TermChar 方法）略過，其餘逐欄比。
const ser = (v) =>
  JSON.stringify(v, (k, x) => (typeof x === "function" ? undefined : x));
const extras = (a) => ({
  hasLitHidden: a.hasLitHidden,
  hasErasedHidden: a.hasErasedHidden,
  imageCaptionBlockCount: a.imageCaptionBlockCount,
  captionMaxCols: a.captionMaxCols,
  domainCandsSig: a.domainCandsSig,
  fixCandsSig: a.fixCandsSig,
  domainCands: ser(a.domainCands),
  fixCands: ser(a.fixCands),
});

const OPTION_SETS = [
  { merge: true, autoFixUrl: true, cards: false, mergeCaption: "imageFirst" },
  { merge: true, autoFixUrl: true, cards: true, mergeCaption: null },
  { merge: false, autoFixUrl: true, cards: true, mergeCaption: null },
  { merge: true, autoFixUrl: false, cards: false, mergeCaption: "captionFirst" },
  { merge: true, autoFixUrl: true, cards: false, mergeCaption: null, fullPush: true },
];

describe("前沿快路徑：逐頁 append 與全量重算逐列相同", () => {
  for (const [oi, o] of OPTION_SETS.entries()) {
    for (const seed of [1, 7, 42]) {
      test(`選項組 ${oi}／種子 ${seed}`, () => {
        const full = makeArticle(seed * 31 + oi, 700, !!o.fullPush);
        const enhance = enhanceFor(o);
        const r = rng(seed);
        let prev = null; // { lines, cache, annotations }
        let fastFrames = 0;
        let frames = 0;
        let maxTail = 0;
        for (let end = 20; ; ) {
          const lines = full.slice(0, end);
          let reuse = null;
          let shape = null;
          if (prev) {
            shape = spliceShape(prev.lines, lines);
            if (shape && shape.removed === 0 && shape.suffix === 0) reuse = prev.cache;
            else shape = null;
          }
          const inc = computeAnnotations(lines, enhance, o.mergeCaption, false, {}, {}, {}, reuse, shape);
          const ref = computeAnnotations(lines, enhance, o.mergeCaption, false, {}, {}, {}, null, null);
          for (let row = 0; row < lines.length; ++row) {
            const a = ser(inc.annotations[row]);
            const b = ser(ref.annotations[row]);
            if (a !== b) expect({ end, row, a }).toEqual({ end, row, a: b });
          }
          expect(extras(inc.annotations)).toEqual(extras(ref.annotations));
          if (inc.stablePrefix > 0) {
            ++fastFrames;
            maxTail = Math.max(maxTail, lines.length - inc.stablePrefix);
            for (let row = 0; row < inc.stablePrefix; ++row)
              expect(inc.annotations[row]).toBe(prev.annotations[row]);
          }
          ++frames;
          prev = { lines, cache: inc.cache, annotations: inc.annotations };
          if (end >= full.length) break;
          end = Math.min(full.length, end + 1 + Math.floor(r() * 30));
        }
        // 正向對照：快路徑真的有走到（推文區開始之後幾乎每一幀都該走）
        expect(fastFrames).toBeGreaterThan(frames * 0.5);
        expect(maxTail, "快路徑每幀重算的尾段應是常數級").toBeLessThan(120);
      });
    }
  }
});

describe("前沿的邊界情形", () => {
  const o = OPTION_SETS[0];
  const run = (lines, steps) => {
    let prev = null;
    let out = null;
    for (const end of steps) {
      const ls = lines.slice(0, end);
      const shape = prev ? spliceShape(prev.lines, ls) : null;
      out = computeAnnotations(ls, enhanceFor(o), o.mergeCaption, false, {}, {}, {}, prev ? prev.cache : null, shape);
      prev = { lines: ls, cache: out.cache };
    }
    return out;
  };

  test("還沒出現任何推文（圖文塊未定型）⇒ 不走快路徑", () => {
    const lines = makeArticle(3, 40).slice(0, 12);
    const out = run(lines, [6, 9, 12]);
    expect(out.stablePrefix).toBe(0);
  });

  test("run 跨頁：上一頁最後一則與下一頁第一則同作者 ⇒ 合併塊涵蓋兩頁", () => {
    const head = makeArticle(5, 40).slice(0, 19);
    const tail = [];
    for (let i = 0; i < 6; ++i) tail.push(push("推", "zeta99", "第 " + i + " 則", "0" + i));
    const lines = head.concat(tail);
    const out = run(lines, [head.length + 3, lines.length]);
    expect(out.stablePrefix).toBeGreaterThan(0);
    const first = head.length;
    expect(out.annotations[first].mergeCommentRun).toBeTruthy();
    for (let i = 1; i < 6; ++i) expect(out.annotations[first + i].mergedIntoComment).toBe(first);
  });

  test("跨行網址鏈跨頁：左片段在上一頁最後一列 ⇒ 下一頁接上後三列同一條連結", () => {
    // 要含簽名線與推文（圖文塊定型）快路徑才會走；最後一幀斷言它真的走了。
    const head = makeArticle(9, 40).slice(0, 19).concat([push("推", "omega1", "x", "01")]);
    const chain = wrappedUrl(rng(1), 3);
    const lines = head.concat(chain, [pad80("after")]);
    const out = run(lines, [head.length, head.length + 1, head.length + 2, lines.length]);
    expect(out.stablePrefix).toBeGreaterThan(0);
    const hrefs = [0, 1, 2].map((k) => {
      const w = out.annotations[head.length + k].wrapUrls;
      return w && w[0].href;
    });
    expect(hrefs[0]).toBeTruthy();
    expect(new Set(hrefs).size).toBe(1);
  });
});
