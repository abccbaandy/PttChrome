// 裸網域自動連結的裝置端 AI 複核**純函式層**（無 DOM / 無網路 / 不碰
// window.LanguageModel，unit test 直接跑 node env）。瀏覽器層見 url_ai.js。
//
// 為什麼需要這層：規則（bare_domain.js）判斷不出「這個網域是作者要讀者去點的
// 網站，還是只是句子裡被提到的名字」——兩者在文字上完全同形：
//   介紹台灣獨立遊戲的 indiegametw.com     ← 要連
//   這家公司後來被 example.com 收購了       ← 只是提到
// 規則只能靠位置訊號（系統行、括號、黑名單）擋掉最典型的提及型，剩下的靠語意。
//
// 契約（把 AI 的自由度壓到最小，且方向與 caption_ai 相反）：
//   - 規則層**預設連**（使用者要的功能在無 AI 環境完整可用）。
//   - AI 的輸出只有一個 boolean link；只有明確的 false 才**撤掉**規則已允許的
//     連結，true／缺席／解析失敗／逾時一律保留規則結果 → 單向收縮。
//   - 只有 gray（規則沒把握）的候選才送 AI，強訊號候選（www. 前綴、三段以上
//     子網域）連問都不問。
//
// 零回歸的結構性保證：applyAiLink(cands, {}) 恆等於 cands（unit 守護）。

// 送進 prompt 的整列文字上限（Nano context 有限，越長越容易漂）。
export const MAX_LINE_CHARS = 120;

// 這個候選是否值得送 AI。gray 由 bare_domain.js 依 host 形狀判定。
export function candNeedsAi(cand) {
  return !!(cand && cand.gray);
}

// 內容型 cache key（FNV-1a，同 caption_ai_logic.spanKey）：好讀翻頁會重算候選，
// 但同一列的內容不變 → key 不變 → 不重複推論。**必須含整列文字**：同一個 host
// 在不同句子裡的答案本來就該不同。
export function domainKey(cand) {
  let h = 0x811c9dc5;
  const s = cand.host + " " + (cand.rowText || "");
  for (let i = 0; i < s.length; ++i) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return cand.host + "-" + h.toString(36);
}

// 單向收縮：只有明確 false 才移除。verdicts 為空 → 原封回傳（引用也不換，避免
// React 端無謂的重繪）。
export function applyAiLink(cands, verdicts) {
  if (!cands || !cands.length || !verdicts) return cands;
  let drop = false;
  for (const c of cands) {
    if (candNeedsAi(c) && verdicts[domainKey(c)] === false) {
      drop = true;
      break;
    }
  }
  if (!drop) return cands;
  return cands.filter(
    (c) => !candNeedsAi(c) || verdicts[domainKey(c)] !== false,
  );
}

// 指令用英文：Prompt API 官方支援語言只有 en/ja/es/de/fr，中文不在清單內
// （developer.chrome.com/docs/ai/prompt-api）。內容維持原文中文。
const SYSTEM_PROMPT =
  "You read single lines from posts on a Taiwanese BBS (PTT). Authors often " +
  "type a website address without the https:// prefix. Sometimes that address " +
  "is a place the author wants readers to VISIT (a site being recommended, a " +
  "source to go read, the author's own page). Other times the domain is merely " +
  "MENTIONED as a name — the company or platform being talked about, a service " +
  "in a news story, an example, or part of the system's own signature. You " +
  "decide which one it is. Answer with JSON only.";

export function urlAiSystemPrompt() {
  return SYSTEM_PROMPT;
}

export function buildDomainPrompt(cand) {
  let line = (cand.rowText || "").trim();
  if (line.length > MAX_LINE_CHARS) line = line.slice(0, MAX_LINE_CHARS) + "…";
  const lines = [];
  lines.push("Line from the post:");
  lines.push(line);
  lines.push("");
  lines.push("Domain in question: " + cand.host);
  lines.push("");
  lines.push(
    "Is this domain something the author is pointing readers to, so it should " +
      "become a clickable link? Answer false when the domain is only being " +
      "named — the subject of the sentence, a company or service being " +
      "discussed, an example, or part of a signature or system notice.",
  );
  // few-shot 內容刻意與任何真實語料無關（拿語料當範例等於考題外洩）。
  lines.push("Examples:");
  lines.push(
    '- Line: 想找食譜的話推薦這個網站 cookpad-demo.com / Domain: cookpad-demo.com → {"link": true}',
  );
  lines.push(
    '- Line: 那家新創 foobar-corp.com 昨天宣布被收購了 / Domain: foobar-corp.com → {"link": false}',
  );
  lines.push(
    '- Line: 詳細規則寫在 rules-sample.org 大家自己去看 / Domain: rules-sample.org → {"link": true}',
  );
  lines.push('Reply as {"link": true} or {"link": false}.');
  return lines.join("\n");
}

// responseConstraint 用的 JSON schema（Prompt API structured output）。
export function domainLinkSchema() {
  return {
    type: "object",
    properties: { link: { type: "boolean" } },
    required: ["link"],
    additionalProperties: false,
  };
}

// 解析模型回覆 → boolean；解析不出來回 null（呼叫端保留規則結果 = 保留連結）。
// responseConstraint 理論上保證是合法 JSON，但 fallback 仍要能吃到裸 true/false。
export function parseLinkReply(reply) {
  if (typeof reply === "boolean") return reply;
  if (typeof reply !== "string") return null;
  try {
    const o = JSON.parse(reply);
    if (o && typeof o.link === "boolean") return o.link;
  } catch (e) {
    /* 落到下方裸字串比對 */
  }
  const m = reply.match(/\b(true|false)\b/i);
  return m ? m[1].toLowerCase() === "true" : null;
}
