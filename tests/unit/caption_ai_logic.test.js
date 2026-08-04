// 好讀「左圖右文」AI 輔助配對的純函式守護。
// 回歸來源：使用者 debug 錄製檔（C_Chat「風俗店內花了60分鐘在打蚊子的客人」，
// cassette: tests/e2e/cassettes/cchat-caption-mosquito.json）——翻譯被空行切成
// 4 段，現行規則只配到第一段（症狀：圖文並排等於沒作用）。
import {
  groupImageCaptionBlocks,
} from "../../src/js/image_caption_group";
import {
  buildCaptionSpans,
  applyAiKeep,
  normalizeKeep,
  spanKey,
  spanNeedsAi,
  buildCaptionPrompt,
  captionKeepSchema,
  parseKeepReply,
  MAX_PARAGRAPHS,
} from "../../src/js/caption_ai_logic";

// 打蚊子篇第一組圖文（列號與 cassette 累積頁一致）。
const MOSQUITO = [
  " 作者  boss0322 (山羊先生)                     看板  C_Chat", // 0
  " 標題  [閒聊] 風俗店內花了60分鐘在打蚊子的客人", // 1
  " 時間  Tue Aug  4 08:21:04 2026", // 2
  "───────────────────────────────────────", // 3
  "", // 4
  "https://x.com/i/status/2083885084516712529", // 5 中性來源連結
  "", // 6
  "http://i.imgur.com/Z4gDlVE.jpg", // 7 圖行
  "", // 8
  "在某家風俗店裡，No.1 的紅牌小姐「佐露嗶醬（）」正在上班中。", // 9
  "", // 10
  "「……雖然很舒服，但對不起，總覺得哪裡好癢。」", // 11
  "「哎呀？」", // 12
  "「啊！有蚊子！！」", // 13
  "「可惡，被牠逃了。」（啪！）", // 14
  "「佐露嗶醬，牠往那邊飛過去了。」", // 15
  "「這次往那邊飛了！」（啪！）", // 16
  "「啊！打死了！」", // 17
  "", // 18
  "60 分鐘方案結束。", // 19
  "", // 20
  "「……等等，我覺得好像還有另外一隻。」", // 21
  "「因為這棟是老建築了嘛……（我去跟工作人員商量一下……）」", // 22
  "為了點蚊香而延長時間。最後順利滿足地回家了", // 23
  "", // 24
  "https://x.com/i/status/2084243767125774592", // 25 下一組的來源連結（中性）
  "http://i.imgur.com/456CKaj.jpg", // 26 下一張圖
  "", // 27
  "某家風俗店，今天的客人……", // 28
  "「嗚哇啊啊啊！那個混蛋××××到底把我當成什麼了……氣死我了！」", // 29
  "", // 30
  "--", // 31 截斷
];

describe("buildCaptionSpans：打蚊子篇（回歸案）", () => {
  const spans = buildCaptionSpans(MOSQUITO, "imageFirst");

  test("首圖切出 4 個候選段，中性來源連結自成一段被丟棄", () => {
    expect(spans.map((s) => s.imageRow)).toEqual([7, 26]);
    const first = spans[0];
    expect(first.paragraphs).toEqual([
      { start: 9, end: 9 },
      { start: 11, end: 17 },
      { start: 19, end: 19 },
      { start: 21, end: 23 },
    ]);
    // row 25 的 x.com 是下一張圖的來源連結，整段中性 → 不進候選。
    expect(first.texts[3]).toContain("為了點蚊香");
  });

  test("現行規則只取第一段（症狀本體），且候選區已封閉、可交給 AI", () => {
    expect(spans[0].ruleKeep).toBe(1);
    expect(spans[0].ruleBlock).toEqual({
      imageRow: 7,
      captionStart: 9,
      captionEnd: 9,
    });
    expect(spans[0].aiEligible).toBe(true);
    expect(spans[0].closed).toBe(true);
    expect(spanNeedsAi(spans[0])).toBe(true);
  });

  test("AI 判 keep=4 → 整段翻譯併進右欄（row 9~23）", () => {
    const rule = groupImageCaptionBlocks(MOSQUITO, "imageFirst");
    const out = applyAiKeep(rule, spans, { 7: 4 });
    expect(out[0]).toEqual({ imageRow: 7, captionStart: 9, captionEnd: 23 });
    // 第二張圖沒給 keep → 沿用規則結果，不受影響。
    expect(out[1]).toEqual(rule[1]);
  });

  test("AI 判 keep=0 → 該圖不配對（寧少配不誤配那一側）", () => {
    const rule = groupImageCaptionBlocks(MOSQUITO, "imageFirst");
    const out = applyAiKeep(rule, spans, { 7: 0 });
    expect(out.map((b) => b.imageRow)).toEqual([26]);
  });
});

// 既有規則測試的全部輸入（tests/unit/image_caption_group.test.js 的素材）：
// 用來守「AI 不介入時輸出與規則逐位元組相同」。
const IMG1 = "https://i.imgur.com/aaa111.jpg";
const IMG2 = "https://i.imgur.com/bbb222.jpg";
const IMG3 = "https://i.imgur.com/ccc333.png";
const CORPUS = [
  MOSQUITO,
  ["作者 someone (nick) 看板 C_Chat", "這是前導心得文字", "", IMG1, "翻譯第一句", "翻譯第二句", "", IMG2, "第二張的翻譯"],
  [IMG1, "", "段落一", "", "段落二", "", IMG2, "字"],
  [IMG1, "step: 35  mu: 0.0", "", "整體心得結語與圖無關", "補充說明也無關", "--"],
  [IMG1, IMG2, "只有第二張有翻譯"],
  [IMG1, "翻譯", "來源：https://i.imgur.com/src.jpg", IMG2, "字"],
  [IMG1, "翻譯", "--", IMG2, "簽名檔裡的字"],
  [IMG1, "翻譯", IMG2, "第二張翻譯", "", "-----", "Sent from JPTT on my Samsung SM-S9380."],
  [IMG1, "翻譯", "推 someuser: 推翻譯 06/13 12:01", IMG2, "推文區貼的圖不分組"],
  [IMG1, "→ tony : 這只是內文引用", IMG2, "字"],
  [IMG1, "翻譯", "https://x.com/SomeAuthor/status/123456", IMG3, "字"],
  [IMG1, "上文", "https://youtu.be/dQw4w9WgXcQ", "下文"],
  ["  " + IMG1 + "   ", "翻譯"],
  [IMG1, "abc  ", "中文四字", IMG2, "mix中1  "],
  ["純文字", "", "還是文字"],
  [IMG1, null, undefined, "字"],
  ["翻譯第一句", "翻譯第二句", "", IMG1, "第二張的翻譯", IMG2, "後記文字（不屬於任何塊）"],
  ["", "段落一", "", "段落二", "", IMG1],
  [
    "前言：模型介紹與工作流討論",
    "所以工作流中的 Guider 可能需要改",
    "",
    "在我的環境下 相同種子下各設定值的生成速度",
    "*(時間為該設定值重複運行十次取最佳值)",
    "",
    "原生Ideogram V4 NVFP4",
    "quality設定值 生成時間為Default的 194%時間",
    "  step: 35  mu: 0.0  std: 1.5",
    IMG1,
    "",
    "原生Ideogram V4 NVFP4",
    "Default設定值 代表基準值 (100%)",
    IMG2,
  ],
  ["說明段", "", IMG1],
  ["", "", IMG1],
  ["只有第一張有翻譯", IMG1, IMG2],
  ["翻譯", "https://x.com/SomeAuthor/status/123456", IMG1, "字", IMG2],
  ["上文", "https://youtu.be/dQw4w9WgXcQ", "下文", IMG1],
  ["翻譯", "--", "簽名檔字", IMG1],
  ["翻譯", "推 someuser: 推 06/13 12:01", "字", IMG1],
  ["翻譯", IMG1, "--", "字", IMG2],
  [
    " 作者  boss0322 (山羊先生)",
    "看板  C_Chat",
    " 標題  [蛋頭] 可以介紹你哥給我認識嗎",
    " 時間  Mon Jul 13 21:35:07 2026",
    "═══════════════════════════",
    "",
    "https://x.com/i/status/123",
    "",
    IMG1,
    "「這是你哥？」",
    IMG2,
  ],
];

describe("零回歸不變量", () => {
  for (const direction of ["imageFirst", "captionFirst"]) {
    test(`AI 不介入時 applyAiKeep 恆等於規則輸出（${direction}）`, () => {
      for (const rows of CORPUS) {
        const rule = groupImageCaptionBlocks(rows, direction);
        const spans = buildCaptionSpans(rows, direction);
        expect(applyAiKeep(rule, spans, {})).toEqual(rule);
        expect(applyAiKeep(rule, spans, null)).toEqual(rule);
      }
    });

    test(`每張圖的 ruleKeep 都能重建出規則原塊（aiEligible 全 true，${direction}）`, () => {
      for (const rows of CORPUS) {
        const spans = buildCaptionSpans(rows, direction);
        for (const s of spans) {
          expect({ rows: rows[s.imageRow], ok: s.aiEligible }).toEqual({
            rows: rows[s.imageRow],
            ok: true,
          });
          // ruleKeep 對應的塊必須就是規則塊。
          const rebuilt = applyAiKeep(
            groupImageCaptionBlocks(rows, direction),
            [s],
            { [s.imageRow]: s.ruleKeep },
          ).find((b) => b.imageRow === s.imageRow);
          expect(rebuilt || null).toEqual(s.ruleBlock);
        }
      }
    });
  }

  test("aiEligible=false 的塊完全沿用規則結果（AI 值被忽略）", () => {
    const rows = [IMG1, "翻譯一", "", "翻譯二"];
    const rule = groupImageCaptionBlocks(rows, "imageFirst");
    const spans = buildCaptionSpans(rows, "imageFirst");
    spans[0].aiEligible = false;
    expect(applyAiKeep(rule, spans, { 0: 2 })).toEqual(rule);
  });
});

describe("候選區封閉性（好讀逐頁累積）", () => {
  test("最後一張圖之後還沒撞到邊界 → closed=false，不送 AI", () => {
    // 文章載到一半：沒有下一張圖、也沒有 -- / 推文。
    const rows = [IMG1, "翻譯一", "", "翻譯二"];
    const spans = buildCaptionSpans(rows, "imageFirst");
    expect(spans[0].closed).toBe(false);
    expect(spanNeedsAi(spans[0])).toBe(false);
    // 載完（撞到簽名檔）→ 封閉。
    const done = buildCaptionSpans([...rows, "", "--"], "imageFirst");
    expect(done[0].closed).toBe(true);
    expect(spanNeedsAi(done[0])).toBe(true);
  });

  test("captionFirst 的候選區恆封閉（遠邊界是已載入的圖行）", () => {
    const spans = buildCaptionSpans(["說明", "", "更多說明", IMG1], "captionFirst");
    expect(spans[0].closed).toBe(true);
    expect(spans[0].texts[0]).toBe("更多說明"); // 由近而遠
  });

  test("只有一段候選 / 規則已取滿 → 沒有可改空間，不送 AI", () => {
    const one = buildCaptionSpans([IMG1, "只有一段", "--"], "imageFirst");
    expect(spanNeedsAi(one[0])).toBe(false);
  });
});

describe("keep 值檢核與 cache key", () => {
  const spans = buildCaptionSpans(MOSQUITO, "imageFirst");
  const span = spans[0];

  test("非整數／超界／NaN 一律退回 ruleKeep", () => {
    expect(normalizeKeep(span, 3)).toBe(3);
    expect(normalizeKeep(span, 0)).toBe(0);
    expect(normalizeKeep(span, 4)).toBe(4);
    expect(normalizeKeep(span, 5)).toBe(span.ruleKeep);
    expect(normalizeKeep(span, -1)).toBe(span.ruleKeep);
    expect(normalizeKeep(span, 2.5)).toBe(span.ruleKeep);
    expect(normalizeKeep(span, NaN)).toBe(span.ruleKeep);
    expect(normalizeKeep(span, "3")).toBe(span.ruleKeep);
    expect(normalizeKeep(span, undefined)).toBe(span.ruleKeep);
  });

  test("spanKey 內容相同即相同（翻頁重算不重複推論）、內容變即改變", () => {
    const again = buildCaptionSpans(MOSQUITO, "imageFirst");
    expect(spanKey(again[0])).toBe(spanKey(span));
    expect(spanKey(spans[1])).not.toBe(spanKey(span));
    const grown = buildCaptionSpans(
      [...MOSQUITO.slice(0, 23), "新增的一行", ...MOSQUITO.slice(23)],
      "imageFirst",
    );
    expect(spanKey(grown[0])).not.toBe(spanKey(span));
    // 方向不同的 key 不互相污染。
    const cf = buildCaptionSpans(MOSQUITO, "captionFirst");
    if (cf.length) expect(spanKey(cf[0]).startsWith("c")).toBe(true);
  });
});

describe("prompt 與回覆解析", () => {
  const span = buildCaptionSpans(MOSQUITO, "imageFirst")[0];

  test("prompt 含編號候選段、圖片 URL 與 0-N 的作答範圍", () => {
    const p = buildCaptionPrompt(span);
    expect(p).toContain("http://i.imgur.com/Z4gDlVE.jpg");
    expect(p).toContain("[1] 在某家風俗店裡");
    expect(p).toContain("[4] ");
    expect(p).toContain('{"keep": <integer 0-4>}');
    expect(p).toContain("right after the image");
    // 2026-08 實測的兩個失敗都是負例（模型往外多吃「作者對讀者說話」那段）→
    // 停止規則寫成可辨識的情境 ＋ few-shot。守著別被改回一句但書。
    expect(p).toContain("starts talking to the readers");
    expect(p).toContain("the answer is 0");
    expect(p.split("\n").filter((l) => l.startsWith("- [1] ")).length).toBe(3);
    // few-shot 不得取自評估語料（tools/caption-ai-cases.json）——考題外洩會讓
    // 評估頁的分數虛高。
    expect(p).not.toContain("以上就是這次的翻譯");
    expect(p).not.toContain("接下來講一下這次改版");
  });

  test("captionFirst 的 prompt 說明「段落 1 是最靠近圖的上方那段」", () => {
    const cf = buildCaptionSpans(["前言", "", "說明", IMG1], "captionFirst")[0];
    expect(buildCaptionPrompt(cf)).toContain("immediately above the image");
  });

  test("超長段落截斷、段數上限", () => {
    const long = "字".repeat(500);
    const rows = [IMG1, long, "", "二", "", "三", "", "四", "", "五", "", "六", "", "七", "", "八", "", "九", "", "--"];
    const s = buildCaptionSpans(rows, "imageFirst")[0];
    const p = buildCaptionPrompt(s);
    expect(p).toContain("…");
    expect(p.split("\n").filter((l) => /^\[\d+\] /.test(l)).length).toBe(
      MAX_PARAGRAPHS,
    );
    expect(captionKeepSchema(s).properties.keep.maximum).toBe(MAX_PARAGRAPHS);
  });

  test("schema 約束 keep 的上下界", () => {
    expect(captionKeepSchema(span)).toEqual({
      type: "object",
      properties: { keep: { type: "integer", minimum: 0, maximum: 4 } },
      required: ["keep"],
      additionalProperties: false,
    });
  });

  test("parseKeepReply 吃 JSON、裸數字、垃圾", () => {
    expect(parseKeepReply('{"keep": 3}')).toBe(3);
    expect(parseKeepReply('  {"keep":0}\n')).toBe(0);
    expect(parseKeepReply("4")).toBe(4);
    expect(parseKeepReply("keep = 2 paragraphs")).toBe(2);
    expect(parseKeepReply(2)).toBe(2);
    expect(parseKeepReply("沒有數字")).toBe(null);
    expect(parseKeepReply(null)).toBe(null);
    expect(parseKeepReply({})).toBe(null);
  });
});
