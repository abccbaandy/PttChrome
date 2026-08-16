// 好讀「左圖右文」裝置端 AI 輔助配對的**純函式層**（無 DOM / 無網路 / 不碰
// window.LanguageModel，unit test 直接跑 node env）。瀏覽器層見 caption_ai.js。
//
// 為什麼需要這層：純結構規則（image_caption_group.js 的「就近段落」）遇空行即
// 封閉說明段，翻譯漫畫文常見的
//   圖 → 空行 → 開場白 → 空行 → 對話數行 → 空行 → 收尾
// 只會把「開場白」一行併進右欄，其餘翻譯全留在原地 → 圖文並排等於沒作用。
// 判斷「這幾段是否還在講同一張圖」需要語意，規則做不到。
//
// 契約（刻意把 AI 的自由度壓到最小）：
//   - buildCaptionSpans() 把每張圖的**候選說明段**切好、由近而遠排序，並記下
//     現行規則實際取了幾段（ruleKeep）。
//   - AI 的輸出只有一個整數 keep ∈ [0..paragraphs.length]（每張圖一個）。
//   - applyAiKeep() 用 keep 重建塊；keep 缺席／非法一律退回 ruleKeep。
//
// 零回歸的結構性保證（不是靠測試碰運氣）：
//   - span.aiEligible = 「用 ruleKeep 重建出來的塊」與規則原塊**完全相等**。
//     不相等（本模組的掃描與規則有任何偏差）即 false，該圖永遠沿用規則原塊。
//   - 因此 applyAiKeep(blocks, spans, {}) 恆等於 blocks（unit 守護）。
import {
  groupImageCaptionBlocks,
  skipArticleHeader,
  RE_SOLE_URL,
} from "./image_caption_group";
import { parseComment } from "./comment_parse";
import { isImageLikeUrl } from "./image_url_detect";

const text0 = (rowTexts, i) => ((rowTexts[i] || "") + "").trim();

// 與 groupImageCaptionBlocks 相同的三分類：
//   'image'   圖行（整行只有一個 URL 且解析得出靜態圖/相簿）→ 塊邊界
//   'neutral' 整行只有 URL 但不是圖（下一張圖的 x.com 來源連結）→ 不算文字、
//             也不算段落邊界（規則裡它既不開塊也不延伸 captionEnd）
//   'blank' / 'text'
function classifyRow(rowTexts, i) {
  const t = text0(rowTexts, i);
  if (t === "") return "blank";
  const m = t.match(RE_SOLE_URL);
  if (!m) return "text";
  return isImageLikeUrl(m[1]) ? "image" : "neutral";
}

// 把 [from, to]（含）切成以空行為界的段落，段落頭尾的中性 sole-URL 行剝掉
// （規則裡中性行不開塊、不延伸 captionEnd，故不屬於說明段的邊緣），整段都是
// 中性行者整段丟棄（典型：下一張圖的來源連結自成一段）。
function paragraphsIn(rowTexts, from, to) {
  const out = [];
  let start = -1;
  const flush = (end) => {
    if (start < 0) return;
    let s = start;
    let e = end;
    while (s <= e && classifyRow(rowTexts, s) === "neutral") ++s;
    while (e >= s && classifyRow(rowTexts, e) === "neutral") --e;
    if (s <= e) out.push({ start: s, end: e });
    start = -1;
  };
  for (let i = from; i <= to; ++i) {
    if (classifyRow(rowTexts, i) === "blank") flush(i - 1);
    else if (start < 0) start = i;
  }
  flush(to);
  return out;
}

// 段落文字（多行接成一段，供 prompt 使用；行尾空白去掉）。
export function paragraphText(rowTexts, p) {
  const parts = [];
  for (let i = p.start; i <= p.end; ++i) {
    parts.push(((rowTexts[i] || "") + "").replace(/\s+$/, ""));
  }
  return parts.join("");
}

// 由 keep 重建塊（imageFirst 往下吃 keep 段、captionFirst 往上吃 keep 段）。
// keep = 0 → 無塊（null）。
function blockFromKeep(span, keep) {
  if (!keep) return null;
  const ps = span.paragraphs;
  if (keep > ps.length) return null;
  return span.captionFirst
    ? {
        imageRow: span.imageRow,
        captionStart: ps[keep - 1].start,
        captionEnd: ps[0].end,
      }
    : {
        imageRow: span.imageRow,
        captionStart: ps[0].start,
        captionEnd: ps[keep - 1].end,
      };
}

const sameBlock = (a, b) =>
  (!a && !b) ||
  !!(
    a &&
    b &&
    a.imageRow === b.imageRow &&
    a.captionStart === b.captionStart &&
    a.captionEnd === b.captionEnd
  );

// 現行規則對這張圖取了幾段：規則塊的範圍必須「正好」蓋住由近而遠的前 n 段。
// 對不上回 -1（→ aiEligible false）。
function keepOfRuleBlock(span, block) {
  if (!block) return 0;
  const ps = span.paragraphs;
  for (let n = 1; n <= ps.length; ++n) {
    if (sameBlock(blockFromKeep(span, n), block)) return n;
  }
  return -1;
}

// rowTexts: 每列純文字（rowToText 還原後，同 groupImageCaptionBlocks）。
// 回傳 [{ imageRow, captionFirst, paragraphs:[{start,end}], texts:[...],
//         ruleKeep, ruleBlock, closed, aiEligible }]，由近而遠排序。
export function buildCaptionSpans(rowTexts, direction = "imageFirst") {
  const captionFirst = direction === "captionFirst";
  const ruleBlocks = groupImageCaptionBlocks(rowTexts, direction);
  const ruleByRow = new Map();
  for (const b of ruleBlocks) ruleByRow.set(b.imageRow, b);

  // 掃出內文起點、停止列（簽名檔分隔線 / 第一則推文）與所有圖行——條件與
  // groupImageCaptionBlocks 的迴圈完全一致。
  const bodyStart = skipArticleHeader(rowTexts);
  let stop = rowTexts.length;
  const imageRows = [];
  for (let i = bodyStart; i < rowTexts.length; ++i) {
    const raw = rowTexts[i] || "";
    if (/^-{2,}$/.test((raw + "").trim()) || parseComment(raw)) {
      stop = i;
      break;
    }
    if (classifyRow(rowTexts, i) === "image") imageRows.push(i);
  }

  const spans = [];
  for (let k = 0; k < imageRows.length; ++k) {
    const imageRow = imageRows[k];
    let from;
    let to;
    let closed;
    if (captionFirst) {
      from = k === 0 ? bodyStart : imageRows[k - 1] + 1;
      to = imageRow - 1;
      // 遠邊界是圖行本身（已載入）→ 候選區永遠是封閉的。
      closed = true;
    } else {
      from = imageRow + 1;
      const next = imageRows[k + 1];
      to = (next === undefined ? stop : next) - 1;
      // 好讀逐頁累積：最後一塊常是「文章還沒載完」——沒有下一張圖、也沒撞到
      // 停止列 → 候選段可能還會長，送 AI 只會得到半截文章的答案並汙染 cache。
      closed = next !== undefined || stop < rowTexts.length;
    }
    const paragraphs = to >= from ? paragraphsIn(rowTexts, from, to) : [];
    if (captionFirst) paragraphs.reverse(); // 由近而遠（最靠近圖的段排第一）
    const span = {
      imageRow,
      captionFirst,
      imageUrl: text0(rowTexts, imageRow),
      paragraphs,
      texts: paragraphs.map((p) => paragraphText(rowTexts, p)),
      closed,
      ruleBlock: ruleByRow.get(imageRow) || null,
    };
    const keep = keepOfRuleBlock(span, span.ruleBlock);
    span.aiEligible = keep >= 0;
    span.ruleKeep = keep >= 0 ? keep : 0;
    spans.push(span);
  }
  return spans;
}

// keep 值檢核：整數且落在 [0, 段數]，否則視為無效（退回 ruleKeep）。
export function normalizeKeep(span, value) {
  if (!Number.isInteger(value)) return span.ruleKeep;
  if (value < 0 || value > span.paragraphs.length) return span.ruleKeep;
  return value;
}

// 以 AI 的 keep 重建塊。keepByImageRow: {[imageRow]: keep}（Map 或普通物件皆可）。
// 不變量：keepByImageRow 為空 → 回傳與 ruleBlocks 完全相同的內容。
export function applyAiKeep(ruleBlocks, spans, keepByImageRow) {
  if (!spans || !spans.length) return ruleBlocks;
  const get = (row) =>
    keepByImageRow instanceof Map
      ? keepByImageRow.get(row)
      : keepByImageRow
        ? keepByImageRow[row]
        : undefined;
  const handled = new Set();
  const out = [];
  for (const span of spans) {
    handled.add(span.imageRow);
    if (!span.aiEligible) {
      if (span.ruleBlock) out.push(span.ruleBlock);
      continue;
    }
    const raw = get(span.imageRow);
    const keep = raw === undefined ? span.ruleKeep : normalizeKeep(span, raw);
    const block = blockFromKeep(span, keep);
    if (block) out.push(block);
  }
  // 防禦：規則產出的塊若不在 spans 裡（掃描漏了某張圖）照樣保留。
  for (const b of ruleBlocks) if (!handled.has(b.imageRow)) out.push(b);
  out.sort((a, b) => a.imageRow - b.imageRow);
  return out;
}

// 內容型 cache key（FNV-1a）：好讀翻頁會重算 spans，但同一張圖的候選段內容不變
// → key 不變 → 不重複推論。換文章由呼叫端另外帶 articleId 進來。
export function spanKey(span) {
  // 下面的分隔符是 U+0000，原始碼裡一律寫成跳脫序列（backslash + u0000），
  // **不可以貼真正的 NUL 位元組進來**：git 只要在檔案裡看到一個 NUL 就把整份當
  // 二進位 → .gitattributes 的 text=auto 對它不生效（換行不再正規化），diff 也
  // 會退化成「Binary files differ」。兩種寫法的執行語意完全相同。
  let h = 0x811c9dc5;
  const s = span.imageUrl + "\u0000" + span.texts.join("\u0000");
  for (let i = 0; i < s.length; ++i) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return (
    (span.captionFirst ? "c" : "i") +
    span.paragraphs.length +
    "-" +
    h.toString(36)
  );
}

// 送給 AI 的候選段是否值得推論：規則已取滿全部段落就沒有可改的空間。
export function spanNeedsAi(span) {
  return (
    span.aiEligible &&
    span.closed &&
    span.paragraphs.length > 1 &&
    span.ruleKeep < span.paragraphs.length
  );
}

// prompt 內每段的截斷長度與段數上限（Nano context 有限，且越長越容易漂）。
export const MAX_PARAGRAPHS = 8;
export const MAX_PARAGRAPH_CHARS = 120;

// 指令用英文：Prompt API 官方支援語言只有 en/ja/es/de/fr，中文不在清單內
// （developer.chrome.com/docs/ai/prompt-api）。內容維持原文中文，能力靠評估頁實測。
const SYSTEM_PROMPT =
  "You segment posts from a Taiwanese BBS (PTT). A post embeds images; " +
  "around each image the author writes text. Some of that text is the CONTENT " +
  "of the image (a translation of the comic panel, its dialogue, a caption, " +
  "narration inside the panel). The rest is the AUTHOR TALKING TO READERS " +
  "(opinions about the post, a preface, a summary, a translation credit or " +
  "apology, a question to readers, a sign-off) or the start of a different " +
  "topic. You decide how much of the text is image content. Answer with JSON only.";

export function captionSystemPrompt() {
  return SYSTEM_PROMPT;
}

// 單塊的使用者 prompt：編號候選段（由近而遠）＋問「前幾段屬於這張圖」。
export function buildCaptionPrompt(span) {
  const n = Math.min(span.texts.length, MAX_PARAGRAPHS);
  const lines = [];
  lines.push(
    span.captionFirst
      ? "An image link appears AFTER the following text paragraphs. " +
          "Paragraph 1 is the one immediately above the image, paragraph 2 is " +
          "further above, and so on."
      : "An image link is followed by the text paragraphs below. " +
          "Paragraph 1 comes right after the image, paragraph 2 after that, and so on.",
  );
  lines.push("Image: " + span.imageUrl);
  lines.push("");
  for (let i = 0; i < n; ++i) {
    let t = span.texts[i];
    if (t.length > MAX_PARAGRAPH_CHARS)
      t = t.slice(0, MAX_PARAGRAPH_CHARS) + "…";
    lines.push("[" + (i + 1) + "] " + t);
  }
  lines.push("");
  // 停止規則寫成「可辨識的情境」而不是一句但書：2026-08 實測的兩個失敗都是負例
  // ——模型往外多吃了「作者對讀者說話」那段（見 docs/merge-caption-ai-assist.md
  // 實測表）。keep=0 同理，光寫 "answer 0 if none" 模型幾乎不會用。
  lines.push(
    "Counting from paragraph 1 outwards, how many CONSECUTIVE paragraphs are " +
      "the content of this image (its translation, its dialogue, its caption)? " +
      "STOP at the first paragraph where the author stops showing the image " +
      "and starts talking to the readers — an opinion about the post, a " +
      "summary, a translation credit or apology, a question to readers, or a " +
      "different topic. That paragraph and everything after it does NOT count. " +
      "If paragraph 1 itself is already the author talking to readers or a " +
      "different topic, the answer is 0.",
  );
  // few-shot 的文字**刻意不取自 tools/caption-ai-cases.json**：拿評估語料當範例
  // 等於考題外洩，分數會虛高。改用結構相同、內容不同的句子。
  lines.push("Examples:");
  // 前綴 "- " 讓範例與上方的候選段清單（"[n] "）在文字上不混淆。
  lines.push(
    '- [1] 「這次的實驗成功了！」「太好了！」 [2] 翻譯到這邊，有錯再麻煩指正 ' +
      '→ {"keep": 1}',
  );
  lines.push(
    '- [1] 另外補充一下昨天的新聞 [2] 有興趣的可以自己去看公告 → {"keep": 0}',
  );
  lines.push(
    '- [1] 深夜的便利商店裡，店員正在補貨。 [2] 「客人怎麼還沒來？」「快打烊了吧。」 ' +
      '→ {"keep": 2}',
  );
  lines.push('Reply as {"keep": <integer 0-' + n + ">}.");
  return lines.join("\n");
}

// responseConstraint 用的 JSON schema（Prompt API structured output）。
export function captionKeepSchema(span) {
  return {
    type: "object",
    properties: {
      keep: {
        type: "integer",
        minimum: 0,
        maximum: Math.min(span.texts.length, MAX_PARAGRAPHS),
      },
    },
    required: ["keep"],
    additionalProperties: false,
  };
}

// 解析模型回覆 → keep 整數；解析不出來回 null（呼叫端退回 ruleKeep）。
// responseConstraint 理論上保證是合法 JSON，但 fallback 仍要能吃到裸數字。
export function parseKeepReply(reply) {
  if (typeof reply === "number") return Number.isInteger(reply) ? reply : null;
  if (typeof reply !== "string") return null;
  try {
    const o = JSON.parse(reply);
    if (o && Number.isInteger(o.keep)) return o.keep;
  } catch (e) {
    /* 落到下方裸數字 */
  }
  const m = reply.match(/-?\d+/);
  return m ? parseInt(m[0], 10) : null;
}
