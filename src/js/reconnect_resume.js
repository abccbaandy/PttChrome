// 斷線重連後回到原處（docs/reading-record.md「斷線重連」）。
//
// 斷線那一刻向閱讀紀錄領一張書籤（使用者眼睛看到的位置），連同「本篇是哪一篇」
// （AID）一起收著；重新連線、登入回到主功能表後，用 AID 跳文同一套機器
// （aid_navigation.startResume）把人帶回去，落地後的列／視野由閱讀紀錄的決策表
// （'reconnect-resume'）交給各畫面擁有者的還原器。
//
// 為什麼要另外記 AID：PTT 的 session（每個板的 getkeep 游標）跟著斷線一起死了，
// 重連後只能重新導航；開文章只准用 AID（編號會因刪文漂移，開錯篇比停在列表糟，
// 見 aid_navigation.js 檔頭），所以書籤裡的列號之外還要知道是哪一篇。斷線當下已經
// 沒有連線可以按 Q 問，只能用免費路徑（網址列／跳文落地記下的那篇）；問不到就退回
// 那篇所在的列表。
//
// 待回目標只在記憶體（同 deep link 的 pending）：重整頁面就該忘掉。
//
// 收手條件（未知就不動，寧可停在 PTT 給的位置）：
//   - 自己登出（logout）不算斷線，不回去。
//   - 這條連線從沒登入過（還在登入畫面就斷了）不重記：保留上一份待回目標，連續幾次
//     重連失敗之後登入成功仍回得去。
//   - 登入後使用者先動了（離開主功能表）、或 deep link 也在等登入（使用者剛給的連結
//     比斷線前的位置新）⇒ 作廢。
//   - 使用者關掉了（pref reconnectResume，預設開）：斷線時不記，重連途中才關也不出發
//     ⇒ 停在 PTT 原生的登入落點（主功能表）。

import { isMainMenuRow } from './aid_navigation';
import { recordFor } from './reading_record';
import { boardNameFromKey } from './screen_titles';
import { readEffectivePrefs } from './pref_storage';

function enabled() {
  return !!readEffectivePrefs().reconnectResume;
}

// 書籤＋本篇身分 → 重連後要去哪。純函式。
//   { kind:'article', board, aid, bookmark } ：回到那篇文章（列由書籤還原）
//   { kind:'list', board, num, bookmark }    ：回到那個板的文章列表；num ＝斷線前
//                                              游標停的那篇（搜尋結果／文摘的編號是
//                                              另一個空間，不帶）
//   null                                       ：沒有可回的地方（主功能表、看板列表、
//                                              站內信、精華區…）
// post：{ board, aid } | null（aid_navigation.currentPostAid）。
// 文章沒有 AID 時退回那篇所在的列表，但只在列表的板就是文章的板時（身後的列表
// 可能是跳文之前的另一個板）。
export function resumePlanFrom(bm, post) {
  if (!bm) return null;
  const art = bm.article;
  if (art && post && post.aid && post.board)
    return { kind: 'article', board: post.board, aid: post.aid, bookmark: bm };
  const list = bm.list;
  const board = list ? boardNameFromKey(list.board) : null;
  if (!board) return null;
  if (art && !(art.board && String(art.board).toLowerCase() === board.toLowerCase())) return null;
  const plain = list.mode === 'plain';
  return {
    kind: 'list',
    board: board,
    num: plain && list.cursorNum > 0 ? list.cursorNum : null,
    // 搜尋結果／文摘：回到的是完整列表（另一個編號空間），不還原視野。
    bookmark: plain ? bm : Object.assign({}, bm, { list: null })
  };
}

export function ReconnectResume(core, view, termBuf) {
  this._core = core;
  this._view = view;
  this._termBuf = termBuf;
  // resumePlanFrom 的輸出 | null。
  this._pending = null;
  // 這條連線看過主功能表了嗎（＝登入完成）。capture() 時清掉。
  this._loggedIn = false;
  if (termBuf && termBuf.addEventListener)
    termBuf.addEventListener('screenSettled', this._onSettled.bind(this));
}

ReconnectResume.prototype = {
  _diag: function(name, info) {
    const rec = this._core && this._core.debugRecorder;
    if (rec && rec.log) rec.log('reconnectResume.' + name, info);
  },

  // App.onClose：**要在任何畫面擁有者被 disable／reset 之前**呼叫（列表 session 的
  // disable 會丟掉看板身分，aidNavigation.reset 會清掉跳文落地的那篇）。
  // loggedOut：這次斷線是使用者自己登出。
  capture: function(loggedOut) {
    const wasLoggedIn = this._loggedIn;
    this._loggedIn = false;
    if (loggedOut) {
      this.discard('logout');
      return;
    }
    // 還沒登入就斷了：畫面是登入流程，沒有閱讀位置；保留上一份。
    if (!wasLoggedIn) return;
    if (!enabled()) {
      this.discard('disabled');
      return;
    }
    const core = this._core;
    const bm = recordFor(core).begin('reconnect-resume', { view: this._view, buf: this._termBuf });
    const nav = core.aidNavigation;
    const post = bm.article && nav && nav.currentPostAid ? nav.currentPostAid() : null;
    this._pending = resumePlanFrom(bm, post);
    this._diag('capture', this._pending
      ? { kind: this._pending.kind, board: this._pending.board, aid: this._pending.aid || null, num: this._pending.num || null }
      : { kind: null });
  },

  discard: function(reason) {
    if (!this._pending) return;
    this._diag('discard', { reason: reason });
    this._pending = null;
  },

  hasPending: function() {
    return !!this._pending;
  },

  _atMainMenu: function() {
    const buf = this._termBuf;
    if (!buf || !buf.getRowText) return false;
    return isMainMenuRow(buf.getRowText(0, 0, buf.cols));
  },

  _onSettled: function() {
    if (!this._atMainMenu()) {
      // 登入後不在主功能表 ＝使用者自己走開了（我們只在主功能表出發）。
      if (this._loggedIn) this.discard('moved');
      return;
    }
    this._loggedIn = true;
    if (!this._pending) return;
    const core = this._core;
    if (core.connectState !== 1) return;
    if (!enabled()) {
      this.discard('disabled');
      return;
    }
    // deep link 先登記了（同一次 settle 它會先跳，已在跑也一樣）：使用者剛給的連結
    // 比斷線前的位置新。
    const dl = core.deepLinkController;
    const nav = core.aidNavigation;
    if ((dl && dl.hasPending && dl.hasPending()) || !nav || nav.active) {
      this.discard('superseded');
      return;
    }
    const plan = this._pending;
    this._pending = null;
    // 同 deep_link_controller._dispatch：AutoLogin 的「請按任意鍵 ⇒ 送空白」會踩到
    // 進板畫面，打亂序列正在等的那一幀。
    if (core.autoLogin && core.autoLogin.stop) core.autoLogin.stop();
    this._diag('dispatch', { kind: plan.kind, board: plan.board });
    nav.startResume(plan);
  }
};

export default ReconnectResume;
