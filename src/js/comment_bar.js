// 好讀文章底部常駐推文列（設計見 docs/long-push.md「底部常駐推文列」）。
//
// 好讀文章的最下面常駐一條「推／噓／→＋文字」輸入列，打完按 Enter 就推出去。送出
// **整條沿用長推文管線**（探路 X → 分段 → 冷卻等待 → 草稿保存 → 錯誤框），這裡只管
// 兩件事：
//   1. 什麼時候出現、畫在哪（控制器，狀態給 components/CommentBar 照畫）；
//   2. 探路回來之後「直接送」還是「退回長推文輸入框讓使用者看一眼」（quickPushPlan，純函式）。
// 送鍵入口只有 ContextMenu 注入的 App.openQuickPush（同 openLongPushModal 的合約）。
//
// 出現條件同文章工具側欄（article_tools._inEasyArticle）：pageState 3＋好讀開著＋不在
// functionMode＋累積頁非空。原生 pmore、列表、選單都不出現 ⇒ 認不出就是原生。
// 送出期間長推文會切進 functionMode（原生鏡像），列跟著收起，送完回到好讀再出現。
import { readEffectivePrefs } from './pref_storage';
import { stripNonBig5, splitPushSegments, big5ByteLength, pushMaxBytes } from './long_push';
import { detectIpLogged, detectAlignedComments } from './push_screen';
import { screenOf, SCREEN_KIND } from './screen_model';
import { listPushTarget, listPushFactsOf, sameListPushTarget } from './list_push';
import { measureContentEdge, stackFloorOf } from './bottom_stack';

export const COMMENT_BAR_ID = 'commentBar';
// 列高（CSS px）。終端機累積頁尾端要多留這麼高的空白，最後一列才捲得出列的下面
// （CSS 變數 --comment-bar-h，見 main.css `.commentBarShown`）。
export const COMMENT_BAR_HEIGHT = 40;
// 打字中（輸入框聚焦）輸入框跟著內容長高，最多這麼多行，再多就在框內捲。平常（沒聚焦）
// 縮回一行 ⇒ 列高回到 COMMENT_BAR_HEIGHT，只在使用者正在打字時才多蓋住文章。
export const COMMENT_BAR_MAX_LINES = 5;
// 超過這麼多則就不直接送，退回輸入框（那裡有「還是要送」的二次確認）。同 LongPushModal。
export const QUICK_PUSH_MAX_SEGMENTS = 20;
// 列表模式（P90）蓋住底列的類型選單時，列的上緣再往上多蓋幾 px（字形上緣超出列框）。
const LIST_COVER_SLACK = 6;

export function isCommentBarTarget(el) {
  return !!(el && typeof el.closest === 'function' && el.closest('#' + COMMENT_BAR_ID));
}

// 送鍵的功能 ⇒ 受長推文總開關與安全模式管（enableCommentBar 在 NATIVE_SAFE_MODE_KEYS，
// 傳進來的是 readEffectivePrefs 的值：安全模式開著時它已經是 false）。
export function commentBarEnabled(prefs) {
  const v = prefs || {};
  return !!(v.enableLongPush && v.enableCommentBar);
}

/**
 * 探路（preflight）成功之後，這一次要直接送，還是退回長推文輸入框。
 *
 * 退回的情況都是「使用者該先看一眼」：這塊板禁噓卻選了噓、有字推不出去會被濾掉、或分段
 * 太多（輸入框那裡有二次確認）。退回時內容已經在草稿裡，輸入框一打開就看得到，一個字都
 * 不會丟。
 *
 * PTT 把這次改成 →（degraded：作者本人／90 秒內連推，bbs.c#comment）**不退回**：原生按 X
 * 也是 PTT 自己改成 → 直接進內容輸入，不多問一次；連推是推文列最常見的用法，退回等於每
 * 第二則都要多按一次送出。送出狀態機每一步都讀畫面，沒有型別選單時本來就不送型別鍵。
 *
 * @param {object} result  LongPushSession.onPreflight 的參數（blocked 為 false 的那種）
 * @param {{text: string, type: string}} quick
 * @param {number} maxBytes
 * @returns {{direct: boolean, reason: string, text: string}}
 */
export function quickPushPlan(result, quick, maxBytes) {
  const r = result || {};
  const raw = String((quick && quick.text) || '');
  const type = (quick && quick.type) || 'push';
  const { text, dropped } = stripNonBig5(raw);
  if (!text.trim()) return { direct: false, reason: 'empty', text };
  if (type === 'boo' && r.booAllowed === false) return { direct: false, reason: 'noBoo', text };
  if (dropped && dropped.length) return { direct: false, reason: 'dropped', text };
  if (splitPushSegments(text, r.maxBytes || maxBytes).length > QUICK_PUSH_MAX_SEGMENTS)
    return { direct: false, reason: 'tooMany', text };
  return { direct: true, reason: 'ok', text };
}

// P90 列表按推文改出推文列：除了推文列本身的開關，還從屬於「按推文鍵開長推文」（關掉＝列表上
// 照舊原生類型選單）。安全模式下 enableCommentBar 已經是 false。
export function listPushEnabled(prefs) {
  return commentBarEnabled(prefs) && !!(prefs && prefs.pushKeyOpensLongPush);
}

// 列表上按送出：直接送，還是擋下來請使用者先改字（列表上沒有長推文輸入框可以退回）。
// 擋下的兩種跟 quickPushPlan 相同理由：有 PTT 顯示不了的字（送出前會被濾掉）、分段太多。
export function listPushPlan(quick, maxBytes) {
  const raw = String((quick && quick.text) || '');
  const { text, dropped } = stripNonBig5(raw);
  if (!text.trim()) return { ok: false, reason: 'empty', text };
  if (dropped && dropped.length) return { ok: false, reason: 'dropped', text };
  if (splitPushSegments(text, maxBytes).length > QUICK_PUSH_MAX_SEGMENTS) return { ok: false, reason: 'tooMany', text };
  return { ok: true, reason: 'ok', text };
}

// 推文列打字時右邊的計數（pref commentBarCounter）：一則放得下 ⇒ 還能打幾個字（全形字；
// 半形算半個，無條件捨去）；放不下 ⇒ 會分成幾則。分段與長推文送出時是**同一支**
// splitPushSegments，所以「會分成 N 則」就是按下去之後真的會送出的則數（maxBytes 是預估，
// 送出時會再被畫面校正，見 commentBarMaxBytes）。空字串不顯示（回 null）。
// PTT 畫不出來的字（emoji）先濾掉再算：它們送出前本來就會被濾掉。
export function commentBarCounter(text, maxBytes) {
  const clean = stripNonBig5(text).text;
  if (!clean.trim()) return null;
  const limit = Math.max(2, maxBytes | 0);
  const segments = splitPushSegments(clean, limit).length;
  if (segments > 1) return { segments, remaining: 0 };
  return { segments: 1, remaining: Math.max(0, Math.floor((limit - big5ByteLength(clean.trim())) / 2)) };
}

// 推文列計數用的單則上限預估：同長推文輸入框的預估（帳號長度），再從這篇已完成的推文列
// 認 IP 欄與對齊推文——不認的話非 IP 板會被當成 IP 板少算 15 byte，一則的話顯示成兩則。
// rows：這篇的推文列文字（只要尾端那幾列就夠）。
export function commentBarMaxBytes(rows, userId) {
  return pushMaxBytes({
    userId: userId || '',
    ipLogged: detectIpLogged(rows),
    alignedCmt: detectAlignedComments(rows),
  });
}
// 認 IP 欄／對齊推文只看累積頁的最後這麼多列（推文在文末，幾千則的文章不用整份掃）。
const COUNTER_SCAN_ROWS = 200;

// 列的位置：與終端機同寬、貼在終端機可見內容的最下緣（桌機在好讀 footer 那一列之上，
// 手機換行版面 footer 收起，就是終端機底＝底部導覽上緣）。bottom 是距視窗底的距離。
// bottomInset：疊在視窗底的浮層（手機底部導覽列＋軟鍵盤＋safe-area，view.keyboardInset）。
// 手機的 .main 會因列高取整比可用高度高幾 px、延伸到導覽列後面 ⇒ 至少要讓出它，不然推文
// 列壓在導覽列上（e2e mobile_bottom_overlay）。
// footerTop：好讀 footer 的上緣（顯示中才給）。footer 疊在格線最後一列、不在 `.main` 最下緣
// （`.main` 比格線高 10px，main.css #easyReadingLastRow），所以量它的上緣，不用 `.main` 下緣扣高度。
export function commentBarGeometry({ mainRect, footerTop, innerHeight, bottomInset }) {
  if (!mainRect || !mainRect.width) return null;
  const floor = stackFloorOf({ mainRect, footerTop, innerHeight, keyboardInset: bottomInset });
  return {
    left: Math.round(mainRect.left),
    width: Math.round(mainRect.width),
    bottom: Math.max(0, Math.round(innerHeight - floor)),
  };
}

// 推文列現在實際佔的高度（px）：沒畫 ⇒ 0；畫著 ⇒ 元件量到的高度（打字中會長高），
// 至少 COMMENT_BAR_HEIGHT。要讓出推文列的功能（下一篇卡片、文章導覽軸）一律問它，
// 不要直接用 COMMENT_BAR_HEIGHT——列長高時會被蓋住。
export function commentBarHeight(state) {
  if (!state || !state.visible) return 0;
  return Math.max(COMMENT_BAR_HEIGHT, Math.round(state.height) || 0);
}

// 推文一則就是一行：貼上的換行（textarea 會留著）換成空白，跟原本單行輸入框貼上時一樣，
// 不會在長推文分段時變成強制斷點。
export function commentBarText(value) {
  return String(value == null ? '' : value).replace(/\r\n?|\n/g, ' ');
}

// 手機收合（pref mobileCommentBarFold，預設開）：平常只留底部導覽，點導覽的「推文」才
// 展開列並叫出鍵盤；送出、離開輸入框、收鍵盤、系統返回就收回。桌機不收合。
export function commentBarFolded(prefs, mobile) {
  return !!(mobile && prefs && prefs.mobileCommentBarFold);
}

// available：出現條件成立（好讀文章＋開關開著）；visible：列真的畫出來（收合時要 expanded）。
// prefill：「回覆這則」之類的預填請求 { type, text, n }（n 每次遞增，元件靠它分辨新請求）。
// focusN：展開時要聚焦輸入框的請求序號（同上，元件靠它分辨新請求）。
const HIDDEN = {
  visible: false,
  available: false,
  folded: false,
  expanded: false,
  left: 0,
  width: 0,
  bottom: 0,
  // 元件量到的列高（打字中長高時 > COMMENT_BAR_HEIGHT），讀的人走 commentBarHeight(state)。
  height: COMMENT_BAR_HEIGHT,
  mobile: false,
  counter: false,
  prefill: null,
  focusN: 0,
  // 'article'＝好讀文章底部常駐；'list'＝列表上的推文類型選單（P90），listTarget 是要推的那一篇。
  mode: 'article',
  listTarget: null,
  booAllowed: true,
  // P91：PTT 已經直接進 → 輸入列（作者本人／90 秒內連推）⇒ 類型只剩 →，notice 是 PTT 那一行原話。
  arrowOnly: false,
  notice: null,
  // 列要往上多蓋的高度（px，P91 蓋住 PTT 的說明列）。
  coverExtra: 0,
};

export function CommentBar(core) {
  this._core = core;
  this._listeners = new Set();
  this._state = Object.assign({}, HIDDEN);
  this._listSuppressed = false;
  const self = this;
  if (core.buf && core.buf.addEventListener)
    core.buf.addEventListener(
      'screenSettled',
      function() {
        self.refresh();
      },
      { owner: 'commentBar' }
    );
  if (typeof window !== 'undefined' && window.addEventListener)
    window.addEventListener('resize', function() {
      self.refresh();
    });
}

CommentBar.prototype = {
  get state() {
    return this._state;
  },

  onChange: function(fn) {
    this._listeners.add(fn);
    fn(this._state);
    const set = this._listeners;
    return function() {
      set.delete(fn);
    };
  },

  _set: function(patch) {
    const next = Object.assign({}, this._state, patch);
    if (Object.keys(patch).every((k) => next[k] === this._state[k])) return;
    this._state = next;
    this._listeners.forEach(function(fn) {
      fn(next);
    });
  },

  // 預填推文列（類型＋文字）並叫出輸入框。不在好讀文章（列不該出現）就不做（回 false）——
  // 不替使用者開別的東西。手機收合中會先展開。
  prefill: function(req) {
    if (!req || !this.expand({ focus: false })) return false;
    const n = ((this._state.prefill && this._state.prefill.n) || 0) + 1;
    this._set({ prefill: { type: req.type || 'push', text: String(req.text || ''), n: n } });
    return true;
  },

  // 展開列並聚焦輸入框（手機收合時底部導覽的「推文」走這裡）。不在好讀文章回 false。
  // 沒收合（桌機、手機常駐）就只聚焦。展開期間登記成 bottom sheet：系統返回先收它。
  expand: function(opts) {
    if (!this._state.available) return false;
    const patch = { visible: true };
    if (this._state.folded && !this._state.expanded) {
      patch.expanded = true;
      const core = this._core;
      if (core.registerSheetDismiss && !this._unregisterBack)
        this._unregisterBack = core.registerSheetDismiss(() => this.collapse());
    }
    if (!opts || opts.focus !== false) patch.focusN = this._state.focusN + 1;
    this._set(patch);
    return true;
  },

  // 元件回報列的實際高度（ResizeObserver）。變了才通知 ⇒ 下一篇卡片／導覽軸跟著讓位。
  setHeight: function(px) {
    this._set({ height: Math.max(COMMENT_BAR_HEIGHT, Math.round(px) || 0) });
  },

  // 收回展開的列（收合模式才有作用）。
  collapse: function() {
    this._releaseBack();
    if (!this._state.expanded) return;
    this._set({ expanded: false, visible: this._state.available && !this._state.folded });
  },

  _releaseBack: function() {
    const off = this._unregisterBack;
    this._unregisterBack = null;
    if (off) off();
  },

  // P90：列表推文列剛出現到輸入框真的拿到焦點之間（React 下一次 render＋一個 rAF），使用者接著打的字
  // 會落在終端機的 #t ⇒ 照送 PTT，底下的類型選單把數字當類型（「2」＝噓）、其他字當取消。
  // 認出選單的那一刻就登記一個 modal 來源擋住終端機收鍵（字留在 #t 的 value 裡），
  // 輸入框聚焦時（takePendingInput）解除並把那些字接過去。收起時一定解除。
  _holdTerminalKeys: function(on) {
    if (!!this._keysHeld === on) return;
    this._keysHeld = on;
    const core = this._core;
    if (core.setModalOpen) core.setModalOpen('commentBarPending', on);
  },

  // 元件：列表模式的輸入框拿到焦點。解除擋鍵，回傳擋鍵期間落在 #t 的字（並清掉，免得之後送給 PTT）。
  takePendingInput: function() {
    if (!this._keysHeld) return '';
    const text = this._clearPendingInput();
    this._holdTerminalKeys(false);
    return text;
  },

  // 元件：聚焦失敗（輸入框沒拿到焦點）⇒ 解除擋鍵退回終端機，不然鍵盤與點擊都被 modal 擋著。
  // 擋鍵期間落在 #t 的字丟掉：那時畫面是推文類型選單，留著會在下一次打字時一起送到別的畫面。
  releasePendingInput: function() {
    if (!this._keysHeld) return;
    this._clearPendingInput();
    this._holdTerminalKeys(false);
  },

  _clearPendingInput: function() {
    const input = this._core.view && this._core.view.input;
    const text = (input && input.value) || '';
    if (input) input.value = '';
    return text;
  },

  // 列表模式：聚焦輸入框（手機工具列「推文」在類型選單上按 ⇒ 不送 X，叫出這一列）。不在列表模式回 false。
  focusList: function() {
    if (this._state.mode !== 'list' || !this._state.visible) return false;
    this._set({ focusN: this._state.focusN + 1 });
    return true;
  },

  _hide: function() {
    this.releasePendingInput();
    this._releaseBack();
    if (this._state.visible || this._state.available || this._state.expanded || this._state.mode !== 'article')
      this._set({ visible: false, available: false, expanded: false, mode: 'article', listTarget: null, booAllowed: true, arrowOnly: false, notice: null, coverExtra: 0 });
  },

  // 推文列計數用的單則上限（commentBarMaxBytes）。依累積頁長度快取：同一篇沒長新列就不重掃。
  maxBytes: function() {
    const core = this._core;
    const buf = core.buf;
    const view = core.view || {};
    const userId = view._selfId || readEffectivePrefs().autoLoginUser || '';
    // 列表上看不到推文列（認不出 IP 欄）⇒ 保守值；送出時第一則的輸入列欄寬會校正。
    if (this._state.mode === 'list') return commentBarMaxBytes([], userId);
    const acc = (buf && buf.pageLines) || [];
    const key = acc.length + ':' + userId;
    if (this._maxBytesKey === key) return this._maxBytesVal;
    const rows = [];
    if (buf && typeof buf.getRowText === 'function')
      for (let r = Math.max(0, acc.length - COUNTER_SCAN_ROWS); r < acc.length; ++r)
        rows.push(buf.getRowText(r, 0, buf.cols, acc));
    this._maxBytesKey = key;
    this._maxBytesVal = commentBarMaxBytes(rows, userId);
    return this._maxBytesVal;
  },

  _inEasyArticle: function() {
    const core = this._core;
    const er = core.easyReading;
    const buf = core.buf;
    // 文章、而且不是官方推文實況（SCREEN_KIND.LIVE）：實況的留言走實況自己的 (X)留言（footer 上那顆）。
    // 這一列送出走長推文，而長推文假設推完回列表再重開、取 AID 要按 Q——實況裡 Q 是「離開」
    // （long_push_session.startPreflight）。
    return !!(buf && screenOf(buf).kind === SCREEN_KIND.ARTICLE && er && er._enabled && !er._functionMode && (buf.pageLines || []).length);
  },

  // 終端機可見內容的下緣：好讀 footer 顯示中＝它的上緣，否則 .main 的下緣。
  _geometry: function() {
    const view = this._core.view;
    const edge = measureContentEdge(view);
    if (!edge) return null;
    return commentBarGeometry({
      mainRect: edge.mainRect,
      footerTop: edge.footerTop,
      innerHeight: window.innerHeight,
      bottomInset: view.keyboardInset,
    });
  },

  // P90：列表上 PTT 畫著推文類型選單、而且認得出要推哪一篇 ⇒ 那一篇（listPushTarget）。
  // 長推文還握著畫面（送出中、取消收尾中）時不出現：那時的類型選單是我們自己按出來的。
  // 送出／取消之後（或長推文握著畫面期間的任何一幀）立 _listSuppressed：失敗、收尾沒成功時畫面可能
  // 還停在那個選單，列再跳出來會把焦點從錯誤框搶走 ⇒ 要看到一幀不是選單（使用者自己再按 X）才解除。
  // 長推文常在 timer／點擊裡放手、之後不一定再來一幀 ⇒ 放手那一刻另由 onWireReleased 判一次。
  _listMenuTarget: function(prefs) {
    if (!listPushEnabled(prefs)) {
      this._listSuppressed = false;
      return null;
    }
    const session = this._core.longPush;
    if (session && session.busy) {
      this._listSuppressed = true;
      return null;
    }
    const target = listPushTarget(listPushFactsOf(this._core.buf));
    if (this._listSuppressed) {
      if (!target) this._listSuppressed = false;
      return null;
    }
    return target;
  },

  _refreshList: function(prefs, target) {
    const core = this._core;
    const g = this._geometry();
    if (!g) return this._hide();
    // 列表模式要整個蓋住底列的類型選單：列的上緣對齊終端機最後一列的上緣（列比一列字高，
    // 往下多出來的落在終端機下緣之外；再往上多蓋 LIST_COVER_SLACK：字形的上緣會超出列框幾 px）。
    // 量不到那一列就照文章模式貼終端機下緣。
    const lastTop = this._lastRowTop(1);
    // P91 只有 → 時連 PTT 的說明列（倒數第二列）一起蓋住：說明改在列裡顯示（notice），不蓋的話
    // 列的上緣會切掉說明列字形的下半。下緣照舊對齊最後一列，列往上多長一列高（coverExtra）。
    let coverExtra = 0;
    if (target.arrowOnly && lastTop != null) {
      const upTop = this._lastRowTop(2);
      if (upTop != null) coverExtra = Math.max(0, Math.round(lastTop - upTop));
    }
    if (lastTop != null && typeof window !== 'undefined')
      g.bottom = Math.max(Math.round(window.innerHeight - lastTop + LIST_COVER_SLACK - COMMENT_BAR_HEIGHT), Math.round((core.view && core.view.keyboardInset) || 0), 0);
    const prev = this._state;
    // 新出現（或換了一篇）⇒ 聚焦輸入框（使用者剛按 X，就是要打字），系統返回＝取消。
    const entering = prev.mode !== 'list' || !prev.visible || !sameListPushTarget(prev.listTarget, target);
    if (entering) {
      this._holdTerminalKeys(true);
      this._releaseBack();
      if (core.registerSheetDismiss) this._unregisterBack = core.registerSheetDismiss(() => this.cancelList());
    }
    this._set({
      visible: true,
      available: true,
      folded: false,
      expanded: false,
      left: g.left,
      width: g.width,
      bottom: g.bottom,
      mobile: !!core.mobile,
      counter: !!prefs.commentBarCounter,
      mode: 'list',
      listTarget: target,
      booAllowed: target.booAllowed,
      arrowOnly: !!target.arrowOnly,
      notice: target.notice || null,
      coverExtra: coverExtra,
      focusN: entering ? prev.focusN + 1 : prev.focusN,
    });
  },

  // 終端機倒數第 fromBottom 列（預設最後一列；原生格線的 bbsrow／srow）的上緣；量不到回 null。
  _lastRowTop: function(fromBottom) {
    const buf = this._core.buf;
    if (!buf || !buf.rows || typeof document === 'undefined' || !document.querySelector) return null;
    const el = document.querySelector('#mainContainer [type="bbsrow"][srow="' + (buf.rows - (fromBottom || 1)) + '"]');
    if (!el || typeof el.getBoundingClientRect !== 'function') return null;
    const r = el.getBoundingClientRect();
    return r && r.height ? r.top : null;
  },

  // 手機工具列問：這一幀的推文提問（類型選單、P91 的 → 輸入列）是不是由推文列接手。是 ⇒ 工具列不出
  // 自己的提問選項／「開鍵盤輸入」面板（兩個疊在一起，點到面板會繞過推文列直接送鍵）。
  // 跟 _listMenuTarget 同一套條件，但不改任何狀態（工具列跟推文列誰先收到這一幀不一定）。
  takesOverListPrompt: function() {
    if (!listPushEnabled(readEffectivePrefs())) return false;
    const session = this._core.longPush;
    if ((session && session.busy) || this._listSuppressed) return false;
    if (!listPushTarget(listPushFactsOf(this._core.buf))) return false;
    // 量不到版面時推文列不會出現（_refreshList → _hide）⇒ 工具列的面板照出，不能兩個都沒有。
    return this._geometry() != null;
  },

  // 長推文放手（LongPushSession._releaseWire，busy 翻 false 的每一條路）：當下畫面已經不是類型選單 ⇒ 解除壓制。
  onWireReleased: function() {
    if (this._listSuppressed && !listPushTarget(listPushFactsOf(this._core.buf))) this._listSuppressed = false;
  },

  // 列表模式按送出（components/CommentBar）。回 { ok, reason }：ok ＝長推文狀態機接手了。
  submitList: function(quick) {
    const st = this._state;
    if (st.mode !== 'list' || !st.listTarget) return { ok: false, reason: 'gone' };
    const maxBytes = this.maxBytes();
    const plan = listPushPlan(quick, maxBytes);
    if (!plan.ok) return plan;
    const session = this._core.longPush;
    if (!session || !session.startFromList) return { ok: false, reason: 'gone' };
    const started = session.startFromList({
      text: plan.text,
      type: st.arrowOnly ? 'arrow' : (quick && quick.type) || 'push',
      target: st.listTarget,
      maxBytes: maxBytes,
    });
    if (!started) return { ok: false, reason: 'gone' };
    this._listSuppressed = true;
    this._hide();
    return { ok: true, reason: 'ok', text: plan.text };
  },

  // 列表模式收起（✕、Esc、系統返回）＝替使用者取消：送 PTT 原生的取消（dismissListMenu）。
  cancelList: function() {
    if (this._state.mode !== 'list') return false;
    const session = this._core.longPush;
    this._listSuppressed = true;
    this._hide();
    return !!(session && session.dismissListMenu && session.dismissListMenu());
  },

  refresh: function() {
    const core = this._core;
    const prefs = readEffectivePrefs();
    const target = this._listMenuTarget(prefs);
    if (target) return this._refreshList(prefs, target);
    if (this._state.mode === 'list') this._hide();
    if (!commentBarEnabled(prefs) || !this._inEasyArticle()) return this._hide();
    const g = this._geometry();
    if (!g) return this._hide();
    const folded = commentBarFolded(prefs, core.mobile);
    // 收合關掉（設定改了、轉成桌機）⇒ 展開狀態沒有意義了。
    if (!folded && this._state.expanded) this._releaseBack();
    const expanded = folded && this._state.expanded;
    this._set({
      visible: !folded || expanded,
      available: true,
      folded: folded,
      expanded: expanded,
      left: g.left,
      width: g.width,
      bottom: g.bottom,
      mobile: !!core.mobile,
      counter: !!prefs.commentBarCounter,
      mode: 'article',
      listTarget: null,
      booAllowed: true,
    });
  },
};

export default CommentBar;
