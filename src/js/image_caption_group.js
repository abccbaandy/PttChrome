// 好讀模式「圖左字右合併」的分組純函式（無 DOM / 無網路，unit test 守護）。
//
// 翻譯漫畫文章的典型結構是重複區塊：
//   圖片連結行 →（自動開圖的 inline 圖）→ 多行翻譯 → 下一個圖片連結行 → …
// 這裡只做「純結構」判斷（無法語意確認那段字真的是翻譯）：
//   - 圖行 = trim 後整行只有一個 URL，且 isImageLikeUrl 判定會解析成靜態圖/相簿。
//     「來源：https://…」這種帶前綴的行不是圖行，自然歸入說明段。
//   - 配對方向（direction 參數，兩種文章排版都有），皆採「就近段落」原則
//     （空行＝段落邊界；寧可少配不誤配——沒配到的行照常原位 render，零遺失）：
//     - "imageFirst"（預設，上圖下文）：說明段 = 圖行之後最近的連續非空段落；
//       圖行與段落間的前導空行照跳，段落後遇空行即封閉本塊（其後的無關結語
//       不被吸進右欄）。首圖之前的前導文不屬於任何塊。
//     - "captionFirst"（上文下圖）：說明段 = 圖行「之前」最近的連續非空段落。
//       空行後又出現文字才重開新 run（段落 → 空行 → 圖 的常見排版仍配對）；
//       遇圖行即配對成塊、run 歸零。多段無關前言只會留最後一段給圖，其餘照常
//       render。最後一張圖之後的殘留文字不屬於任何塊。
//   - 整行只有 URL 但「不是圖」的行（如下一張圖的 x.com 來源連結）視為中性：
//     不開塊、不延伸 captionEnd、不當段落邊界、（captionFirst）不重置 run——
//     避免來源連結被拖進右欄尾巴或斷開配對。
//   - 停止條件（先到先停）：簽名檔分隔線（整行全是 -，≥2 個——涵蓋標準 "--"
//     與 JPTT 等 app 的 "-----"）或第一條推文
//     （parseComment 命中——真推文要求行尾 MM/DD HH:MM 時間戳）。
//   - 文章開頭 header（作者/看板/標題/時間＋分隔線）先跳過，不算任何說明段
//     （否則 captionFirst 會把 header 併進首圖右欄）。
//   - 說明段為空的圖行（連續兩張圖）不回傳塊——沒有右欄可合併，照常 render。
//
// 誤判安全性：此功能是浮動按鈕 opt-in、per-session；合併時說明行是「搬進右欄」
// 而非隱藏刪除，內容零遺失，再按一次按鈕即還原。
import { parseComment } from "./comment_parse";
import { isImageLikeUrl } from "./image_url_detect";

// export 供 caption_ai_logic.js 重用（AI 候選段掃描要用完全相同的「圖行 / 中性
// sole-URL 行 / header」判準，兩邊各養一套必漂移）。行為不變。
export const RE_SOLE_URL = /^(https?:\/\/\S+)$/;
// 文章 header 標籤列（好讀累積頁的最前面：作者/看板/標題/時間）。
const RE_HEADER_LABEL = /^(作者|看板|標題|時間)\s/;

// 文章開頭的 header 區（作者/看板/標題/時間＋其後的全形分隔線）不屬於任何
// 說明段——captionFirst 模式若不跳過，header 會被當成首圖的文字 run 併進右欄。
// 回傳內文起始 row index；非文章頂（row 0 不是「作者」列）回傳 0。
export function skipArticleHeader(rowTexts) {
  if (!RE_HEADER_LABEL.test(((rowTexts[0] || "") + "").trim())) return 0;
  let i = 0;
  while (
    i < rowTexts.length &&
    RE_HEADER_LABEL.test(((rowTexts[i] || "") + "").trim())
  ) {
    ++i;
  }
  // header 下緣的分隔線（同一個全形字重複整列）一併跳過。
  const t = ((rowTexts[i] || "") + "").trim();
  if (
    t.length >= 4 &&
    t.charCodeAt(0) > 0xff &&
    Array.prototype.every.call(t, (c) => c === t[0])
  ) {
    ++i;
  }
  return i;
}

// rowTexts: 每列的純文字（rowToText 還原後）。direction: "imageFirst"（預設，
// 上圖下文）或 "captionFirst"（上文下圖）。
// 回傳 [{ imageRow, captionStart, captionEnd }]（captionStart/End 皆含、
// 皆為非空行；只含說明段非空的塊）。
export function groupImageCaptionBlocks(rowTexts, direction = "imageFirst") {
  const blocks = [];
  const captionFirst = direction === "captionFirst";
  // imageFirst：current 由圖行開啟，其後文字填入。
  // captionFirst：current 先累積文字 run（imageRow 未定），遇圖行補上即成塊。
  let current = null;
  // captionFirst 就近段落：空行只「標記」段落結束（parBreak），之後又出現文字
  // 才重開新 run——這樣「段落 → 空行 → 圖」仍能配對，多段前言只留最後一段。
  let parBreak = false;
  const finalize = () => {
    if (
      current &&
      current.captionStart !== undefined &&
      current.imageRow !== undefined
    ) {
      blocks.push(current);
    }
    current = null;
  };
  for (let i = skipArticleHeader(rowTexts); i < rowTexts.length; ++i) {
    const text = rowTexts[i] || "";
    const trimmed = text.trim();
    if (/^-{2,}$/.test(trimmed) || parseComment(text)) break;
    const m = trimmed.match(RE_SOLE_URL);
    if (m && isImageLikeUrl(m[1])) {
      if (captionFirst) {
        // 累積 run ＋ 本圖行配對成塊；run 為空則本圖無塊。
        if (current) current.imageRow = i;
        finalize();
        parBreak = false;
      } else {
        finalize();
        current = {
          imageRow: i,
          captionStart: undefined,
          captionEnd: undefined,
        };
      }
    } else if (trimmed === "") {
      if (captionFirst) {
        if (current) parBreak = true;
      } else if (current && current.captionStart !== undefined) {
        // 就近段落：說明段已開始，遇空行即封閉本塊（其後文字與本圖無關）。
        finalize();
      }
    } else if (!m && (captionFirst || current)) {
      // m 非空但非圖 ＝ 中性 sole-URL 行：不開新塊/不重置 run、不延伸 captionEnd。
      if (captionFirst && parBreak) {
        // 空行後的第一個文字行：重開新 run，丟棄較遠的舊段落。
        current = null;
        parBreak = false;
      }
      if (!current) {
        current = {
          imageRow: undefined,
          captionStart: undefined,
          captionEnd: undefined,
        };
      }
      if (current.captionStart === undefined) current.captionStart = i;
      current.captionEnd = i;
    }
  }
  finalize();
  return blocks;
}

// 說明段的「顯示欄寬」最大值（半形=1、全形=2 欄；行尾空白不計），供 Screen
// 動態決定右欄寬度（右欄不換行，寬度跟著最寬的翻譯行走）。回傳 0 表無說明段。
export function maxCaptionCols(rowTexts, blocks) {
  let max = 0;
  for (let k = 0; k < blocks.length; ++k) {
    const b = blocks[k];
    for (let r = b.captionStart; r <= b.captionEnd; ++r) {
      const text = (rowTexts[r] || "").replace(/\s+$/, "");
      let cols = 0;
      for (let i = 0; i < text.length; ++i) {
        cols += text.charCodeAt(i) > 0xff ? 2 : 1;
      }
      if (cols > max) max = cols;
    }
  }
  return max;
}
