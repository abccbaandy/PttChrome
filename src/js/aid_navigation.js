// Click-to-navigate for PTT article-code (AID) links in easy reading.
//
// Clicking a "#1gIeu-3A" link (detected by aid_parse.js, rendered by
// Row/LinkSegmentBuilder) drives the native key sequence a user would type:
//   s <board> ⏎   (board jump — works from INSIDE the article too, so no
//                  leave-article step is needed; always taken, even for the
//                  same board: one code path, and the s-search is forgiving)
//   # <aid> ⏎     (AID search — cursor lands on the target row)
//   ⏎             (open the article)
//
// …but ONLY when the pager is in currstat == READING. mbbsd/more.c:102-112 gates
// both s (RET_SELECTBRD) and # (RET_SELECTAID) on it, so inside a 站內信
// (currstat == RMAIL) they are DONOTHING and "s<board>\r" gets eaten KEY BY KEY
// as pager hotkeys instead (Y=回信給所有人, X/%=推文, T=改標題, E=編輯…) — a
// misfire, not just a no-op (回報實錄 ptt-debug-20260813: 畫面直接跳到另一封信).
// So the sequence is preceded by an ESCAPE preamble whenever the footer does not
// prove READING (parsePagerFooterContext, single-directional — see string_util):
//   ← × n         (back out one level per press until 【主功能表】)
// 主功能表 is the only safe place to resume from: mbbsd/menu.c:498 routes s in
// MMENU/TMENU/XMENU to ReadSelect() → do_select() → a real board entry, whereas
// mbbsd/board.c:1902's s (看板列表/我的最愛/分類看板) is a SEARCH that only moves
// the cursor. The price is that ReadSelect() calls Read(), which shows the board's
// 進板畫面 + pressanykey on this session's first entry (mbbsd/bbs.c:4482-4492) —
// the in-article path never does (more.c:177 calls Select() alone) — so the
// via-menu board jump also dismisses those. See _enqueueBoardJump.
// Each step is a serialized CommandQueue command completed by CONTENT (an
// expect over the settle facts), exactly like list_session's transactions.
// While the sequence runs, user input is blocked (`active` is checked at the
// term_view/pttchrome input entry points) and the REAL native screen is
// mirrored live: the article easy reading enters functionMode, and an engaged
// list session is parked in its own functionMode via beginExternalNavigation()
// so its reducer stays out of the way (clean-list settles stay; the final
// article settle takes the normal handoff).
//
// Failures are visible, never silently retried (v5 convention): any step's
// onFail unlocks input, flashes a banner and leaves the native screen as-is —
// the easy-reading/list state machines self-converge from whatever shows.

import { parseStatusRow, parsePagerFooterContext } from './string_util';

// AID search rejected: pttbbs answers with a press-any-key message instead of
// a clean list. Belt-and-braces text guard for the (unlikely) case the message
// still classifies as clean-list.
const AID_NOT_FOUND_RE = /找不到|不正確/;

// ← as the terminal sees it. Backs out exactly one level everywhere the escape
// preamble can run (pmore, i_read list, domenu) and is a no-side-effect dismiss
// on a pressanykey screen.
const KEY_LEFT = '\x1b[D';

// 主功能表 title (term_buf.setPageState / classifyListScreen use the same literal).
const MAIN_MENU_TITLE = '【主功能表】';

// The board's 進板畫面 tail: mbbsd/bbs.c#Read → pressanykey(). Same literals
// term_buf.setPageState matches for pageState 5.
const PRESS_ANY_KEY_RE = /請按任意鍵繼續|請按 空白鍵 繼續/;

// Escape presses allowed before giving up. 站內信 needs 3 (信件內容 → 信件列表 →
// 郵件選單 → 主功能表); the slack covers deeper nests. A cap is mandatory: with an
// over-quota mailbox mbbsd/menu.c:493 turns ← in the MAIL menu into 'R' (forced
// back into reading mail), so the screen keeps changing but never reaches MMENU.
const MAX_ESCAPE_STEPS = 6;

// 進板畫面 pager + its pressanykey = 2 keys; the slack absorbs a multi-page one.
const MAX_ENTER_DISMISS = 3;

function screenSignature(rowTexts) {
  return (rowTexts || []).join('\n');
}

export function AidNavigation(core, view, termBuf, queue) {
  this._core = core;
  this._view = view;
  this._termBuf = termBuf;
  this._queue = queue;
  // True while the key sequence is in flight — input entry points check this
  // (term_view.onKeyDown / App.onMouse_click / wheel) and swallow everything.
  this.active = false;
}

AidNavigation.prototype = {
  _hint: function(msg, ms) {
    if (this._view.flashListHint) this._view.flashListHint(msg, ms || 4000);
  },

  _fail: function(msg) {
    this.active = false;
    this._hint('AID 跳文失敗：' + msg + '（已停在原生畫面）');
  },

  // Whole native screen as one string — the escape steps decide "did ← actually
  // move us a level?" by content, never by timing (v5). \f (fullRepaint) makes
  // every judged frame complete, so an unchanged signature really means unchanged.
  _screenSignature: function() {
    const buf = this._termBuf;
    const rowTexts = [];
    for (let r = 0; r < buf.rows; ++r) rowTexts.push(buf.getRowText(r, 0, buf.cols));
    return screenSignature(rowTexts);
  },

  // 'reading' → s/# are live in this pager; anything else → escape preamble.
  // Deliberately single-directional (see string_util.parsePagerFooterContext):
  // 'unknown' (footer squeezed out) degrades to the SLOW path, never the fast one.
  _pagerContext: function() {
    const buf = this._termBuf;
    return parsePagerFooterContext(buf.getRowText(buf.rows - 1, 0, buf.cols));
  },

  // board may be null when the #AID had no suffix AND the article header was
  // never parsed — nothing to navigate to, tell the user instead of guessing.
  start: function(aid, board) {
    if (this.active) return;
    if (!board) {
      this._hint('AID 跳文：無法判斷目標看板');
      return;
    }
    if (!this._termBuf.startedEasyReading) {
      // AID links only render in easy reading; a click that somehow arrives
      // outside an open post (stale DOM during a transition) is ignored.
      return;
    }
    this.active = true;
    this._hint('跳至 #' + aid + ' (' + board + ')…', 15000);

    // Show the REAL native screen while we drive it. The article easy reading's
    // functionMode is the existing live-mirror mechanism; when we leave the
    // post its settle logic runs leaveCurrentPost, and the final 2→3 settle
    // edge re-enables easy reading on the TARGET article — zero new coupling.
    this._core.easyReading._enterFunctionMode();
    // Park an engaged list session in its functionMode (native mirror,
    // nativeHold, queue flushed) so the shared queue is empty and its reducer
    // absorbs our intermediate clean-list settles. Must run BEFORE we enqueue.
    if (this._core.listSession) this._core.listSession.beginExternalNavigation();

    const boardLower = String(board).toLowerCase();
    if (this._pagerContext() === 'reading') {
      this._enqueueBoardJump(aid, board, boardLower, false);
    } else {
      this._enqueueEscape(aid, board, boardLower, 0, this._screenSignature());
    }
  },

  // Step 0 (only when the pager is not currstat == READING): ← until 【主功能表】.
  // One press per command so every level is confirmed by CONTENT before the next
  // key goes out — a blind burst would be typeahead-swallowed (protocol §1/§2)
  // and could overshoot into 主功能表's ← (which highlights G)oodbye).
  _enqueueEscape: function(aid, board, boardLower, step, prevSig) {
    const self = this;
    this._queue.enqueue({
      keys: KEY_LEFT,
      kind: 'aid-escape',
      fullRepaint: true,
      // Same reason as the other steps: flush() is silent by contract, and a
      // dropped command would leave `active` stuck true (every keystroke
      // swallowed at the term_view entry point, with no way back).
      onFlushed: function() {
        self._fail('畫面已變更');
      },
      timeoutMs: 4000,
      expect: function(snapshot, facts) {
        if ((facts.rowTexts[0] || '').indexOf(MAIN_MENU_TITLE) === 0)
          return { menu: true };
        const sig = screenSignature(facts.rowTexts);
        // Unchanged screen = ← did nothing (or was swallowed): NOT a level up.
        // Stay in flight → probe → miss → visible fail, never a silent retry.
        return sig === prevSig ? false : { sig: sig };
      },
      onDone: function(result) {
        if (result.menu) {
          self._enqueueBoardJump(aid, board, boardLower, true);
          return;
        }
        if (step + 1 >= MAX_ESCAPE_STEPS) {
          self._fail('退不回主功能表（層數過多）');
          return;
        }
        self._enqueueEscape(aid, board, boardLower, step + 1, result.sig);
      },
      onFail: function(reason) {
        self._fail('退不回主功能表（' + reason + '）');
      }
    });
  },

  // Dismiss the 進板畫面 that ReadSelect() → Read() shows on this session's first
  // entry to a board (mbbsd/bbs.c:4482-4492: more(notes) then pressanykey()).
  // ← leaves the pmore pager AND satisfies pressanykey, so one key handles both.
  _enqueueEnterBoardDismiss: function(aid, board, boardLower, round) {
    const self = this;
    this._queue.enqueue({
      keys: KEY_LEFT,
      kind: 'aid-board-enter',
      fullRepaint: true,
      onFlushed: function() {
        self._fail('畫面已變更');
      },
      timeoutMs: 4000,
      expect: this._boardLandingExpect(boardLower),
      onDone: function(result) {
        self._onBoardLanding(result, aid, board, boardLower, round);
      },
      onFail: function(reason) {
        self._fail('進入看板 ' + board + ' 失敗（' + reason + '）');
      }
    });
  },

  // Shared by the via-menu board jump and its dismiss rounds: the landing is the
  // target board's clean list; a 進板畫面 (pmore → classifies as 'article') or a
  // pressanykey tail is a known intermediate, everything else keeps waiting.
  _boardLandingExpect: function(boardLower) {
    return function(snapshot, facts) {
      if (
        facts.kind === 'clean-list' &&
        facts.boardName != null &&
        facts.boardName.toLowerCase() === boardLower
      )
        return { landed: true };
      const lastRow = facts.rowTexts[facts.rows - 1] || '';
      if (PRESS_ANY_KEY_RE.test(lastRow)) return { dismiss: true };
      // We are between 主功能表 and the list here, so an article screen can only
      // be the 進板畫面 pager — the target post is still two commands away.
      if (facts.kind === 'article') return { dismiss: true };
      return false;
    };
  },

  _onBoardLanding: function(result, aid, board, boardLower, round) {
    if (result.landed) {
      this._enqueueAidSearch(aid);
      return;
    }
    if (round + 1 >= MAX_ENTER_DISMISS) {
      this._fail('進板畫面未關閉（' + board + '）');
      return;
    }
    this._enqueueEnterBoardDismiss(aid, board, boardLower, round + 1);
  },

  // Step 1: s <board> ⏎ — the board-search jump. Lands on the target board's
  // clean list; a candidate menu / typo never satisfies the expect and ends as a
  // visible miss on the probed full frame.
  //   viaMenu=false: sent from INSIDE the article (pmore handles s directly,
  //     more.c:177 → Select() only). No 進板畫面 is possible → the expect stays
  //     exactly what it always was.
  //   viaMenu=true:  sent at 主功能表 after the escape preamble (menu.c:498 →
  //     ReadSelect() → do_select() + Read()), so the landing may be preceded by
  //     the board's 進板畫面 + pressanykey — dismissed by _onBoardLanding.
  _enqueueBoardJump: function(aid, board, boardLower, viaMenu) {
    const self = this;
    this._queue.enqueue({
      keys: 's' + board + '\r',
      kind: 'aid-board-jump',
      fullRepaint: true,
      // The queue is SHARED with list_session, whose cleanup / native-mirror
      // switches / disconnect all call flush() — which is silent by contract
      // (no onFail). Without this hook the dropped step would leave `active`
      // stuck true forever and every keystroke swallowed at the term_view
      // entry point, with no way back.
      onFlushed: function() {
        self._fail('畫面已變更');
      },
      timeoutMs: 6000,
      expect: viaMenu
        ? this._boardLandingExpect(boardLower)
        : function(snapshot, facts) {
            return (
              facts.kind === 'clean-list' &&
              facts.boardName != null &&
              facts.boardName.toLowerCase() === boardLower
            );
          },
      onDone: function(result) {
        if (viaMenu) self._onBoardLanding(result, aid, board, boardLower, 0);
        else self._enqueueAidSearch(aid);
      },
      onFail: function(reason) {
        self._fail('切換看板 ' + board + ' 失敗（' + reason + '）');
      }
    });
  },

  // Step 2: # <aid> ⏎ — the in-board AID search. Success = the cursor parks on
  // a parsable article row in the entry area with the board title still up.
  // NOT gated on kind === 'clean-list': the AID-jump landing leaves the bottom
  // footer row BLANK (the # prompt cleared it and the jump repaint doesn't
  // redraw it — live-verified 2026-07-10, even after a \f probe), so the
  // classifier reads 'transient' on a perfectly good landing. "Not found"
  // parks the cursor on the bottom message row instead → cursorRowNum null →
  // probe → miss.
  _enqueueAidSearch: function(aid) {
    const self = this;
    this._queue.enqueue({
      keys: '#' + aid + '\r',
      kind: 'aid-search',
      fullRepaint: true,
      // The queue is SHARED with list_session, whose cleanup / native-mirror
      // switches / disconnect all call flush() — which is silent by contract
      // (no onFail). Without this hook the dropped step would leave `active`
      // stuck true forever and every keystroke swallowed at the term_view
      // entry point, with no way back.
      onFlushed: function() {
        self._fail('畫面已變更');
      },
      timeoutMs: 4000,
      expect: function(snapshot, facts) {
        if (facts.boardName == null) return false;
        if (facts.cursorRowNum == null) return false;
        if (facts.curY < 3 || facts.curY > facts.rows - 2) return false;
        const lastRow = facts.rowTexts[facts.rows - 1] || '';
        if (AID_NOT_FOUND_RE.test(lastRow)) return false;
        return true;
      },
      onDone: function() {
        self._enqueueOpen(aid);
      },
      onFail: function(reason) {
        self._fail(
          reason === 'miss' ? '找不到文章 #' + aid : 'AID 搜尋逾時'
        );
      }
    });
  },

  // Step 3: ⏎ opens the article under the cursor. The article settle also
  // drives the normal handoffs (list session → suspended; easy reading
  // re-enters on its settled edge), so finishing here is just an unlock.
  _enqueueOpen: function(aid) {
    const self = this;
    this._queue.enqueue({
      keys: '\r',
      kind: 'aid-open',
      fullRepaint: true,
      // The queue is SHARED with list_session, whose cleanup / native-mirror
      // switches / disconnect all call flush() — which is silent by contract
      // (no onFail). Without this hook the dropped step would leave `active`
      // stuck true forever and every keystroke swallowed at the term_view
      // entry point, with no way back.
      onFlushed: function() {
        self._fail('畫面已變更');
      },
      timeoutMs: 4000,
      expect: function(snapshot, facts) {
        if (facts.kind === 'article') return true;
        // Some posts open straight onto a short page whose bottom row is the
        // reading status row even if the classifier hesitates — accept that too.
        const lastRow = facts.rowTexts[facts.rows - 1] || '';
        return !!parseStatusRow(lastRow);
      },
      onDone: function() {
        self.active = false;
        // Replace the long-lived "跳至…" progress banner (15s) with a short
        // confirmation so it fades right away instead of lingering into the
        // opened article.
        self._hint('已跳至 #' + aid, 1200);
      },
      onFail: function(reason) {
        self._fail('開啟文章失敗（' + reason + '）');
      }
    });
  }
};

export default AidNavigation;
