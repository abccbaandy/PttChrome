// 看板列表（PTT `choose_board`）的**純解析層**：畫面指紋、逐列編號、抓頁判定。
// 零 DOM、零 app 狀態 ⇒ 全部在 tests/unit/board_list_parse.test.js 守護。
//
// 事實來源一律是 `3rd_script/pttbbs/mbbsd/board.c#show_brdlist` / `#choose_board`
// （CLAUDE.md：PTT 邏輯不准猜）。三個承重事實：
//   1. 版型：showtitle row0 → 熱鍵列 row1 → vbarf 欄位列 row2 → body row 3..22
//      （`while (++myrow < b_lines)`，b_lines=23）→ vs_footer 在 row 23。
//   2. 序號欄是 `prints("%7d", head)`（head 已 ++）⇒ **編號＝1-based 絕對位置**，
//      而且 `head = (num / p_lines) * p_lines` ⇒ 分頁對齊、跨頁零重疊。
//      例外：`newflag`（按 `c` 的「新文章」模式）印的是文章總數 `B_TOTAL`，
//      群組板／無權限板則印 `%7s` 空白 —— 那種畫面**一律不 engage**，靠 row2
//      的「總數／編號」字樣就分得出來（board.c:1338）。
//   3. footer 三變體由 `IS_LISTING_FAV()` / `IN_CLASS()` 決定（board.c:1279-1290），
//      是「我的最愛／分類子分類／全部看板」唯一可靠的指紋。
//
// 本期只 engage 我的最愛（fav）與分類看板子分類（class）；全部看板／熱門看板
// （all）與分類看板根（row0 是【分類看板】，這裡直接不命中）不做。

// 渲染後畫面裡 body 從第幾列開始（row0 標題、row1 熱鍵、row2 欄位列）。
// 與文章列表好讀的 LIST_HEADER_ROWS 同值但**語意不同**（那是 bbs.c 的表頭），
// 刻意各自宣告，日後其中一邊改版才不會靜默連坐。
export const BRD_HEADER_ROWS = 3;

// `%7d` 欄寬：序號右對齊塞在 cells [0,7)。游標 `>` 只蓋 cell 0（半形，
// pttbbs b9a5029f），而看板數量遠小於 10^6 ⇒ 永遠不會蓋到數字。
const NUM_COL_END = 7;

// 一列的看板編號。null ＝這一列沒有編號（標題／熱鍵列／欄位列／footer／
// body 尾端的空白列／newflag 的 `%7s` 空白）。
//
// **不要求數字後面接空白**：無權限板印的是 `prints("%7d", head)` 緊接
// `prints("X%c ...")`（board.c:1427-1435）⇒ `      5X ...`，用 `\d+\s` 會漏掉。
// 改以「數字必須落在 `%7d` 欄位內」當守門（結束位置 ≤ 7），這正是欄位定義本身。
export function parseBoardListNum(text) {
  if (!text) return null;
  const m = /^[\s>]*(\d+)/.exec(text);
  if (!m || m[0].length > NUM_COL_END) return null;
  return parseInt(m[1], 10);
}

// 分隔線列（`NBRD_LINE`，board.c:1374）：`%7d %c ` 之後整段都是 `-`。
// **必須認得出來**：對它按 Enter 時 board.c 直接 `break` ⇒ server 一個 byte 都不回，
// 開文交易只能等到逾時。認出來就在本地擋掉並提示，零 round-trip。
export function isBoardListSeparatorRow(text) {
  if (!text) return false;
  if (parseBoardListNum(text) == null) return false;
  return /^\s*-{6,}/.test(text.slice(NUM_COL_END + 1));
}

// 禁入／隱板列（board.c:1427-1441）：`HasBoardPerm` 為假的看板。Enter 同樣
// **零回應**（外層 `if (HasBoardPerm(...))` 直接落空），理由同上。
export function isBoardListBlockedRow(text) {
  if (!text) return false;
  return text.indexOf('[禁入]') >= 0 || text.indexOf('[隱板]') >= 0;
}

// 目錄列（`NBRD_FOLDER`，board.c:1390）：Enter 會遞迴進一層新的 choose_board
// （＝另一份看板列表、另一個編號空間），不是進文章列表。
export function isBoardListFolderRow(text) {
  return !!text && text.indexOf('目錄') >= 0 && parseBoardListNum(text) != null;
}

// 整頁逐列編號。與 comment_parse.pageArticleNums **刻意不共用**：那支為文章列表
// 寫了「游標蓋住高位數字→從鄰居回推」與「單調修復」兩段補救，而看板列表的
// `%7d` 是右對齊、`>` 只蓋前置空白 ⇒ 那些補救在這裡只會是憑空修改的風險。
export function boardListRowNums(rowTexts, rows) {
  const n = rows == null ? rowTexts.length : rows;
  const out = new Array(n).fill(null);
  for (let r = BRD_HEADER_ROWS; r <= n - 2; ++r)
    out[r] = parseBoardListNum(rowTexts[r] || '');
  return out;
}

// 一幀畫面是不是看板列表，以及是哪一種。回 null ＝根本不是（文章列表／主功能表／
// 【分類看板】根／文章／prompt…）。
//
// facts = { rowTexts, curX, curY, rows }（與 ListSession._collectFacts 同形，
// 兩個 session 的 facts 都餵得進來）。回傳：
//   { variant, newflag, nums, cursorNum, topNum, parked, engageable }
// variant: 'fav' 我的最愛／'class' 分類子分類／'all' 全部看板・熱門看板／'unknown'
// engageable: 只有 fav / class ＋ 非 newflag ＋ 游標停在 body ＋ 有編號才為真。
export function classifyBoardListScreen(facts) {
  if (!facts) return null;
  const rowTexts = facts.rowTexts || [];
  const rows = facts.rows || rowTexts.length;
  if ((rowTexts[0] || '').indexOf('【看板列表】') !== 0) return null;
  const foot = rowTexts[rows - 1] || '';
  if (foot.indexOf('選擇看板') < 0) return null;
  const header = rowTexts[2] || '';
  // row2 是 `vbarf(... newflag ? "總數" : "編號")`（board.c:1338）：畫面自己就分得出
  // newflag，不必去攔 `c` 鍵。newflag 下 `%7d` 印的是文章總數，編號 key 立刻失真。
  const newflag = header.indexOf('總數') >= 0;
  if (!newflag && header.indexOf('編號') < 0) return null;

  let variant = 'unknown';
  // 判序照 board.c:1279-1290 的三元式反推。'all' 要**先於** 'class' 判：兩者
  // 都以 `(m)加入/移出最愛` 開頭，只有第二個選項不同。
  if (foot.indexOf('(a)增加看板') >= 0) variant = 'fav';
  else if (foot.indexOf('(y)只列最愛') >= 0) variant = 'all';
  else if (foot.indexOf('(m)加入/移出最愛') >= 0) variant = 'class';

  const nums = boardListRowNums(rowTexts, rows);
  const curY = facts.curY;
  const curX = facts.curX;
  const parked =
    curY != null && curY >= BRD_HEADER_ROWS && curY <= rows - 2 && (curX || 0) <= 1;
  const cursorNum = parked ? nums[curY] : null;
  let topNum = null;
  for (let r = BRD_HEADER_ROWS; r <= rows - 2; ++r) {
    if (nums[r] != null) {
      topNum = nums[r];
      break;
    }
  }
  return {
    variant: variant,
    newflag: newflag,
    nums: nums,
    cursorNum: cursorNum,
    topNum: topNum,
    parked: parked,
    engageable:
      !newflag &&
      (variant === 'fav' || variant === 'class') &&
      parked &&
      cursorNum != null &&
      topNum != null
  };
}

// 這一幀屬於哪一種「情境」——state machine 只吃這個枚舉。
//   'brdlist'       可 engage 的看板列表（我的最愛／分類子分類）
//   'brdlist-other' 看板列表但不在本期範圍（全部看板／熱門／newflag）
//   'article-list'  文章列表（《看板》＋「文章選讀」）⇒ ListSession 的地盤
//   'menu'          主功能表／分類看板根／精華文章 ⇒ 已離開看板列表
//   'other'         prompt／半繪／說明畫面…（原生鏡像照畫即可）
export function boardListContextKind(facts) {
  const brd = classifyBoardListScreen(facts);
  if (brd) return brd.engageable ? 'brdlist' : 'brdlist-other';
  const rowTexts = (facts && facts.rowTexts) || [];
  const rows = (facts && facts.rows) || rowTexts.length;
  const row0 = rowTexts[0] || '';
  const foot = rowTexts[rows - 1] || '';
  if (row0.indexOf('《') >= 0 && foot.indexOf('文章選讀') >= 0) return 'article-list';
  if (
    row0.indexOf('【主功能表】') === 0 ||
    row0.indexOf('【分類看板】') === 0 ||
    row0.indexOf('【精華文章】') === 0
  )
    return 'menu';
  return 'other';
}

// 「往這個方向再抓一頁」的跳號目標。看板列表的分頁是對齊的，而且編號＝絕對位置，
// 所以**不必用 PgUp/PgDn**：跳到緊鄰緩衝邊界的那一號，server 自己會把
// `head = (num / p_lines) * p_lines` 對齊到含它的那一頁（board.c:1710-1716）。
//
// 刻意不照抄 ListSession 的「錨點跳號 ＋ PgUp/PgDn」兩腿：board.c 的翻頁鍵會
// **wrap**（第一項 PgUp fall-through 到 KEY_END、最後一項 PgDn 回到第 1 項，
// board.c:1760-1785），拿它抓頁得多一套 wrap-aware 判定，而跳號一腿就搞定且
// 每次只要一個 round-trip。
export function boardListFetchTarget({ base, dir }) {
  if (base == null) return null;
  const t = dir < 0 ? base - 1 : base + 1;
  return t >= 1 ? t : null;
}

// 抓頁落地判定。`search_num` 會把超過 brdnum 的輸入夾到 brdnum（stuff.c:189-208）
// ⇒ **往下跳一號卻停在原地就是板尾**，一腿同時做到「抓頁」與「探邊」。
// 往上同理（跳到 base-1 卻沒往上 ⇒ 只可能是被夾住了）。
export function boardListFetchVerdict({ base, landed, dir }) {
  if (landed == null) return { edge: false, ok: false };
  if (dir < 0) return { ok: true, edge: landed >= base };
  return { ok: true, edge: landed <= base };
}
