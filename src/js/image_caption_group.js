// 好讀模式「圖左字右合併」的分組純函式（無 DOM / 無網路，unit test 守護）。
//
// 翻譯漫畫文章的典型結構是重複區塊：
//   圖片連結行 →（自動開圖的 inline 圖）→ 多行翻譯 → 下一個圖片連結行 → …
// 這裡只做「純結構」判斷（無法語意確認那段字真的是翻譯）：
//   - 圖行 = trim 後整行只有一個 URL，且 isImageLikeUrl 判定會解析成靜態圖/相簿。
//     「來源：https://…」這種帶前綴的行不是圖行，自然歸入上一塊的說明段。
//   - 說明段（caption）= 圖行之後、到下一個圖行／停止條件為止的行；
//     去頭尾空白行（captionStart/captionEnd 都指向非空行），保留段內空行。
//     整行只有 URL 但「不是圖」的行（如下一張圖的 x.com 來源連結）視為中性：
//     夾在文字中間會照常留在段內，但不延伸 captionEnd——避免下一張圖的來源
//     連結被拖進上一塊的右欄尾巴。
//   - 停止條件（先到先停）：簽名檔分隔線（trim === "--"）或第一條推文
//     （parseComment 命中——真推文要求行尾 MM/DD HH:MM 時間戳）。
//   - 首圖之前的前導文不屬於任何塊，照常 render。
//   - 說明段為空的圖行（連續兩張圖）不回傳塊——沒有右欄可合併，照常 render。
//
// 誤判安全性：此功能是浮動按鈕 opt-in、per-session；合併時說明行是「搬進右欄」
// 而非隱藏刪除，內容零遺失，再按一次按鈕即還原。
import { parseComment } from "./comment_parse";
import { isImageLikeUrl } from "./image_url_detect";

const RE_SOLE_URL = /^(https?:\/\/\S+)$/;

// rowTexts: 每列的純文字（rowToText 還原後）。
// 回傳 [{ imageRow, captionStart, captionEnd }]（captionStart/End 皆含、
// 皆為非空行；只含說明段非空的塊）。
export function groupImageCaptionBlocks(rowTexts) {
  const blocks = [];
  let current = null;
  const finalize = () => {
    if (current && current.captionStart !== undefined) blocks.push(current);
    current = null;
  };
  for (let i = 0; i < rowTexts.length; ++i) {
    const text = rowTexts[i] || "";
    const trimmed = text.trim();
    if (trimmed === "--" || parseComment(text)) break;
    const m = trimmed.match(RE_SOLE_URL);
    if (m && isImageLikeUrl(m[1])) {
      finalize();
      current = { imageRow: i, captionStart: undefined, captionEnd: undefined };
    } else if (current && trimmed !== "" && !m) {
      // m 非空但非圖 ＝ 中性 sole-URL 行：不開新塊也不延伸 captionEnd。
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
