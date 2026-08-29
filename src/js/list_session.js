// List easy reading v4 — the pure decision layer (this file, top half) and the
// ListSession owner class (bottom half, added in M6).
//
// Three principles (docs/easy-reading-list.md; blueprint was docs/handoff):
//   A. Content classification: the settle event only decides WHEN to evaluate;
//      WHAT the screen is comes from content predicates (screen fingerprints,
//      docs/pttbbs-screen-protocol.md §3/§5) — never from timing heuristics.
//   B. Explicit state machine: transitionListSession is the single source of
//      truth for mode changes; render/keyboard read the resulting state instead
//      of guessing from pageState.
//   C. Serialized commands: machine keys go through CommandQueue one in-flight
//      at a time (pttbbs typeahead skips repaints when keys race — protocol §2).
// Misclassification always degrades toward NATIVE (functionMode mirrors the raw
// screen), never toward a stale buffer.
import {
  parseListAuthor,
  parseListTitle,
  matchTitleBlacklist,
  pageArticleNums,
  parseListArticleNumLoose,
  isPinnedListRow,
  isDeletedListRow,
  rowToText,
  parseListTitleRaw,
  LIST_AUTHOR_COL_START,
  LIST_AUTHOR_COL_END,
} from './comment_parse';
import { clickableColStart } from './mouse_regions';
import {
  parseStatusRow,
  parseListRow,
  u2b,
  ansiHalfColorConv,
  normalizePasteText
} from './string_util';
import { keyEventToBytes } from './term_keyboard';
import { createSmoothScroller } from './smooth_scroll';
import { LEFT_ARROW } from './function_key_plan';
import { readValuesWithDefault } from './pref_storage';
import {
  moveListCursorWindow,
  scrollListWindow,
  normalizeListWindow,
  windowVisibleSequence,
  LIST_HEADER_ROWS,
} from './list_window';

// ---------------------------------------------------------------------------
// Screen classification (pure)
// ---------------------------------------------------------------------------

// Board name from the row-0 title bar: 「…看板《C_Chat》…」. The reversed title
// is repainted on every board switch (protocol §4 TITLE_REDRAW), so this is the
// aliasing guard for accumulated article numbers across boards.
const BOARD_NAME_RE = /《([^《》]+)》/;
export function parseBoardName(row0Text) {
  if (!row0Text) return null;
  const m = row0Text.match(BOARD_NAME_RE);
  return m ? m[1] : null;
}

// Classify one settled screen from plain facts. facts = {
//   rowTexts:  string[] (getRowText for every row),
//   curX, curY: settle cursor park position (term_buf settleSnapshot),
//   rows:      row count,
//   row0Reversed, row2Reversed: bool (caller runs buf.isUnicolor — kept out of
//              here so the classifier stays free of TermBuf),
// } → { kind: 'clean-list'|'article'|'menu'|'prompt'|'transient', boardName }
//
// clean-list fingerprint (protocol doc §3/§5, all five must hold):
//   row0 reversed title with a parsable 《board》, row2 reversed header with
//   「編號」, ≥3 parsable article numbers in the entry area (or the board-tail
//   short-page rule below), the cursor parked in the entry area at col ≤ 1,
//   and the bottom feeter containing 「文章選讀」.
// Deliberately NOT parseListRow — that matches the BOARD MENU footer (v3 trap #3).
// feeter 文字對 mbbsd/read.c#i_read 的 READ_REDRAW 分支（pttbbs @ c1ff72df）：
//   vs_footer(" 文章選讀 ", " (y)回應(X)推文(^X)轉錄 …")   一般看板
//   vs_footer(" 鴻雁往返 ", " (R/y)回信 (x)站內轉寄 …")     currstat == RMAIL
// 精確比對「文章選讀」正好把信箱擋在外面（信箱不得 engage 列表好讀）。
// row2 表頭來自 bbs.c 的 vbarf(ANSI_REVERSE "   編號    %s 作  者       文  章  標  題\t人氣:%d ")，
// 其中 %s 是 日 期／價 格（LISTMODE），所以只認「編號」最穩。
export function classifyListScreen(facts) {
  const { rowTexts, curX, curY, rows, row0Reversed, row2Reversed } = facts;
  const lastRowText = rowTexts[rows - 1] || '';
  const boardName = parseBoardName(rowTexts[0]);

  if (
    row0Reversed &&
    boardName != null &&
    row2Reversed &&
    (rowTexts[2] || '').indexOf('編號') >= 0 &&
    lastRowText.indexOf('文章選讀') >= 0 &&
    curY >= 3 &&
    curY <= rows - 2 &&
    curX <= 1
  ) {
    const nums = pageArticleNums(rowTexts, curY);
    let count = 0;
    for (let i = 3; i <= rows - 2; ++i) if (nums[i] != null) ++count;
    if (count >= 3) return { kind: 'clean-list', boardName };
    // 板尾短頁（2026-07-11 錄製檔誤降級）：最後一頁可能只剩 1-2 列編號文章
    // （舊全形 ● 游標蓋掉最高位時連 parseListArticleNum 都是 null，只有 loose 可讀；
    //   新半形 > 游標不蓋數字，strict/loose 同值——但 loose 仍須 strip '>'）
    // ＋置底文＋空白列，湊不滿 3 列 → 永遠 transient → 板尾任何無主 settle 都
    // 降級 functionMode 且無法自癒。放寬條件（半繪防護仍在）：游標列本身必須
    // 是列表形列，且 entry 區每個非空列都是列表形（編號/置底/刪除），至少一列。
    const listShapedRow = i =>
      nums[i] != null ||
      isPinnedListRow(rowTexts[i]) ||
      isDeletedListRow(rowTexts[i]) ||
      (i === curY && parseListArticleNumLoose(rowTexts[i]) != null);
    if ((rowTexts[curY] || '').trim() && listShapedRow(curY)) {
      let shaped = 0;
      let foreign = false;
      for (let i = 3; i <= rows - 2; ++i) {
        if (!(rowTexts[i] || '').trim()) continue;
        if (listShapedRow(i)) ++shaped;
        else foreign = true;
      }
      if (!foreign && shaped >= 1) return { kind: 'clean-list', boardName };
    }
  }

  // Article (pmore): the bottom status row 「瀏覽 第 x/y 頁 …」 is decisive.
  if (parseStatusRow(lastRowText)) return { kind: 'article', boardName };

  // Menus: top-level 【主功能表】/【分類看板】/【精華文章】 titles, or the
  // board-MENU footer parseListRow matches (the thing clean-list must NOT use).
  const row0 = rowTexts[0] || '';
  // 【看板列表】/【我的最愛】: the landing screens of a ← leave-board when the
  // board was entered from a board list / favourites (not an `s` jump) — must
  // classify as menu or the leave transaction's expect never completes
  // (timeout → probe → visible degrade: the「退到看板列表卡住」bug, v5/M4).
  if (
    row0.indexOf('【主功能表】') === 0 ||
    row0.indexOf('【分類看板】') === 0 ||
    row0.indexOf('【精華文章】') === 0 ||
    row0.indexOf('【看板列表】') === 0 ||
    row0.indexOf('【我的最愛】') === 0 ||
    parseListRow(lastRowText)
  ) {
    return { kind: 'menu', boardName };
  }

  // Prompt: the server parked the cursor on the bottom row = it is waiting for
  // input there (protocol §5) — search prompts, jump-to-number, y/N questions.
  if (curY === rows - 1) return { kind: 'prompt', boardName };

  return { kind: 'transient', boardName };
}

// Classify one settle window's dirty-row burst (term_buf settleSnapshot
// .changedRows — the rows the SERVER wrote during the quiet period). This is a
// fast-path HINT only: completion decisions always use the final screen
// predicate above (classifyListScreen), never the burst shape — WS proxy
// coalescing can merge responses (protocol §4, §6 unknown).
//   cursor-move:  exactly the old+new cursor rows, all inside the entry area.
//   page-turn:    move(3,0)+clrtobot repaint — rows 3..rows-1 all dirty, the
//                 row0-2 header untouched.
//   full-repaint: clear() — header dirty too, whole screen covered.
export function classifyListBurst({ changedRows, curY, rows }) {
  if (!changedRows || changedRows.size === 0) return 'other';
  const has = r => changedRows.has(r);
  const headerTouched = has(0) || has(1) || has(2);

  let entryFull = true;
  for (let r = 3; r <= rows - 1; ++r) {
    if (!has(r)) {
      entryFull = false;
      break;
    }
  }
  if (!headerTouched && entryFull) return 'page-turn';

  if (headerTouched && entryFull && has(0) && has(1) && has(2)) {
    let all = true;
    for (let r = 0; r <= rows - 1; ++r) {
      if (!has(r)) {
        all = false;
        break;
      }
    }
    if (all) return 'full-repaint';
  }

  if (changedRows.size <= 2) {
    let inEntry = true;
    changedRows.forEach(r => {
      if (r < 3 || r > rows - 2) inEntry = false;
    });
    if (inEntry && curY >= 3 && curY <= rows - 2) return 'cursor-move';
  }

  return 'other';
}

// T4 non-solicited message fingerprint (v5/M4; protocol §9 CONFIRMED): a
// waterball/broadcast is outmsg writing ONLY the bottom row (one row up when
// msg_occupied>0), the row starting with the reversed ◆ marker. The caller
// must already have excluded in-flight transactions — this only inspects the
// settle's dirty-row shape and content. Used to pick the banner wording when
// the active-state catch-all degrades to native.
export function isWaterballSettle({ changedRows, rowTexts, rows }) {
  if (!changedRows || changedRows.size === 0 || changedRows.size > 2)
    return false;
  let bottomOnly = true;
  let marker = false;
  changedRows.forEach(r => {
    if (r < rows - 2) bottomOnly = false;
    else if (((rowTexts[r] || '').trimStart()).indexOf('◆') === 0) marker = true;
  });
  return bottomOnly && marker;
}

// Does this frame's entry area hold at least one NUMBERED article row?
// 錨定式 prefetch 的每一條腿都要一個序號當錨（bufferEdgeNum 給的序號，jump 過去），所以
// 一幀「只有置底文／空白」的 clean-list（getkeep 落點剛好在板尾 ⇒ readdoent 只
// 畫得出那幾列置底就 clrtobot，實錄 20260820-015809）雖然通過板尾短頁放寬規則
// （不變量 3a），卻 seed 不出任何錨點：_startFill/_maybeFill/_maybeDemand/
// _requestEnd 全部在 base==null 靜默 return，導覽鍵只能在那兩三列裡原地打轉
// ＝永久卡死。⇒ 不變量 17：這種幀不得驅動 seed/rebuild/resume。
export function hasNumberedEntryRow(facts) {
  const nums = (facts && facts.nums) || [];
  for (let r = 3; r <= (facts.rows || 0) - 2; ++r) if (nums[r] != null) return true;
  return false;
}

// ---------------------------------------------------------------------------
// State machine (pure reducer)
// ---------------------------------------------------------------------------

// States: idle → active ⇄ functionMode; active → opening → suspended → active.
//   idle:         not engaged (native render, native keys).
//   active:       buffer render (accumulated listLines), local navigation.
//   functionMode: whole-screen native LIVE mirror, ALL keys pass through —
//                 the catch-all self-heal target for anything unexpected.
//   opening:      frozen render while the serialized open-article commands run.
//   suspended:    an article is open (article easy reading or native renders);
//                 the accumulated buffer is kept for restore.
//
// Events (plain data; the session precomputes every boolean so this table is
// exhaustively unit-enumerable):
//   { type:'settle', kind, boardNameMatch, inFlightKind,
//     landedNumInBuffer, engageEligible }
//   { type:'key', keyClass: 'nav'|'open'|'open-pinned'|'other' }
//   { type:'pref-off' } | { type:'open-timeout' }
//
// Returns { next, actions[] } — action names are interpreted by ListSession.
// Misroutes always fall toward functionMode/native (principle: self-heal).
export function transitionListSession(state, event) {
  const stay = { next: state, actions: [] };

  if (event.type === 'pref-off') {
    return state === 'idle' ? stay : { next: 'idle', actions: ['cleanup'] };
  }

  switch (state) {
    case 'idle': {
      if (
        event.type === 'settle' &&
        event.kind === 'clean-list' &&
        event.engageEligible &&
        // 無編號列的幀 seed 不出錨點（不變量 17）：停在原生，等下一幀再 engage。
        event.hasNumberedRow
      ) {
        return { next: 'active', actions: ['seed', 'start-fill'] };
      }
      return stay;
    }

    case 'active': {
      if (event.type === 'settle') {
        switch (event.kind) {
          case 'clean-list':
            // 無編號列（getkeep 落在板尾 ⇒ 只剩置底文的短頁，不變量 17）：這一幀
            // 帶不進任何序號，rebuild 只會把 buffer 清成無錨點的死局。板名相同就
            // 續用現有 buffer；板名不同則連舊 buffer 都不能當畫面 → 顯性降級原生。
            if (!event.hasNumberedRow)
              return event.boardNameMatch
                ? stay
                : { next: 'functionMode', actions: ['enter-function-mode'] };
            // Accumulation already happened in redraw; a board switch (s-jump,
            // MODE_SELECT filtered list) rebuilds to stop number aliasing.
            return event.boardNameMatch
              ? { next: 'active', actions: ['continue-fill'] }
              : { next: 'active', actions: ['rebuild'] };
          case 'article':
            // Hand off to article easy reading (its own settled 2→3 edge fires
            // independently — zero new coupling; without it the native article
            // renders).
            return { next: 'suspended', actions: ['handoff-article'] };
          case 'menu':
            // A settled menu = we left the board. Exit directly: routing it
            // through functionMode (the old catch-all) needs ANOTHER settle to
            // reach idle, and a static menu screen never produces one — the ←
            // 離板 response can interleave with an in-flight prefetch's jump
            // repaint (jump settle → resume bounce → menu settle lands here),
            // wedging functionMode forever (live soak).
            return { next: 'idle', actions: ['cleanup'] };
          default:
            // prompt/transient: explainable while a serialized command is
            // mid-flight (a slow multi-write response can settle half-painted),
            // OR when this very settle was consumed by the command that just
            // completed on it (inFlightKind already null post-account; a
            // board-tail edge probe's completion frame is transient — jump
            // park keeps the bottom row empty, protocol §4✚/§6. Miss counts
            // too: its onFail already handles the degrade — a catch-all here
            // would double it). Otherwise catch-all self-heal to the native
            // mirror (waterball, 動態看板, misclassification — everything
            // lands here).
            return event.inFlightKind || event.consumed
              ? stay
              : { next: 'functionMode', actions: ['enter-function-mode'] };
        }
      }
      if (event.type === 'key') {
        switch (event.keyClass) {
          case 'nav':
            return { next: 'active', actions: ['move-selection'] };
          case 'open':
            return { next: 'opening', actions: ['begin-open'] };
          case 'open-pinned':
            // Pinned rows have no number to jump to; the serialized-safe path
            // is End (last page, deterministic regardless of new arrivals) →
            // locate the target pinned row by CONTENT on the settled screen →
            // arrow steps → Enter (see _beginOpenPinned).
            return { next: 'opening', actions: ['begin-open-pinned'] };
          case 'leave':
            // ←/q/e: leave-board as a serialized TRANSACTION over the frozen
            // snapshot (v5: no native flash) — the response settle routes
            // through functionMode's own table (menu → cleanup, clean-list →
            // resume: MODE_SELECT exit / thread hops land back on a list).
            return { next: 'functionMode', actions: ['begin-leave'] };
          case 'passthrough':
            // One-key native passthrough (2026-07-10, T3 airlock 退役): any
            // non-whitelisted key switches to native in ONE press. The caller
            // (_beginNativePassthrough) runs the optional cursor-sync leg and
            // the actual enter-function-mode + key send — the reducer only
            // moves the state so in-flight settles are absorbed and other keys
            // are swallowed while the sync leg is on the wire.
            return { next: 'functionMode', actions: [] };
          case 'transact':
            // A locally-collected parameter transaction commits (number jump):
            // the caller runs the specific begin* right after this dispatch.
            return { next: 'functionMode', actions: [] };
          default:
            return stay;
        }
      }
      return stay;
    }

    case 'functionMode': {
      if (event.type === 'settle') {
        switch (event.kind) {
          case 'clean-list':
            // A serialized transaction (sync leg / leave / jump) is mid-flight:
            // its own jump-landing settle must not bounce us back to active —
            // keep mirroring until it completes (the completing settle reads
            // inFlightKind null and resumes with the LANDED cursor).
            if (event.inFlightKind) return stay;
            // Sticky native excursion (2026-07-10 UX): a passthrough/self-heal
            // switch to native STAYS native — auto-resuming on every clean-list
            // settle made repeated [ ] flash buffer↔native and mis-trip the
            // catch-all banner. The hold is released only by a real context
            // change: article (suspended → article ER takes over) or menu
            // (idle → re-entering the board re-engages).
            if (event.nativeHold) return stay;
            // 無編號列的落點無法 resume/rebuild（不變量 17）：繼續鏡像原生，
            // 使用者原生翻一頁就會拿到有序號的幀再恢復好讀。
            if (!event.hasNumberedRow) return stay;
            // Content-decided exit. If the landed cursor row is an article we
            // already hold AND we are on the same board, the page overwrite (in
            // redraw) is enough; otherwise rebuild from the current page
            // (covers `s` board jumps and `/` MODE_SELECT number aliasing).
            // NOTE: entering functionMode via enter-function-mode（airlock/
            // 自癒/降級）clears _boardName at the ACTION layer
            // (_enterFunctionMode) — a native excursion always lands on the
            // rebuild branch here. Only frozen transactions (relative/leave/
            // mark) that keep _boardName can take the fast resume-only path.
            return event.landedNumInBuffer && event.boardNameMatch
              ? { next: 'active', actions: ['resume-buffer'] }
              : { next: 'active', actions: ['resume-buffer', 'rebuild'] };
          case 'article':
            // User opened an article natively while mirrored.
            return { next: 'suspended', actions: ['handoff-article'] };
          case 'menu':
            // A serialized transaction is mid-flight and its route goes THROUGH
            // menus: AidNavigation's escape preamble presses ← up to 主功能表
            // before it may send `s <board>` (mbbsd/more.c:102 gates s on
            // currstat == READING, so 站內信 needs the detour). cleanup() calls
            // queue.flush() → the in-flight command's onFlushed → the whole AID
            // sequence dies on its own first step. Same shape as the clean-list
            // guard above: wait for the transaction to conclude.
            if (event.inFlightKind) return stay;
            // Left the board: clean up entirely, back to native life.
            return { next: 'idle', actions: ['cleanup'] };
          default:
            return stay; // prompt/transient: keep mirroring (like native)
        }
      }
      return stay; // keys never route here — the keyboard hook is off in native
    }

    case 'opening': {
      if (event.type === 'settle') {
        // clean-list settles mid-open (jump prompt echoes, the cursor landing
        // on the target) are consumed by the CommandQueue expects — the reducer
        // just waits for the article.
        if (event.kind === 'article') {
          return { next: 'suspended', actions: ['handoff-article'] };
        }
        return stay;
      }
      if (event.type === 'open-timeout') {
        // Self-heal: abandon the open, mirror whatever the server shows.
        return { next: 'functionMode', actions: ['enter-function-mode'] };
      }
      // Serialization: user keys are swallowed while the open commands are in
      // flight (sub-second; the timeout above self-heals a wedged open).
      if (event.type === 'key') return stay;
      return stay;
    }

    case 'suspended': {
      if (event.type === 'settle') {
        switch (event.kind) {
          case 'clean-list':
            // Back from the article (v5/M4 re-seed): the server repaints the
            // full list on article exit (READ_REDRAW) with its own getkeep
            // window and cursor — adopt that landing as the truth (push counts
            // on the repainted page refresh via the redraw merge) instead of
            // replaying saved anchors (the retired _restore parity family).
            // Same rule as functionMode: landed outside the buffer (pinned
            // cursor parses null num) or board changed → rebuild.
            // 退文落點只剩置底文時同樣不能 re-seed（不變量 17）：停在原生鏡像
            //（_handoffArticle 已把 renderMode 設 native），等下一幀。
            if (!event.hasNumberedRow) return stay;
            return event.landedNumInBuffer && event.boardNameMatch
              ? { next: 'active', actions: ['resume-buffer'] }
              : { next: 'active', actions: ['resume-buffer', 'rebuild'] };
          case 'menu':
            // Same in-flight guard as functionMode's menu branch: an AID escape
            // preamble routes through menus and cleanup()'s queue.flush() would
            // kill it mid-sequence.
            if (event.inFlightKind) return stay;
            return { next: 'idle', actions: ['cleanup'] };
          default:
            return stay; // article page turns / prompts inside the article
        }
      }
      return stay;
    }

    default:
      return stay;
  }
}

// ---------------------------------------------------------------------------
// Accumulation / selection primitives (pure, ported from the v3 wip branch)
// ---------------------------------------------------------------------------

// Pure list-buffer accumulation core (no DOM / no TermChar). A board page contributes
// `entries`: { num:int|null, key:string|null, row:any }. Numbered rows (num!=null) are
// written into `numMap` keyed by article number, OVERWRITING any existing entry — so a
// re-painted page's live changes (推文數, `v` 已讀標記) replace the stale clone. Number-
// less ★pinned rows go into `pinnedMap` keyed by their TITLE slice (`key`) — NOT the
// whole row text: the push-count column of a pinned row changes live, and a text-keyed
// map would then grow a duplicate row (v3 design bug 5a). Mutates the maps in place.
export function mergeListPage(numMap, pinnedMap, entries) {
  for (let i = 0; i < entries.length; ++i) {
    const e = entries[i];
    if (e.num != null) numMap.set(e.num, e.row);
    else if (e.key != null) pinnedMap.set(e.key, e.row);
  }
}

// Pure flatten of the accumulated maps into parallel render arrays. Numbered rows ASCEND
// by article number (oldest→newest, matching native top→bottom); ★pinned rows follow at
// the very bottom in insertion order (they sit below the newest article on the board, so
// scrolling toward older content naturally moves the selection away from them). Returns
// { lines, nums } parallel arrays; nums is null for the pinned tail rows.
export function flattenListBuffer(numMap, pinnedMap) {
  const sortedNums = Array.from(numMap.keys()).sort((a, b) => a - b);
  const lines = [];
  const nums = [];
  for (let i = 0; i < sortedNums.length; ++i) {
    lines.push(numMap.get(sortedNums[i]));
    nums.push(sortedNums[i]);
  }
  pinnedMap.forEach(function(row) {
    lines.push(row);
    nums.push(null);
  });
  return { lines, nums };
}

// ---- last-read row styling (normalize-on-store / decorate-on-render) -------
// pttbbs 真實邏輯（mbbsd/bbs.c readdoent:830）：last-read 高亮是「標題比對」——
// 讀完文章時 currtitle = subject(title)（bbs.c:2424，去 Re:/Fw: 前綴），列表上
// 每一列凡 subject_ex(ent->title) == currtitle 就把 mark 起到行尾塗
// ANSI_COLOR(1;3c)，c 依該列自身 title_type：□=1紅 R:=3黃 轉=6青 鎖=5紫 ˇ=2綠
// （bbs.c:735-752）。所以【同主題多列同時亮是正常行為】，且高亮不含作者欄——
// 作者亮白(1;37)是 isonline（作者在線上，bbs.c:815-823），與 last-read 無關。
// 實錄驗證：debug 20260717-224420 t=1937（296/298 同紅、289 isonline 亮白）。
// client 模型：map 永遠存 CLEAN（去色）列；session 記 _lastReadTitle（subject
// 正規化字串），render 時對每列比對 subject，命中就以該列自身 mark 的顏色重繪。
// 欄位切分（normalize 的處置，cell 索引）：
//   [0,8)   序號 ─────── 清
//   [8,12)  mark+推文數 ─ 豁免（綠/黃/爆是該欄自己的合法顏色）
//   [12,17) 日期 ─────── 清
//   [17,29) 作者 ─────── 豁免：此區的亮色【只可能】是 isonline（readdoent 在作者
//           前後各包一次 ANSI_COLOR(1)/ANSI_RESET，bbs.c:815-823），last-read 從
//           mark 才起塗（bbs.c:830）→ 這裡沒有 last-read 的色要 strip。曾一併清掉
//           而 paintLastReadListRow 又只重畫 [29,) → 進文章再退回，該列作者永久
//           變灰＝看起來下線（實測 + 錄製 20260725-153131 t=2869：server 明明仍送
//           `ESC[1;37m<author>`）。
//   [29,)   標題 ─────── 清（render 時由 paintLastReadListRow 重畫）
const LASTREAD_EXEMPT_START = 8;
const LASTREAD_EXEMPT_END = 12;

// Detection is attribute-based: a non-blank bold cell in the title region (past
// the author column) carrying one of the five last-read title colors
// (□紅/R:黃/轉青/鎖紫/ˇ綠, readdoent's 1;3c). Returns true on hit; the caller
// normalizes the row and teaches the session the row's SUBJECT. Bold colored
// text never appears in a list row's title region except for the last-read
// marker: "爆"/push-counts live in cols [8,12) (before the region), TN_ANNOUNCE
// is bold WHITE (fg 7, not in the set), and a deleted row's title carries no
// color. A miss keeps today's behavior (fail-safe).
const LASTREAD_TITLE_FGS = [1, 2, 3, 5, 6];
export function isLastReadStyledListRow(row) {
  for (let i = LIST_AUTHOR_COL_END; i < row.length; ++i) {
    const c = row[i];
    if (!c || c.ch === ' ' || !c.bright || c.bg !== 0) continue;
    if (LASTREAD_TITLE_FGS.indexOf(c.fg) >= 0) return c.fg;
  }
  return 0;
}

// The subject key of a list row — pttbbs's strcmp(currtitle, subject_ex(title))
// re-done client-side. The displayed title is ALREADY subject_ex-stripped by the
// server (readdoent prints mark + stripped title), so the key is the title
// region minus the leading type mark ("R:"/"□"/"轉"/"鎖"/"ˇ"); the defensive
// Re:/Fw: loop-strip mirrors subject_ex (common/bbs/string.c:58, case-insensitive,
// optional trailing space) in case a raw prefix ever leaks through. null = no
// usable title (blank/short row) — never matches.
const LIST_MARK_FG = { 'R': 3, '轉': 6, '鎖': 5, 'ˇ': 2 };
export function subjectOfListRow(row) {
  return subjectOfListText(rowToText(row));
}

// Same key from an already-flattened row STRING (settle facts carry rowTexts,
// not TermChar rows — aid_navigation's back landing verifies against these).
export function subjectOfListText(text) {
  let t = parseListTitleRaw(text);
  if (!t) return null;
  if (t.charAt(0) === 'R' && t.charAt(1) === ':') t = t.substring(2);
  else if (t.charCodeAt(0) > 0x7f) t = t.substring(1); // □/轉/鎖/ˇ state glyph
  t = t.trim();
  let prev;
  do {
    prev = t;
    t = t.replace(/^(re:|fw:) ?/i, '');
  } while (t !== prev);
  t = t.trim();
  return t || null;
}

// Which 1;3c color THIS row's last-read highlight uses — from its own type mark
// (readdoent's title_type switch): R:=3黃 轉=6青 鎖=5紫 ˇ=2綠, default □=1紅.
export function listRowMarkFg(row) {
  const t = parseListTitleRaw(rowToText(row));
  if (!t) return 1;
  const key = t.charAt(0) === 'R' && t.charAt(1) === ':' ? 'R' : t.charAt(0);
  return LIST_MARK_FG[key] || 1;
}

// Strip the last-read styling back to a plain row (default attrs) — called on the
// accumulate-time clone only when detection hit. Two column ranges are exempt (see
// the field map above): the push-count columns and the author column, whose colors
// belong to the row itself (推文數 / isonline), not to the last-read highlight.
// Direct field writes, not resetAttr(): the accumulate unit fixtures use
// plain-object cells.
export function normalizeLastReadListRow(row) {
  for (let i = 0; i < row.length; ++i) {
    if (i >= LASTREAD_EXEMPT_START && i < LASTREAD_EXEMPT_END) continue;
    if (i >= LIST_AUTHOR_COL_START && i < LIST_AUTHOR_COL_END) continue;
    const c = row[i];
    c.fg = 7;
    c.bg = 0;
    c.bright = false;
    c.blink = false;
    c.underLine = false;
    c.invert = false;
  }
}

// Inverse of normalizeLastReadListRow: re-paint the server's last-read styling
// on a render-time clone — mark + title (col LIST_AUTHOR_COL_END →) bold in the
// row's own mark color, author column untouched (readdoent paints from the mark
// only; a bright author is isonline, which the stored row keeps verbatim thanks
// to normalize's author exemption).
export function paintLastReadListRow(row, fg) {
  if (fg == null) fg = listRowMarkFg(row);
  for (let i = LIST_AUTHOR_COL_END; i < row.length; ++i) {
    const c = row[i];
    if (!c) continue;
    c.bright = true;
    c.bg = 0;
    c.fg = fg;
  }
}

// Pure "stop prefetching?" decision. We page until enough VISIBLE (non-blacklisted)
// rows are accumulated (`target`), but cap total pages (`maxPages`) so a board with a
// high blacklist hit rate can't page forever. End-of-board (cursor didn't move on a
// page command) is detected separately by the queue expect and is authoritative.
export function shouldStopListPrefetch({ visibleCount, target, pageCount, maxPages }) {
  return visibleCount >= target || pageCount >= maxPages;
}

// Pure selection movement over the VISIBLE (rendered, non-hidden) rows. `visibleIndices`
// is the ascending list of absolute listLines indices that survive the blacklist drop;
// `currentAbs` is the currently-selected absolute index (may be -1/stale). Returns the
// new absolute index after moving `delta` visible steps, clamped to the ends. When the
// current selection is not itself visible (e.g. it got blacklisted) we snap to the
// nearest visible row in the direction of travel before stepping. Returns -1 only when
// there are no visible rows at all.
export function moveListSelection(visibleIndices, currentAbs, delta) {
  if (!visibleIndices.length) return -1;
  let pos = visibleIndices.indexOf(currentAbs);
  if (pos === -1) {
    // The current selection was dropped (e.g. it just got blacklisted). Find the
    // insertion point: `idx` = first visible row whose absolute index is > currentAbs
    // (== count of visible rows strictly before it). A single step then lands on the
    // visible neighbour in the direction of travel — moving down → first row below,
    // moving up → last row above — and that snap consumes one unit of `delta`.
    let idx = 0;
    while (idx < visibleIndices.length && visibleIndices[idx] < currentAbs) idx++;
    if (delta > 0) {
      pos = idx;
      delta -= 1;
    } else if (delta < 0) {
      pos = idx - 1;
      delta += 1;
    } else pos = idx < visibleIndices.length ? idx : idx - 1;
  }
  let next = pos + delta;
  if (next < 0) next = 0;
  if (next > visibleIndices.length - 1) next = visibleIndices.length - 1;
  return visibleIndices[next];
}

// ---------------------------------------------------------------------------
// ListSession — the single owner (class half; pure layer above)
// ---------------------------------------------------------------------------

// Same shape as easy_reading.js's private bindProperty: expose obj[prop] as a
// live view of target[name] so term_view/redraw can read buf.listRenderMode
// without importing this module's instance.
function bindProperty(target, name, obj, prop) {
  if (!prop) prop = name;
  Object.defineProperty(obj, prop, {
    get: function() {
      return target[name];
    },
    set: function(val) {
      target[name] = val;
    }
  });
}

// Initial background fill is capped LOW: the window render is cheap, but every
// prefetch is still two server roundtrips — 2-3 pages cover the first screens;
// demand fetches the rest as the user actually navigates.
const FILL_MAX_PAGES = 3;
// Total-row cap: bounds the map / flatten / visibleListIndices cost. The end
// FARTHEST from the selection is evicted; demand re-fetches it later.
export const MAX_LIST_ROWS = 300;
// Last line of defense against a freeze with no exit at all: a no-progress
// backstop for the frozen render (_armFrozenWatchdog). Re-armed on
// every completed leg, so this is "nothing has advanced for 2.5s", NOT a cap on
// a whole multi-leg transaction (_beginOpenPinned can run a dozen legs).
const FROZEN_WATCHDOG_MS = 2500;
// Fast-fail budgets for the serialized machine keys. PTT answers in ~90ms and
// term_buf needs another SETTLE_MS (50ms) to settle, so anything past ~250ms of
// silence is already abnormal: ask the deterministic question (the queue's
// zero-side-effect \f probe) instead of sitting on a second-scale timeout with
// the list render frozen. 寧可降級回原生，不要凍畫面空等（錄製檔
// ptt-debug-20260825-105701#t=12562：open-jump 空等 4002ms）.
const CMD_PROBE_AFTER_MS = 250; // soft: triggers the probe, never a failure
const CMD_PROBE_WINDOW_MS = 600; // how long the probed full frame gets
const CMD_HARD_MS = 1200; // absolute cap from send (never re-armed)
// Background prefetch legs: slightly wider (they hold nothing hostage) but
// still far under the queue's 10s default.
const PREFETCH_HARD_MS = 1500;
// native-key / native-paste deliberately keep a LONG window: they do not freeze
// anything (the native mirror is already on screen) and their only job is to
// hold functionMode's settle absorption until their own response lands. Cutting
// it short ends the absorption early = the state churn they were introduced to
// stop (see _beginPassthroughBytes).
const NATIVE_PASSTHROUGH_MS = 3000;
// (2026-07-10) [ ] = / v / `/` 模擬交易與 T3 airlock 皆退役：非白名單鍵一律
// 走 _beginNativePassthrough（有序號選取先 sync-jump，再切原生鏡像＋代送）。

// Owner of list easy reading. Subscribes to term_buf 'screenSettled' and runs:
//   settle → snapshot+facts → queue.onSettle (command completion first)
//          → event booleans → transitionListSession → execute actions.
// Owns: state, the selection (by article NUMBER, stable across prepends), the
// board name (aliasing guard), and listRenderMode (bindProperty onto term_buf;
// 'native' | 'buffer' | 'frozen' — redraw/onKeyDown key off it, never off
// pageState).
export function ListSession(core, view, termBuf, queue) {
  this._core = core;
  this._view = view;
  this._termBuf = termBuf;
  this._queue = queue;

  this.state = 'idle';
  this._renderMode = 'native';
  this._boardName = null;
  this._selectedNum = null; // numbered selection (article number)
  // Article number WE opened (set in _beginOpen). Unlike _selectedNum this is
  // never a stale echo of a cursor that moved natively — see currentAnchor.
  this._openedNum = null;
  this._selectedPinnedKey = null; // pinned-row selection (title key)
  this._topNum = null; // window-top anchor (article number; native top_ln)
  this._fillTarget = 0;
  this._fillPages = 0;
  this._edgeUp = false;
  this._edgeDown = false;
  // Contiguity-prune pivot override while a far jump is in flight (End/Home):
  // the jump's landing page is DISCONTIGUOUS with the buffer by design, and the
  // prune must keep the TARGET segment, not the one the cursor came from.
  // undefined = no override (prune around the selection).
  this._prunePivotOverride = undefined;
  // Prefetch chain: after a completed same-direction prefetch page command the
  // server cursor position is KNOWN (the landed row) — the next prefetch may
  // skip the anchor-jump leg and send PgUp/PgDn directly (halving the
  // round-trips). ANY other server interaction invalidates the knowledge →
  // _breakChain() at every such point (flush callers, other enqueues, settles
  // with no in-flight command, buffer rebuilds). null = must anchor.
  this._chainState = null; // { dir: -1|1, lastLanded: number }
  // Last KNOWN server cursor article number (v5 speed fix): local T1 nav never
  // moves the real cursor, so after any landing that parked it on a known
  // number (seed/re-seed/resume facts, prefetch landings, relative resume)
  // a cursor-relative transaction ([ ] = / v) whose selection ALREADY equals
  // it can skip the sync-jump leg — one round-trip instead of two. null =
  // unknown (native excursion / probe timeout / article) → always sync first.
  this._serverNum = null;
  // SUBJECT of the last-read article (pttbbs currtitle mirror; see the
  // last-read styling block). Taught two ways: frame-taught when accumulate
  // spots a server-styled row (covers native excursions / search jumps), and
  // actively on our own serialized open (the client KNOWS what it just opened
  // — closes the partial-frame detection hole). Render paints EVERY row whose
  // subjectOfListRow matches, each in its own mark color. null = unknown;
  // reset only on cleanup — currtitle is per-login global on the server, so
  // seed/rebuild/board changes keep it (frames re-teach on any drift).
  this._lastReadTitle = null;
  // (2026-07-10) T3 airlock（同鍵二連擊）與 T2 mark/search 模擬皆退役：非白名單
  // 鍵一律走 _beginNativePassthrough（sync → 切原生 → 代送），單按即生效。
  // Sticky native excursion: true from _enterFunctionMode until a context
  // change (article handoff / board leave / resume) — while held, clean-list
  // settles do NOT bounce back to the buffer render (reducer reads it via
  // _settleEvent.nativeHold).
  this._nativeHold = false;
  // MODE_SELECT (`/` filtered list) sub-state: its article-number space is
  // independent from the main list (protocol §8) — entering/leaving forces a
  // rebuild (via _boardName=null) so numbers never alias.
  this._selectMode = false;
  // Absolute frozen-render backstop (see _armFrozenWatchdog). null = disarmed.
  this._frozenWatchdog = null;
  // ---- 平滑捲動（滾輪：緩動動畫＋次列位移）----
  // _scrollFrac：視窗頂端那一列**已經捲掉的像素**，恆在 [0, chh)。render 端把它
  // 交給 body 視口的 scrollTop（src/render/screen.js 的 .listBodyView），畫面因此
  // 停得住半列的位置 —— 沒有它，最小單位是一整列（26px），滾起來就是一階一階跳。
  // 兩個邊旗標由 _setWindow 每次更新（getWindowView 每幀都會呼叫 ⇒ 恆新）：貼齊
  // 邊界時 frac 必須是 0，否則會捲出空白。
  this._scrollFrac = 0;
  this._scrollAtTop = true;
  this._scrollAtBottom = true;
  // 邊旗標還沒被 _setWindow 算過（seed 完但還沒 render 過的視窗）⇒ 快路徑不可用，
  // 一律走慢路徑重算。**寧可多算一次也不能拿舊旗標擋捲動**：擋錯＝捲不動，
  // 而快路徑放行錯＝畫面露出空白。
  this._scrollEdgesKnown = false;
  this._scroller = null;

  bindProperty(this, '_renderMode', termBuf, 'listRenderMode');
  termBuf.addEventListener('screenSettled', this._onScreenSettled.bind(this));
}

ListSession.prototype = {
  // ---- settle pipeline -----------------------------------------------------

  _onScreenSettled: function() {
    const snap = this._termBuf.settleSnapshot;
    // A settle window with ZERO server-written rows AND no server cursor move
    // is a purely local repaint — those must never drive state transitions nor
    // feed the queue's expects. A cursor-only window (cursorMoved, zero rows)
    // IS a real response tail: when a response's content window and its final
    // cursor-park escape straddle a >SETTLE_MS gap, the response settles twice
    // and the second settle carries the authoritative park position — dropping
    // it starves the queue (the offline jump-anchor wedge).
    if (
      snap &&
      snap.changedRows &&
      snap.changedRows.size === 0 &&
      !snap.cursorMoved
    )
      return;
    const facts = this._collectFacts(snap);
    // Pure notification (touches nothing here): landing on a list or a menu
    // means the user left the article by themselves, so aid_navigation's back
    // anchors no longer describe where they are. Deliberately BEFORE
    // queue.onSettle — while OUR sequence runs, aidNavigation.active is still
    // true at this point and the call no-ops, so only foreign settles count.
    if (this._core.aidNavigation) this._core.aidNavigation.noteSettle(facts);
    // Server activity with NO command of ours in flight = external interaction
    // (user key passthrough, server-initiated repaint): the server cursor may
    // have moved — the prefetch chain's landed position is no longer trusted.
    // Checked BEFORE onSettle so a completing command's own settle (inFlight
    // still set here) never breaks the chain it is about to extend.
    if (!this._queue.inFlightKind) this._breakChain();
    // Command completion first, so the reducer sees inFlightKind post-account
    // and a completed open/prefetch can chain its next command before we act.
    // `consumed` marks a settle OWNED by the command that just completed on it
    // (done or miss): its inFlightKind is already null here, and a completion
    // frame that isn't clean-list (board-tail probe / jump park, protocol
    // §4✚/§6) must not look ownerless to active's transient catch-all
    //（2026-07-14 錄製檔誤降級）.
    const consumed = this._queue.onSettle(snap, facts);
    // A completed leg IS progress: re-arm the frozen backstop so it measures
    // "nothing advanced for FROZEN_WATCHDOG_MS" rather than capping a whole
    // multi-leg transaction (_beginOpenPinned's per-row steps would otherwise
    // race the cap once the per-command budgets got short).
    if (consumed === 'done' && (this._renderMode === 'frozen' || this.state === 'opening'))
      this._armFrozenWatchdog();
    this._dispatch(this._settleEvent(facts, consumed), facts);
  },

  // One facts object per settle: everything the classifier, the queue expects
  // and the reducer need, computed once. curX/curY come from the frozen settle
  // snapshot (the server's cursor park position for THIS response).
  _collectFacts: function(snap) {
    const buf = this._termBuf;
    const rowTexts = [];
    for (let r = 0; r < buf.rows; ++r) rowTexts.push(buf.getRowText(r, 0, buf.cols));
    const facts = {
      rowTexts: rowTexts,
      curX: snap ? snap.curX : buf.cur_x,
      curY: snap ? snap.curY : buf.cur_y,
      rows: buf.rows,
      row0Reversed: buf.isUnicolor(0, 0, 29),
      row2Reversed: buf.isUnicolor(2, 0, buf.cols - 10)
    };
    const cls = classifyListScreen(facts);
    facts.kind = cls.kind;
    facts.boardName = cls.boardName;
    // T4 banner wording (isWaterballSettle) reads the settle's dirty-row shape.
    facts.changedRows = snap ? snap.changedRows : null;
    facts.nums = pageArticleNums(rowTexts, facts.curY);
    facts.cursorRowNum =
      facts.curY >= 0 && facts.curY < facts.nums.length ? facts.nums[facts.curY] : null;
    return facts;
  },

  _settleEvent: function(facts, consumed) {
    return {
      type: 'settle',
      kind: facts.kind,
      boardNameMatch: facts.boardName != null && facts.boardName === this._boardName,
      inFlightKind: this._queue.inFlightKind,
      consumed: !!consumed,
      landedNumInBuffer:
        facts.cursorRowNum != null &&
        (this._termBuf.listLineNums || []).indexOf(facts.cursorRowNum) !== -1,
      nativeHold: !!this._nativeHold,
      hasNumberedRow: hasNumberedEntryRow(facts),
      engageEligible: this._engageEligible()
    };
  },

  // pref on ∧ standard 24-row term (v1 bypass otherwise) ∧ the article easy
  // reading is not mid-post (startedEasyReading tracks an actually-open post;
  // view.useEasyReadingMode stays latched true between posts, so it is NOT the
  // right guard here).
  _engageEligible: function() {
    return (
      !!readValuesWithDefault().enableEasyReadingList &&
      this._termBuf.rows === 24 &&
      !this._termBuf.startedEasyReading
    );
  },

  _dispatch: function(event, facts) {
    const r = transitionListSession(this.state, event);
    if (r.next !== this.state)
      this._core.debugRecorder?.log('listSession.transition', {
        from: this.state, event, to: r.next,
      });
    this.state = r.next;
    for (let i = 0; i < r.actions.length; ++i) this._runAction(r.actions[i], facts);
  },

  _runAction: function(action, facts) {
    switch (action) {
      case 'seed':
        return this._seed(facts);
      case 'start-fill':
        return this._startFill();
      case 'continue-fill':
        return this._maybeFill();
      case 'rebuild':
        return this._rebuild(facts);
      case 'handoff-article':
        return this._handoffArticle();
      case 'enter-function-mode':
        return this._enterFunctionMode(facts);
      case 'resume-buffer':
        return this._resumeBuffer(facts);
      case 'cleanup':
        return this._cleanup();
      // 'move-selection' / 'begin-open*' carry key context; executed in onKeyDown.
      case 'move-selection':
      case 'begin-open':
      case 'begin-open-pinned':
        return;
      default:
        return;
    }
  },

  // ---- external entry points ------------------------------------------------

  // Pref flipped ON while the screen sits still (no settle will come): evaluate
  // the current screen as if it just settled. Also used right after connect.
  evaluateNow: function() {
    if (this.state !== 'idle') return;
    const facts = this._collectFacts(null);
    this._dispatch(this._settleEvent(facts), facts);
  },

  // Pref flipped OFF / disconnect: single exit (mirrors exitEasyReading rigor).
  disable: function() {
    this._dispatch({ type: 'pref-off' }, null);
  },

  // An external serialized navigation (aid_navigation.js) is about to drive
  // the SHARED queue through list screens: park the session in functionMode
  // (native mirror, sticky nativeHold, queue flushed) so the reducer absorbs
  // the intermediate clean-list settles instead of resuming the buffer or
  // enqueuing its own commands mid-sequence. Must be called BEFORE the
  // external commands are enqueued (the flush here would drop them). The
  // final article settle takes the normal handoff-article path.
  beginExternalNavigation: function() {
    if (this.state === 'idle') return;
    this.state = 'functionMode';
    this._enterFunctionMode();
  },

  // Read-only snapshot of "which article is open, as a list coordinate" for
  // aid_navigation's back stack. Valid while an article is open (suspended):
  // _handoffArticle clears _serverNum only, so the board name, the selected
  // number and the last-read subject all survive into the open post.
  // MUST be read BEFORE beginExternalNavigation() — _enterFunctionMode() drops
  // _boardName/_serverNum on entry.
  // `board` may be null even with a usable number: a native excursion
  // (_enterFunctionMode — any non-list screen, e.g. the Q post-info box) drops
  // _boardName and the returning resume path does not re-seed it. The caller
  // fills that in from the article header (nav_history.chooseAnchor).
  // Which article is open, as a list coordinate, for aid_navigation's back
  // stack. _openedNum (set by our own serialized open) is the ONLY number that
  // provably matches the post on screen — two live misfires on 2026-08-13:
  //   - a pinned (置底) post has no number at all, and _selectedNum still held
  //     the previously selected numbered row → back opened a random article;
  //   - with the list rendered natively (functionMode after e.g. the Q info
  //     box), arrow keys move the server cursor without us, so _selectedNum
  //     stayed on the row it was last told about → back opened the wrong post.
  // `board` may be null (a native excursion drops _boardName and the resume
  // path does not re-seed it); the caller fills it in from the article header
  // (nav_history.chooseAnchor).
  currentAnchor: function() {
    if (this._openedNum == null) return null;
    return {
      board: this._boardName,
      num: this._openedNum,
      subject: this._lastReadTitle
    };
  },

  // The post we opened is no longer the one on screen (article→article keys,
  // which never pass a list screen — relayed by aid_navigation.noteLeftPost).
  noteLeftPost: function() {
    this._openedNum = null;
  },

  // Keyboard, called from term_view.onKeyDown ONLY while renderMode is
  // buffer/frozen (native modes never route here — full passthrough).
  onKeyDown: function(e) {
    // Browser/app-level clipboard combos stay with the handlers right after
    // this hook (term_view: Ctrl-C copy / Ctrl-A select-all / Ctrl-Shift-V
    // paste); Alt/Meta combos are browser shortcuts. Everything ELSE — Ctrl-P
    // 發文 included — falls through to the closed-interaction whitelist below
    // (v4 let all ctrl combos reach the server: an open key-leak).
    //
    // Shift-Insert (the paste shortcut this app tells users to use — i18n
    // alert_pasteShortcutText) MUST be in here too. It isn't a ctrl combo, so
    // it used to fall through to 'passthrough', whose e.preventDefault()
    // CANCELS THE BROWSER'S PASTE: no `paste` event on #t, App.onDOMPaste never
    // fires, and all PTT gets is the \x1b[2~ that keyEventToBytes made of the
    // Insert key. The list flipped to the native mirror with nothing pasted, so
    // the user had to paste a SECOND time (that one worked — by then
    // listRenderMode is 'native' and this hook isn't called at all). Bare
    // Insert stays a passthrough key: only the shifted form is a clipboard
    // action. The paste itself is handled in onPaste (App.onPasteDone routes it
    // back here), not by letting bytes leak straight onto the wire.
    const clipboard =
      (e.ctrlKey &&
        !e.altKey &&
        !e.metaKey &&
        ['c', 'a', 'v', 'x'].indexOf((e.key || '').toLowerCase()) !== -1) ||
      (e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && e.key === 'Insert');
    if (clipboard || e.altKey || e.metaKey) return;

    if (this.state === 'opening') {
      // Serialized open in flight: swallow everything (sub-second; the open
      // timeout self-heals a wedged one). Letting keys through would race the
      // jump/enter sequence — the exact v3 failure mode. Never silent: the
      // user gets a hint instead of dead keys (2026-07-10「按了沒反應」).
      e.preventDefault();
      if (this._view.flashListHint)
        this._view.flashListHint('好讀列表：開啟文章中，請稍候…');
      return;
    }
    if (this.state === 'functionMode' && this._renderMode === 'frozen') {
      // A serialized transaction (sync leg / leave / jump) is in flight behind
      // the frozen snapshot: swallow user keys — letting them through would
      // race the serialized bytes (typeahead, protocol §2). A missed command
      // can hold this for up to its timeout (~3s), so never swallow silently.
      e.preventDefault();
      if (this._view.flashListHint)
        this._view.flashListHint('好讀列表：指令處理中，請稍候…');
      return;
    }
    if (this.state !== 'active') return;

    const key = this._classifyKey(e);
    if (key.class === 'ignore') {
      // Deliberately NOT preventDefault'd: F12 devtools / CapsLock's OS
      // behaviour belong to the browser, and the native keyboard path below
      // sends nothing for these keys anyway.
      return;
    }
    if (key.class === 'passthrough') {
      // Non-whitelisted key: one-key switch to native (sync → mirror → send).
      // preventDefault is decided inside (Ctrl/unmappable keys stay native).
      this._beginNativePassthrough(e);
      return;
    }
    e.preventDefault();

    if (key.class === 'jump-digit') {
      // Digits collect LOCALLY (no server prompt round-trip): overlay input
      // pre-filled with the first digit; commit = one jump transaction.
      this._beginJumpCollect(key.digit);
      return;
    }

    const r = transitionListSession(this.state, { type: 'key', keyClass: key.class });
    this.state = r.next;
    for (let i = 0; i < r.actions.length; ++i) {
      const a = r.actions[i];
      if (a === 'move-selection') this._moveSelection(key.op);
      else if (a === 'begin-open') this._beginOpen();
      else if (a === 'begin-open-pinned') this._beginOpenPinned();
      else if (a === 'begin-leave') this._beginLeave();
      else this._runAction(a, null);
    }
  },

  // One-key native passthrough (2026-07-10; replaces the [ ] = / v / `/`
  // simulated transactions AND the T3 double-press airlock). Contract: any
  // non-whitelisted key = sync the REAL cursor to the selection when needed
  // (cursor-relative native commands act FROM it — [ ] = v; local T1 nav is
  // zero-network so it lags), then enter-function-mode (native excursion:
  // invariant 15 drops the cache via _boardName/_serverNum) and send the key
  // itself. The sync leg is serialized: sending "N\r" + key in one tick trips
  // pttbbs typeahead (protocol §2 — the old「[ 卡住但其實跳了」bug), so the
  // key goes out raw only after the jump's park settle. While the leg is on
  // the wire the reducer already sits in functionMode (keyClass 'passthrough')
  // over the frozen snapshot — other keys are swallowed with a hint.
  // Ctrl combos are NOT resent: no sync (can't serialize a key we don't own),
  // immediate mirror switch, and the event is left un-defaulted so the native
  // keyboard path sends this very press. Keys that map to NO bytes never get
  // here at all — _classifyKey turns them into 'ignore' (they would take the
  // same branch and hand over to a native path that also sends nothing).
  _beginNativePassthrough: function(e) {
    let bytes = e.ctrlKey ? null : keyEventToBytes(e);
    // A printable non-ASCII char must go out as Big5 (raw UTF-16 = mojibake).
    if (bytes && bytes.length === 1 && bytes.charCodeAt(0) > 127) bytes = u2b(bytes);
    if (bytes == null) {
      // Ctrl combo (only case left — see header): not resendable, so switch the
      // mirror now; the un-prevented event reaches the native keyboard handlers
      // right after this hook returns and they send it.
      const r0 = transitionListSession(this.state, { type: 'key', keyClass: 'passthrough' });
      this.state = r0.next;
      this._enterFunctionMode();
      if (this._view.flashListHint)
        this._view.flashListHint('已切至原生操作（開啟文章或離開看板後恢復好讀）', 4000);
      return;
    }
    e.preventDefault();
    this._beginPassthroughBytes(bytes);
  },

  // _beginNativePassthrough 的**後半段**，抽出來給滑鼠點功能鍵共用
  // （onFunctionKey）。純重構，鍵盤行為一字未改：前半段的 keyEventToBytes /
  // preventDefault / Ctrl 組合判斷留在原函式，那些只有鍵盤事件才有。
  _beginPassthroughBytes: function(bytes) {
    const r = transitionListSession(this.state, { type: 'key', keyClass: 'passthrough' });
    this.state = r.next; // functionMode: absorbs settles / swallows keys meanwhile
    const self = this;
    const finish = function() {
      self._enterFunctionMode(); // native excursion: flush + drop cache (inv. 15)
      // The key goes through the QUEUE, not raw conn.send: the sync leg's own
      // settle can be a clean-list (busy board full repaint) and the reducer
      // runs right after queue.onSettle — with nothing in flight it would
      // resume to the buffer immediately and the key's response would land in
      // `active` (state churn; live soak). An in-flight 'native-key' keeps the
      // absorption rule (functionMode + clean-list + inFlight → stay) until
      // the key's OWN response settles; a dead key just times out and we stay
      // in the native mirror (same picture, no harm).
      self._queue.enqueue({
        keys: bytes,
        kind: 'native-key',
        expect: function() {
          return true; // any settle is the response
        },
        timeoutMs: NATIVE_PASSTHROUGH_MS
      });
      if (self._view.flashListHint)
        self._view.flashListHint('已切至原生操作（開啟文章或離開看板後恢復好讀）', 4000);
    };
    if (this._selectedNum != null && this._selectedNum !== this._serverNum) {
      this._freezeForTransaction();
      // onFail too: still hand over to native + send (visible degrade — the
      // native mirror shows whatever the server did; never a silent dead key).
      this._enqueueCursorSyncJump('native-sync-jump', finish, finish);
      return;
    }
    finish();
  },

  // 滑鼠點畫面上的功能鍵按鈕（`[←]回上層` / `[→]閱讀` / `[c]新文章` …），由
  // App.onFunctionKey 轉進來。回 true ＝我接手了（呼叫端不可以再送一次）。
  //
  // **為什麼不能直送 byte**：v5 的封閉互動合約是「白名單以外的鍵＝一鍵切原生，
  // 永不靜默」（見 _classifyKey / docs/easy-reading-list.md）。滑鼠點功能鍵語意上
  // 完全等同按下那個鍵，必須走同一條路，否則 byte 會落在使用者看不見的畫面上、
  // 又繞過 CommandQueue。
  onFunctionKey: function(bytes) {
    if (this._renderMode === 'native') return false; // 沒接管，交給一般路徑
    if (this.state === 'opening') {
      if (this._view.flashListHint)
        this._view.flashListHint('好讀列表：開啟文章中，請稍候…');
      return true;
    }
    if (this.state === 'functionMode' && this._renderMode === 'frozen') {
      if (this._view.flashListHint)
        this._view.flashListHint('好讀列表：指令處理中，請稍候…');
      return true;
    }
    if (this.state !== 'active') return false;
    if (!bytes) return true;

    const cls = this._classifyBytes(bytes);
    if (cls.class === 'passthrough') {
      this._beginPassthroughBytes(bytes);
      return true;
    }
    const r = transitionListSession(this.state, { type: 'key', keyClass: cls.class });
    this.state = r.next;
    for (let i = 0; i < r.actions.length; ++i) {
      const a = r.actions[i];
      if (a === 'move-selection') this._moveSelection(cls.op);
      else if (a === 'begin-open') this._beginOpen();
      else if (a === 'begin-open-pinned') this._beginOpenPinned();
      else if (a === 'begin-leave') this._beginLeave();
      else this._runAction(a, null);
    }
    return true;
  },

  // 滑鼠的左側退出帶（cols 0-6）→ 與按 ← 完全同一條路。
  // **絕不直送 byte**：_beginLeave 會先 getkeep 把 server 的真游標同步回來再送鍵。
  onMouseExitClick: function() {
    return this.onFunctionKey(LEFT_ARROW);
  },

  // byte 序列 → 白名單類別。**刻意獨立於 _classifyKey，不要合併**：
  // 後者認 `q` / `e` / `j` / `k` / `n` / `p` 這些**字元**為導覽鍵，因為那是使用者
  // 按下的按鍵；而 byte 層看到的 'q' 就只是 'q'（例如貼上、或功能鍵標示的字面
  // 按鍵）。合併會把「按鍵」與「送位元組」兩種語意攪在一起。
  //
  // 這裡只認**明確的方向鍵／翻頁鍵序列**，其餘一律 passthrough（切原生＋送出），
  // 方向安全：passthrough 永遠會把鍵送到 PTT，只是畫面切回原生。
  _classifyBytes: function(bytes) {
    switch (bytes) {
      case '\x1b[A': return { class: 'nav', op: 'up' };
      case '\x1b[B': return { class: 'nav', op: 'down' };
      case '\x1b[5~': return { class: 'nav', op: 'pgup' };
      case '\x1b[6~': return { class: 'nav', op: 'pgdn' };
      case '\x1b[1~': return { class: 'nav', op: 'home' };
      case '\x1b[4~': return { class: 'nav', op: 'end' };
      case '\x1b[C':
      case '\r':
        return { class: this._selectedNum == null ? 'open-pinned' : 'open' };
      case LEFT_ARROW: return { class: 'leave' };
      default: return { class: 'passthrough' };
    }
  },

  // Paste (Shift-Insert / context menu / middle click), routed here from
  // App.onPasteDone — the single funnel every paste route already goes through.
  // Returns true when this session took ownership of the text (the caller must
  // NOT also send it), false to let the ordinary native path run.
  //
  // Shape is exactly the T3 one-key passthrough (_beginNativePassthrough), only
  // the payload is a whole string instead of one key's bytes: sync the real
  // cursor when it lags the selection, switch to the native mirror, then send.
  // Two reasons it can't just go raw down view.onTextInput like it used to:
  //   - un-serialized bytes race whatever prefetch/jump is in flight (pttbbs
  //     typeahead swallows repaints — protocol §2);
  //   - in buffer mode the screen shows the accumulated list, so the prompt PTT
  //     draws in response is INVISIBLE until some later settle trips the
  //     catch-all. Users read that as "nothing happened" and paste again, which
  //     appends into the same prompt (#1gIeu-3A1gIeu-3A → 找不到文章).
  // What PTT then does with the text is left entirely native — no AID parsing,
  // no synthesized Enter. `#` opens 搜尋文章代碼(AID): # and waits for Enter,
  // and on success only MOVES the cursor (pttbbs read.c#select_by_aid); a
  // pasted trailing newline submits it, exactly as in a real terminal.
  onPaste: function(text) {
    if (this.state === 'opening') {
      // Same rule as onKeyDown: the serialized open owns the wire. Never
      // silent — a swallowed paste with no feedback is the original bug.
      if (this._view.flashListHint)
        this._view.flashListHint('好讀列表：開啟文章中，請稍候…');
      return true;
    }
    if (this.state === 'functionMode' && this._renderMode === 'frozen') {
      if (this._view.flashListHint)
        this._view.flashListHint('好讀列表：指令處理中，請稍候…');
      return true;
    }
    // Native mirror (or not engaged at all): this hook doesn't own keys there,
    // and paste is no different — the ordinary convSend path is correct.
    if (this.state !== 'active') return false;

    // CommandQueue's send is bound to the RAW conn.send (pttchrome.jsx), not
    // conn.convSend, so the Big5 conversion that convSend would have done has
    // to happen here — same two steps, same order (telnet.js#convSend).
    const keys = ansiHalfColorConv(
      u2b(normalizePasteText(text, this._view.lineWrap))
    );
    if (!keys) return false; // empty/unconvertible: don't burn a native switch

    const r = transitionListSession(this.state, {
      type: 'key',
      keyClass: 'passthrough'
    });
    this.state = r.next; // functionMode: absorbs settles / swallows keys meanwhile
    const self = this;
    const finish = function() {
      self._enterFunctionMode(); // native excursion: flush + drop cache (inv. 15)
      self._queue.enqueue({
        keys: keys,
        kind: 'native-paste',
        expect: function() {
          return true; // any settle is the response (same as 'native-key')
        },
        timeoutMs: NATIVE_PASSTHROUGH_MS
      });
      if (self._view.flashListHint)
        self._view.flashListHint(
          '已貼上並切至原生操作（開啟文章或離開看板後恢復好讀）',
          4000
        );
    };
    if (this._selectedNum != null && this._selectedNum !== this._serverNum) {
      this._freezeForTransaction();
      // onFail too: visible degrade, never a silently dropped paste.
      this._enqueueCursorSyncJump('native-sync-jump', finish, finish);
      return true;
    }
    finish();
    return true;
  },

  // Shared sync-jump leg: park the server's REAL cursor on the local selection
  // before a command that acts FROM the cursor ([ ] = / v mark / ← leave —
  // pttbbs remembers the board position via the real cursor, getkeep). Expect
  // = jump-landing park fingerprint (protocol §4 ✚, same as open-jump). NOT
  // clean-list: the post-jump bottom row stays empty even through a \f redraw
  // (redrawwin repaints the server's CURRENT virtual screen — protocol §6 M1
  // correction). Timeout recovery = the queue's \f probe. Callers gate on
  // `_selectedNum != null` and the `_serverNum` fast path themselves.
  _enqueueCursorSyncJump: function(kind, onSynced, onFail) {
    const num = this._selectedNum;
    const self = this;
    this._queue.enqueue({
      keys: String(num) + '\r',
      kind: kind,
      expect: function(snap, facts) {
        return (
          facts.cursorRowNum === num &&
          facts.curY >= 3 &&
          facts.curY <= facts.rows - 2 &&
          facts.curX <= 1
        );
      },
      // EVERY number-jump leg carries fullRepaint. A jump whose target is the
      // row the real cursor is ALREADY on produces zero screen delta, so PTT
      // sends ZERO bytes — and term_buf only arms its settle timer on server
      // activity, so no settle ever reaches the expect and the command can only
      // die by timeout (錄製檔 ptt-debug-20260825-105701#t=12562: prefetch had
      // just parked the cursor on 2381, the open jumped to 2381 again, 4002ms
      // of frozen screen followed). The appended \f forces one full frame, so
      // the landing is always judgeable. The expect stays the PARK fingerprint:
      // protocol §6 M1 — redrawwin repaints the server's CURRENT virtual screen,
      // so the post-jump bottom row stays empty and this never becomes
      // clean-list.
      fullRepaint: true,
      timeoutMs: CMD_PROBE_AFTER_MS,
      probeTimeoutMs: CMD_PROBE_WINDOW_MS,
      hardTimeoutMs: CMD_HARD_MS,
      onDone: function() {
        self._serverNum = num;
        onSynced();
      },
      onFail: function() {
        self._serverNum = null;
        onFail();
      }
    });
  },

  // 'begin-leave' executor (v5 T2): ←/q/e as a serialized transaction over the
  // frozen snapshot — no native flash (blacklist/deleted rows stay hidden while
  // the response is on the wire). The completing settle routes through the
  // functionMode table: menu → cleanup (left the board), clean-list → resume
  // (MODE_SELECT exit / thread hop landed back on a list). Timeout/miss =
  // explicit degrade to the native mirror (v5: failures are visible).
  _beginLeave: function() {
    this._freezeForTransaction();
    const num = this._selectedNum;
    if (num == null || num === this._serverNum) {
      // Pinned/no selection (nothing to jump to) or the real cursor is
      // already on the selection — skip the sync leg (one round-trip).
      this._enqueueLeaveKey();
      return;
    }
    // Sync the REAL cursor to the selection first: pttbbs stores the board's
    // re-entry position from the real cursor on exit (getkeep) — leaving from
    // a stale cursor makes the NEXT board entry land somewhere else entirely
    // (local T1 navigation is zero-network; 2026-07-08 report).
    const self = this;
    this._enqueueCursorSyncJump('leave-sync-jump', function() {
      self._enqueueLeaveKey();
    }, function() {
      self._degradeToNative('離開列表逾時，已切至原生模式');
    });
  },

  _enqueueLeaveKey: function() {
    const self = this;
    this._serverNum = null; // the landing (menu / main list) re-teaches it
    this._queue.enqueue({
      keys: '\x1b[D',
      kind: 'leave-board',
      expect: function(snap, facts) {
        return facts.kind === 'menu' || facts.kind === 'clean-list';
      },
      timeoutMs: CMD_PROBE_AFTER_MS,
      probeTimeoutMs: CMD_PROBE_WINDOW_MS,
      hardTimeoutMs: CMD_HARD_MS,
      // onDone runs BEFORE the same settle's reducer pass: leaving a
      // MODE_SELECT list lands back on the MAIN list whose number space is
      // different (§8) — clear _boardName so the reducer path rebuilds.
      onDone: function() {
        if (self._selectMode) {
          self._selectMode = false;
          self._boardName = null;
        }
      },
      onFail: function() {
        self._degradeToNative('離開列表逾時，已切至原生模式');
      }
    });
  },

  // ---- T2 transactions (v5, M3) ---------------------------------------------

  // Freeze the window snapshot and clear the pipeline — shared preamble of
  // every serialized transaction (relative pair / leave / T2). flushPending,
  // NOT flush: an in-flight prefetch stays PAIRED so its on-the-wire response
  // can't become an ownerless settle that prematurely satisfies our expect
  // (live race) — the transaction serializes behind it.
  _freezeForTransaction: function() {
    this._resetScroll(); // 凍結前先回到整列對齊（frozen 快照不該停在半列）
    this._breakChain();
    this._prunePivotOverride = undefined; // flush is silent — reset here
    this._queue.flushPending();
    this._expediteBackground();
    this._renderMode = 'frozen';
    this._setLoading(true);
    this._armFrozenWatchdog();
    this._view.hideCursor();
    this._forceRedraw();
  },

  // The render is about to freeze behind a user transaction. If the wire is
  // still owned by a BACKGROUND prefetch, cut its remaining wait to ~a
  // round-trip (queue.expedite fires the ordinary \f probe, so the command
  // keeps its pairing — invariant 7 forbids flushing it). Without this the
  // frozen screen sat out the prefetch's whole soft/hard budget before the
  // user's first byte went out（回報：連按翻頁後開文/離板「畫面停住、顯示
  // 處理中，過一陣子才復原」）. Foreground kinds are left alone: transactions
  // stay strictly serialized with respect to each other.
  _expediteBackground: function() {
    const kind = this._queue.inFlightKind || '';
    if (kind.indexOf('prefetch') === 0 && this._queue.expedite)
      this._queue.expedite(250);
  },

  // Absolute backstop for the frozen render. Every freeze has its own timeout
  // path, but a callback that never runs (a reducer with no transition for the
  // event — e.g. _openFailed dispatched outside `opening` — or a silently
  // flushed command) would strand the list frozen FOREVER: screen never
  // repaints and every key is swallowed. Re-armed per freeze; a no-op if the
  // render already recovered, so it needs no clearing at the many unfreeze
  // points (only _cleanup tears it down).
  _armFrozenWatchdog: function() {
    const self = this;
    if (this._frozenWatchdog) clearTimeout(this._frozenWatchdog);
    this._frozenWatchdog = setTimeout(function() {
      self._frozenWatchdog = null;
      if (self._renderMode === 'frozen' || self.state === 'opening')
        self._degradeToNative('指令逾時，已切至原生模式');
    }, FROZEN_WATCHDOG_MS);
  },

  // Number jump: digits collected locally (overlay input), one serialized
  // jump transaction on commit. The landing page may be far outside the
  // buffer → rebuild from the landed facts instead of resuming stale anchors.
  _beginJumpCollect: function(firstDigit) {
    const self = this;
    if (!this._view.promptListInput) return; // no UI — stay put (tests)
    this._view.promptListInput('跳至第幾項：', firstDigit, function(val) {
      const num = val ? parseInt(val, 10) : NaN;
      if (!num || num <= 0) return; // cancelled / not a number: zero server
      const r = transitionListSession(self.state, { type: 'key', keyClass: 'transact' });
      self.state = r.next;
      self._beginJumpNumber(num);
    });
  },

  _beginJumpNumber: function(num) {
    this._freezeForTransaction();
    this._prunePivotOverride = null; // far jump: keep the landing segment
    const self = this;
    let landed = null;
    this._queue.enqueue({
      keys: String(num) + '\r',
      kind: 'jump-number',
      expect: function(snap, facts) {
        // Jump-landing park fingerprint. The server CLAMPS an over-large
        // number to the last line (search_num) — accept any entry-area park
        // (the landed page is authoritative, whatever row it chose).
        if (facts.curY >= 3 && facts.curY <= facts.rows - 2 && facts.curX <= 1) {
          landed = facts;
          return true;
        }
        return false;
      },
      // 跳號腿一律 fullRepaint（詳見 _enqueueCursorSyncJump）.
      fullRepaint: true,
      timeoutMs: CMD_PROBE_AFTER_MS,
      probeTimeoutMs: CMD_PROBE_WINDOW_MS,
      hardTimeoutMs: CMD_HARD_MS,
      onDone: function() {
        // Adopt the landed page wholesale (it may be discontiguous with the
        // buffer): rebuild seeds anchors from the landed facts.
        self._prunePivotOverride = undefined;
        self.state = 'active';
        self._renderMode = 'buffer';
        self._setLoading(false);
        self._view.hideCursor();
        self._rebuild(landed);
      },
      onFail: function() {
        self._prunePivotOverride = undefined;
        self._degradeToNative('跳號逾時，已切至原生模式');
      }
    });
  },

  // Key → whitelist class (the enumeration IS the contract —
  // docs/easy-reading-list.md §操作分類). Whitelist = navigation / open /
  // number jump / leave; anything else is 'passthrough' (one-key switch to
  // native + resend, _beginNativePassthrough) — never a SILENT passthrough,
  // and never a swallowed dead key (the retired noop/airlock pair).
  _classifyKey: function(e) {
    // Keys that produce NO bytes at all (CapsLock / F1-F12 / NumLock /
    // ScrollLock / unmappable Ctrl-Shift combos): swallow, never transition.
    // The passthrough contract assumes the un-prevented event still reaches
    // PTT through the native keyboard path, but TermKeyboard._onKeyDown drops
    // these too (KeyMap miss + key.length !== 1) — so a native excursion here
    // costs the buffer, the cache (inv. 15) and a sticky hold while the server
    // never moves, leaving a mirror of whatever page the prefetch last landed
    // on (2026-08「按 Caps Lock/F2 畫面跑掉」). The test IS the send path, so
    // no hardcoded key list can drift out of sync with it. Article easy
    // reading has the same guard as `e.key.length === 1` (easy_reading.js).
    if (keyEventToBytes(e) == null) return { class: 'ignore' };
    if (e.ctrlKey) return { class: 'passthrough' }; // Ctrl-P 發文 etc.
    // Navigation synonyms follow pttbbs read.c:858-902 (' ' / 'N' / KEY_PGDN /
    // Ctrl-F = next page, 'P' / KEY_PGUP / Ctrl-B = prev page, 'p'/'k'/KEY_UP,
    // 'n'/'j'/KEY_DOWN, '$'/KEY_END). Ctrl-F/Ctrl-B deliberately stay out:
    // ctrl combos keep their existing browser-shortcut boundary.
    switch (e.key) {
      case 'ArrowUp':
      case 'k':
      case 'p':
        return { class: 'nav', op: 'up' };
      case 'ArrowDown':
      case 'j':
      case 'n':
        return { class: 'nav', op: 'down' };
      case 'PageUp':
      case 'P':
        return { class: 'nav', op: 'pgup' };
      case 'PageDown':
      case ' ':
      case 'N':
        return { class: 'nav', op: 'pgdn' };
      case 'Home':
        return { class: 'nav', op: 'home' };
      case 'End':
      case '$':
        return { class: 'nav', op: 'end' };
      case 'Enter':
      case 'ArrowRight':
        return { class: this._selectedNum == null ? 'open-pinned' : 'open' };
      case 'ArrowLeft':
      case 'q':
      case 'e':
        // Leave-board family (read.c:712 q/e/KEY_LEFT) — high-frequency, so a
        // first-class serialized transaction rather than an airlock.
        return { class: 'leave' };
      default:
        // Number jump (T2): digits collect locally in an overlay; committing
        // runs a single serialized jump transaction (_beginJumpNumber).
        if (/^[0-9]$/.test(e.key)) return { class: 'jump-digit', digit: e.key };
        return { class: 'passthrough' };
    }
  },

  // Wheel (routed from App.mouse_scroll with the native pref mapping already
  // applied): execute the op through the SAME nav path as the keyboard.
  onWheel: function(op) {
    if (this.state !== 'active' || this._renderMode !== 'buffer') return;
    this._moveSelection(op);
  },

  // 滾輪平滑捲動（pref mouseWheelSmoothScroll，預設開）：`px` 是**未縮放的內容像素**
  // （呼叫端已把 deltaY 除以 scaleY），一律交給緩動器分散到數幀。
  //
  // 與鍵盤導覽共用狀態機、demand 與讀取中膠囊；仍然是純本地：零 byte、不轉態。
  onWheelScrollPx: function(px) {
    if (this.state !== 'active' || this._renderMode !== 'buffer') return;
    if (!px) return;
    this._ensureScroller().add(px);
  },

  _ensureScroller: function() {
    if (!this._scroller) {
      const self = this;
      const raf =
        typeof requestAnimationFrame === 'function'
          ? function(fn) { return requestAnimationFrame(fn); }
          : function(fn) { return setTimeout(fn, 16); };
      const cancel =
        typeof cancelAnimationFrame === 'function'
          ? function(h) { cancelAnimationFrame(h); }
          : function(h) { clearTimeout(h); };
      this._scroller = createSmoothScroller({
        raf: raf,
        cancel: cancel,
        onStep: function(step) { return self._stepScroll(step); }
      });
    }
    return this._scroller;
  },

  // 動畫的一幀。回 false ⇒ 緩動器停止（撞到邊界／模式已切走）。
  //
  // 兩條路徑，差別是成本：**沒跨列**就只改視口偏移（一次 scrollTop 寫入，不重繪、
  // 不重算序列）；跨列才動視窗錨並重繪。滾輪的事件率遠高於按鍵，序列重算是
  // O(緩衝列數) 的 rowToText，每幀都做會吃掉整個 frame budget。
  _stepScroll: function(step) {
    if (this.state !== 'active' || this._renderMode !== 'buffer') return false;
    const rowH = this._rowHeight();
    if (!(rowH > 0)) return false;
    const next = this._scrollFrac + step;
    if (this._scrollEdgesKnown) {
      // 邊界：貼齊時 frac 必須是 0（再捲就是露出空白）。
      if (next < 0 && this._scrollAtTop) {
        this._setScrollFrac(0);
        return false;
      }
      if (next > 0 && this._scrollAtBottom) {
        this._setScrollFrac(0);
        return false;
      }
      if (next >= 0 && next < rowH) {
        this._setScrollFrac(next);
        return true;
      }
    }
    // 跨列：換算成「序列像素座標」再夾擠，一次算出新的 (top, frac)。
    const seq = this._sequence();
    const pos = this._windowPos(seq);
    if (!pos) return false;
    const B = this._bodyRows();
    const maxPx = Math.max(0, seq.length - B) * rowH;
    // 上限要取 max(理論上限, 目前位置)：pgup/pgdn 可以把 top 推到超過 maxTop 的
    // 位置（read.c 語意，下面全是空白補列），從那裡往下捲**不可以**把視窗往回
    // 拉，往上捲也不該一次被吸到 maxTop。與 scrollListWindow 的方向性夾擠同源。
    const capPx = Math.max(maxPx, pos.top * rowH);
    let target = pos.top * rowH + next;
    let hitEdge = false;
    if (target < 0) {
      target = 0;
      hitEdge = true;
    } else if (target > capPx) {
      target = capPx;
      hitEdge = true;
    }
    // 1e-6：浮點誤差讓 target 剛好落在列邊界下方一點點時，floor 會少一列。
    const newTop = Math.floor(target / rowH + 1e-6);
    const newFrac = Math.max(0, target - newTop * rowH);
    const delta = newTop - pos.top;
    if (!delta) {
      this._setScrollFrac(newFrac);
      return !hitEdge;
    }
    const r = scrollListWindow(pos, delta, { len: seq.length, bodyRows: B });
    this._setWindow(seq, r.top, r.cursor);
    this._scrollFrac = newFrac;
    this._forceRedraw();
    const direction = delta < 0 ? -1 : 1;
    this._maybeDemand(direction);
    const moreExpected = direction > 0 ? !this._edgeDown : !this._edgeUp;
    const atEdge = direction > 0 ? this._scrollAtBottom : this._scrollAtTop;
    if (atEdge && moreExpected && !this._queue.idle) this._setLoading(true);
    return !hitEdge;
  },

  // 未縮放的列高（＝畫面上的 chh；scaleY 由呼叫端在換算 deltaY 時處理）。
  _rowHeight: function() {
    return (this._view && this._view.chh) || 0;
  },

  // 只改視口偏移的快路徑：不重繪、不重算序列，一次 scrollTop 寫入。
  _setScrollFrac: function(px) {
    this._scrollFrac = px;
    const screen = this._view && this._view.componentScreen;
    if (screen && screen.setListScrollOffset) screen.setListScrollOffset(px);
  },

  // 回到整列對齊（鍵盤導覽／交易／切模式）。次列偏移是滾輪專屬狀態，其他入口
  // 一律先歸零，否則畫面會停在半列上。
  _resetScroll: function() {
    if (this._scroller) this._scroller.stop();
    if (this._scrollFrac) {
      this._scrollFrac = 0;
      this._forceRedraw();
    }
  },

  // render 端（term_view.buildListWindowLines）用來決定要不要多畫一列補滿視口。
  scrollFrac: function() {
    return this._scrollFrac;
  },

  // 左鍵單擊某一列（App.mouse_click 已把 client 座標換成**渲染後**的列號）＝
  // 「把選取移到那一列並開文」，與原生滑鼠瀏覽的語意一致。
  //
  // 合約（不可放行到 App.onMouse_click）：那條會依 buf.mouseAction 與 server 的真實
  // 24 列幾何直接 conn.send('\x1b[A'×N + '\r')。畫面上是我們自己組的虛擬視窗，兩套
  // 座標並不對應 ⇒ 會開到別篇，而且繞過 CommandQueue（違反 v5 封閉互動 + 交易序列化）。
  // 這裡改成「解析出絕對索引 → 寫回序號錨 → 走鍵盤同一條 reducer/開文交易」。
  onMouseClick: function(renderRow, col) {
    // 原生鏡像期間（passthrough/functionMode 的 native）不歸這裡管：呼叫端根本不會
    // 進來，但保險起見不處理也不提示，交給原生滑鼠瀏覽。
    if (this._renderMode === 'native') return;
    if (this.state !== 'active' || this._renderMode !== 'buffer') {
      // 交易進行中（開文／leave／jump 的 frozen）：與鍵盤同樣的「吞掉但不靜默」。
      if (this._view.flashListHint)
        this._view.flashListHint('好讀列表：處理中，請稍候…');
      return;
    }
    // renderRow === rows（＝24）是平滑捲動時視口底部露出的那一小條（overscan 列，
    // 渲染 index 24；App.clientToPos 會算出這個列號）。它一樣點得到。
    const isOverscan = renderRow === this._termBuf.rows;
    const idx = renderRow - LIST_HEADER_ROWS;
    if (!isOverscan && (idx < 0 || idx >= this._bodyRows())) return; // header / footer
    // 防誤觸模式開啟時只有標題欄可以開文，與原生一致（避免點到日期／作者欄誤開）。
    // 虛擬視窗的欄位與 server 的 readdoent 逐格對齊（buildListWindowLines 取的就是
    // 同一批 80 格 TermChar；relabelListCursorRow 只重寫 cols 0-6、labelListCursor
    // 的半形 '>' 只佔 cell 0），所以 comment_parse 的欄位表在這裡照樣成立。
    const guard = !!(
      this._termBuf &&
      this._termBuf.useMouseBrowsing &&
      this._view &&
      this._view.mouseMisclickGuard
    );
    if (col < clickableColStart(2, guard)) return;
    const win = this.getWindowView();
    if (!win) return;
    const abs = isOverscan ? win.overscanAbs : win.body[idx];
    if (abs == null) return; // 短頁的空白補列，沒有文章可點
    // 點擊＝離開捲動：停止動畫並回到整列對齊（視窗的 top/游標不受影響，所以上面
    // 解析出來的 abs 仍然有效）。
    this._resetScroll();

    const nums = this._termBuf.listLineNums || [];
    this._selectedNum = nums[abs];
    this._selectedPinnedKey =
      this._selectedNum == null ? this._pinnedKeyAt(abs) : null;
    // 先同步重畫：_beginOpen 會立刻切 frozen 並定住當下的視窗快照，沒有這一步
    // 凍住的會是**點擊前**的游標位置（畫面看起來像點錯列）。
    this._forceRedraw();

    const keyClass = this._selectedNum == null ? 'open-pinned' : 'open';
    const r = transitionListSession(this.state, { type: 'key', keyClass: keyClass });
    this.state = r.next;
    for (let i = 0; i < r.actions.length; ++i) {
      const a = r.actions[i];
      if (a === 'begin-open') this._beginOpen();
      else if (a === 'begin-open-pinned') this._beginOpenPinned();
      else this._runAction(a, null);
    }
  },

  // ---- actions ---------------------------------------------------------------

  _seed: function(facts) {
    this._nativeHold = false;
    this._breakChain();
    // _lastReadTitle deliberately NOT reset: pttbbs's currtitle is per-login
    // global (readdoent compares it in every board), and a title key doesn't
    // depend on the number space. The seed frame re-teaches anyway.
    this._view.resetListAccumulation();
    this._termBuf.listLines = [];
    this._termBuf.listLineNums = [];
    this._boardName = facts.boardName;
    this._edgeUp = false;
    this._edgeDown = false;
    this._fillPages = 0;
    this._renderMode = 'buffer';
    this._view.hideCursor();
    this._seedAnchors(facts);
    this._forceRedraw(); // synchronous: accumulates this page into the buffer
    if (this._selectedNum == null && this._selectedPinnedKey == null)
      this._selectLastNumbered();
    // Same as _rebuild: an engage landing mid-board (getkeep restored the read
    // cursor above the newest article) leaves the window short — blank rows below
    // and NOTHING buffered there. Background fill only pages UP; without this the
    // gap never fills until the user presses ↓ (問題1), and the down-prefetch's
    // markEdge never fires so _edgeDown stays false → the whole pinned tail is
    // gated out (問題2b). Fill the visible window downward first; start-fill's
    // upward _maybeFill runs right after (defers while this leg is in flight, then
    // the demand chain's onDone falls back to it).
    this._demandDownIfWindowShort();
  },

  // Fill the visible window downward when the landing page is short (window taller
  // than the buffer below the top anchor = real blank rows), the bottom edge is not
  // yet confirmed, and the queue is idle. Shared by _seed and _rebuild. Guard is
  // intentional: an unconditional demand would probe past a FULL landing page — at
  // a board end that is a zero-response PgDn whose timeout→\f probe races the hard
  // timeout into an ownerless settle (spurious functionMode banner). See
  // docs/easy-reading-list.md 已知限制「滿版落點不得探測」.
  _demandDownIfWindowShort: function() {
    const seq = this._sequence();
    const pos = seq.length ? this._windowPos(seq) : null;
    if (
      pos &&
      seq.length < pos.top + this._bodyRows() &&
      !this._edgeDown &&
      this._queue.idle
    )
      this._enqueuePrefetch(false, 'key');
  },

  _rebuild: function(facts) {
    this._breakChain();
    // _lastReadTitle kept: title keys are number-space independent (see _seed).
    this._view.resetListAccumulation();
    this._termBuf.listLines = [];
    this._termBuf.listLineNums = [];
    this._boardName = facts ? facts.boardName : this._boardName;
    this._edgeUp = false;
    this._edgeDown = false;
    this._fillPages = 0;
    this._seedAnchors(facts);
    this._forceRedraw();
    if (this._selectedNum == null && this._selectedPinnedKey == null)
      this._selectLastNumbered();
    // The landing page may sit mid-board with NOTHING buffered below (e.g. a
    // MODE_SELECT exit lands on the account's read cursor over a PARTIAL
    // server frame) — the window would render blank rows until the user
    // happens to press a key. Fill the visible window downward FIRST (shared
    // guard with _seed), then the upward background fill takes over (the demand
    // chain's onDone falls back to _maybeFill).
    this._demandDownIfWindowShort();
    this._maybeFill();
  },

  // Adopt the native screen's cursor + window top as our anchors (facts from a
  // clean-list settle): the window then renders EXACTLY what native shows.
  // The bottom edge is confirmed when a ★pinned row is on screen — 置底文 exist
  // only on the board's last page (read.c bottom_line..last_line); without any
  // pinned row the edge stays unknown and demand discovers it later.
  _seedAnchors: function(facts) {
    this._serverNum = facts ? facts.cursorRowNum : null;
    this._selectedNum = facts ? facts.cursorRowNum : null;
    this._selectedPinnedKey = null;
    this._topNum = null;
    if (facts) {
      for (let r = 3; r <= facts.rows - 2; ++r) {
        if (facts.nums[r] != null) {
          this._topNum = facts.nums[r];
          break;
        }
      }
      let hasPinned = false;
      for (let r = 3; r <= facts.rows - 2; ++r) {
        const t = facts.rowTexts[r] || '';
        if (t.indexOf('★') >= 0 && isPinnedListRow(t)) {
          hasPinned = true;
          break;
        }
      }
      if (hasPinned) this._edgeDown = true;
      if (this._selectedNum == null) {
        const ct = facts.rowTexts[facts.curY] || '';
        if (isPinnedListRow(ct) && ct.indexOf('★') >= 0) {
          this._selectedPinnedKey = pinnedRowKey(ct);
          return;
        }
      }
    }
  },

  _startFill: function() {
    this._fillTarget = readValuesWithDefault().easyReadingListPrefetchCount || 0;
    this._fillPages = 0;
    this._maybeFill();
  },

  // Background fill: page UP (older articles — we enter at the newest) until
  // enough visible rows, the page cap, or the top edge. One command at a time,
  // chained via onDone — never in parallel with anything.
  _maybeFill: function() {
    if (this.state !== 'active') return;
    if (this._edgeUp) return;
    if (!this._queue.idle) return;
    if (
      shouldStopListPrefetch({
        visibleCount: this._visibleIndices().length,
        target: this._fillTarget,
        pageCount: this._fillPages,
        maxPages: FILL_MAX_PAGES
      })
    )
      return;
    this._enqueuePrefetch(true, 'fill');
  },

  // Demand prefetch: keep TWO full pages of rows buffered beyond the window in
  // the direction of travel (one page was too late — the fetch only started
  // once the user was about to hit the edge, so every boundary crossing waited
  // out the full serialized round-trips; two pages of headroom lets the chain
  // finish before the user gets there). Only the direction of travel is
  // extended — in a small buffer everything is "near" both edges.
  _maybeDemand: function(direction) {
    if (this.state !== 'active' || !this._queue.idle) return;
    const seq = this._sequence();
    if (!seq.length) return;
    const pos = this._windowPos(seq);
    if (!pos) return;
    const B = this._bodyRows();
    if (direction < 0 && pos.top < 2 * B && !this._edgeUp)
      this._enqueuePrefetch(true, 'key');
    else if (
      direction > 0 &&
      seq.length - (pos.top + B) < 2 * B &&
      !this._edgeDown
    )
      this._enqueuePrefetch(false, 'key');
  },

  // term_view.accumulateListLines evicted rows past MAX_LIST_ROWS on this end:
  // clear the edge flag so demand can re-fetch the dropped segment. The buffer
  // edge moved under the chain → its landed reference may now be discontiguous
  // with the surviving segment: re-anchor.
  noteEvicted: function(direction) {
    if (direction < 0) this._edgeUp = false;
    else this._edgeDown = false;
    this._chainState = null;
  },

  // Teach the last-read SUBJECT (pttbbs currtitle mirror). Called frame-taught
  // (accumulate spotted a server-styled row → its subject) and actively on our
  // own serialized open. Render re-paints every row whose subject matches.
  noteLastRead: function(title) {
    if (title) this._lastReadTitle = title;
  },

  // Invalidate the prefetch chain: the server cursor is no longer where the
  // last prefetch left it (another command went out / an external response
  // arrived / the buffer was rebuilt). The next prefetch re-anchors (two legs).
  _breakChain: function() {
    this._chainState = null;
  },

  // Pivot for pruneListToSegment (term_view.accumulateListLines): normally the
  // selection's segment survives; while an End jump is in flight the override
  // is null (= keep the LARGEST-number segment, the landing page), while a
  // Home jump keeps article 1's segment.
  prunePivot: function() {
    return this._prunePivotOverride !== undefined
      ? this._prunePivotOverride
      : this._selectedNum;
  },

  // ANCHORED prefetch (v4-stabilize bug 3: 往上讀卡住/亂跳頁). The single real
  // cursor may sit anywhere after an open/functionMode excursion — blindly
  // paging from there fetches pages around the CURSOR, filling the middle of
  // the buffer instead of extending the edge the user is scrolling toward (and
  // mid-buffer insertions defeat the top-only scroll compensation). So every
  // prefetch is a serialized command PAIR:
  //   1. jump to the buffer-edge article number (re-home the real cursor; the
  //      jump-settle fingerprint is park-in-entry + target number — the bottom
  //      row stays EMPTY until the next response, protocol doc §4 ✚);
  //   2. PgUp/PgDn — cursor number moving past the anchor = a new page (edge
  //      growth guaranteed contiguous), unchanged = the board edge.
  // CHAINED same-direction prefetch skips leg 1: the previous page command's
  // landed cursor is a confirmed server position (nothing else touched the
  // server since — _breakChain() guards every such point), so a direct
  // PgUp/PgDn extends the edge contiguously with ONE round-trip. The reference
  // point for moved/edge is then the last landed row instead of the anchor
  // (a PgDn parks the cursor on the NEW page's TOP, not the buffer's bottom
  // edge — anchor equality would misread every chained page as edge).
  // origin picks the CHAIN rule for the next page (each is self-bounding, so a
  // chain never crosses triggers — that would make the offline gating and the
  // stop condition nondeterministic):
  //   'fill' → _maybeFill (target / page-cap bounded)
  //   'key'  → _maybeDemand (stops once the headroom margin is buffered)
  _enqueuePrefetch: function(up, origin) {
    const dir = up ? -1 : 1;
    const chained = this._chainState !== null && this._chainState.dir === dir;
    const base = chained
      ? this._chainState.lastLanded
      : bufferEdgeNum(this._termBuf.listLineNums, dir);
    if (base == null) {
      // buffer 裡一列編號都沒有 ⇒ 沒有錨點可跳，這條腿送不出去。reducer 的
      // 不變量 17 守門後不該再發生；真發生了就是「卡在這一頁、按鍵沒反應」的
      // 那個死局，留一則診斷讓下次的 debug 錄製檔一眼看得到（不變量 7f）。
      this._setLoading(false);
      this._core.debugRecorder?.log('listSession.noAnchor', {
        state: this.state,
        origin: origin,
        dir: dir
      });
      return;
    }
    const self = this;
    const markEdge = function() {
      if (up) self._edgeUp = true;
      else self._edgeDown = true;
      self._chainState = null;
      self._setLoading(false); // an edge-waiting user has their answer
      // A confirmed bottom edge un-gates the pinned tail (windowVisibleSequence)
      // — repaint so 置底文 appear, exactly like native's last page.
      self._forceRedraw();
    };
    if (!chained) {
      this._queue.enqueue({
        keys: String(base) + '\r',
        kind: up ? 'prefetch-anchor-up' : 'prefetch-anchor-down',
        expect: function(snap, facts) {
          // Jump-landing park fingerprint (protocol §4 ✚: bottom row stays
          // empty → never clean-list; a \f redraw would not change that, §6).
          return (
            facts.cursorRowNum === base &&
            facts.curY >= 3 &&
            facts.curY <= facts.rows - 2 &&
            facts.curX <= 1
          );
        },
        // 跳號腿一律 fullRepaint（詳見 _enqueueCursorSyncJump）.
        fullRepaint: true,
        // Background work must never hold the foreground hostage: cap the
        // absolute wait well under the queue default (10s). A user pressing
        // against the buffer edge sees 「讀取中…」 for at most this long
        // before the benign edge answer (markEdge) unblocks navigation.
        timeoutMs: CMD_PROBE_AFTER_MS,
        probeTimeoutMs: CMD_PROBE_WINDOW_MS,
        hardTimeoutMs: PREFETCH_HARD_MS,
        onDone: function() {
          self._serverNum = base;
        },
        // Anchor failed (article deleted / weird screen): drop the queued page
        // command too — paging from an unknown position is exactly the bug.
        onFail: function() {
          self._serverNum = null;
          markEdge();
          // Only cancel OUR paired page command: pending may already hold a
          // user transaction (its preamble flushPending-ed the page command
          // and queued itself behind this anchor) — a full flush would kill
          // it silently and strand the session frozen.
          self._queue.flushPendingKind('prefetch');
        }
      });
    }
    this._queue.enqueue({
      keys: up ? '\x1b[5~' : '\x1b[6~',
      kind: up ? 'prefetch-up' : 'prefetch-down',
      expect: function(snap, facts) {
        const now = facts.cursorRowNum;
        if (facts.kind !== 'clean-list') {
          // 第二道防線（2026-07-11 錄製檔）：板尾短頁仍可能被分類 transient，
          // 但 park 指紋（entry 區 col≤1）＋序號相對 base 的位移已足以確定
          // 落點——不收腿就是 timeout→探針 miss→無主 settle→誤降級。null 在
          // transient 幀可能只是半繪解析不到，不得判 edge（等探針的全幅幀）。
          const parked =
            facts.curY >= 3 && facts.curY <= facts.rows - 2 && facts.curX <= 1;
          if (!parked || now == null) return false;
          if (up ? now < base : now > base) return { moved: true, landed: now };
          if (now === base) return { edge: true, landed: now };
          return false;
        }
        // A PgDn on the TRUE last page parks the cursor on a 置底 row (no
        // number → null): that IS the board edge (same precedent as
        // _requestEnd, invariant 3). Without this the response never matches,
        // the leg dies as a hard-timeout miss, and the \f probe's late frame
        // becomes an ownerless settle that the catch-all degrades on (live
        // 2026-07-08「畫面偏離列表格式」誤降級). Pinned rows only exist on the
        // last page, so an UP leg can never legitimately land there.
        if (now == null) return up ? false : { edge: true, landed: null };
        if (up ? now < base : now > base) return { moved: true, landed: now };
        if (now === base) return { edge: true, landed: now };
        return false;
      },
      // The board-edge probe gets ZERO response (cursor already at the end,
      // live-tested). v5: the short quiet window only TRIGGERS the queue's \f
      // probe — the probed full frame then answers deterministically (cursor
      // still on base → {edge:true} judged by CONTENT, old invariant 7's
      // RTT-adaptive timeout retired). No \f on the page key itself: a moved
      // page already responds deterministically (doubling traffic buys nothing).
      timeoutMs: CMD_PROBE_AFTER_MS,
      probeTimeoutMs: CMD_PROBE_WINDOW_MS,
      hardTimeoutMs: PREFETCH_HARD_MS, // background: same as the anchor leg
      onDone: function(r) {
        self._fillPages++;
        self._serverNum = r.landed;
        if (r.edge) markEdge();
        else {
          self._setLoading(false); // new rows arrived — edge wait (if any) over
          self._chainState = { dir: dir, lastLanded: r.landed };
          if (origin === 'key') {
            self._maybeDemand(dir);
            // Demand satisfied (nothing enqueued → queue idle): hand back to
            // the background fill so a rebuild's up-fill isn't starved by the
            // window-first demand pass (_maybeFill no-ops while busy).
            self._maybeFill();
          } else self._maybeFill();
        }
      },
      // Prefetch timeout is BENIGN: treat as the edge and stop paging that way
      // — never flips the mode (the user keeps scrolling what we have).
      onFail: function() {
        self._serverNum = null;
        markEdge();
      }
    });
  },

  // Two-stage serialized open: jump-to-number (expect: cursor landed on it),
  // then Enter (expect: article). The jump prompt's odd settles are EXPECTED
  // inside the opening state — this is why v3's "跳序號亂 settle" is safe here.
  _beginOpen: function() {
    const num = this._selectedNum;
    if (num == null) return;
    this._resetScroll(); // 開文前回到整列對齊（frozen 快照不該停在半列）
    // Active last-read teaching: opening this article sets the server's
    // currtitle to its subject (bbs.c:2424) — capture it now so the return
    // frame needn't be relied on (partial frames may show no styled row).
    const lrIdx = (this._termBuf.listLineNums || []).indexOf(num);
    const lrSubject =
      lrIdx >= 0 ? subjectOfListRow(this._termBuf.listLines[lrIdx]) : null;
    // The article WE are opening, by number — the only number that is known to
    // match the post actually on screen. _selectedNum is not: while the list is
    // rendered natively (functionMode / list easy reading off) the cursor moves
    // without us and _selectedNum keeps its stale value. See currentAnchor.
    this._openedNum = num;
    this._renderMode = 'frozen';
    this._setLoading(true);
    this._armFrozenWatchdog();
    this._breakChain();
    // flushPending: drop queued prefetch but keep an in-flight one paired
    // (see _beginRelative); content predicates absorb the seam.
    this._queue.flushPending();
    this._expediteBackground();
    const self = this;
    this._queue.enqueue({
      keys: String(num) + '\r',
      kind: 'open-jump',
      expect: function(snap, facts) {
        // Recorded protocol fact (protocol §4 ✚): after a number jump the
        // bottom row stays EMPTY until the next response — transient, never
        // clean-list (a \f redraw repaints that same virtual screen, §6).
        // Accept the landing by the cursor PARK position on the target.
        return (
          facts.cursorRowNum === num &&
          facts.curY >= 3 &&
          facts.curY <= facts.rows - 2 &&
          facts.curX <= 1
        );
      },
      // 跳號腿一律 fullRepaint（詳見 _enqueueCursorSyncJump）.
      fullRepaint: true,
      timeoutMs: CMD_PROBE_AFTER_MS,
      probeTimeoutMs: CMD_PROBE_WINDOW_MS,
      hardTimeoutMs: CMD_HARD_MS,
      onDone: function() {
        self._queue.enqueue({
          keys: '\r',
          kind: 'open-enter',
          expect: function(snap, facts) {
            return facts.kind === 'article';
          },
          // No fullRepaint: entering an article always repaints by itself.
          timeoutMs: CMD_PROBE_AFTER_MS,
          probeTimeoutMs: CMD_PROBE_WINDOW_MS,
          hardTimeoutMs: CMD_HARD_MS,
          onDone: function() {
            self.noteLastRead(lrSubject);
          },
          onFail: function() {
            self._openFailed();
          }
        });
      },
      onFail: function() {
        self._openFailed();
      }
    });
  },

  // Serialized open for a ★pinned row (no article number to jump to).
  //   1. jump to the buffer's LARGEST article number (an article number is a
  //      stable identity — new arrivals don't move it — and a number jump
  //      always gets a deterministic response; the existing park fingerprint);
  //   2. End → the bottom-most row of the last page. NOT sent standalone:
  //      when the real cursor is ALREADY at the bottom, End gets no server
  //      response at all and the open would always time out (live-tested) —
  //      after step 1 the cursor sits on a numbered row above the pinned tail,
  //      so End always moves = always answers. Its expect also requires the
  //      TARGET pinned row on screen (located by CONTENT: isPinnedListRow +
  //      pinnedRowKey equality — never a counted offset);
  //   3. one arrow per row toward it, each step expecting the exact curY, the
  //      last step ALSO re-verifying the cursor row's pinned key;
  //   4. Enter → expect article.
  // Any mismatch waits out the step timeout → _openFailed → functionMode
  // self-heal, same as the numbered open.
  _beginOpenPinned: function() {
    this._resetScroll(); // 同 _beginOpen
    const key = this._selectedPinnedKey;
    const anchor = bufferEdgeNum(this._termBuf.listLineNums, 1);
    if (key == null || anchor == null) {
      this._openFailed();
      return;
    }
    this._renderMode = 'frozen';
    this._setLoading(true);
    this._armFrozenWatchdog();
    this._breakChain();
    // flushPending: keep an in-flight prefetch paired (see _beginRelative).
    this._queue.flushPending();
    this._expediteBackground();
    const self = this;
    let parkY = -1;
    let targetY = -1;
    // Active last-read teaching, same as _beginOpen: locate the pinned row in
    // the buffer by its key and capture its subject before the open runs.
    let lrSubject = null;
    const lines = this._termBuf.listLines || [];
    const nums = this._termBuf.listLineNums || [];
    for (let i = 0; i < lines.length; ++i) {
      if (nums[i] == null && this._pinnedKeyAt(i) === key) {
        lrSubject = subjectOfListRow(lines[i]);
        break;
      }
    }
    const fail = function() {
      self._openFailed();
    };
    const enqueueEnter = function() {
      self._queue.enqueue({
        keys: '\r',
        kind: 'open-enter',
        expect: function(snap, facts) {
          return facts.kind === 'article';
        },
        timeoutMs: CMD_PROBE_AFTER_MS,
        probeTimeoutMs: CMD_PROBE_WINDOW_MS,
        hardTimeoutMs: CMD_HARD_MS,
        onDone: function() {
          self.noteLastRead(lrSubject);
        },
        onFail: fail
      });
    };
    const enqueueSteps = function() {
      if (targetY === parkY) {
        enqueueEnter();
        return;
      }
      const delta = targetY > parkY ? 1 : -1;
      for (let y = parkY + delta; ; y += delta) {
        const stepY = y;
        const isLast = stepY === targetY;
        self._queue.enqueue({
          keys: delta > 0 ? '\x1b[B' : '\x1b[A',
          kind: 'open-pinned-step',
          expect: function(snap, facts) {
            if (facts.curY !== stepY || facts.curX > 1) return false;
            // Final verification before Enter: the cursor row must BE the
            // target pinned row (content identity, not position arithmetic).
            if (isLast && pinnedRowKey(facts.rowTexts[stepY] || '') !== key)
              return false;
            return true;
          },
          timeoutMs: CMD_PROBE_AFTER_MS,
          probeTimeoutMs: CMD_PROBE_WINDOW_MS,
          hardTimeoutMs: CMD_HARD_MS,
          onDone: isLast ? enqueueEnter : undefined,
          onFail: fail
        });
        if (isLast) break;
      }
    };
    const enqueueEnd = function() {
      self._queue.enqueue({
        keys: '\x1b[4~', // End: park on the last page (pinned rows included)
        kind: 'open-pinned-end',
        expect: function(snap, facts) {
          if (facts.curY < 3 || facts.curY > facts.rows - 2 || facts.curX > 1)
            return false;
          for (let r = 3; r <= facts.rows - 2; ++r) {
            const text = facts.rowTexts[r] || '';
            if (isPinnedListRow(text) && pinnedRowKey(text) === key) {
              parkY = facts.curY;
              targetY = r;
              return true;
            }
          }
          return false; // target not on the last page → timeout → self-heal
        },
        // fullRepaint: End on a cursor that is already at the bottom answers
        // with NOTHING (live-tested, see the header). Step 1's jump makes that
        // unlikely, not impossible — the \f removes the case entirely.
        fullRepaint: true,
        timeoutMs: CMD_PROBE_AFTER_MS,
        probeTimeoutMs: CMD_PROBE_WINDOW_MS,
        hardTimeoutMs: CMD_HARD_MS,
        onDone: enqueueSteps,
        onFail: fail
      });
    };
    this._queue.enqueue({
      keys: String(anchor) + '\r',
      kind: 'open-pinned-jump',
      expect: function(snap, facts) {
        // Same jump-landing fingerprint as open-jump / prefetch anchors
        // (protocol §4 ✚: the bottom row stays empty → never clean-list).
        return (
          facts.cursorRowNum === anchor &&
          facts.curY >= 3 &&
          facts.curY <= facts.rows - 2 &&
          facts.curX <= 1
        );
      },
      // 跳號腿一律 fullRepaint（詳見 _enqueueCursorSyncJump）.
      fullRepaint: true,
      timeoutMs: CMD_PROBE_AFTER_MS,
      probeTimeoutMs: CMD_PROBE_WINDOW_MS,
      hardTimeoutMs: CMD_HARD_MS,
      onDone: enqueueEnd,
      onFail: fail
    });
  },

  _openFailed: function() {
    // v5 contract #5: failures are visible — banner, then the reducer routes
    // opening → functionMode (native mirror).
    if (this._view.flashListHint)
      this._view.flashListHint('開啟文章失敗，已切至原生模式', 4000);
    this._dispatch({ type: 'open-timeout' }, null);
  },

  // Article open confirmed: hand the screen to the article renderers. The
  // buffer maps are KEPT — coming back re-seeds from the server's landing
  // (suspended → clean-list → resume-buffer), no saved anchors needed (v5/M4).
  _handoffArticle: function() {
    this._nativeHold = false; // context change: the article releases the hold
    this._setLoading(false);
    this._serverNum = null;
    this._breakChain();
    this._prunePivotOverride = undefined; // flush is silent — reset here
    this._queue.flush();
    this._renderMode = 'native';
    this._view.showCursor();
    // Paint the article: the article easy reading's own settled edge fires on
    // the same settle (pageStateSettled precedes screenSettled) — when it is
    // off, this force paints the plain native article.
    this._forceRedraw();
  },

  // Switch to the native LIVE mirror. `facts` present = the reducer's settle
  // catch-all routed us here (T4 non-solicited / misclassification) — v5
  // failures are VISIBLE: show a banner naming why (waterball fingerprint gets
  // the specific wording). facts null = an explicit entry (airlock consent,
  // internal callers) — no banner.
  _enterFunctionMode: function(facts) {
    this._resetScroll(); // 切原生鏡像前把次列偏移歸零
    this._nativeHold = true; // sticky: stay native until article/menu/resume
    this._setLoading(false);
    this._serverNum = null; // native excursion: the cursor goes wherever
    // Native excursion = the LISTING is no longer trusted either: any native
    // key can rewrite the list's content/number space (Z 推文數、a 作者、`/`
    // 搜尋… MODE_SELECT numbers are an independent space, §8). Clearing the
    // board name forces the returning clean-list settle down the rebuild
    // branch — resume-buffer alone would merge stale rows into the new list
    // (movie 板多輪搜尋混雜、點舊序號開文 timeout，2026-07-10).
    this._boardName = null;
    // Same reason: after a native excursion the post that gets opened may not be
    // the one we last opened ourselves (the cursor moved without us).
    this._openedNum = null;
    this._breakChain();
    this._prunePivotOverride = undefined; // flush is silent — reset here
    this._queue.flush();
    this._renderMode = 'native';
    this._view.showCursor();
    this._forceRedraw();
    if (facts && this._view.flashListHint) {
      this._view.flashListHint(
        isWaterballSettle(facts)
          ? '收到水球／廣播，已切至原生模式（開啟文章或離開看板後恢復好讀）'
          : '畫面偏離列表格式，已切至原生模式（開啟文章或離開看板後恢復好讀）',
        4000
      );
    }
  },

  // Explicit visible degrade for transaction failures (timeout after the \f
  // probe, unexpected screens): banner + native mirror. v5 contract #5 — no
  // silent falls.
  _degradeToNative: function(msg) {
    if (this._view.flashListHint) this._view.flashListHint(msg, 4000);
    this._enterFunctionMode();
  },

  // Reusable "loading" indicator (v5 contract #4): shown while a serialized
  // transaction freezes the render, and while a demand prefetch is filling
  // past a window edge the user is pressing against. View-optional (tests).
  _setLoading: function(on) {
    if (this._view.setListLoading) this._view.setListLoading(on);
  },

  _resumeBuffer: function(facts) {
    this._nativeHold = false;
    this._breakChain();
    this._renderMode = 'buffer';
    this._setLoading(false);
    this._view.hideCursor();
    this._serverNum = facts ? facts.cursorRowNum : null;
    if (facts && facts.cursorRowNum != null) {
      // Adopt the native screen's cursor AND window top so the buffer render
      // shows exactly the page the user just saw in the mirror (native parity:
      // the mode switch itself must be invisible).
      this._selectedNum = facts.cursorRowNum;
      this._selectedPinnedKey = null;
      for (let r = 3; r <= facts.rows - 2; ++r) {
        if (facts.nums[r] != null) {
          this._topNum = facts.nums[r];
          break;
        }
      }
      for (let r = 3; r <= facts.rows - 2; ++r) {
        const t = facts.rowTexts[r] || '';
        if (t.indexOf('★') >= 0 && isPinnedListRow(t)) {
          this._edgeDown = true;
          break;
        }
      }
    }
    this._forceRedraw();
  },

  _cleanup: function() {
    this._resetScroll();
    this._nativeHold = false;
    this._serverNum = null;
    if (this._frozenWatchdog) {
      clearTimeout(this._frozenWatchdog);
      this._frozenWatchdog = null;
    }
    this._breakChain();
    this._queue.flush();
    this._setLoading(false);
    this._selectMode = false;
    if (this._view.hideListOverlay) this._view.hideListOverlay();
    this._renderMode = 'native';
    this._boardName = null;
    this._selectedNum = null;
    this._openedNum = null;
    this._selectedPinnedKey = null;
    this._topNum = null;
    this._edgeUp = false;
    this._edgeDown = false;
    this._fillPages = 0;
    this._lastReadTitle = null;
    this._prunePivotOverride = undefined;
    this._view.resetListAccumulation();
    this._termBuf.listLines = [];
    this._termBuf.listLineNums = [];
    this._view.showCursor();
    this._forceRedraw();
  },

  // ---- window navigation ------------------------------------------------------

  // The window's body row count: the native list body (rows 3..rows-2 on a
  // 24-row screen = 20 entries, pttbbs p_lines).
  _bodyRows: function() {
    return this._termBuf.rows - 4;
  },

  // The navigable sequence: blacklist-filtered absolute listLines indices,
  // pinned tail gated behind a confirmed bottom edge (native parity: 置底文
  // exist only on the board's last page).
  _sequence: function() {
    return windowVisibleSequence(
      this._visibleIndices(),
      this._termBuf.listLineNums || [],
      this._edgeDown
    );
  },

  // Resolve the persisted (topNum, selection) anchors into sequence positions,
  // normalized to the native cursor-in-window invariant. Returns null when the
  // sequence is empty.
  _windowPos: function(seq) {
    if (!seq.length) return null;
    const nums = this._termBuf.listLineNums || [];
    let cursorAbs = this._resolveSelectedIndex();
    let cursor = seq.indexOf(cursorAbs);
    if (cursor === -1) {
      // Selection lost (blacklisted / evicted / pinned re-gated): snap to the
      // nearest surviving row, same rule as moveListSelection.
      const snapped = moveListSelection(seq, cursorAbs, 0);
      cursor = snapped === -1 ? seq.length - 1 : seq.indexOf(snapped);
    }
    let top = -1;
    if (this._topNum != null) {
      const topAbs = nums.indexOf(this._topNum);
      if (topAbs !== -1) top = seq.indexOf(topAbs);
    }
    return normalizeListWindow(top, cursor, seq.length, this._bodyRows());
  },

  // Persist window positions back as content anchors (number / pinned key):
  // anchors survive prepends and evictions, positions don't.
  _setWindow: function(seq, top, cursor) {
    const nums = this._termBuf.listLineNums || [];
    // 平滑捲動的邊旗標（快路徑要用，見 _stepScroll）。這裡是唯一的視窗寫入點，
    // getWindowView 每幀都會走到 ⇒ 旗標恆新，不需要另外的失效機制。
    const maxTop = Math.max(0, seq.length - this._bodyRows());
    this._scrollAtTop = top <= 0;
    this._scrollAtBottom = top >= maxTop;
    this._scrollEdgesKnown = true;
    if (this._scrollAtBottom && this._scrollFrac) this._scrollFrac = 0;
    const cursorAbs = seq[cursor];
    this._selectedNum = nums[cursorAbs];
    this._selectedPinnedKey =
      nums[cursorAbs] == null ? this._pinnedKeyAt(cursorAbs) : null;
    const topAbs = seq[top];
    this._topNum = topAbs != null ? nums[topAbs] : null;
  },

  // The render contract with term_view.buildListWindowLines(): the 20 body
  // slots as absolute listLines indices (null = blank filler row, native
  // short-page parity) + the cursor row's absolute index.
  getWindowView: function() {
    const seq = this._sequence();
    const pos = this._windowPos(seq);
    if (!pos) return null;
    this._setWindow(seq, pos.top, pos.cursor);
    const B = this._bodyRows();
    const body = [];
    for (let i = pos.top; i < pos.top + B; ++i) {
      body.push(i < seq.length ? seq[i] : null);
    }
    // 次列位移時視口底部會露出下一列的一小條 ⇒ 多給 render 端一列補滿。
    // 刻意**不放進 body**：body 的長度＝渲染列號的換算基準（LIST_HEADER_ROWS +
    // index），多塞一格會讓 footer 的 data-row 位移，那是外部契約。
    const overscanAbs =
      this._scrollFrac > 0 && pos.top + B < seq.length ? seq[pos.top + B] : null;
    return {
      body: body,
      cursorAbs: seq[pos.cursor],
      overscanAbs: overscanAbs,
      scrollPx: this._scrollFrac
    };
  },

  // Local navigation (zero network when the rows are buffered): one native
  // read.c op over the window, then directional demand keeps a page of
  // headroom. Ops that need rows beyond a confirmed edge go to the server
  // (serverOp), exactly like native would.
  _moveSelection: function(op) {
    this._resetScroll(); // 鍵盤／翻頁一律回到整列對齊
    const seq = this._sequence();
    const pos = this._windowPos(seq);
    if (!pos) return;
    const r = moveListCursorWindow(pos, op, {
      len: seq.length,
      bodyRows: this._bodyRows(),
      atTop: this._edgeUp,
      atBottom: this._edgeDown
    });
    if (r.serverOp === 'end') return this._requestEnd();
    if (r.serverOp === 'home') return this._requestHome();
    this._setWindow(seq, r.top, r.cursor);
    this._forceRedraw();
    const direction = op === 'up' || op === 'pgup' || op === 'home' ? -1 : 1;
    this._maybeDemand(direction);
    // 到邊讀取中 (v5/M4): the cursor is pressed against the buffer edge, more
    // rows exist server-side, and a prefetch is in flight (the demand above or
    // an earlier chain) — show the loading indicator until rows arrive
    // (prefetch onDone/markEdge clear it).
    const atEdge = direction > 0 ? r.cursor === seq.length - 1 : r.cursor === 0;
    const moreExpected = direction > 0 ? !this._edgeDown : !this._edgeUp;
    if (atEdge && moreExpected && !this._queue.idle) this._setLoading(true);
  },

  // Native End (read.c KEY_END: new_ln = last_line, which INCLUDES the pinned
  // tail). We don't hold the board end yet — fetch it with a single always-
  // answered command: a number jump far past the newest article lands the real
  // cursor on last_line (search_num clamps to max, read.c:190-210), pulling
  // the last page (pinned rows included) into the buffer. Then apply End
  // locally. (A bare End times out when the cursor is already at the bottom —
  // zero response, live-tested — the over-jump always answers.)
  _requestEnd: function() {
    if (!this._queue.idle) return;
    const anchor = bufferEdgeNum(this._termBuf.listLineNums, 1);
    if (anchor == null) return;
    this._breakChain(); // a non-prefetch command moves the server cursor
    const self = this;
    this._prunePivotOverride = null; // keep the landing (max-number) segment
    this._queue.enqueue({
      keys: '99999999\r',
      kind: 'jump-end',
      expect: function(snap, facts) {
        // Jump landing fingerprint (protocol §4 ✚: bottom row stays empty →
        // transient, never clean-list): parked in the entry area, on a row at
        // or past our previous bottom edge (a pinned row parses as null num).
        return (
          facts.curY >= 3 &&
          facts.curY <= facts.rows - 2 &&
          facts.curX <= 1 &&
          (facts.cursorRowNum == null || facts.cursorRowNum >= anchor)
        );
      },
      // 跳號腿一律 fullRepaint（詳見 _enqueueCursorSyncJump）.
      fullRepaint: true,
      timeoutMs: CMD_PROBE_AFTER_MS,
      probeTimeoutMs: CMD_PROBE_WINDOW_MS,
      hardTimeoutMs: CMD_HARD_MS,
      onDone: function() {
        // The landed page IS the board end (last_line): confirm the edge, then
        // land the local cursor there like native End. The landed row may be a
        // pinned one (no number) — the cheap safe answer is "unknown".
        self._serverNum = null;
        self._prunePivotOverride = undefined;
        // _moveSelection lights 「讀取中…」 whenever the cursor is pressed
        // against a buffer edge with a command in flight — this transaction IS
        // that command, so it owns turning it off (it used to leak: onDone also
        // sets _edgeDown, so the next press no longer re-evaluates the
        // indicator and the pill stayed lit until an article/board change).
        self._setLoading(false);
        self._edgeDown = true;
        const seq = self._sequence();
        if (!seq.length) return;
        const B = self._bodyRows();
        let top = seq.length - B;
        if (top < 0) top = 0;
        self._setWindow(seq, top, seq.length - 1);
        self._forceRedraw();
      },
      // Benign failure: keep the window where it was (native would too if the
      // server didn't answer).
      onFail: function() {
        self._prunePivotOverride = undefined;
        self._setLoading(false);
      }
    });
  },

  // Native Home (read.c KEY_HOME: new_ln = 0 → clamped to line 1). Article 1
  // always exists (numbers re-compact on deletion) and a number jump always
  // answers — one command, then apply Home locally.
  _requestHome: function() {
    if (!this._queue.idle) return;
    this._breakChain(); // a non-prefetch command moves the server cursor
    const self = this;
    this._prunePivotOverride = 1; // keep article 1's (landing) segment
    this._queue.enqueue({
      keys: '1\r',
      kind: 'jump-home',
      expect: function(snap, facts) {
        return (
          facts.cursorRowNum === 1 &&
          facts.curY >= 3 &&
          facts.curY <= facts.rows - 2 &&
          facts.curX <= 1
        );
      },
      // 跳號腿一律 fullRepaint（詳見 _enqueueCursorSyncJump）.
      fullRepaint: true,
      timeoutMs: CMD_PROBE_AFTER_MS,
      probeTimeoutMs: CMD_PROBE_WINDOW_MS,
      hardTimeoutMs: CMD_HARD_MS,
      onDone: function() {
        self._serverNum = 1;
        self._prunePivotOverride = undefined;
        self._setLoading(false); // same edge-indicator ownership as _requestEnd
        self._edgeUp = true;
        const seq = self._sequence();
        if (!seq.length) return;
        self._setWindow(seq, 0, 0);
        self._forceRedraw();
      },
      onFail: function() {
        self._prunePivotOverride = undefined;
        self._setLoading(false);
      }
    });
  },

  // Absolute listLines index of the current selection. Numbered selections
  // resolve by NUMBER (stable across prepends); pinned selections by title key.
  _resolveSelectedIndex: function() {
    const nums = this._termBuf.listLineNums || [];
    if (this._selectedNum != null) return nums.indexOf(this._selectedNum);
    if (this._selectedPinnedKey != null) {
      const lines = this._termBuf.listLines || [];
      for (let i = 0; i < nums.length; ++i) {
        if (nums[i] == null && this._pinnedKeyAt(i) === this._selectedPinnedKey)
          return i;
      }
    }
    return -1;
  },

  _pinnedKeyAt: function(idx) {
    const lines = this._termBuf.listLines || [];
    const text = lines[idx] ? rowToText(lines[idx]) : '';
    return pinnedRowKey(text);
  },

  _selectLastNumbered: function() {
    const nums = this._termBuf.listLineNums || [];
    for (let i = nums.length - 1; i >= 0; --i) {
      if (nums[i] != null) {
        this._selectedNum = nums[i];
        this._selectedPinnedKey = null;
        return;
      }
    }
  },

  _visibleIndices: function() {
    const lines = this._termBuf.listLines || [];
    const texts = [];
    for (let i = 0; i < lines.length; ++i) texts.push(rowToText(lines[i]));
    return visibleListIndices(texts, this._view.blacklist, this._view.titleBlacklist);
  },

  // ---- misc -------------------------------------------------------------------

  _forceRedraw: function() {
    this._termBuf.lineChangeds.fill(true);
    this._termBuf.changed = true;
    this._termBuf.notify();
  }
};

// Identity key for a ★pinned/置底 row. Author + title: the push-count column
// changes live (a whole-row key would duplicate the row on repaint — v3 bug 5a),
// while a title-only key COLLAPSES two announcements that share a truncated
// title (v4-stabilize bug 2a: 置底文少一篇). realignListColumns inside the two
// parsers makes the cursor variant key-equal to the clean row for BOTH cursor
// generations (old ● shifts the columns and gets re-padded; new '>' is half-width
// and shifts nothing). Used by BOTH term_view.accumulateListLines (map key) and
// ListSession._pinnedKeyAt (selection identity) — must stay the same function.
export function pinnedRowKey(text) {
  const author = parseListAuthor(text) || '';
  const title = parseListTitle(text) || text || '';
  return author + '|' + title;
}

// Evict numbered rows over the cap, dropping from the end FARTHEST from the
// selection (the selection itself always survives; a null selection = pinned
// tail = bottom, so the top is farthest). Mutates numMap in place; the pinned
// map is never evicted (a handful of rows at most). Returns which end(s) got
// dropped so the session can clear the matching _edgeUp/_edgeDown flag —
// demand must be able to re-fetch an evicted segment.
export function evictListBuffer(numMap, selectedNum, cap) {
  const r = { evictedUp: false, evictedDown: false };
  if (!numMap || numMap.size <= cap) return r;
  const nums = Array.from(numMap.keys()).sort((a, b) => a - b);
  const sel = selectedNum == null ? Infinity : selectedNum;
  let lo = 0;
  let hi = nums.length - 1;
  let excess = nums.length - cap;
  while (excess-- > 0) {
    if (sel - nums[lo] >= nums[hi] - sel) {
      numMap.delete(nums[lo++]);
      r.evictedUp = true;
    } else {
      numMap.delete(nums[hi--]);
      r.evictedDown = true;
    }
  }
  return r;
}

// The article number at a buffer edge: smallest (direction<0, the "older" top)
// or largest (direction>0, bottom) non-null entry of the ASCENDING nums array.
// null when the buffer holds no numbered rows. Anchored prefetch jumps the real
// cursor here before paging (see _enqueuePrefetch).
export function bufferEdgeNum(nums, direction) {
  if (!nums || !nums.length) return null;
  if (direction < 0) {
    for (let i = 0; i < nums.length; ++i) if (nums[i] != null) return nums[i];
    return null;
  }
  for (let i = nums.length - 1; i >= 0; --i) if (nums[i] != null) return nums[i];
  return null;
}

// Which absolute listLines indices survive the blacklist drop. MUST mirror the
// PAGE_LIST branch of Screen.js#computeAnnotations (the render-side hide): an
// author hit on the parsed author column, else a title-keyword hit. Kept here as
// a pure text function so local navigation can walk exactly the rows the user
// sees. `rowTexts` = listLines mapped through rowToText.
export function visibleListIndices(rowTexts, blacklistSet, titleKeywords) {
  const hasBlacklist = blacklistSet && blacklistSet.size > 0;
  const hasTitle = titleKeywords && titleKeywords.length > 0;
  const out = [];
  for (let i = 0; i < rowTexts.length; ++i) {
    const text = rowTexts[i];
    // Deleted articles ((本文已被刪除) / (已被xxx刪除), author column "-") are
    // hidden unconditionally: they cannot be opened (the serialized open would
    // wedge on them) — treated exactly like a blacklist hit.
    let hide = isDeletedListRow(text);
    if (!hide && hasBlacklist) {
      const author = parseListAuthor(text);
      if (author && blacklistSet.has(author)) hide = true;
    }
    if (!hide && hasTitle) {
      if (matchTitleBlacklist(parseListTitle(text), titleKeywords)) hide = true;
    }
    if (!hide) out.push(i);
  }
  return out;
}
