// Deep link 的排程器：把「外面送進來的一個 { board, aid }」接到既有的 AID 跳轉
// 機器上，並處理「連結先到、人還沒登入」這個必然情況。
//
// URL 怎麼解析在 deep_link.js（純函式）；怎麼跳在 aid_navigation.js。這裡只管
// 兩件事：**什麼時候可以跳**，以及**該用哪個入口跳**。
//
// 待跳目標刻意只放在記憶體（不落 localStorage）：重整頁面就該忘掉它。一個
// 幾分鐘前貼的連結在使用者早就跑去別的地方以後才突然把畫面搶走，比讓他再點一
// 次連結糟糕得多。
//
// 「已登入」的判準是**畫面出現過主功能表**——全專案唯一可靠的登入訊號
// （auto_login.js 也是這樣認的）。掛在 termBuf 的 'screenSettled' 上而不是接進
// AutoLogin，是因為手動登入根本不經過 AutoLogin。

import { MAIN_MENU_TITLE } from './aid_navigation';
import { buildDeepLink, stripDeepLink } from './deep_link';
import { parseStatusRow } from './string_util';

export function DeepLinkController(core, view, termBuf) {
  this._core = core;
  this._view = view;
  this._termBuf = termBuf;
  // { board, aid } | null — 等登入的目標，只在記憶體。
  this._pending = null;
  // 這次連線看過主功能表了嗎（＝登入完成）。斷線時由 reset() 清掉。
  this._loggedIn = false;
  if (termBuf && termBuf.addEventListener)
    termBuf.addEventListener('screenSettled', this._onSettled.bind(this));
}

DeepLinkController.prototype = {
  // 外部入口（啟動時的 URL、hashchange、PWA launchQueue、其他分頁的交接）。
  // 回傳 'navigating'（已經開跳）或 'pending'（收下了，等登入）。
  //
  // opts.source === 'handoff'：**別的分頁**把連結交給我們（deep_link_entry 的
  // serveHandoff）。那代表使用者的眼睛在另一個分頁上，這個分頁得主動出聲；其餘
  // 來源（開站網址、hashchange、launchQueue）都是使用者本人在這個分頁的動作，
  // 通知他自己剛做的事只是噪音。
  //
  // 通知發在跳轉**之前**：接手的分頁若還沒登入，_hold() 會把目標收著等登入，落地
  // 可能永遠不會發生 —— 但使用者仍然得先知道有東西在等他。順序上 _hold 的
  // 「登入後將跳至…」橫幅會蓋在後面，讀起來剛好是「收到了 → 登入後會跳」。
  request: function(target, opts) {
    if (!target || !target.board || !target.aid) return null;
    if (opts && opts.source === 'handoff' && this._view &&
        this._view.notifyDeepLinkHandoff)
      this._view.notifyDeepLinkHandoff(target);
    if (this._canNavigate()) {
      this._pending = null;
      return this._dispatch(target) ? 'navigating' : this._hold(target);
    }
    return this._hold(target);
  },

  // 斷線：pttbbs 的 session（含每個板的游標）沒了，待跳目標也該一起丟——重連
  // 後要重新登入，那時的畫面狀態跟現在毫無關係。
  reset: function() {
    this._pending = null;
    this._loggedIn = false;
  },

  hasPending: function() {
    return !!this._pending;
  },

  _hold: function(target) {
    this._pending = target;
    this._hint('登入後將跳至 #' + target.aid + ' (' + target.board + ')…', 6000);
    return 'pending';
  },

  // 分享端：問出「目前這篇」的 AID，組成 deep link 丟進剪貼簿。
  //
  // 走 aidNavigation.resolvePostAid：文章本文的「※ 文章網址:」那行看得到時免費換算
  // （畫面完全不動、即時完成），看不到才退回按 Q。畫面上的 #AID 一律是內文引用的
  // 別篇，不是本篇，所以不能拿來用。
  //
  // 差別在收尾：按 Q 那條路會被 FULLUPDATE 抛回文章列表，這裡沒有下一個指令，得自己
  // 走 reopenAfterPostInfo 回原處；免費路徑則什麼都不必做。
  copyCurrentPostLink: function() {
    const nav = this._core.aidNavigation;
    if (!nav || nav.active || this._core.connectState !== 1) return false;
    const buf = this._termBuf;
    // Q 只在 pager 裡才是「文章資訊」。用 parseStatusRow 而不是
    // parsePagerFooterContext 判：長文的 footer 會被頁碼擠掉（part3 消失）
    // ⇒ context 變成 'unknown'，但那仍然是一篇正常的文章。
    if (!parseStatusRow(buf.getRowText(buf.rows - 1, 0, buf.cols))) {
      this._hint('請在文章內使用「複製本篇連結」', 3000);
      return false;
    }
    // 免費路徑（畫面上讀得到「※ 文章網址:」）什麼副作用都不該有：不進 functionMode、
    // 不記閱讀位置、不重開文章。所以先問一次，問到了就直接交件。
    const local = nav.findLocalPostAid && nav.findLocalPostAid();
    if (local) {
      this._deliverLink(local);
      return true;
    }
    // 以下是按 Q 那條路。讀 AID 是有代價的：mbbsd/bbs.c:2375-2377 對 Q 的回應是
    // `view_postinfo(...); return FULLUPDATE;` —— 那個 FULLUPDATE 會離開 pager
    // 把畫面換成文章列表。所以「複製完回到原處」必須自己走完（reopenAfterPostInfo），
    // 順便把閱讀位置一起帶回去。
    //
    // ORDER INVARIANT：閱讀位置必須在 _enterFunctionMode() **之前**擷取。那個函式
    // 結尾的 termBuf.notify() 是同步的（term_buf 的 changed 分支直接呼叫
    // view.update()），而 term_view.redraw 的 functionMode 分支第一件事就是
    // mainDisplay.scrollTop = 0（原生 24 列畫面本來就該從頂端顯示）。順序反過來
    // 讀到的永遠是 0 ⇒ _enqueueReopen 的 `if (lineIndex …)` 直接 falsy ⇒ 複製完
    // 雖然回到原篇卻停在第一行。aid_navigation.start() 有同一條不變量的註解。
    const lineIndex = this._currentLineIndex();
    // 按 Q 會蓋出一個原生資訊框：對好讀模式來說跟「r 回應」「X 推文」是同一類
    // 事件，先進 functionMode 停掉它的累積／翻頁，畫面才不會在交易途中被動。
    const er = this._core.easyReading;
    if (er && er._enterFunctionMode) er._enterFunctionMode();
    const self = this;
    nav.queryPostAid({
      kind: 'deeplink-copy-info',
      onFlushed: function() {
        self._hint('複製連結失敗：畫面已變更', 3000);
      },
      onDone: function(info) {
        // 回原處永遠要做，就算沒問到 AID —— 不然使用者被丟在列表上。
        nav.reopenAfterPostInfo(lineIndex);
        self._deliverLink(info);
      },
      onFail: function() {
        self._hint('複製連結失敗：讀不到文章代碼', 3000);
      }
    });
    return true;
  },

  // 閱讀位置記的是行索引不是像素：文章會被重新讀一次，pixel 值不會對得上。
  // 與 aid_navigation._currentLineIndex 同一套算法。
  _currentLineIndex: function() {
    const view = this._view;
    const disp = view && view.mainDisplay;
    const chh = view && view.chh;
    if (!disp || !chh) return null;
    return Math.round(disp.scrollTop / chh);
  },

  // board 可能是 null（站內信／精華區，pttbbs 在 currboard 空時印「不明」）：
  // 沒有看板的 AID 跳不回去（# 只搜 currboard），所以那種連結不該產生。
  _deliverLink: function(info) {
    const link =
      info && buildDeepLink(this._locationHref(), info.board, info.aid);
    if (!link) {
      this._hint('這個畫面無法產生連結（沒有文章代碼或看板）', 4000);
      return;
    }
    const self = this;
    const fallback = function() {
      // 剪貼簿被擋（非 secure context、或 user activation 已經過期）：至少把
      // 連結顯示出來，使用者還能自己選起來複製。
      self._hint('連結：' + link, 12000);
    };
    try {
      const clip = this._clipboard();
      if (!clip || !clip.writeText) return fallback();
      clip.writeText(link).then(function() {
        self._hint('已複製本篇連結', 2000);
      }, fallback);
    } catch (e) {
      fallback();
    }
  },

  // 網址列跟著「現在在讀哪一篇」走：貼給別人、加書籤、按 F5 都直接落在同一篇。
  //
  // 資料來源只有免費的那條（aidNavigation.findLocalPostAid，讀畫面上的
  // 「※ 文章網址:」那行）。**絕不為了填網址列去按 Q**：那會被 FULLUPDATE 抛回
  // 文章列表再重開，為了網址列讓畫面閃一下完全不划算。所以長文從第一頁開始讀時
  // 網址列會先停在站台根網址，滾到內文末尾那行進畫面後才補上——這是刻意的。
  //
  // 一律 replaceState：不留瀏覽歷史（否則「上一頁」會在文章之間亂跳，而且離開
  // 本站要按很多次），而且 replaceState 不觸發 hashchange ⇒ 不會被
  // deep_link_entry 的 hashchange 監聽者當成「有人貼了新連結」而自我重跳。
  _syncAddressBar: function() {
    const buf = this._termBuf;
    const href = this._locationHref();
    let next;
    // pageState 3 = READING。
    if (buf && buf.pageState === 3) {
      const nav = this._core.aidNavigation;
      const info = nav && nav.findLocalPostAid ? nav.findLocalPostAid() : null;
      // 還算不出本篇是哪一篇 ⇒ 什麼都不做，維持現況（不要清掉，使用者可能正是
      // 從一條 deep link 進來的，清掉反而更差）。
      if (!info) return;
      next = buildDeepLink(href, info.board, info.aid);
      if (!next) return;
    } else {
      // 回到列表／選單：網址列不該還停在剛剛那篇。
      next = stripDeepLink(href);
    }
    if (next === href) return;
    this._replaceState(next);
  },

  // 抽成方法讓 unit test 不必碰真的 window/history。
  // **state 必須原封不動帶過去**：我們改的是「當前 entry」，而使用者站著的那一
  // 層通常是 history_back_guard 的 sentinel（它把身分記在 history.state 裡）。
  // 傳 null 會把 sentinel 洗成一般 entry ⇒ guard 認不出「落回自己那一層」，
  // 使用者按「下一頁」回到它時會被當成一次往外退而多送一個左方向鍵。
  _replaceState: function(href) {
    try {
      if (window.history && window.history.replaceState)
        window.history.replaceState(window.history.state, '', href);
    } catch (e) {
      // file:// 下 replaceState 會 throw。網址列漂亮與否不值得中斷 settle 流程。
    }
  },

  // 抽成方法讓 unit test 不必碰真的 window/navigator。
  _locationHref: function() {
    return window.location.href;
  },

  _clipboard: function() {
    return typeof navigator === 'undefined' ? null : navigator.clipboard;
  },

  _hint: function(msg, ms) {
    if (this._view && this._view.flashListHint) this._view.flashListHint(msg, ms);
  },

  _canNavigate: function() {
    if (this._core.connectState !== 1) return false;
    if (!this._loggedIn) return false;
    const nav = this._core.aidNavigation;
    return !!nav && !nav.active;
  },

  _dispatch: function(target) {
    const nav = this._core.aidNavigation;
    // AutoLogin 用 500ms 輪詢自走，且它的「歡迎畫面 → 送空白鍵」分支只認畫面
    // 上有沒有「請按任意鍵」——而進板畫面正好長那樣。跳轉一旦開始，它每一次
    // 誤送都會打亂 CommandQueue 正在等的那一幀。它自己也是看到主功能表才收
    // 手，但我們可能比它的下一次輪詢更早離開主功能表，所以這裡明講。
    if (this._core.autoLogin && this._core.autoLogin.stop) this._core.autoLogin.stop();
    // 人正在看某篇文章（既有分頁收到連結）→ 走一般的 start()：它會按 Q 問出
    // 本篇 AID 當錨點，跳完就有「← 返回原文」可按。冷啟動沒有原文可回，用
    // startExternal（也不受 startedEasyReading 這道 gate 擋住）。
    if (this._termBuf.startedEasyReading) {
      nav.start(target.aid, target.board);
      return nav.active;
    }
    return nav.startExternal(target.aid, target.board);
  },

  _atMainMenu: function() {
    const buf = this._termBuf;
    if (!buf || !buf.getRowText) return false;
    return buf.getRowText(0, 0, buf.cols).indexOf(MAIN_MENU_TITLE) === 0;
  },

  _onSettled: function() {
    if (this._atMainMenu()) this._loggedIn = true;
    this._syncAddressBar();
    if (!this._pending || !this._canNavigate()) return;
    const target = this._pending;
    this._pending = null;
    // 開不成（跳轉正在進行中之類）就放回去，下一次 settle 再試。
    if (!this._dispatch(target)) this._pending = target;
  }
};

export default DeepLinkController;
