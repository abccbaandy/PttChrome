// 跨行推文 AID 接合（無 DOM / 無網路，守護測試 tests/unit/aid_wrap.test.js）。
//
// url_wrap.js 的姊妹檔：同一個「PTT 推文輸入欄有固定寬度上限」的坑，只是被切斷的
// 東西從網址換成文章代碼（AIDc，恆為 8 碼，見 aid_parse.js 檔頭）：
//   → pttuser: ...這篇有講 #1gU3ww  08/26 22:17
//   → pttuser: NZ (Browsers) 可以看  08/26 22:17
// 逐列偵測兩邊都只看到 6 碼／2 碼的殘段 ⇒ detectAids 的「恰 8 碼」判準直接落空，
// 兩則都不會有連結。「連續同作者推文合併」（comment_merge.js）已經把同一位作者的
// 連續推文重組成含 '\n' cell 的 TermChar[]，接合所需的上下文全在手上。
//
// **另一種切法在 aid_parse.parseBoardSuffix**：AID 本體完整、只有 "(Board)" 被切到
// 下一則。那條刻意不要求本檔的三訊號（理由見該函式註解），別把兩者混為一談。
//
// ---- 三訊號缺一不可（照抄 url_wrap 的理由）----
//   1. leftFull   左邊那則寫滿內容欄（comment_merge 依 pttbbs 算式推導，見該檔檔頭）
//   2. 時間戳     兩則相差 ≤ 1 分鐘（被切斷的續推幾乎都在同一分鐘送出）
//   3. AID 形狀   併起來**恰好** 8 個 AID 字元，且左片段前面正好是一個合法起頭的 '#'
// 反向守門：左片段自己就已滿 8 碼 ⇒ 那是「作者剛好寫滿的完整 AID」，逐列偵測抓得到，
// 不在這裡重複產生。
//
// ---- 與 url_wrap 的呈現差異：一次接合產出「兩個」候選 ----
// url_wrap 不改寫原文、只在塊下方補一行「↳ 完整網址」。AID 沒有那種附加行 UI，所以
// 兩個殘段要**原位**變成可點連結。但範圍型連結不可以跨換行：LinkSegmentBuilder 的
// readChar 在 '\n' cell 上一律收錨並清掉 _aid／_mention／…（那個無條件清空是刻意的，
// 否則 endCol 落在換行格時狀態會外溢，整塊被畫底線——使用者 2026-08 回報過）。
// 故本模組對每一處接合回傳**兩筆**候選（左殘段一筆、右殘段一筆），aid／board／
// 呼叫端掛上的 onClick 完全相同 ⇒ 兩半都有底線、點哪一半都跳同一篇，而 renderer
// 與「候選範圍不跨換行」這條不變量一字不動。
import { rangeInTermUrl } from './term_url_flag';
import { withinOneMinute, isDbcsCell } from './comment_break';
import { AID_LEN, NEWLINE, isAidChar, parseBoardSuffix } from './aid_parse';

const MAX_PER_BLOCK = 3;

// 掃描一律走旗標判 DBCS，**不可只看 ch**：Big5 trail byte 可能剛好是 '-'／'_'／
// 英數這種合法 AID 字元（見 docs/enhanced-addon.md 踩坑 A）。
function isAidCell(chars, i) {
  const c = chars[i];
  return !!c && !isDbcsCell(chars, i) && isAidChar(c.ch);
}

function isPlainCh(chars, i, ch) {
  const c = chars[i];
  return !!c && !isDbcsCell(chars, i) && c.ch === ch;
}

// detectWrappedAids(chars, breaks) -> Array<{ startCol, endCol, aid, board }>
// chars／breaks 來自 comment_merge.buildMergedCommentChars。絕大多數塊回 []。
// 產物形狀與 aid_parse.detectAids 一致 ⇒ 呼叫端補上 onClick 後直接併進 aids。
// 每一處接合回傳兩筆（左殘段、右殘段），理由見檔頭「兩個候選」。
export function detectWrappedAids(chars, breaks) {
  if (!chars || !breaks || !breaks.length) return [];
  const out = [];
  const seen = new Set();
  for (let k = 0; k < breaks.length; ++k) {
    const br = breaks[k];
    if (!br.leftFull) continue; // 上一則沒被輸入欄寫滿 ⇒ 不是截斷
    if (!withinOneMinute(br.leftTime, br.rightTime)) continue;
    if (!isPlainCh(chars, br.index, NEWLINE)) continue; // 防禦：breaks 指的就是換行格

    // ---- 左片段：緊貼換行往左取連續 AID 字元，前面必須正好是一個 '#' ----
    if (!isAidCell(chars, br.index - 1)) continue;
    let l = br.index - 1;
    while (isAidCell(chars, l - 1)) --l;
    const hashCol = l - 1;
    if (!isPlainCh(chars, hashCol, '#')) continue;
    // '#' 前一格不可是 AID 字元或 '#'（同 detectAids 的前綴規則：擋 "a#..."／"##..."）。
    const beforeCol = hashCol - 1;
    if (beforeCol >= 0 && !isDbcsCell(chars, beforeCol)) {
      const b = chars[beforeCol];
      if (b && (isAidChar(b.ch) || b.ch === '#')) continue;
    }
    let left = '';
    for (let i = l; i < br.index; ++i) left += chars[i].ch;
    if (left.length >= AID_LEN) continue; // 已是完整 AID ⇒ 逐列偵測的事

    // ---- 右片段：必須從**下一則內容的第 0 欄**接續（換行 cell 的下一格）----
    if (!isAidCell(chars, br.index + 1)) continue;
    let r = br.index + 1;
    while (isAidCell(chars, r + 1)) ++r;
    let right = '';
    for (let i = br.index + 1; i <= r; ++i) right += chars[i].ch;
    // 恰好補滿 8 碼：短了不是 AID，長了代表第 9 格還是 AID 字元 ⇒ 那是別的識別碼。
    if (right.length !== AID_LEN - left.length) continue;

    const endCol = r + 1;
    // 網址 fragment 與 AIDc 同形（見 term_url_flag.js）：兩側任一落在已標記的 URL
    // 內就不接，否則會把一條好好的網址從中切開。
    if (
      rangeInTermUrl(chars, hashCol, br.index) ||
      rangeInTermUrl(chars, br.index + 1, endCol)
    ) {
      continue;
    }
    const aid = left + right;
    if (seen.has(aid)) continue;
    seen.add(aid);
    // 後綴可能還在右片段之後，也可能又被切到再下一則——parseBoardSuffix 已能跨換行。
    const board = parseBoardSuffix(chars, endCol);
    // 左殘段（'#' 起至換行前）與右殘段（換行後至 endCol）各自成錨。
    out.push({ startCol: hashCol, endCol: br.index, aid, board });
    out.push({ startCol: br.index + 1, endCol, aid, board });
    if (seen.size >= MAX_PER_BLOCK) break;
  }
  return out;
}
