// 長推文的游標錨定 —— 純邏輯，無 DOM／無網路。
//
// ---- 為什麼需要這個檔 ----
// pttbbs 的文章列表游標 `crs_ln` 是 **`.DIR` 的純行號，不綁任何文章身分**
// （`include/pttstruct.h#keeploc_t`）。`read.c#cursor_pos` 只做上下界 clamp；
// `i_read` 的 PARTUPDATE 偵測到篇數變動時也只是 `recbase = -1` 重讀 headers，
// **crs_ln 原地不動**（read.c:1198-1221），唯一的修正是 `crs_ln > last_line`
// 時夾到最後一列。
//
// 而長推文從第 2 則起是**在列表**按 X 的：read_post 對 pmore 的 RET_DORECOMMEND
// 一律 `recommend(ent, fhdr, direct); return FULLUPDATE;`（bbs.c:2471-2473）
// ⇒ 推完必定離開 pager 回列表，`i_read_key` 現場取的是
// `&headers[crs_ln - top_ln]`（read.c:1007）。只要這中間板上有增刪：
//   - 一般刪文（record.c#delete_record2）把後面每一筆 index 往前搬 ⇒ 游標滑到下一篇
//   - 置底區是 `.DIR.bottom` 的虛擬延伸，隨 bottom_line 整批位移
// 「同編號」就不再是「同一篇」，第 2 則會**推到別篇文章**（使用者實測，熱門版）。
//
// ---- 基準為什麼一定要在文章裡取 ----
// 第 1 則的 X 是在文章內按的，`fhdr` 是進文章那一刻 i_read_key 傳給 read_post 的
// 快取 ⇒ 那一則必定推對。但它落地那一幀**已經是 reload 之後**的畫面，游標列可能
// 早就換人了。所以拿落地幀當基準等於把污染當成正確值 —— 基準必須在**還在文章裡**
// 的時候，從文章標頭（作者／標題）取。
//
// ---- 比對為什麼要容忍截斷 ----
// bbs.c#readdoent 印標題時 `if (strlen(title) > w) { outns(title, w-2); outs("…"); }`
// （w = t_columns - 34）⇒ 長標題在列表上是「前綴 ＋ …」。文章標頭是完整標題，
// 直接字串相等會永遠不符。
//
// 判斷一律**保守**：讀不出來就回 'unknown'，呼叫端與 'moved' 同等處理（先重新
// 定位，不成就停手）。誤推無法收回，寧可失敗。

import {
  parseListAuthor,
  parseArticleAuthor,
  parseArticleTitle,
  subjectOfListText,
  pageArticleNums
} from './comment_parse';

// 列表標題被截斷時 bbs.c#readdoent 補的省略號。
const ELLIPSIS = '…';

// 把一個 RAW 標題正規化成「主題 key」——與 subjectOfListText 的尾段同一套規則
// （subject_ex，common/bbs/string.c:58：大小寫不敏感、可有可無的尾隨空白）。
// 列表那側的型別符（R:/□/轉/鎖/ˇ）由 subjectOfListText 自己剝掉。
export function subjectKey(rawTitle) {
  if (!rawTitle) return null;
  let t = String(rawTitle).trim();
  let prev;
  do {
    prev = t;
    t = t.replace(/^(re:|fw:) ?/i, '');
  } while (t !== prev);
  t = t.trim();
  return t || null;
}

// 從一列列表文字取出身分。author 是小寫 userid，subject 是 subject_ex 後的主題
// （可能以 … 結尾＝被截斷）。兩者缺一就回 null —— 只有一半的身分不足以判定
// 「還是同一篇」。空列／已刪除列（作者欄是 "-"）都會落在這裡。
// **置底（★）列不會**：它照樣有作者與標題，只是沒有編號（bbs.c:843 以 ★ 取代
// %7d）⇒ 身分讀得出來，能不能用編號跳是另一回事（findAnchorRowNum）。
export function listRowIdentity(text) {
  const author = parseListAuthor(text);
  if (!author) return null;
  const subject = subjectOfListText(text);
  if (!subject) return null;
  return { author, subject };
}

// 文章標頭 → 錨點基準。rowTexts 是文章畫面（或好讀累積頁）最前面幾列，
// 只要掃得到「作者 …」與「標題 …」兩行就成立。轉錄文的標頭是**原文**的作者，
// 與列表上的轉錄者不同 ⇒ 那種文章第一次比對必定 'moved'，靠重新定位自癒
// （見 long_push_session._afterRelocate 的重新採集）。
export function articleAnchor(rowTexts) {
  if (!rowTexts) return null;
  let author = null;
  let title = null;
  for (let i = 0; i < rowTexts.length && (!author || !title); ++i) {
    if (!author) author = parseArticleAuthor(rowTexts[i]);
    if (!title) title = parseArticleTitle(rowTexts[i]);
  }
  const subject = subjectKey(title);
  if (!author || !subject) return null;
  return { author, subject };
}

// 落地幀 → 錨點（次選基準）。只有在文章標頭讀不到時才用，而且只在**第一次**
// 落地時採 —— 之後每一幀都可能已經飄掉了。
export function captureCursorAnchor(facts) {
  if (!facts || facts.curY == null) return null;
  const id = listRowIdentity((facts.rowTexts && facts.rowTexts[facts.curY]) || '');
  if (!id) return null;
  return { author: id.author, subject: id.subject, num: cursorNum(facts) };
}

function cursorNum(facts) {
  if (facts.cursorRowNum != null) return facts.cursorRowNum;
  const nums = facts.nums || pageArticleNums(facts.rowTexts || [], facts.curY);
  return facts.curY != null && facts.curY < nums.length ? nums[facts.curY] : null;
}

// 列表上這一列的主題，是不是錨點那一篇？截斷過的（… 結尾）只比前綴。
// 兩側都可能是截斷版（錨點若取自落地幀就是列表印出來的），所以兩個方向都試。
export function subjectMatches(rowSubject, anchorSubject) {
  if (!rowSubject || !anchorSubject) return false;
  if (rowSubject === anchorSubject) return true;
  if (rowSubject.endsWith(ELLIPSIS))
    return anchorSubject.startsWith(rowSubject.slice(0, -1));
  if (anchorSubject.endsWith(ELLIPSIS))
    return rowSubject.startsWith(anchorSubject.slice(0, -1));
  return false;
}

function identityMatches(id, anchor) {
  return !!id && id.author === anchor.author && subjectMatches(id.subject, anchor.subject);
}

// 游標現在指的還是錨點那一篇嗎？
//   'ok'      作者與主題都對得上 ⇒ 可以按 X
//   'moved'   對不上 ⇒ 一定要先重新定位
//   'unknown' 這一列讀不出身分（空列／已刪除列／短列），或根本沒有錨點 ⇒ 比照
//             moved（沒有基準就不能宣稱 'ok'）。置底 ★ 列讀得出身分，會走 ok/moved
export function checkCursorAnchor(facts, anchor) {
  if (!anchor || !anchor.author || !anchor.subject) return 'unknown';
  if (!facts || facts.curY == null) return 'unknown';
  const id = listRowIdentity((facts.rowTexts && facts.rowTexts[facts.curY]) || '');
  if (!id) return 'unknown';
  return identityMatches(id, anchor) ? 'ok' : 'moved';
}

// 錨點那一篇還在這一頁上嗎？在就回它的文章編號（供 `<編號>⏎` 跳過去），否則回
// null。只掃 entry 區 [3, rows-2]（row 0-2 是看板標題與欄位表頭，最後一列是
// footer），與 classifyListScreen 用的是同一段範圍。
//
// pageArticleNums 已經處理過「游標蓋住編號最高位」的還原；置底列（★）本來就沒有
// 編號會被跳過 —— 那正是我們要的：`<編號>⏎` 只吃列表上印出來的編號，置底列沒有
// 一個可以指定。置底文要定位只能靠 #AID（那條路是通的，見
// aid_navigation#aidSearchLanded）。
export function findAnchorRowNum(facts, anchor) {
  if (!anchor || !anchor.author || !anchor.subject) return null;
  if (!facts || !facts.rowTexts) return null;
  const rows = facts.rows || facts.rowTexts.length;
  const nums = facts.nums || pageArticleNums(facts.rowTexts, facts.curY);
  for (let i = 3; i <= rows - 2; ++i) {
    if (nums[i] == null) continue;
    if (identityMatches(listRowIdentity(facts.rowTexts[i] || ''), anchor))
      return nums[i];
  }
  return null;
}
