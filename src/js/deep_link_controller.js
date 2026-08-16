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
import { buildDeepLink } from './deep_link';
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
  request: function(target) {
    if (!target || !target.board || !target.aid) return null;
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
  // 唯一能知道自己在看哪一篇的方法就是按 Q（畫面上的 #AID 是內文引用的別篇，
  // 不是本篇）—— 跟跳轉存返回錨點是同一件事，所以共用 aidNavigation.queryPostAid。
  // 差別在收尾：跳轉會把關框併進下一個指令，這裡沒有下一個指令，得自己關。
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
    // 按 Q 會蓋出一個原生資訊框：對好讀模式來說跟「r 回應」「X 推文」是同一類
    // 事件，先進 functionMode 停掉它的累積／翻頁，畫面才不會在交易途中被動。
    const er = this._core.easyReading;
    if (er && er._enterFunctionMode) er._enterFunctionMode();
    // 讀 AID 是有代價的：mbbsd/bbs.c:2375-2377 對 Q 的回應是
    // `view_postinfo(...); return FULLUPDATE;` —— 那個 FULLUPDATE 會離開 pager
    // 把畫面換成文章列表。所以「複製完回到原處」必須自己走完（reopenAfterPostInfo），
    // 順便把閱讀位置一起帶回去。
    const lineIndex = this._currentLineIndex();
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
    if (!this._pending || !this._canNavigate()) return;
    const target = this._pending;
    this._pending = null;
    // 開不成（跳轉正在進行中之類）就放回去，下一次 settle 再試。
    if (!this._dispatch(target)) this._pending = target;
  }
};

export default DeepLinkController;
