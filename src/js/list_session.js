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
  isListShapedRow,
  rowToText,
  parseListTitleRaw,
  subjectOfListRow,
  subjectOfListText,
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
import {
  topPosFromScrollTop,
  anchorScrollTop,
  revealScrollTop,
  revealPlan,
  maxScrollTopFor,
  isRowVisible
} from './list_scroll';
import { LEFT_ARROW } from './function_key_plan';
import { readValuesWithDefault } from './pref_storage';
import {
  windowVisibleSequence,
  LIST_HEADER_ROWS,
} from './list_window';
import {
  defineOwnedRenderMode,
  OWNER_ARTICLE_LIST,
  isBoardListCommandKind
} from './list_render_owner';

// 程式化平滑捲動的最長等待：超過就放棄「等它到站」，把 scroll 事件當成使用者
// 自己捲的（動畫會被使用者的滾輪／拖曳取消，那時永遠到不了目標）。
const SCROLL_ANIM_MAX_MS = 1000;

// 兩次導覽操作間隔小於這個值就算「連發」（按住鍵的 OS 自動重複約 30/s、滾輪一次
// 一頁的連續刻度也在這個量級）⇒ 該次 reveal 退成 instant，見 list_scroll.revealPlan。
// e.repeat 抓得到「自動重複的第一發」（初次延遲約 500ms，落在這個視窗外），這一支
// 則補上沒有 repeat 旗標的來源（滾輪、貼上的 bytes、使用者自己連按）。
const NAV_BURST_MS = 250;

// 使用者要求減少動態效果時，程式化捲動一律 instant（作業系統／瀏覽器的無障礙
// 設定）。matchMedia 在 jsdom 可能不存在 ⇒ 沒有就當作沒開。
function prefersReducedMotion() {
  return !!(
    typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

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
//     landedNumInBuffer, engageEligible, holdReason, withinResumeGrace }
//   { type:'key', keyClass: 'nav'|'open'|'open-pinned'|'other' }
//   { type:'resume-probe', ... }（同 settle 的欄位；靜置探針量當下畫面合成）
//   { type:'pref-off' } | { type:'open-timeout' }
//
// holdReason（functionMode 的停泊理由，取代舊的 boolean _nativeHold）：
//   'passthrough' 非白名單鍵／自癒降級的原生小旅行 —— 操作做完後由靜置探針
//                 （resume-probe）自動切回好讀。
//   'external'    aid_navigation／long_push 的多步序列把我們停泊在這裡 ——
//                 **永不自動解除**（不變量 N1）：序列途中會經過大量 clean-list
//                 幀，命令與命令之間 inFlightKind 也會是 null，自動回復會把
//                 別人的序列從中間截斷。
//   null          沒有停泊（frozen 交易借用 functionMode 吸收 settle）。
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
            // lands here). `withinResumeGrace` 是第三個豁免（不變量 N4）：剛從
            // 原生自動回到好讀的那一瞬間，server 的殘餘幀（半繪／prompt 收尾）
            // 還在路上，打到這裡就是「剛回好讀又被 banner 踢回原生」。與
            // `consumed` 的放寬（不變量 3c）同型，是必要條件不是保險。
            return event.inFlightKind || event.consumed || event.withinResumeGrace
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
          case 'native-inplace':
            // A 類鍵（原地重繪，見 INPLACE_KEYS）：**全程不切原生**。借用
            // functionMode 吸收在途 settle／吞鍵，但 render 維持 frozen
            //（'state=functionMode ∧ render=frozen' 是既有的合法組合），落地由
            // _enqueueInplaceKey 的 expect 判定後 _resumeInPlace 直接回 buffer。
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
      // 靜置探針：非導覽操作做完了 ⇒ 自動切回好讀（本功能的主體）。事件由
      // ListSession._tryResumeProbe 在「畫面與使用者都靜止 RESUME_QUIET_MS」之後
      // 量當下畫面合成，這裡只做純粹的枚舉判斷。三個洞各自對應一個條件：
      //   洞 1 PTT 還在等輸入 → kind === 'clean-list'（其中的 curX <= 1，見 N9）
      //   洞 2 命令還在線上   → !inFlightKind
      //   洞 3 一個回應 settle 兩次 → 靜置時間（由呼叫端把關，這裡收不到未靜置的探針）
      if (event.type === 'resume-probe') {
        if (event.holdReason !== 'passthrough') return stay; // N1
        if (event.inFlightKind) return stay;
        if (event.kind !== 'clean-list') return stay;
        if (!event.hasNumberedRow) return stay; // 不變量 17
        if (!event.engageEligible) return stay;
        // _enterFunctionMode 依不變量 15 清過 _boardName ⇒ B 類實務上一律 rebuild；
        // 那是對的（原生鍵可以改寫清單內容與編號空間）。快路徑留給保住板名的
        // 凍結交易（L1 的 native-inplace 走自己的 _resumeInPlace，不經這裡）。
        return event.landedNumInBuffer && event.boardNameMatch
          ? { next: 'active', actions: ['resume-buffer'] }
          : { next: 'active', actions: ['resume-buffer', 'rebuild'] };
      }
      if (event.type === 'settle') {
        switch (event.kind) {
          case 'clean-list':
            // A serialized transaction (sync leg / leave / jump) is mid-flight:
            // its own jump-landing settle must not bounce us back to active —
            // keep mirroring until it completes (the completing settle reads
            // inFlightKind null and resumes with the LANDED cursor).
            if (event.inFlightKind) return stay;
            // 停泊中（2026-07-10 起的黏性原生）：clean-list settle **本身**不解除
            // hold。'external' 永遠不解除（N1）；'passthrough' 由靜置探針
            // （resume-probe）解除 —— 不在這裡直接彈回的理由是 §3.4 洞 3：一個
            // 回應可能 settle 兩次，第一個 settle 內容已新、游標還停在舊位置，
            // 在它上面 resume 會採用到錯的落點（游標跳列）。
            if (event.holdReason) return stay;
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

// subjectOfListText / subjectOfListRow moved to comment_parse (pure layer): the
// long-push cursor anchor needs the same key and must not pull this DOM-coupled
// module in. Re-exported here so the existing consumers (term_view, the
// accumulate tests, aid_navigation) keep their import site unchanged.
export { subjectOfListRow, subjectOfListText };

const LIST_MARK_FG = { 'R': 3, '轉': 6, '鎖': 5, 'ˇ': 2 };

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
// 「非導覽操作完成後自動切回好讀」的兩個時間常數（pref enableListNativeAutoResume）。
//
// RESUME_QUIET_MS **不是體感旋鈕**，別拿它調手感。它只堵一個判定漏洞：一個回應的
// 「內容視窗」與「游標 park 視窗」跨過 SETTLE_MS 的間隔時會 **settle 兩次**
// （term_buf.js 的 settle 註解寫明），第一個 settle 的內容已經是新清單、游標卻還
// 停在舊位置 —— 那種幀完全可能通過 clean-list 指紋，在它上面 resume 就會採用到錯
// 的落點（游標跳到別列）。所以要等「畫面真的不動了」而不是「使用者不動了」，時鐘
// 從 max(最後一次 server 活動, 最後一次使用者送 byte) 起算。值直接沿用
// CMD_PROBE_AFTER_MS（PTT 約 90ms 回應 + settle 50ms ⇒ 250ms 靜默已屬異常），
// 不另開一個沒有來源的數字。
const RESUME_QUIET_MS = CMD_PROBE_AFTER_MS;
// 回到 active 之後的寬限窗（不變量 N4）：緊接著的殘餘半繪／prompt 幀不得打到
// active 的 catch-all，否則就是「剛回好讀又被 banner 踢回原生」。
const RESUME_GRACE_MS = 400;
// A 類鍵＝**原地重繪、清單內容與編號空間不變**的非白名單鍵。枚舉即合約
// （不變量 N5，來源是 mbbsd/read.c#i_read_key 的 case 表，pttbbs @ c1ff72df）：
//   thread() → new_ln → cursor_pos()：  =  \  ]  +  [  -  <  ,  .  >
//   search_read(READ_PREV/NEXT)：       {  }
//   ToggleTagItem → crs_ln++ + PARTUPDATE： t
// 它們不開 prompt、不進子畫面，所以走「凍結交易」（送真鍵 → 等真回應 → 採用真
// 落點）全程不切原生 —— 反覆按 [ ] 不再閃動，也不必丟 cache 重抓（不變量 15 的
// 理由只對「會改寫清單」的 B 類成立）。
// **Ctrl-C（ClearTagList）刻意不在這一組**：它是 FULLUPDATE 但只重畫當前那一頁，
// 緩衝裡其他頁的 tag 標記會殘留 ⇒ 走 B 類（切原生，回來 rebuild）。Ctrl 組合本來
// 就在 _classifyKey 的 e.ctrlKey 分支先被判成 passthrough，這裡只是說明理由。
const INPLACE_KEYS = '=\\]+[-<,.>{}t';

// 切原生時提示語的尾巴。自動回復開著＝「做完就回來」；關掉＝維持舊措辭（那時
// 行為也真的是舊的）。**留著舊措辭比沒提示更糟**，所以每一處切原生的 hint 都走
// 這一支，不要再各自寫死字串。
function nativeResumeHint() {
  return readValuesWithDefault().enableListNativeAutoResume
    ? '（操作完成後自動恢復好讀）'
    : '（開啟文章或離開看板後恢復好讀）';
}
// 看板列表按 `v` ＝ b_mark_read_unread（mbbsd/bbs.c:4309）：畫面下方跳出 getdata
// prompt「設定所有文章 (U)未讀 (V)已讀 (W)前已讀後未讀 (Q)取消？[Q] 」。
// b_lines = t_lines-1 ⇒ 24 列終端時 prompt 畫在 **row 22**（不是最後一列），所以
// 判定要掃整個畫面、不能只看底列。W 分支拿該篇檔名時間戳當參考點，取不到就吐
// vmsg 那句。詳見 docs/pttbbs-screen-protocol.md §11.5。
const MARK_READ_PROMPT = '前已讀後未讀';
const MARK_READ_REJECT = '請改用其它文章設定當參考點';
// (2026-07-10) [ ] = / v / `/` 模擬交易與 T3 airlock 皆退役：非白名單鍵一律
// 走 _beginNativePassthrough（有序號選取先 sync-jump，再切原生鏡像＋代送）。

// Owner of list easy reading. Subscribes to term_buf 'screenSettled' and runs:
//   settle → snapshot+facts → queue.onSettle (command completion first)
//          → event booleans → transitionListSession → execute actions.
// Owns: state, the selection (by article NUMBER, stable across prepends), the
// board name (aliasing guard), and listRenderMode ('native' | 'buffer' |
// 'frozen' — redraw/onKeyDown key off it, never off pageState). That flag is
// SHARED with the board-list session, so it is reached through the ownership
// layer in js/list_render_owner.js rather than written directly.
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
  this._topNum = null; // 捲動錨：視口頂端那一列的文章編號
  // 視口頂端是置底列（無編號）時的錨。與 _topNum 互斥，同 _selectedPinnedKey。
  this._topPinnedKey = null;
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
  // Sticky native excursion，兩種語意（reducer 透過 _settleEvent.holdReason 讀）：
  //   'passthrough' 非白名單鍵／自癒降級 —— 操作做完後由靜置探針自動回好讀
  //   'external'    aid_navigation／long_push 的多步序列停泊 —— **永不自動解除**
  //   null          沒有停泊
  // 兩者一定要分開：把黏性直接拿掉會靜默弄壞 deep link 與長推文（它們要的是
  // 「在我這條序列跑完之前你不准自己彈回 buffer、不准自己排命令」）。
  this._holdReason = null;
  // 靜置探針的 timer handle 與它的兩個時鐘來源（見 RESUME_QUIET_MS）。
  // _lastServerActivityAt 只在 settle 上更新（settle 本身就是「server 活動後靜止
  // SETTLE_MS」）——**不要**去 term_buf 另外開 hook，那會踩到不變量 2/2b。
  this._resumeProbe = null;
  this._lastServerActivityAt = 0;
  this._lastUserByteAt = 0;
  // 最近一次回到 active 的時刻（RESUME_GRACE_MS 的起點，不變量 N4）。
  this._resumedAt = 0;
  // MODE_SELECT (`/` filtered list) sub-state: its article-number space is
  // independent from the main list (protocol §8) — entering/leaving forces a
  // rebuild (via _boardName=null) so numbers never alias.
  this._selectMode = false;
  // Absolute frozen-render backstop (see _armFrozenWatchdog). null = disarmed.
  this._frozenWatchdog = null;
  // ---- 捲動（瀏覽器原生；我們只維護錨）----
  // 畫面是「整段序列畫進一個 overflow-y:auto 的視口」，捲動由瀏覽器負責。session
  // 這邊只保存**內容錨**：(_topNum | _topPinnedKey, _scrollFrac) ＝ 視口頂端是哪
  // 一列、那一列被捲掉幾 px。重繪前 captureScrollAnchor 從 DOM 擷取，重繪後
  // applyScrollAfterRender 還原 —— 這是不變量 6（prepend/evict 不動視窗）的
  // 原生捲動形式。
  this._scrollFrac = 0;
  // 這一幀的錨由 action 指定（開文落地／End/Home／re-seed），不從 DOM 擷取。
  this._anchorOverride = false;
  // 待消費的「把某一列帶進視口」：{ pos, block, behavior }，見 _scheduleReveal。
  this._pendingReveal = null;
  // scroll 事件的 rAF 合併 handle，與上一次讀到的 scrollTop（推導捲動方向用）。
  this._scrollRaf = null;
  this._lastScrollTop = 0;
  // 進行中的平滑捲動：{ num, key, block, px, at }。目標記的是**那一列的內容
  // 身分**（序號／置底 key）而不只是像素——背景補頁會讓整段序列上下位移，px
  // 必須跟著重算，否則動畫會朝一個已經不對的地方飛（＝使用者看到的回捲）。
  // null＝沒有動畫在跑。
  this._scrollAnim = null;
  // 上一次導覽操作的時刻（連發判定，見 NAV_BURST_MS）。
  this._lastNavAt = 0;
  // _sequence() 的記憶化（見該函式）：null＝還沒算過。
  this._seqCache = null;

  // listRenderMode 是**共用**旗標（看板列表平滑捲動走同一個），所以透過所有權層
  // 存取：寫 buffer/frozen ＝宣告所有權，寫 native ＝只釋放自己持有的，讀 ＝別人
  // 持有時回 'native'。少了它，「進板」那一幀（我們 engage、BoardListSession 收攤）
  // 的結果會取決於兩個 settle listener 誰先跑。見 js/list_render_owner.js。
  defineOwnedRenderMode(this, termBuf, OWNER_ARTICLE_LIST);
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
    // 這一幀是 server 活動後的靜止點 ⇒ 自動回復的時鐘從這裡起算（洞 3）。上面
    // 那道守門已經把純本地重繪擋掉了，所以不會誤把自己的重繪當成 server 活動。
    this._lastServerActivityAt = Date.now();
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
    // 佇列所有權（js/list_render_owner.js）：in-flight 是看板列表 session 的命令
    // 時，判定權在它手上——這裡若照樣 onSettle，就是拿**文章列表的 facts**（沒有
    // `brd` 欄位）去跑對方的 expect，靜默判錯。反向的守門在 BoardListSession。
    const consumed = isBoardListCommandKind(this._queue.inFlightKind)
      ? null
      : this._queue.onSettle(snap, facts);
    // A completed leg IS progress: re-arm the frozen backstop so it measures
    // "nothing advanced for FROZEN_WATCHDOG_MS" rather than capping a whole
    // multi-leg transaction (_beginOpenPinned's per-row steps would otherwise
    // race the cap once the per-command budgets got short).
    if (consumed === 'done' && (this._renderMode === 'frozen' || this.state === 'opening'))
      this._armFrozenWatchdog();
    this._dispatch(this._settleEvent(facts, consumed), facts);
    this._scheduleResumeProbe();
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
      holdReason: this._holdReason,
      withinResumeGrace: Date.now() - this._resumedAt < RESUME_GRACE_MS,
      hasNumberedRow: hasNumberedEntryRow(facts),
      engageEligible: this._engageEligible()
    };
  },

  // pref 開著＝本功能（L1 凍結交易 ＋ L2 自動回復）生效；關掉＝**逐位元回到
  // 2026-09-03 之前**：A 類鍵一律走 passthrough、探針一次都不排。
  // 這是使用者拍板的逃生門（三階梯見 docs/easy-reading-list.md）：判定類功能的
  // 最後一道防線就是設定開關，全關就回到原生體驗。
  _autoResumeEnabled: function() {
    return !!readValuesWithDefault().enableListNativeAutoResume;
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

  // ---- 靜置探針（非導覽操作完成 → 自動回好讀）--------------------------------

  // 使用者往 PTT 送了 byte（原生鏡像期間鍵盤／貼上／IME／點功能鍵都走不到
  // activeListSession()，所以這條是**無條件**從 term_view / pttchrome 呼進來的）。
  // **只記時間戳，不得有任何其他副作用**（不變量 N2）。
  noteNativeInput: function() {
    this._lastUserByteAt = Date.now();
    this._scheduleResumeProbe();
  },

  // (重新)排定探針。排定點：進入 hold 當下、每一次 settle、每一次使用者送 byte。
  // 取消點：離開 functionMode／cleanup／pref-off／hold 變 external／斷線 ——
  // 全部收斂到「holdReason !== 'passthrough' 就清掉」這一條。
  _scheduleResumeProbe: function(delay) {
    if (this._resumeProbe) {
      clearTimeout(this._resumeProbe);
      this._resumeProbe = null;
    }
    if (this._holdReason !== 'passthrough') return;
    if (!this._autoResumeEnabled()) return;
    const self = this;
    this._resumeProbe = setTimeout(function() {
      self._resumeProbe = null;
      self._tryResumeProbe();
    }, delay == null ? RESUME_QUIET_MS : delay);
  },

  _cancelResumeProbe: function() {
    if (!this._resumeProbe) return;
    clearTimeout(this._resumeProbe);
    this._resumeProbe = null;
  },

  // 探針到點：**不看事件，直接量當下畫面**（形狀同 evaluateNow）。只讀不寫
  // （不變量 N2：不送 byte、不排命令、不改錨），唯一的輸出是一個合成事件。
  _tryResumeProbe: function() {
    if (this._holdReason !== 'passthrough' || !this._autoResumeEnabled()) return;
    // 洞 3：畫面與使用者都要靜止。還沒靜置滿就補排剩下的時間（不是輪詢）。
    const quietSince = Math.max(this._lastServerActivityAt, this._lastUserByteAt);
    const waited = Date.now() - quietSince;
    if (waited < RESUME_QUIET_MS) return this._scheduleResumeProbe(RESUME_QUIET_MS - waited);
    // 洞 2：命令還在線上。它自己的回應會帶來 settle → 由那裡重排；但「PTT 完全
    // 忽略這個鍵」的情形是零 byte 零 settle，只能等命令自己 timeout ⇒ 這裡補排
    // 一次，讓 timeout 之後仍然有人來看一眼。
    if (this._queue.inFlightKind) return this._scheduleResumeProbe();
    const facts = this._collectFacts(null);
    const event = this._settleEvent(facts, null);
    event.type = 'resume-probe';
    // 內容不合格（洞 1：PTT 還在等輸入 ⇒ classifyListScreen 的 curX<=1 判掉；
    // 子畫面／編輯器根本不是 clean-list）：不再排，等下一個 settle 重新排。
    if (facts.kind !== 'clean-list') return;
    const before = this.state;
    this._dispatch(event, facts);
    // 換畫面永不靜默（不變量 N7）：使用者沒按任何鍵，畫面卻從原生換回好讀，
    // 一定要說一聲。
    if (before !== this.state && this.state === 'active' && this._view.flashListHint)
      this._view.flashListHint('操作完成，已回到好讀列表', 2000);
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
    // 'external'：**永不自動解除**（不變量 N1）。序列途中的 clean-list 幀很多，
    // 命令與命令之間 inFlightKind 也會是 null ⇒ 讓靜置探針看到就會把別人的序列
    // 從中間截斷（deep link 跳文、長推文）。
    this._enterFunctionMode(null, { hold: 'external' });
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

    if (key.class === 'native-inplace') {
      // A 類鍵：凍結交易（畫面凍住 → 送真鍵 → 採用真落點 → 直接回 buffer）。
      this._beginInplaceTransaction(key.bytes);
      return;
    }

    const r = transitionListSession(this.state, { type: 'key', keyClass: key.class });
    this.state = r.next;
    for (let i = 0; i < r.actions.length; ++i) {
      const a = r.actions[i];
      // e.repeat＝OS 的自動重複（按住不放）⇒ 這次 reveal 不做動畫，見 _moveSelection。
      if (a === 'move-selection') this._moveSelection(key.op, { repeat: !!e.repeat });
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
        this._view.flashListHint('已切至原生操作' + nativeResumeHint(), 4000);
      return;
    }
    e.preventDefault();
    this._beginPassthroughBytes(bytes);
  },

  // _beginNativePassthrough 的**後半段**，抽出來給滑鼠點功能鍵（onFunctionKey）、
  // 貼上（onPaste）、IME 送字（noteTextInput）共用。純重構，鍵盤行為一字未改：
  // 前半段的 keyEventToBytes / preventDefault / Ctrl 組合判斷留在原函式，那些只有
  // 鍵盤事件才有。
  //
  // opts.kind / opts.hint 只換佇列命令的診斷名稱與提示措辭；**序列本身**
  //（state transition → cursor sync 腿 → _enterFunctionMode → queue.enqueue）
  // 是不變量 12 的承重部分，三個入口一律共用這一份，勿再各自複製一遍。
  _beginPassthroughBytes: function(bytes, opts) {
    const kind = (opts && opts.kind) || 'native-key';
    // hint === null ＝刻意不在切換當下閃提示（多步序列由最後一步自己說「做了
    // 什麼」）。欄位缺席才吃預設值。
    const hint =
      opts && 'hint' in opts
        ? opts.hint
        : '已切至原生操作' + nativeResumeHint();
    // bytes 是字串 ＝ 一步；是陣列 ＝ 多步序列（每步 {keys, kind, expect,
    // onDone, onFail}）。**第 n+1 步只在第 n 步的 onDone 裡 enqueue**，所以前一步
    // 的 expect 沒滿足時後面的鍵絕不會出去 —— 那不是保險，是必要條件：'v' 沒進
    // prompt 時 'w' 會落回列表按鍵 b_call_in（對該列作者送呼叫器，有副作用），
    // '\r' 則會開文（docs/pttbbs-screen-protocol.md §11.5）。
    const steps = Array.isArray(bytes) ? bytes : [{ keys: bytes, kind: kind }];
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
      self._enqueuePassthroughStep(steps, 0);
      if (hint && self._view.flashListHint) self._view.flashListHint(hint, 4000);
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

  // 送出 passthrough 序列的第 i 步，並在它落地後才排下一步（單步序列＝原本的
  // 行為，一字未改：expect 恆真、無 onDone/onFail、NATIVE_PASSTHROUGH_MS）。
  _enqueuePassthroughStep: function(steps, i) {
    const self = this;
    const step = steps[i];
    this._queue.enqueue({
      keys: step.keys,
      kind: step.kind || 'native-key',
      // 尾附 \f：PTT 完全忽略某個鍵時（無權限、MODE_SELECT 下的 Ctrl-D…）是
      // **零 byte 零 settle**，命令只能等到 NATIVE_PASSTHROUGH_MS(3s) 才 timeout
      // ⇒ 使用者要盯著原生畫面發呆 3 秒，自動回復也無從觸發。\f 保證必有一幀
      // （協定 §6：igetch 全域攔截，getdata/vgets/pmore/編輯器一律吃這條）。
      fullRepaint: 'fullRepaint' in step ? step.fullRepaint : true,
      expect:
        step.expect ||
        function() {
          return true; // any settle is the response
        },
      timeoutMs: step.timeoutMs || NATIVE_PASSTHROUGH_MS,
      onDone: function(result) {
        if (step.onDone) step.onDone(result);
        if (i + 1 < steps.length) self._enqueuePassthroughStep(steps, i + 1);
      },
      onFail: step.onFail
    });
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

  // 「使用者送了一整串文字給 PTT」的共用主體：貼上（onPaste）與 IME 送字
  // （noteTextInput）都走這裡。回 true ＝本 session 已接手（呼叫端**不得**再送）。
  //
  // Shape is exactly the T3 one-key passthrough (_beginNativePassthrough), only
  // the payload is a whole string instead of one key's bytes: sync the real
  // cursor when it lags the selection, switch to the native mirror, then send.
  // Two reasons it can't just go raw down view.onTextInput like it used to:
  //   - un-serialized bytes race whatever prefetch/jump is in flight (pttbbs
  //     typeahead swallows repaints — protocol §2);
  //   - in buffer mode the screen shows the accumulated list, so the prompt PTT
  //     draws in response is INVISIBLE until some later settle trips the
  //     catch-all. Users read that as "nothing happened" (貼上會再貼一次 →
  //     #1gIeu-3A1gIeu-3A → 找不到文章；IME 則讀成「整個畫面卡住」).
  // What PTT then does with the text is left entirely native — no AID parsing,
  // no synthesized Enter. `#` opens 搜尋文章代碼(AID): # and waits for Enter,
  // and on success only MOVES the cursor (pttbbs read.c#select_by_aid); a
  // pasted trailing newline submits it, exactly as in a real terminal.
  //
  // opts.normalize ＝要不要先套 normalizePasteText（**貼上專屬**的換行／折行
  // 正規化；IME 送的是剛組完的一段字，沒有多行語意，套了會憑空多出 Enter）。
  _beginTextPassthrough: function(text, opts) {
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
    // and a text payload is no different — the ordinary convSend path is correct.
    if (this.state !== 'active') return false;

    // CommandQueue's send is bound to the RAW conn.send (pttchrome.jsx), not
    // conn.convSend, so the Big5 conversion that convSend would have done has
    // to happen here — same two steps, same order (telnet.js#convSend).
    const src = opts.normalize
      ? normalizePasteText(text, this._view.lineWrap)
      : text;
    const keys = ansiHalfColorConv(u2b(src));
    if (!keys) return false; // empty/unconvertible: don't burn a native switch

    this._beginPassthroughBytes(keys, opts); // ← 共用序列（sync 腿也在裡面）
    return true;
  },

  // Paste (Shift-Insert / context menu / middle click), routed here from
  // App.onPasteDone — the single funnel every paste route already goes through.
  onPaste: function(text) {
    return this._beginTextPassthrough(text, {
      normalize: true,
      kind: 'native-paste',
      hint: '已貼上並切至原生操作' + nativeResumeHint()
    });
  },

  // 使用者用中文輸入法在列表上打字（compositionend → term_view.onInput →
  // onTextInput），由那條共用漏斗轉進來。
  //
  // **不是按鍵**：IME 的 keydown keyCode 是 229，被 term_view 的 keyEventFilter
  // 擋在 onKeyDown 之外 ⇒ 走不到 _classifyKey 的 passthrough（一鍵切原生）。舊碼
  // 因此讓 bytes 裸送，症狀＝「切到中文輸入法打字，整個畫面就卡住」——PTT 開了
  // prompt，畫面卻還是累積緩衝視窗，使用者看不到自己打的字。與貼上（不變量 12b）
  // 同源、同一條 T3 路徑，差別只有不套 normalizePasteText 與佇列命令的 kind。
  // 回 true ＝已接手（term_view.onTextInput 不得再 _convSend）。
  // 守護：tests/unit/list_text_input.test.js、tests/unit/term_view_text_input.test.js。
  noteTextInput: function(text) {
    return this._beginTextPassthrough(text, {
      normalize: false,
      kind: 'native-input',
      hint: '已切至原生操作' + nativeResumeHint()
    });
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

  // A 類鍵（INPLACE_KEYS）的凍結交易 —— 本功能的 L1，形狀完全照抄 _beginLeave：
  // 畫面逐像素凍住 → （必要時）同步真游標 → 送真鍵 → 等真回應 → 採用真落點。
  // **不是** v5 退役的「模擬交易」（那是 client 自己算游標該去哪）；這裡送的是
  // 真的鍵、採用的是 server 的落點，只是全程不讓使用者看到原生鏡像。
  //
  // 為什麼 A 類值得這樣做（2026-07-10 黏性原生當初要解的三題，對 A 類同時消失）：
  //   閃動   —— 反覆 [ ] 不再 buffer↔原生 翻面
  //   丟 cache —— 沒有 _enterFunctionMode ⇒ _boardName 還在，落地走純 resume 快路徑
  //   banner —— 全程沒經過 active 的 catch-all
  _beginInplaceTransaction: function(bytes) {
    const r = transitionListSession(this.state, {
      type: 'key',
      keyClass: 'native-inplace'
    });
    this.state = r.next; // functionMode（吸收在途 settle／吞鍵），render 仍是 frozen
    this._freezeForTransaction();
    const self = this;
    const send = function() {
      self._enqueueInplaceKey(bytes);
    };
    // A 類鍵幾乎都是**對真游標所在那一列**動作的（thread 家族從游標找關聯文、
    // t 標記游標那一列），本地導覽零網路 ⇒ 真游標落後時必須先跳號同步。
    if (this._selectedNum != null && this._selectedNum !== this._serverNum) {
      this._enqueueCursorSyncJump('inplace-sync-jump', send, function() {
        self._degradeToNative('操作逾時，已切至原生模式');
      });
      return;
    }
    send();
  },

  _enqueueInplaceKey: function(bytes) {
    const self = this;
    let landed = null;
    this._queue.enqueue({
      keys: bytes,
      kind: 'native-inplace',
      // 保證必有一幀可判定：thread() 找不到目標時回原位，畫面幾乎沒有變化。
      // \f 在 prompt／pmore／編輯器內都是零副作用的（協定 §6）。
      fullRepaint: true,
      // **不可以寫成 kind === 'clean-list'**（陷阱 T1）：這個鍵前面若剛跑過
      // inplace-sync-jump，server 虛擬螢幕的底列是空的（協定 §4 ✚），redrawwin
      // 重繪的是**現狀**而不是推進狀態 ⇒ \f 之後仍然不是 clean-list。用 park 指紋。
      expect: function(snap, facts) {
        if (
          facts.curX <= 1 &&
          facts.curY >= 3 &&
          facts.curY <= facts.rows - 2 &&
          (facts.cursorRowNum != null || facts.kind === 'clean-list')
        ) {
          landed = facts;
          return true;
        }
        return false;
      },
      timeoutMs: CMD_PROBE_AFTER_MS,
      probeTimeoutMs: CMD_PROBE_WINDOW_MS,
      hardTimeoutMs: CMD_HARD_MS,
      onDone: function() {
        self.state = 'active';
        const inBuf =
          !!landed &&
          landed.cursorRowNum != null &&
          (self._termBuf.listLineNums || []).indexOf(landed.cursorRowNum) !== -1;
        // 落點不在緩衝（`[` 跳到很遠的舊文、置底列）＝畫面本來就要換一份 ⇒
        // 走既有的 resume+rebuild（那時視野跳一下是合理的）。
        if (inBuf) self._resumeInPlace(landed);
        else {
          self._resumeBuffer(landed);
          self._rebuild(landed);
        }
      },
      onFail: function() {
        self._degradeToNative('操作逾時，已切至原生模式');
      }
    });
  },

  // 凍結交易落地後回到 buffer。**不可以直接用 _resumeBuffer**（陷阱 T2）：那一支
  // 是給「從原生鏡像回來、畫面本來就是 server 那一頁」設計的，會把 _topNum 重設
  // 成原生畫面第一列並設 _anchorOverride。A 類交易期間畫面是**凍住的 buffer**，
  // 使用者的捲動位置在自己的視口裡 —— 套用會讓視野瞬間跳走。
  // 這裡只做兩件事：採用落點當選取／server 游標，然後把它帶進視野（不變量 N6）。
  _resumeInPlace: function(facts) {
    this._holdReason = null;
    this._cancelResumeProbe();
    this._resumedAt = Date.now();
    this._breakChain();
    this._renderMode = 'buffer';
    this._setLoading(false);
    this._view.hideCursor();
    if (facts && facts.cursorRowNum != null) {
      this._serverNum = facts.cursorRowNum;
      this._selectedNum = facts.cursorRowNum;
      this._selectedPinnedKey = null;
    }
    // 同步重繪：把落地那一頁併回緩衝（t 的 tag 標記之類的逐列變化靠這一趟生效）。
    // 錨（_topNum/_topPinnedKey/_scrollFrac）一律不碰。
    this._forceRedraw();
    const seq = this._sequence();
    const pos = this._cursorPos(seq);
    if (pos >= 0 && !this._isPosVisible(seq, pos)) {
      this._scheduleReveal(pos, { block: 'nearest', behavior: 'auto' });
      this._forceRedraw();
    }
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
    this._cancelScroll(); // 畫面要逐像素凍住 ⇒ 殘留的平滑動畫必須停掉
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
        // A 類鍵（INPLACE_KEYS，枚舉即合約——不變量 N5）：原地重繪，清單內容與
        // 編號空間都不變 ⇒ 走凍結交易，**全程不切原生**。pref 關掉時整組落回
        // passthrough（＝逐位元回到 2026-09-03 之前的行為）。
        if (
          e.key.length === 1 &&
          INPLACE_KEYS.indexOf(e.key) !== -1 &&
          this._autoResumeEnabled()
        )
          return { class: 'native-inplace', bytes: keyEventToBytes(e) };
        return { class: 'passthrough' };
    }
  },

  // Wheel (routed from App.mouse_scroll with the native pref mapping already
  // applied): execute the op through the SAME nav path as the keyboard.
  onWheel: function(op) {
    if (this.state !== 'active' || this._renderMode !== 'buffer') return;
    this._moveSelection(op);
  },

  // 滾輪到邊（`App.mouse_scroll` 在放行給瀏覽器之前呼叫，dir: -1 上 / +1 下）。
  //
  // 為什麼需要它：捲動本身交給瀏覽器之後，demand 是由 scroll 事件驅動的——而
  // **捲不動就沒有 scroll 事件**。buffer 只有一頁時（內容高＝視口高，剛進板的
  // 常態）使用者往上滾，畫面不動也不補頁，看起來就是卡住。到邊的滾輪本身就是
  // 「請給我更多」的意思，這裡把它接回既有的 demand（零 byte 判斷，真正要不要
  // 送命令仍由 _maybeDemand 的水位規則決定）。
  onWheelAtEdge: function(dir) {
    if (this.state !== 'active' || this._renderMode !== 'buffer') return;
    const screen = this._screen();
    if (!screen || !screen.getListScrollTop) return;
    const px = screen.getListScrollTop();
    const atEdge = dir < 0 ? px <= 0 : px >= this._maxScrollTop() - 1;
    if (!atEdge) return; // 還捲得動 ⇒ scroll 事件會處理
    this._maybeDemand(dir);
    const moreExpected = dir > 0 ? !this._edgeDown : !this._edgeUp;
    if (moreExpected && !this._queue.idle) this._setLoading(true);
  },

  // 原生捲動的 scroll 事件（`.listBodyView`，passive）。rAF 合併：捲動事件率遠高
  // 於一幀，而這裡每次要走一趟 O(序列長度) 的位置換算＋水位判斷。
  //
  // **絕不重繪**（不變量 2b 的紅線）：本地重繪會餵 term_buf 的 lineChangeds，
  // 一旦混進 settle 視窗就是「按住鍵永遠不 settle → queue expect 餓死」。捲動
  // 只做兩件事：更新錨、必要時補資料。
  onDomScroll: function() {
    if (this.state !== 'active' || this._renderMode !== 'buffer') return;
    if (this._scrollRaf != null) return;
    const self = this;
    const raf =
      typeof requestAnimationFrame === 'function'
        ? function(fn) { return requestAnimationFrame(fn); }
        : function(fn) { return setTimeout(fn, 16); };
    this._scrollRaf = raf(function() {
      self._scrollRaf = null;
      self._onScrollFrame();
    });
  },

  _onScrollFrame: function() {
    if (this.state !== 'active' || this._renderMode !== 'buffer') return;
    const screen = this._screen();
    if (!screen || !screen.getListScrollTop) return;
    const px = screen.getListScrollTop();
    const dir = px > this._lastScrollTop ? 1 : px < this._lastScrollTop ? -1 : 0;
    this._lastScrollTop = px;
    this._scrollAnimSettled(px); // 到站／逾時就把動畫狀態收掉
    this.captureScrollAnchor();
    if (!dir) return;
    this._maybeDemand(dir);
    // 到邊讀取中：視口已貼著 buffer 邊、server 端還有東西、而且有命令在飛
    // （上面那次 demand 或更早的鏈）。prefetch onDone/markEdge 會關掉它。
    const atEdge =
      dir > 0
        ? px >= this._maxScrollTop() - 1
        : px <= 0;
    const moreExpected = dir > 0 ? !this._edgeDown : !this._edgeUp;
    if (atEdge && moreExpected && !this._queue.idle) this._setLoading(true);
  },

  _maxScrollTop: function() {
    const screen = this._screen();
    const rowH = this._rowHeight();
    if (!screen || !(rowH > 0)) return 0;
    const B = this._bodyRows();
    return maxScrollTopFor({
      len: this._sequence().length,
      bodyRows: B,
      rowH: rowH,
      viewportPx: (screen.getListViewportPx && screen.getListViewportPx()) || B * rowH
    });
  },

  // 未縮放的列高（＝畫面上的 chh）。
  _rowHeight: function() {
    return (this._view && this._view.chh) || 0;
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
    // renderRow 是**渲染後**的列號：header 3 列之後就是整段序列（body 現在全部
    // 畫出來、由瀏覽器捲），所以 body index 直接是序列位置。
    const idx = renderRow - LIST_HEADER_ROWS;
    if (idx < 0) return; // header
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
    const view = this.getListView();
    if (!view) return;
    // idx >= seq.length ＝ 短板補到 bodyRows 的空白列（或 footer），沒有文章可點。
    const abs = idx < view.seq.length ? view.seq[idx] : null;
    if (abs == null) return;

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

  // ---- 右鍵選單「前已讀後未讀」(pttbbs b_mark_read_unread) --------------------

  // 純查詢、零副作用：右鍵選單問「這一列做得了嗎、對象是第幾篇」。回 null ＝
  // 那個選單項不出現（條件全收在這裡，React 端不重複判斷）。
  markReadTargetAtRow: function(renderRow) {
    if (this.state !== 'active' || this._renderMode !== 'buffer') return null;
    const idx = renderRow - LIST_HEADER_ROWS;
    if (idx < 0) return null; // header
    const view = this.getListView();
    // idx >= seq.length ＝ 短板補到 bodyRows 的空白列（或 footer）。
    if (!view || idx >= view.seq.length) return null;
    const abs = view.seq[idx];
    if (abs == null) return null;
    // 置底文不支援：沒有序號 ⇒ sync leg 的 `<num>\r` 無從送起，而且它的時間戳
    // 當「界線」語意也不對（置底恆排在最前面）。
    const num = (this._termBuf.listLineNums || [])[abs];
    if (num == null) return null;
    return { num: num };
  },

  // 需求的三步：真游標移到那一列 → `v` → `w` + Enter。回 true ＝我接手了。
  //
  // 為什麼**不能**一次送 'vw\r'：`v` 沒成功進 prompt 時（列表為空、畫面偏移），
  // `w` 會落回列表按鍵 b_call_in（對該列作者送呼叫器）、`\r` 會開文。兩步一定要
  // 序列化，而且第一步的 expect 必須確認 prompt 真的出現才准送第二步。
  //
  // 完成後停在原生鏡像（_enterFunctionMode 的 'passthrough' hold）：已讀標記改
  // 變 ⇒ 累積 buffer 的內容全數過時，返回時本來就該走 rebuild。畫面靜下來之後
  // 由靜置探針自動切回好讀（pref enableListNativeAutoResume；關掉就停在原生）。
  markReadUnreadBefore: function(num) {
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
    if (num == null) return false;

    // 先把選取移到目標並**同步重畫**：_beginPassthroughBytes 會立刻凍住畫面，
    // 少了這一步凍住的是點擊前的游標位置（看起來像點錯列）。同 onMouseClick。
    this._selectedNum = num;
    this._selectedPinnedKey = null;
    this._forceRedraw();

    const self = this;
    // 第二步的判定畫面：expect 收到的 facts 就是結論這道命令的那一幀，留著給
    // onDone 決定提示措辭（成功 vs PTT 拒絕）。
    let applyFacts = null;
    this._beginPassthroughBytes(
      [
        {
          keys: 'v',
          kind: 'mark-read-prompt',
          // 掃整個畫面：prompt 在 row 22，只看底列會永遠判否。
          expect: function(snap, facts) {
            for (let i = 0; i < facts.rowTexts.length; ++i)
              if (facts.rowTexts[i].indexOf(MARK_READ_PROMPT) !== -1) return true;
            return false;
          },
          onFail: function() {
            self._degradeToNative('設定已讀未讀逾時，已切至原生模式');
          }
        },
        {
          keys: 'w\r', // getdata 是整行輸入（vgets）⇒ 必須補 Enter
          kind: 'mark-read-apply',
          // 任何 settle 都是回應：正常是 FULLUPDATE 的列表，錯誤是 vmsg 的
          // 等按鍵畫面 —— 兩者都停在原生鏡像讓使用者自己看（v5：失敗顯性化）。
          expect: function(snap, facts) {
            applyFacts = facts;
            return true;
          },
          onDone: function() {
            if (!self._view.flashListHint) return;
            const rejected =
              !!applyFacts &&
              applyFacts.rowTexts.some(function(t) {
                return t.indexOf(MARK_READ_REJECT) !== -1;
              });
            self._view.flashListHint(
              rejected
                ? 'PTT 不接受這篇當參考點，已讀記錄沒有變動（請改用其它文章）。' +
                    '已切至原生' + nativeResumeHint()
                : '已將第 ' +
                    num +
                    ' 篇（含）以前設為已讀、以後設為未讀。' +
                    '已切至原生' + nativeResumeHint(),
              4000
            );
          }
        }
      ],
      // 切原生當下不閃提示：結論由上面那句在落地後補（兩句連著閃會互相蓋掉）。
      { kind: 'mark-read', hint: null }
    );
    return true;
  },

  // ---- actions ---------------------------------------------------------------

  _seed: function(facts) {
    this._holdReason = null;
    this._cancelResumeProbe();
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
    if (!seq.length) return;
    const top = this._viewportTopPos(seq);
    if (
      seq.length < top + this._bodyRows() &&
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
    // 錨的三個欄位是一組，重設要一起（漏掉 pinned key 會讓 _anchorPos 拿舊的
    // 置底列去對位，畫面定位到別的地方）。
    this._topPinnedKey = null;
    this._scrollFrac = 0;
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
    const top = this._viewportTopPos(seq);
    const B = this._bodyRows();
    if (direction < 0 && top < 2 * B && !this._edgeUp)
      this._enqueuePrefetch(true, 'key');
    else if (
      direction > 0 &&
      seq.length - (top + B) < 2 * B &&
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
  // evict／prune 的樞紐＝**視口頂那一列的序號**（使用者眼前的位置），退路才是選取。
  // 見 evictListBuffer 的註解：游標可以離視口很遠，用它當樞紐會丟掉眼前的內容。
  evictPivot: function() {
    if (this._topNum != null) return this._topNum;
    return this._selectedNum;
  },

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
    this._cancelScroll(); // 同 _freezeForTransaction
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
    this._cancelScroll(); // 同 _beginOpen
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
    this._holdReason = null; // context change: the article releases the hold
    this._cancelResumeProbe();
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
  // opts.hold: 'passthrough'（預設，靜置後自動回好讀）| 'external'（永不自動解除）。
  _enterFunctionMode: function(facts, opts) {
    this._cancelScroll(); // 原生鏡像沒有捲動視口，排隊中的 reveal 要作廢
    this._holdReason = (opts && opts.hold) || 'passthrough';
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
    // 停泊當下就排一次探針：使用者按完鍵之後可能再也不動（畫面靜止不會有 settle）。
    this._scheduleResumeProbe();
    if (facts && this._view.flashListHint) {
      this._view.flashListHint(
        (isWaterballSettle(facts)
          ? '收到水球／廣播，已切至原生模式'
          : '畫面偏離列表格式，已切至原生模式') + nativeResumeHint(),
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
    this._holdReason = null;
    this._cancelResumeProbe();
    this._resumedAt = Date.now(); // 不變量 N4：殘餘幀不得打到 active 的 catch-all
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
      // 錨的三個欄位是一組，重設要一起（同 _seedAnchors）。
      this._topNum = null;
      this._topPinnedKey = null;
      this._scrollFrac = 0;
      // 這一幀的錨由這次 action 指定，不從 DOM 擷取——同 _requestEnd/_requestHome。
      // 少了它，緊接著的 _forceRedraw 會讓 captureScrollAnchor 拿**還沒掛回 DOM
      // 的視口**（scrollTop 恆 0）覆寫掉下面剛採用的落點（退文後視野跑掉）。
      this._anchorOverride = true;
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
    this._cancelScroll();
    this._holdReason = null;
    this._cancelResumeProbe();
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
    this._topPinnedKey = null;
    this._scrollFrac = 0;
    this._seqCache = null;
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
  //
  // 記憶化：這是 O(緩衝列數) 的 rowToText（緩衝上限 MAX_LIST_ROWS=300），而原生
  // 捲動下每個 scroll 事件都要換算一次位置＋判 demand ⇒ 不快取就是每幀重算整份。
  // 失效判準全是**參考比對**，四個來源都只換不改：`listLines`/`listLineNums` 由
  // flattenListBuffer 每次產生新陣列（term_view.accumulateListLines），
  // blacklist/titleBlacklist 由 parseBlacklist/parseTitleBlacklist 換新集合
  // （pttchrome.jsx 的 pref 套用點）。`_edgeDown` 是 pinned 門控的輸入 ⇒ 一併入 key。
  _sequence: function() {
    const buf = this._termBuf;
    const nums = buf.listLineNums || [];
    const lines = buf.listLines || [];
    const bl = this._view.blacklist;
    const tbl = this._view.titleBlacklist;
    const c = this._seqCache;
    if (
      c &&
      c.lines === lines &&
      c.nums === nums &&
      c.len === lines.length &&
      c.numLen === nums.length &&
      c.edgeDown === this._edgeDown &&
      c.blacklist === bl &&
      c.titleBlacklist === tbl
    )
      return c.seq;
    const seq = windowVisibleSequence(this._visibleIndices(), nums, this._edgeDown);
    this._seqCache = {
      lines: lines,
      nums: nums,
      // 長度一併入 key：參考比對擋不掉「就地 push/splice」，而快取失效失敗是靜默的
      // （畫面停在舊序列、demand 不觸發）。長度是零成本的第二道網。
      len: lines.length,
      numLen: nums.length,
      edgeDown: this._edgeDown,
      blacklist: bl,
      titleBlacklist: tbl,
      seq: seq
    };
    return seq;
  },

  // 游標（`>`）落在序列的第幾個位置。選取以**內容**為身分（序號／置底 title
  // key），所以 prepend/evict 都不會移動它。
  //
  // 2026-08-30 起游標與捲動位置**解耦**（網頁式語意）：捲動不動游標、游標也不再
  // 被視窗推著走。舊的 normalizeListWindow（視窗以游標重錨）因此從 render 路徑
  // 退場——那條耦合正是 v1–v4 混合模型失敗的接縫（research doc §4）。
  _cursorPos: function(seq) {
    if (!seq.length) return -1;
    const cursorAbs = this._resolveSelectedIndex();
    const cursor = seq.indexOf(cursorAbs);
    if (cursor !== -1) return cursor;
    // Selection lost (blacklisted / evicted / pinned re-gated): snap to the
    // nearest surviving row, same rule as moveListSelection.
    const snapped = moveListSelection(seq, cursorAbs, 0);
    return snapped === -1 ? seq.length - 1 : seq.indexOf(snapped);
  },

  // 捲動錨（視口頂端那一列）落在序列的第幾個位置。-1＝錨遺失（那一列被 evict／
  // 被黑名單隱藏／pinned 重新門控）。
  _anchorPos: function(seq) {
    if (!seq.length) return -1;
    const nums = this._termBuf.listLineNums || [];
    if (this._topNum != null) {
      const abs = nums.indexOf(this._topNum);
      if (abs !== -1) {
        const p = seq.indexOf(abs);
        if (p !== -1) return p;
      }
    } else if (this._topPinnedKey != null) {
      for (let i = 0; i < seq.length; ++i) {
        if (nums[seq[i]] == null && this._pinnedKeyAt(seq[i]) === this._topPinnedKey)
          return i;
      }
    }
    return -1;
  },

  // 視口頂端的序列位置，含退路。demand 的水位判斷用它（原生捲動下 scroll 事件
  // 會持續把錨更新成 DOM 的實況，所以這是純狀態讀取、不碰 DOM）。
  _viewportTopPos: function(seq) {
    const p = this._anchorPos(seq);
    if (p !== -1) return p;
    return Math.max(0, this._cursorPos(seq));
  },

  // 翻頁的基準位置。動畫還在飛時要用**動畫的終點**而不是中間值 —— 否則連按
  // PgUp 的第二次只會從半路再翻一頁，距離不足（使用者感受：翻不動／卡卡的）。
  _navTopPos: function(seq) {
    const a = this._scrollAnim;
    const rowH = this._rowHeight();
    if (a && rowH > 0) {
      const p = Math.round(a.px / rowH);
      if (p >= 0 && p < seq.length) return p;
    }
    return this._viewportTopPos(seq);
  },

  // 把序列位置寫回**內容錨**（序號／置底 key）＋列內 px 偏移。錨活得過 prepend
  // 與 evict，位置活不過 —— 這就是不變量 6 在原生捲動下的形式。
  _setAnchorPos: function(seq, pos, frac) {
    if (!seq.length) return;
    const nums = this._termBuf.listLineNums || [];
    const p = Math.max(0, Math.min(pos, seq.length - 1));
    const abs = seq[p];
    this._topNum = nums[abs];
    this._topPinnedKey = this._topNum == null ? this._pinnedKeyAt(abs) : null;
    this._scrollFrac = Math.max(0, frac || 0);
  },

  // 游標寫回內容錨。
  _setCursorPos: function(seq, cursor) {
    if (!seq.length) return;
    const nums = this._termBuf.listLineNums || [];
    const c = Math.max(0, Math.min(cursor, seq.length - 1));
    const cursorAbs = seq[c];
    this._selectedNum = nums[cursorAbs];
    this._selectedPinnedKey =
      nums[cursorAbs] == null ? this._pinnedKeyAt(cursorAbs) : null;
  },

  // 排一次「把第 pos 列帶進視口」，由 applyScrollAfterRender 在重繪後消費
  // （render 之前算 scrollTop 沒有意義：序列長度還沒定案）。
  _scheduleReveal: function(pos, plan) {
    this._pendingReveal = { pos: pos, block: plan.block, behavior: plan.behavior };
  },

  // The render contract with term_view.buildListWindowLines(): 整段過濾後序列
  // （絕對 listLines 索引）＋游標那一列的絕對索引。body 不再是 20 格切片——
  // 全部畫出去，捲動交給瀏覽器。
  getListView: function() {
    const seq = this._sequence();
    if (!seq.length) return null;
    const cursor = this._cursorPos(seq);
    // 每幀把游標寫回內容錨（snap 之後可能換了一列）。捲動錨**不在這裡寫**：它
    // 的真相源是 DOM 的 scrollTop，由 captureScrollAnchor 在重繪前擷取。
    this._setCursorPos(seq, cursor);
    return { seq: seq, cursorAbs: seq[cursor], cursorPos: cursor };
  },

  // ---- 原生捲動的錨定（render 前擷取 / render 後還原）-------------------------

  // 記下一個進行中的平滑捲動：目標那一列的**內容身分**＋當下算出的目標 px。
  _armScrollAnim: function(seq, pos, block, px) {
    const nums = this._termBuf.listLineNums || [];
    const abs = seq[Math.max(0, Math.min(pos, seq.length - 1))];
    const num = nums[abs];
    this._scrollAnim = {
      num: num,
      key: num == null ? this._pinnedKeyAt(abs) : null,
      block: block,
      px: px,
      at: Date.now()
    };
  },

  // 動畫目標那一列現在在序列的第幾個位置（補頁／evict 之後會位移）。-1＝不見了。
  _animTargetPos: function(seq) {
    const a = this._scrollAnim;
    if (!a) return -1;
    const nums = this._termBuf.listLineNums || [];
    if (a.num != null) {
      const abs = nums.indexOf(a.num);
      if (abs !== -1) return seq.indexOf(abs);
      return -1;
    }
    if (a.key == null) return -1;
    for (let i = 0; i < seq.length; ++i)
      if (nums[seq[i]] == null && this._pinnedKeyAt(seq[i]) === a.key) return i;
    return -1;
  },

  // 動畫到站了嗎（順便清掉）。逾時逃生門：使用者中途自己捲動會取消瀏覽器的
  // 動畫，那時永遠到不了目標。
  _scrollAnimSettled: function(px) {
    const a = this._scrollAnim;
    if (!a) return true;
    if (Math.abs(px - a.px) < 1 || Date.now() - a.at > SCROLL_ANIM_MAX_MS) {
      this._scrollAnim = null;
      return true;
    }
    return false;
  },

  // 重繪前：把 DOM 現在的 scrollTop 轉成內容錨。accumulate 會讓整段序列上下位移
  // （merge/evict/prune），位置留不住、錨留得住。
  captureScrollAnchor: function() {
    if (this._anchorOverride) {
      // 這一幀的錨由 action 指定（開文落地／End/Home／re-seed），不從 DOM 擷取。
      this._anchorOverride = false;
      return;
    }
    const screen = this._screen();
    if (!screen || !screen.getListScrollTop) return;
    // 視口不在 DOM 上（剛從文章／原生鏡像回來，這一幀還沒把它掛回去）：detached
    // 節點的 scrollTop 恆為 0，那是「沒有資訊」不是「捲到最上面」。拿它當錨會把
    // 畫面丟回緩衝最舊那一列（使用者：退文後視野跑掉）。DOM 沒有意見的時候，
    // session 手上的錨就是唯一的真相。
    if (screen.hasListViewport && !screen.hasListViewport()) return;
    const rowH = this._rowHeight();
    if (!(rowH > 0)) return;
    const seq = this._sequence();
    if (!seq.length) return;
    // **動畫期間照樣擷取**：錨的意義是「現在顯示的是哪一列」，補頁時要靠它把
    // scrollTop 補償到新座標系（DOM 前置插入 N 列＝內容整體下移 N 列）。動畫的
    // 終點另外由 _scrollAnim 記著，兩者是不同的東西 —— 混為一談就是回捲。
    const t = topPosFromScrollTop({
      scrollTop: screen.getListScrollTop(),
      rowH: rowH
    });
    this._setAnchorPos(seq, t.pos, t.frac);
  },

  // 重繪後：錨 → 新的序列位置 → scrollTop。接著消費 _pendingReveal。
  applyScrollAfterRender: function() {
    const screen = this._screen();
    if (!screen || !screen.setListScrollTop) return;
    const rowH = this._rowHeight();
    if (!(rowH > 0)) return;
    const seq = this._sequence();
    if (!seq.length) return;
    const B = this._bodyRows();
    const viewportPx = screen.getListViewportPx() || B * rowH;
    const maxScrollTop = maxScrollTopFor({
      len: seq.length,
      bodyRows: B,
      rowH: rowH,
      viewportPx: viewportPx
    });
    let pos = this._anchorPos(seq);
    if (pos === -1) {
      // 錨遺失（那一列被 evict／黑名單／pinned 門控拿掉）。退路：游標 → 0。
      // 這是新架構最可能靜默出錯的地方 ⇒ 留一則診斷（不變量 7f）。
      pos = Math.max(0, this._cursorPos(seq));
      this._diag('listSession.scrollAnchorLost', {
        topNum: this._topNum,
        fallbackPos: pos,
        len: seq.length
      });
      this._setAnchorPos(seq, pos, 0);
    }
    let top = anchorScrollTop({
      pos: pos,
      frac: this._scrollFrac,
      rowH: rowH,
      maxScrollTop: maxScrollTop
    });
    // 補償：把畫面定回「錨那一列」該在的地方。補頁／evict 讓序列整段位移時，
    // 這一步就是「畫面不跳」的全部（不變量 6）。動畫進行中也照做——動畫的中間值
    // 是舊座標系的，不補償就會瞬間跳過頭。
    //
    // **序列沒位移時一格都不准寫**：同步寫 scrollTop 會取消瀏覽器進行中的平滑捲動
    // （_cancelScroll 正是靠這個副作用停住畫面的）。列表每有一幀重繪就寫一次「與
    // 現值相同」的值 ⇒ 動畫被殺，而下面的 _scrollAnim 分支又因為「目標沒變」不重發
    // ⇒ 單按一次 PgUp 只要中途來一幀就捲到一半停住。
    const cur = screen.getListScrollTop ? screen.getListScrollTop() : top;
    const compensated = Math.abs(top - cur) >= 0.5;
    if (compensated) {
      screen.setListScrollTop(top);
      // 程式化定位＝新的基準。不同步的話它引發的 scroll 事件會被 _onScrollFrame
      // 當成「使用者往這個方向捲」而偷送一次反方向 demand（退文回來必踩：
      // _cancelScroll 已把 _lastScrollTop 歸零）。平滑動畫**不**同步——它的中間
      // 幀是真的位移，方向要照常看得見。
      this._lastScrollTop = top;
    }

    const rv = this._pendingReveal;
    if (rv) {
      this._pendingReveal = null;
      const target = revealScrollTop({
        pos: rv.pos,
        scrollTop: top,
        rowH: rowH,
        viewportPx: viewportPx,
        maxScrollTop: maxScrollTop,
        block: rv.block
      });
      if (target !== top && rv.behavior === 'smooth') {
        screen.scrollListTo(target, 'smooth');
        this._armScrollAnim(seq, rv.pos, rv.block, target);
      } else {
        // instant：**一定要**寫一次，把上一發還在飛的平滑動畫殺掉（連發的第二發
        // 就是這條路；不寫的話舊動畫會繼續把畫面帶走＝放開後還在捲）。
        const hadAnim = !!this._scrollAnim;
        this._scrollAnim = null;
        if (target !== top || hadAnim) screen.scrollListTo(target, rv.behavior);
        this._lastScrollTop = target; // 同上：瞬時定位就是新的基準
        this._syncAnchorFromPx(seq, target, rowH);
      }
      return;
    }

    if (this._scrollAnim) {
      // 動畫還在飛：目標那一列可能被補頁往下推了，px 要跟著它重算，否則動畫會
      // 朝一個已經不對的位置飛（往回捲）。序列沒動時 target 不變 ⇒ 不重發。
      const tpos = this._animTargetPos(seq);
      if (tpos === -1) {
        this._scrollAnim = null; // 目標那一列不見了（evict／黑名單）⇒ 停在原地
        return;
      }
      const target = revealScrollTop({
        pos: tpos,
        scrollTop: top,
        rowH: rowH,
        viewportPx: viewportPx,
        maxScrollTop: maxScrollTop,
        block: this._scrollAnim.block
      });
      // compensated＝剛剛那次寫入已經把動畫殺了 ⇒ 即使目標 px 一樣也必須重發。
      if (compensated || Math.abs(target - this._scrollAnim.px) >= 1) {
        screen.scrollListTo(target, 'smooth');
        this._scrollAnim.px = target;
        this._scrollAnim.at = Date.now();
      }
      return;
    }

    // clamp 可能把位置往回拉（序列變短）⇒ 錨要跟著更新，否則下一幀又被拉一次。
    this._syncAnchorFromPx(seq, top, rowH);
  },

  // 停住捲動：作廢排隊中的 reveal 與 rAF，並**取消瀏覽器還在跑的平滑動畫**。
  //
  // `overflow:hidden` 只擋使用者輸入，不會取消已經排定的 `scrollTo({smooth})`
  // ⇒ 交易 frozen 之後畫面還會自己慢慢捲幾像素（實測 462 → 458）。把 scrollTop
  // 原值寫回去就能停住它（同步寫入會取消進行中的平滑捲動），位置一格都不動。
  // 呼叫點：交易凍結（_freezeForTransaction／_beginOpen／_beginOpenPinned）、
  // 切原生鏡像、cleanup。
  _cancelScroll: function() {
    this._pendingReveal = null;
    this._anchorOverride = false;
    this._lastScrollTop = 0;
    this._scrollAnim = null;
    this._lastNavAt = 0; // 交易凍結後的第一發不該被誤判成連發
    const screen = this._screen();
    if (screen && screen.getListScrollTop && screen.setListScrollTop)
      screen.setListScrollTop(screen.getListScrollTop());
    if (this._scrollRaf != null) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._scrollRaf);
      else clearTimeout(this._scrollRaf);
      this._scrollRaf = null;
    }
  },

  _syncAnchorFromPx: function(seq, px, rowH) {
    const t = topPosFromScrollTop({ scrollTop: px, rowH: rowH });
    this._setAnchorPos(seq, t.pos, t.frac);
  },

  _screen: function() {
    return (this._view && this._view.componentScreen) || null;
  },

  _diag: function(name, info) {
    const rec = this._core && this._core.debugRecorder;
    if (rec) rec.log(name, info);
  },

  // Local navigation (zero network when the rows are buffered), then directional
  // demand keeps two pages of headroom. Ops that need rows beyond a confirmed
  // edge go to the server (serverOp), exactly like native would.
  //
  // 游標與捲動**解耦**（2026-08-30，網頁式語意）：這裡只算「游標移到哪一篇」，
  // 畫面位置交給瀏覽器 —— 移完排一次 reveal，由 applyScrollAfterRender 用
  // scrollTo 把它帶進視野。兩類操作的基準不同，這是刻意的：
  //   ↑↓（游標相對操作）＝ 以游標為基準，且「本來就看得到」時只做最小的位移
  //   PgUp/PgDn/Home/End（視口操作）＝ 以**視口頂**為基準；游標被捲出視野時
  //     PgUp 若先瞬移回游標再翻一頁會很怪，而游標可見時與 read.c 語意一致。
  // serverOp 的判準一字未改（read.c:842-880 的邊界條件）。
  _moveSelection: function(op, opts) {
    const seq = this._sequence();
    if (!seq.length) return;
    const len = seq.length;
    const B = this._bodyRows();
    const cursor = this._cursorPos(seq);
    const top = this._navTopPos(seq);
    let next;
    switch (op) {
      case 'up':
        if (cursor <= 0) {
          // read.c KEY_UP 在第一列 wrap 到 last_line（板尾）——板尾未確認就得先問。
          if (!this._edgeDown) return this._requestEnd();
          next = len - 1;
        } else next = cursor - 1;
        break;
      case 'down':
        next = Math.min(cursor + 1, len - 1); // read.c KEY_DOWN：到底不 wrap
        break;
      case 'pgup':
        next = Math.max(0, top - B);
        break;
      case 'pgdn':
        // read.c 允許 over-scroll（top 越過 maxTop、下面全是空白列）；這裡照 web
        // 慣例夾住（v5 合約允許偏離 read.c，見 docs/easy-reading-list.md）。
        next = Math.min(top + B, len - 1);
        break;
      // Home/End 一律走 server（原生鍵直通，2026-09-05 使用者決定）。以前只在
      // 「該方向的板邊還沒確認」時才發交易，其餘本地瞬移 —— 那讓落點取決於
      // _edgeUp/_edgeDown 這兩個推導旗標，一旦被誤設成 true，End 只會跳到 buffer
      // 末列而不是板尾。原生鍵沒有這個狀態相依（read.c:893-902 KEY_END → last_line，
      // 含置底文）。代價是每次一趟 round-trip（實測 ~100ms）。
      case 'home':
        return this._requestHome();
      case 'end':
        return this._requestEnd();
      default:
        return;
    }
    const wasVisible = this._isPosVisible(seq, cursor);
    // 連發（按住鍵的自動重複／連續滾輪刻度）＝這次不做動畫。瀏覽器的 programmatic
    // 平滑捲動不保留速度，比它快的按鍵只會讓畫面一直從曲線起點重跑（見 revealPlan）。
    // e.repeat 給第一發、時間差給其餘來源，兩者缺一不可。
    const now = Date.now();
    const repeat = !!(opts && opts.repeat) || now - this._lastNavAt < NAV_BURST_MS;
    this._lastNavAt = now;
    this._setCursorPos(seq, next);
    this._scheduleReveal(
      next,
      revealPlan(op, {
        wasVisible: wasVisible,
        reducedMotion: prefersReducedMotion(),
        repeat: repeat
      })
    );
    this._forceRedraw();
    const direction = op === 'up' || op === 'pgup' || op === 'home' ? -1 : 1;
    this._maybeDemand(direction);
    // 到邊讀取中 (v5/M4): the cursor is pressed against the buffer edge, more
    // rows exist server-side, and a prefetch is in flight (the demand above or
    // an earlier chain) — show the loading indicator until rows arrive
    // (prefetch onDone/markEdge clear it).
    const atEdge = direction > 0 ? next === len - 1 : next === 0;
    const moreExpected = direction > 0 ? !this._edgeDown : !this._edgeUp;
    if (atEdge && moreExpected && !this._queue.idle) this._setLoading(true);
  },

  // 第 pos 列現在看得見嗎（reveal 政策的輸入）。量不到 DOM（尚未 render／unit
  // stub）時一律當作看得見 ⇒ 走 instant，不會憑空放一段動畫。
  _isPosVisible: function(seq, pos) {
    const screen = this._screen();
    const rowH = this._rowHeight();
    if (!screen || !screen.getListScrollTop || !(rowH > 0)) return true;
    return isRowVisible({
      pos: pos,
      scrollTop: screen.getListScrollTop(),
      rowH: rowH,
      viewportPx:
        (screen.getListViewportPx && screen.getListViewportPx()) ||
        this._bodyRows() * rowH
    });
  },

  // End = 原生 End 直通（`\x1b[4~`）。read.c:893-902 CONFIRMED：
  // `KEY_END`/`$` → `new_ln = last_line`，**含置底文**——比舊做法的
  // `99999999\r`（search_num 只夾到最大**編號**文章，read.c:190-210）更接近
  // 「末頁」的直覺。
  //
  // 「游標已在底端時 End 零回應會 timeout（live-tested）」是舊做法繞開原生鍵的
  // 唯一理由，`fullRepaint` 已經把它解決掉了：queue 送的是 `\x1b[4~\f`，
  // igetch 的全域熱鍵保證回一個完整幀給 expect 判（protocol §6）。同一招在
  // `open-pinned-end`（本檔 _beginOpenPinned）已經跑了很久。
  //
  // 佇列忙碌時**不再靜默丟棄**（2026-09-05 回報「Home/End 有時失效」）：舊碼
  // `if (!this._queue.idle) return;` 讓整個按鍵零 byte、零重繪、零提示消失，而
  // _moveSelection 尾端必定 _maybeDemand → 剛按過任何導覽鍵佇列通常就非 idle，
  // 進板頭 1-3 秒的鏈式補頁更是必中。改成前景優先 ＋ 排在在飛的那筆後面。
  _requestEnd: function() {
    // 連按冪等：已經有一筆跳號在路上就別再排（見 CommandQueue#hasKind）。
    if (this._queue.hasKind('jump-')) return;
    this._breakChain(); // a non-prefetch command moves the server cursor
    const self = this;
    // 前景導覽鍵優先於背景補頁：還沒送出的 prefetch 直接丟（它們的落點馬上就
    // 不算數了），在飛的那筆用 expedite 把等待縮成一個 round-trip —— 不能 flush
    // 它，那會讓還在線上的回應變成無主 settle 去滿足我們的 expect（不變量 7）。
    this._queue.flushPendingKind('prefetch');
    this._expediteBackground();
    // 吞鍵不得無聲：排在 prefetch 後面時使用者要看得到「在做事」。
    // onDone/onFail 負責關掉（膠囊擁有權見 docs/easy-reading-list.md 7d）。
    this._setLoading(true);
    // anchor 必須在**送出當下**才取：這筆命令可能排在 prefetch 後面，enqueue 當時
    // 的 buffer 邊界到送出時已經長大了。
    let anchor = null;
    this._queue.enqueue({
      keys: '\x1b[4~',
      kind: 'jump-end',
      onSend: function() {
        anchor = bufferEdgeNum(self._termBuf.listLineNums, 1);
        self._prunePivotOverride = null; // keep the landing (max-number) segment
      },
      expect: function(snap, facts) {
        // Jump landing fingerprint (protocol §4 ✚: bottom row stays empty →
        // transient, never clean-list): parked in the entry area, on a row at
        // or past our previous bottom edge (a pinned row parses as null num).
        // anchor == null（buffer 裡一列編號都沒有）不再靜默 return —— 那是不變量
        // 17 的死局殘留；沒有錨點就純粹不拿它當條件，命令照樣送得出去。
        return (
          facts.curY >= 3 &&
          facts.curY <= facts.rows - 2 &&
          facts.curX <= 1 &&
          (anchor == null ||
            facts.cursorRowNum == null ||
            facts.cursorRowNum >= anchor)
        );
      },
      // 原生 End 在底端零回應 ⇒ 必須 fullRepaint（見上方說明）。
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
        // 落點就是板尾：游標到最後一列，畫面捲到底（錨由這次 action 指定，
        // 不要讓下一幀的 captureScrollAnchor 拿舊 scrollTop 覆寫掉）。
        self._setCursorPos(seq, seq.length - 1);
        self._anchorOverride = true;
        self._scheduleReveal(seq.length - 1, {
          block: 'end',
          behavior: prefersReducedMotion() ? 'auto' : 'smooth'
        });
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

  // Home = 原生 Home 直通（`\x1b[1~`）。read.c:893-896 CONFIRMED：
  // `KEY_HOME` → `new_ln = 0; new_top = 0` ⇒ 落在第 1 篇（編號在刪文後會重新
  // 壓實，所以第 1 篇恆存在）。與 _requestEnd 同樣的三件事：fullRepaint 保證有
  // 回應、佇列忙碌時排隊而不是靜默丟棄、pivot 在 onSend 才設。
  _requestHome: function() {
    if (this._queue.hasKind('jump-')) return;
    this._breakChain(); // a non-prefetch command moves the server cursor
    const self = this;
    this._queue.flushPendingKind('prefetch');
    this._expediteBackground();
    this._setLoading(true);
    this._queue.enqueue({
      keys: '\x1b[1~',
      kind: 'jump-home',
      onSend: function() {
        // 樞紐必須等到送出才設：排在 prefetch 後面時提早設會讓**那筆 prefetch**
        // 的 prune 用「保留第 1 篇所在的段」當樞紐，而第 1 篇還不在 buffer 裡。
        self._prunePivotOverride = 1; // keep article 1's (landing) segment
      },
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
        self._setCursorPos(seq, 0);
        self._anchorOverride = true;
        self._scheduleReveal(0, {
          block: 'start',
          behavior: prefersReducedMotion() ? 'auto' : 'smooth'
        });
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

// Evict numbered rows over the cap, dropping from the end FARTHEST from
// `pivotNum` — **視口**所在的那一列（ListSession.evictPivot），不是選取。
//
// 為什麼是視口而不是選取：游標與捲動位置自 2026-08-30 起解耦（網頁式語意，
// 游標可以被捲出視野），使用者可以把畫面捲到離游標兩百多列外。pivot 若還綁著
// 選取，下一次 prefetch 撞到 cap 時被丟掉的正是**使用者眼前那一段** —— 症狀是
// 列突然消失、畫面跳。
//
// **刻意不做「選取那一列一定留著」**：留下一列孤島會讓 buffer 不連續，隨後的
// pruneListToSegment（只留 pivot 所在的連續段）本來就會把它丟掉，等於白做。
// 選取被淘汰掉的降級是既有且正確的——_cursorPos 會 snap 到最近的存活列，而
// 開文走的是序號 jump 交易、不依賴那一列還在 buffer 裡。
//
// Mutates numMap in place; the pinned map is never evicted (a handful of rows at
// most). Returns which end(s) got dropped so the session can clear the matching
// _edgeUp/_edgeDown flag — demand must be able to re-fetch an evicted segment.
export function evictListBuffer(numMap, pivotNum, cap) {
  const r = { evictedUp: false, evictedDown: false };
  if (!numMap || numMap.size <= cap) return r;
  const nums = Array.from(numMap.keys()).sort((a, b) => a - b);
  const sel = pivotNum == null ? Infinity : pivotNum;
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
    // 不是列表形列 ⇒ 一律可見，連問都不問（與 computeAnnotations 的同一道守門
    // 逐字對稱，不變量 10）。對累積進 listLines 的資料這是 no-op —— 那裡只收
    // entry 區的列表列 —— 但兩份實作必須長得一樣，否則下次有人只改一邊就是
    // 「導覽走的列」與「畫出來的列」對不上。
    if (!isListShapedRow(text)) {
      out.push(i);
      continue;
    }
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
