// 裸網域 AI 複核的純函式守護（src/js/url_ai_logic.js）。核心是**單向收縮**契約：
// 規則層預設連，AI 只能撤掉；任何「沒有明確 false」的情況都必須保留連結，
// 所以 AI 關閉／不支援／逾時的結果恆等於純規則結果。
import {
  applyAiFix,
  applyAiLink,
  buildBrokenUrlPrompt,
  buildDomainPrompt,
  candNeedsAi,
  domainKey,
  domainLinkSchema,
  fixCandNeedsAi,
  fixKey,
  parseLinkReply,
  urlAiSystemPrompt,
  urlFixSystemPrompt,
  MAX_LINE_CHARS
} from "../../src/js/url_ai_logic";

const cand = (host, rowText, gray = true) => ({
  startCol: 0,
  endCol: host.length,
  host,
  href: "https://" + host,
  gray,
  rowText
});

const gray = cand("indiegametw.com", "介紹台灣獨立遊戲的 indiegametw.com");
const strong = cand("a.b.example.com", "看 a.b.example.com", false);

describe("applyAiLink — 零回歸不變量（單向收縮）", () => {
  test("空 verdicts → 原封回傳（連引用都不換）", () => {
    const cands = [gray, strong];
    expect(applyAiLink(cands, {})).toBe(cands);
    expect(applyAiLink(cands, null)).toBe(cands);
    expect(applyAiLink(cands, undefined)).toBe(cands);
  });

  test("verdict true → 保留", () => {
    const cands = [gray];
    expect(applyAiLink(cands, { [domainKey(gray)]: true })).toEqual(cands);
  });

  test("verdict false → 移除（唯一會改變結果的情況）", () => {
    expect(applyAiLink([gray], { [domainKey(gray)]: false })).toEqual([]);
  });

  test("verdict 是垃圾值（null / 字串 / 數字）→ 保留", () => {
    for (const v of [null, undefined, "false", 0, ""]) {
      expect(applyAiLink([gray], { [domainKey(gray)]: v })).toEqual([gray]);
    }
  });

  test("非 gray 候選即使被判 false 也不撤（根本不該送 AI）", () => {
    expect(applyAiLink([strong], { [domainKey(strong)]: false })).toEqual([
      strong
    ]);
  });

  test("多候選只撤掉被判 false 的那個", () => {
    const other = cand("second.com", "另一個 second.com");
    const out = applyAiLink([gray, other], { [domainKey(gray)]: false });
    expect(out).toEqual([other]);
  });

  test("空陣列 / null 安全", () => {
    expect(applyAiLink([], { x: false })).toEqual([]);
    expect(applyAiLink(null, { x: false })).toBeNull();
  });
});

describe("candNeedsAi", () => {
  test("只有 gray 候選才送 AI", () => {
    expect(candNeedsAi(gray)).toBe(true);
    expect(candNeedsAi(strong)).toBe(false);
    expect(candNeedsAi(null)).toBe(false);
  });
});

describe("domainKey — 內容型 cache key", () => {
  test("同 host 同列 → 同 key（翻頁不重跑）", () => {
    expect(domainKey(gray)).toBe(domainKey({ ...gray }));
  });

  test("同 host 不同句子 → 不同 key（語意本來就不同）", () => {
    const a = cand("example.com", "推薦這個站 example.com");
    const b = cand("example.com", "那家公司 example.com 被收購了");
    expect(domainKey(a)).not.toBe(domainKey(b));
  });

  test("不同 host → 不同 key", () => {
    expect(domainKey(gray)).not.toBe(domainKey(cand("other.com", gray.rowText)));
  });

  test("缺 rowText 不炸", () => {
    expect(typeof domainKey({ host: "a.com" })).toBe("string");
  });
});

describe("prompt / schema / 解析", () => {
  test("system prompt 是英文指令（Prompt API 不支援中文語言標記）", () => {
    expect(urlAiSystemPrompt()).toMatch(/JSON only/);
  });

  test("prompt 含整列文字與候選 host", () => {
    const p = buildDomainPrompt(gray);
    expect(p).toContain("indiegametw.com");
    expect(p).toContain("介紹台灣獨立遊戲的");
  });

  test("過長的列被截斷（Nano context 有限）", () => {
    const long = cand("a.com", "字".repeat(MAX_LINE_CHARS + 50) + " a.com");
    const p = buildDomainPrompt(long);
    expect(p).toContain("…");
    expect(p.length).toBeLessThan(long.rowText.length + 1200);
  });

  test("缺 rowText 不炸", () => {
    expect(() => buildDomainPrompt({ host: "a.com" })).not.toThrow();
  });

  test("schema 鎖成單一 boolean", () => {
    expect(domainLinkSchema()).toEqual({
      type: "object",
      properties: { link: { type: "boolean" } },
      required: ["link"],
      additionalProperties: false
    });
  });

  test("parseLinkReply：合法 JSON", () => {
    expect(parseLinkReply('{"link": true}')).toBe(true);
    expect(parseLinkReply('{"link": false}')).toBe(false);
  });

  test("parseLinkReply：裸 boolean 與裸字串 fallback", () => {
    expect(parseLinkReply(true)).toBe(true);
    expect(parseLinkReply("false")).toBe(false);
    expect(parseLinkReply("The answer is TRUE.")).toBe(true);
  });

  test("parseLinkReply：解析不出來回 null（→ 保留連結）", () => {
    expect(parseLinkReply("I cannot help with that.")).toBeNull();
    expect(parseLinkReply('{"keep": 2}')).toBeNull();
    expect(parseLinkReply(null)).toBeNull();
    expect(parseLinkReply(42)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// URL 修復（url_fix.js）的 gray 候選，方向**相反**：規則層不敢認 → 預設不修，
// 只有 AI 明確答 true 才放行。保守側是「不要生出假連結」。
// ---------------------------------------------------------------------------
const fix = (original, fixed, rowText, gray = true) => ({
  original,
  fixed,
  host: fixed.replace(/^https?:\/\//, "").split(/[/:]/)[0].toLowerCase(),
  gray,
  rowText
});

const grayFix = fix(
  "Duty. It",
  "https://Duty.It",
  "The goal was to match a modern Call of Duty. It does not."
);
const solidFix = fix(
  "google .tw/page",
  "https://google.tw/page",
  "還有這種很機車的斷開：google .tw/page",
  false
);

describe("applyAiFix — 加法方向（規則預設不修，AI 才放行）", () => {
  test("空 verdicts → 只留非 gray（AI 關閉時的預設行為）", () => {
    expect(applyAiFix([grayFix, solidFix], {})).toEqual([solidFix]);
    expect(applyAiFix([grayFix, solidFix], null)).toEqual([solidFix]);
    expect(applyAiFix([grayFix, solidFix], undefined)).toEqual([solidFix]);
  });

  test("全部非 gray → 原封回傳（連引用都不換）", () => {
    const cands = [solidFix];
    expect(applyAiFix(cands, {})).toBe(cands);
    expect(applyAiFix(cands, { [fixKey(solidFix)]: false })).toBe(cands);
  });

  test("verdict true → 放行（唯一會讓 gray 出現的情況）", () => {
    expect(applyAiFix([grayFix], { [fixKey(grayFix)]: true })).toEqual([grayFix]);
  });

  test("verdict false / 缺席 / 垃圾值 → 一律不放行", () => {
    for (const v of [false, null, undefined, "true", 1, ""]) {
      expect(applyAiFix([grayFix], { [fixKey(grayFix)]: v })).toEqual([]);
    }
  });

  test("多候選只放行被判 true 的那個", () => {
    const other = fix("part. In", "https://part.In", "That was the best part. In fact…");
    const out = applyAiFix([grayFix, other], { [fixKey(grayFix)]: true });
    expect(out).toEqual([grayFix]);
  });

  test("空陣列 / null 安全", () => {
    expect(applyAiFix([], { x: true })).toEqual([]);
    expect(applyAiFix(null, { x: true })).toBeNull();
  });
});

describe("fixCandNeedsAi / fixKey", () => {
  test("只有 gray 候選才送 AI", () => {
    expect(fixCandNeedsAi(grayFix)).toBe(true);
    expect(fixCandNeedsAi(solidFix)).toBe(false);
    expect(fixCandNeedsAi(null)).toBe(false);
  });

  test("同內容 → 同 key（翻頁不重跑）", () => {
    expect(fixKey(grayFix)).toBe(fixKey({ ...grayFix }));
  });

  test("同 host 不同列 → 不同 key", () => {
    const a = fix("a. it", "https://a.It", "第一句 a. it 這樣");
    const b = fix("a. it", "https://a.It", "另一句 a. it 那樣");
    expect(fixKey(a)).not.toBe(fixKey(b));
  });

  // 兩個功能的判決不可共用：同一列的同一個 host，「該不該連」與「這到底是不是
  // 網址」是兩個問題，key 撞在一起會讓一邊的答案污染另一邊。
  test("與 domainKey 不撞（即使 host 與 rowText 完全相同）", () => {
    const row = "官網在這 example.com 記得看";
    expect(fixKey({ host: "example.com", original: "example.com", rowText: row })).not.toBe(
      domainKey({ host: "example.com", rowText: row })
    );
  });
});

describe("URL 修復的 prompt", () => {
  test("system prompt 是英文指令並點出 ccTLD 同形陷阱", () => {
    expect(urlFixSystemPrompt()).toMatch(/JSON only/);
    expect(urlFixSystemPrompt()).toMatch(/country domain/);
  });

  test("prompt 含整列文字、原始片段與修復後結果", () => {
    const p = buildBrokenUrlPrompt(grayFix);
    expect(p).toContain("Duty. It");
    expect(p).toContain("https://Duty.It");
    expect(p).toContain("a modern Call of Duty");
  });

  test("過長的列被截斷（Nano context 有限）", () => {
    const long = fix("a. it", "https://a.It", "字".repeat(MAX_LINE_CHARS + 50));
    expect(buildBrokenUrlPrompt(long)).toContain("…");
  });

  test("缺 rowText 不炸", () => {
    expect(() =>
      buildBrokenUrlPrompt({ original: "a. it", fixed: "https://a.It" })
    ).not.toThrow();
  });
});
