// 閱讀紀錄（reading record）：「使用者眼睛看到的位置」的唯一擁有者。
// 設計、決策表與盤點見 docs/reading-record.md —— 改這支之前先讀它。
//
// 為什麼需要它：好讀模式（文章好讀／列表好讀／看板列表平滑捲動）下，使用者看到的
// 畫面常常不是 PTT 的真實畫面。任何會暫時改掉畫面的功能（長推文、重新整理、AID
// 跳轉、設已讀、`s` 看板搜尋…）結束後都要把人送回原處 —— 以前每個功能各自採樣、
// 各自保存、各自還原，同一條「採樣要在切原生之前」的規則寫了四遍，列表側更是只有
// 一個功能做對。這裡把三件事收成一處：
//
//   1. 模型：三種畫面各一型紀錄（文章／文章列表／看板列表），**只存身分與列錨**，
//      不存像素（文章重讀後預覽高度會變；列表補頁、刪頁之後像素對不上）。
//   2. 凍結：畫面擁有者切進原生鏡像那一刻交一份快照進來（鏡像期間畫面不可捲，
//      量到的值沒有意義）。鏡像期間任何人問「現在在哪」都拿到那份快照 ⇒ 呼叫端
//      不必再管採樣順序。快照只在擁有者回報「仍在鏡像中」時有效，離開就自動作廢。
//   3. 交易：功能開始時 begin(feature) 領一張書籤，結束時 end(bookmark, outcome)
//      交回；要不要還原、還原到哪由下面的決策表決定，不由功能端自己判斷。
//      實際捲動仍交給各畫面擁有者既有的還原器（easy_reading 的一次性還原、
//      list_session／board_list_session 的待還原錨），它們負責「認不出就不還原」。
//
// 這支不碰 DOM、不送鍵；量測一律借用畫面擁有者（term_view.currentLineIndex 量節點，
// 手機換行版面也正確；列表的 readingPosition 用編號＋列內比例）。

import { parseStatusRow } from './string_util';

// ---------------------------------------------------------------------------
// 決策表（純資料，tests/unit/reading_record.test.js 逐格守護）
// ---------------------------------------------------------------------------
//
// 每格：{ article, list, boardList }
//   article   'origin' 回到書籤的列（列索引＋比例） | 'bottom' 文末 |
//             'auto'   書籤記著「在文末」就文末，否則原列 | 'none' 不動
//   list      'origin' 回到書籤的列表視野 | 'none'
//   boardList 'origin' | 'none'
// 不在表上的功能／結果 ＝ 全部 'none'（未知就不動，寧可停在 PTT 給的位置）。
const NONE = { article: 'none', list: 'none', boardList: 'none' };

function cell(article, list, boardList) {
  return {
    article: article || 'none',
    list: list || 'none',
    boardList: boardList || 'none'
  };
}

export const RESTORE_TABLE = {
  // 長推文：送完落在文末看自己剛推的；探路／被擋／取消／失敗回到推之前的位置。
  'long-push': {
    done: cell('bottom'),
    cancel: cell('origin'),
    fail: cell('origin')
  },
  // AID 跳文：目的地就是結果（不還原）；返回的列由返回堆疊的錨帶（end 的 opts）。
  'aid-jump': { done: NONE, cancel: NONE, fail: NONE },
  'aid-back': { done: cell('origin'), cancel: NONE, fail: NONE },
  // 無看板 AID 指定看板（aid_navigation.preparePicked）：送出＝跳文（不還原）；在 `s`
  // 補全彈窗取消 ＝ 原生取消落在文章列表 ⇒ 重開原文回原列（reopenPicked 落地時才下）。
  'aid-board-pick': { done: NONE, cancel: cell('origin'), fail: NONE },
  // 文章重新整理：原本在文末就黏回文末（新推文在那裡），否則同一列。
  'article-refresh': { done: cell('auto'), cancel: NONE, fail: NONE },
  // 複製本篇連結（Q 路徑會被踢回列表再重開）：一律回原列。
  'deep-link-copy': {
    done: cell('origin'),
    cancel: cell('origin'),
    fail: cell('origin')
  },
  // 外部帶進來的連結：目的地就是結果；出發點進返回堆疊，返回時走 'aid-back'。
  'deep-link-jump': { done: NONE, cancel: NONE, fail: NONE },
  // 列表重新整理（F5／工具列／下拉）：游標原地（getkeep），視野也回原處。
  'list-refresh': {
    done: cell(null, 'origin'),
    cancel: cell(null, 'origin'),
    fail: cell(null, 'origin')
  },
  'board-list-refresh': {
    done: cell(null, null, 'origin'),
    cancel: cell(null, null, 'origin'),
    fail: cell(null, null, 'origin')
  },
  // 設已讀類：編號空間不變，只有已讀標記變了 ⇒ 回原處。看板列表的「<板> 設為已讀」
  // 不在表上：接管時是原地交易（_resumeInPlace，視野本來就不動），沒接管就是原生。
  'mark-read-before': {
    done: cell(null, 'origin'),
    cancel: cell(null, 'origin'),
    fail: cell(null, 'origin')
  },
  'mark-all-read': {
    done: cell(null, 'origin'),
    cancel: cell(null, 'origin'),
    fail: cell(null, 'origin')
  },
  // `s` 看板搜尋：送出＝換板（不還原）；取消／開不出來＝回原處。
  'board-search': {
    done: NONE,
    cancel: cell(null, 'origin', 'origin'),
    fail: cell(null, 'origin', 'origin')
  },
  // 文章搜尋：送出＝搜尋結果（另一個編號空間，不還原）；取消本來就零送出。
  'article-search': { done: NONE, cancel: NONE, fail: NONE },
  // 跳到第一篇未讀：目的就是移動；找不到時停在翻到的那頁（使用者拍板）。
  'unread-jump': { done: NONE, cancel: NONE, fail: NONE },
  // 斷線重連後回到原處（reconnect_resume.js）：落在文章 ⇒ 斷線前在文末就黏回文末，
  // 否則原列；落在列表 ⇒ 原處。找不到原文（被刪）停在該板列表 ⇒ 列表回原處。
  // 取消（使用者登入後先動了、deep link 搶先）＝不動。
  'reconnect-resume': {
    done: cell('auto', 'origin'),
    cancel: NONE,
    fail: cell(null, 'origin')
  }
};

export const OUTCOMES = ['done', 'cancel', 'fail'];

export function restorePlan(feature, outcome) {
  const row = RESTORE_TABLE[feature];
  if (!row) return NONE;
  return row[outcome] || NONE;
}

// 文章 'auto' 的展開：書籤記著在文末 ⇒ 'bottom'，否則 'origin'。
export function resolveArticleMode(mode, article) {
  if (mode !== 'auto') return mode;
  return article && article.atBottom ? 'bottom' : 'origin';
}

// ---------------------------------------------------------------------------
// 列表紀錄的比對（純函式）
// ---------------------------------------------------------------------------
//
// 列表紀錄：{ kind:'list', board, mode, topNum, topPinnedKey, scrollFrac, cursorNum }
//   board     看板身分鍵（screen_titles.parseBoardKey；有《板名》就是板名）
//   mode      'plain' 完整列表 | 'select' 搜尋結果／文摘（獨立編號空間）| null 不明
//   cursorNum 書籤當下的選取（列表好讀的選取＝我們同步給 server 的游標）
//
// 還原的前提是「落地的是同一份清單」：同板、同編號空間，而且游標停在書籤記的那一篇
// （原生交易沒有移動游標的證據）。matchBoardOnly：返回堆疊的看板錨（`s<板>` 回列表）
// server 游標是 getkeep 的 crs_ln，不一定等於列表好讀的本地選取 ⇒ 只比板與編號空間。
export function listRecordMatches(record, landing) {
  if (!record || !landing) return false;
  if (record.board == null || landing.board == null) return false;
  if (record.board !== landing.board) return false;
  if (record.mode && landing.mode && record.mode !== landing.mode) return false;
  if (record.matchBoardOnly) return true;
  return landing.cursorNum != null && landing.cursorNum === record.cursorNum;
}

// 看板列表紀錄：{ kind:'boardList', variant, topNum, scrollFrac, cursorNum }
export function boardListRecordMatches(record, landing) {
  if (!record || !landing) return false;
  if (record.variant == null || record.variant !== landing.variant) return false;
  return landing.cursorNum != null && landing.cursorNum === record.cursorNum;
}

function copy(o) {
  return o ? Object.assign({}, o) : null;
}

// ---------------------------------------------------------------------------
// ReadingRecord
// ---------------------------------------------------------------------------

export function ReadingRecord(core) {
  this._core = core;
  // 各畫面擁有者切進原生鏡像時交進來的快照：{ article, list, boardList }。
  this._frozen = { article: null, list: null, boardList: null };
  // 「身後的列表」：使用者從文章列表進了文章，文章裡的操作（AID 跳轉、長推文、
  // 重新整理）會把列表 session 停進外部導覽、清掉看板身分 ⇒ 退回列表時會 rebuild。
  // 這份紀錄留到下一次列表 rebuild 才交給 list_session 驗證後還原（不符就丟）。
  this._behindList = null;
}

ReadingRecord.prototype = {
  _diag: function(name, info) {
    const rec = this._core && this._core.debugRecorder;
    if (rec && rec.log) rec.log('readingRecord.' + name, info);
  },

  // ---- 量測（借用畫面擁有者） ------------------------------------------------

  // 文章紀錄：{ kind:'article', board, lineIndex, atBottom, easy }。不在文章裡回 null。
  // ctx { view, buf }：發起交易的模組手上的 view／termBuf（unit 的假 core 沒掛這兩個）。
  _liveArticle: function(ctx) {
    const core = this._core || {};
    const c = ctx || {};
    const buf = c.buf || core.buf;
    const view = c.view || core.view;
    if (!buf || buf.pageState !== 3 || !view) return null;
    const er = core.easyReading;
    const easy = !!(er && er._enabled && !er._functionMode);
    let atBottom = false;
    if (easy) {
      // 好讀：已讀到文末（反向讀取補完）且捲到底 2 列內（與 aid_navigation.refresh 的
      // 舊判準相同）。
      const disp = view.mainDisplay;
      const slack = (view.chh || 0) * 2;
      atBottom =
        !!er.easyReadingReachedPageEnd &&
        !!disp &&
        disp.scrollHeight - disp.scrollTop - disp.clientHeight <= slack;
    } else if (buf.getRowText) {
      // 原生 pmore：狀態列 100%。
      const status = parseStatusRow(buf.getRowText(buf.rows - 1, 0, buf.cols));
      atBottom = !!status && status.pagePercent === 100;
    }
    return {
      kind: 'article',
      board: view._articleBoard || null,
      lineIndex: view.currentLineIndex ? view.currentLineIndex() : null,
      atBottom: atBottom,
      easy: easy
    };
  },

  _liveList: function() {
    const ls = this._core && this._core.listSession;
    return ls && typeof ls.readingPosition === 'function' ? ls.readingPosition() : null;
  },

  _liveBoardList: function() {
    const bs = this._core && this._core.boardListSession;
    return bs && typeof bs.readingPosition === 'function' ? bs.readingPosition() : null;
  },

  // 擁有者「仍在原生鏡像中」嗎？快照只在這段期間有效。
  _mirroring: function(surface) {
    const core = this._core || {};
    if (surface === 'article') {
      const er = core.easyReading;
      return !!(er && er._functionMode);
    }
    const owner = surface === 'list' ? core.listSession : core.boardListSession;
    return !!(owner && owner.state === 'functionMode');
  },

  _surface: function(surface, ctx) {
    const frozen = this._frozen[surface];
    if (frozen) {
      if (this._mirroring(surface)) return copy(frozen);
      this._frozen[surface] = null; // 擁有者已離開鏡像：快照作廢
    }
    if (surface === 'article') return this._liveArticle(ctx);
    if (surface === 'list') return this._liveList();
    return this._liveBoardList();
  },

  // ---- 對外 API ---------------------------------------------------------------

  // 使用者現在在哪（鏡像期間＝切進鏡像那一刻）。
  current: function(ctx) {
    return {
      article: this._surface('article', ctx),
      list: this._surface('list'),
      boardList: this._surface('boardList')
    };
  },

  // 畫面擁有者切進原生鏡像的那一刻呼叫（只在「真的切進去」時叫，同一趟鏡像不重叫）。
  // snapshot 省略＝由這裡現場量。
  freeze: function(surface, snapshot, ctx) {
    let snap = snapshot;
    if (snap === undefined) {
      if (surface === 'article') snap = this._liveArticle(ctx);
      else if (surface === 'list') snap = this._liveList();
      else snap = this._liveBoardList();
    }
    this._frozen[surface] = snap ? copy(snap) : null;
  },

  // 開始一筆會改變畫面的交易。回傳的書籤是當下紀錄的副本。
  // own：畫面擁有者自己發起的交易可以直接交出自己的量測與還原對象
  //   （{ list, listOwner } | { boardList, boardListOwner }），不必經過 core 上的掛載點；
  //   { view, buf } ＝量文章用的 term_view／termBuf。
  begin: function(feature, own) {
    const o = own || {};
    const cur = this.current({ view: o.view, buf: o.buf });
    const bm = {
      feature: feature,
      at: Date.now(),
      article: cur.article,
      list: o.list !== undefined ? copy(o.list) : cur.list,
      boardList: o.boardList !== undefined ? copy(o.boardList) : cur.boardList,
      listOwner: o.listOwner || null,
      boardListOwner: o.boardListOwner || null
    };
    this._diag('begin', {
      feature: feature,
      lineIndex: bm.article ? bm.article.lineIndex : null,
      listTop: bm.list ? bm.list.topNum : null,
      boardListTop: bm.boardList ? bm.boardList.topNum : null
    });
    return bm;
  },

  // 交易結束。outcome ∈ 'done' | 'cancel' | 'fail'。
  // opts.article：覆寫要還原的文章紀錄（AID 返回用返回堆疊的錨）。
  // opts.only：只處理某一種畫面（'article' | 'list' | 'boardList'）——文章的還原
  //   要在「文章真的重開了」那一刻才下，列表的還原要在交易收尾時下，兩者在同一個
  //   功能裡可能是不同時間點。
  end: function(bm, outcome, opts) {
    if (!bm) return;
    const o = opts || {};
    const plan = restorePlan(bm.feature, outcome);
    this._diag('end', {
      feature: bm.feature,
      outcome: outcome,
      article: plan.article,
      list: plan.list,
      boardList: plan.boardList
    });
    if (!o.only || o.only === 'article') {
      const art = o.article !== undefined ? o.article : bm.article;
      const mode = resolveArticleMode(plan.article, art);
      if (mode !== 'none') this.restoreArticle(art, mode);
    }
    if ((!o.only || o.only === 'list') && plan.list === 'origin' && bm.list)
      this.restoreList(bm.list, bm.listOwner);
    if ((!o.only || o.only === 'boardList') && plan.boardList === 'origin' && bm.boardList)
      this.restoreBoardList(bm.boardList, bm.boardListOwner);
  },

  // 文章還原。mode 'origin'｜'bottom'。
  //   'bottom'：好讀 ⇒ easy_reading 的「落在文末」；原生 pmore ⇒ 原生 End（mf_goBottom）。
  //   'origin'：交給 easy_reading 的一次性還原（量節點、等累積到位才套用；好讀還沒
  //             接手時請求先掛著）。書籤是在**原生** pmore 量的（easy === false）⇒
  //             列索引沒有意義、pmore 也沒有跳行入口 ⇒ 不還原。lineIndex 0／null
  //             ＝本來就在頂端。
  restoreArticle: function(article, mode) {
    const core = this._core;
    const er = core && core.easyReading;
    const easyNow = !!(er && (er._enabled || er._pendingEnableOnArticle));
    if (mode === 'bottom') {
      // 書籤明說是在原生 pmore 量的、而好讀此刻也沒接手 ⇒ 原生 End。其餘一律交給
      // 好讀的「落在文末」請求（好讀稍後接手時才生效；從沒接手就隨離開文章作廢）。
      if (!easyNow && article && article.easy === false) {
        if (!core || !core.sendMachineBytes) return false;
        core.sendMachineBytes('\x1b[4~');
        return true;
      }
      if (!er || !er.requestScrollToBottom) return false;
      er.requestScrollToBottom();
      return true;
    }
    if (!article || !article.lineIndex || article.easy === false) return false;
    if (!er || !er.requestScrollRestore) return false;
    er.requestScrollRestore(article.lineIndex);
    return true;
  },

  restoreList: function(record, owner) {
    const ls = owner || (this._core && this._core.listSession);
    if (!record || !ls || typeof ls.requestViewportRestore !== 'function') return false;
    ls.requestViewportRestore(record);
    return true;
  },

  restoreBoardList: function(record, owner) {
    const bs = owner || (this._core && this._core.boardListSession);
    if (!record || !bs || typeof bs.requestViewportRestore !== 'function') return false;
    bs.requestViewportRestore(record);
    return true;
  },

  // ---- 身後的列表 -------------------------------------------------------------

  noteBehindList: function(record) {
    this._behindList = record ? copy(record) : null;
    if (record) this._diag('behindList', { action: 'noted', topNum: record.topNum });
  },

  peekBehindList: function() {
    return copy(this._behindList);
  },

  // 列表 rebuild 時取走（一次性：不論驗證過不過，下一次 rebuild 都不再用它）。
  takeBehindList: function() {
    const r = this._behindList;
    this._behindList = null;
    return r;
  },

  // 外部導覽（AID 跳轉／長推文／重新整理）收尾：把列表 session 的外部 hold 放開，
  // 交回靜置探針（停在列表時才有作用；落在文章時 handoff 早就解除了）。
  releaseExternal: function() {
    const core = this._core || {};
    if (core.listSession && core.listSession.endExternalNavigation)
      core.listSession.endExternalNavigation();
    if (core.boardListSession && core.boardListSession.endExternalNavigation)
      core.boardListSession.endExternalNavigation();
  }
};

// 取得（必要時建立）core 上的閱讀紀錄。unit 的假 core 沒有掛它也能用 ——
// 功能端一律經過這裡，不直接讀 core.readingRecord。沒有 core（單獨建構的模組）時
// 給一個空的：量不到、也還原不了任何東西，呼叫端不必另外判 null。
export function recordFor(core) {
  if (!core) return new ReadingRecord({});
  if (!core.readingRecord) core.readingRecord = new ReadingRecord(core);
  return core.readingRecord;
}

export default ReadingRecord;
