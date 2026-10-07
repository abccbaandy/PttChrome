// 搜尋彈窗（文章列表的 / ? a Z ＋看板的 s）：攔截判準、prompt 指紋、送出序列。
//
// 為什麼要攔：pttbbs 的輸入記憶（↑ 叫回上一筆）是**整個登入 session 共用一份**
// （mbbsd/vtuikit.c:1018-1128 `static InputHistory ih`，508 bytes，≥2 bytes 才存，
// 只有 NOECHO 不存），跳號 prompt ` 跳至第幾項: `（stuff.c:190，NUMECHO）照樣存進去
// ⇒ 列表好讀／看板列表在背景送的 `N\r` 會把使用者真正的搜尋關鍵字擠掉，↑ 只叫得
// 回一串數字。client 關不掉 server 的記憶，所以改成自己記（search_history.js），
// 並在按下搜尋鍵時改開彈窗。細節見 docs/article-search.md。
//
// 純函式吃 App-ish 物件（同 long_push_gate.js 的慣例）：term_view（舊式 prototype）、
// React 工具列與 unit 都能直接呼叫。**只讀 e.key／修飾鍵**，理由同 long_push_gate
// 檔頭（sendKeyAsUser 合成的事件沒有 code/target）。

import { u2b, ansiHalfColorConv } from './string_util';
import { boardListContextKind } from './board_list_parse';
import { listRenderOwnerOf, OWNER_ARTICLE_LIST } from './list_render_owner';
import { rowHasTitle, MAIN_MENU } from './screen_titles';
import { readValuesWithDefault } from './pref_storage';

// 種類 → PTT 端的按鍵。`?` 與 `/` 是同一個指令（read.c:1430-1431），送出一律用 `/`。
// `Z` 是推文數（大寫；小寫 z 是精華區，bbs.c:4406）。
export const SEARCH_KINDS = ['title', 'author', 'push', 'board'];
export const SEARCH_KEY_OF = { title: '/', author: 'a', push: 'Z', board: 's' };
const KIND_OF_KEY = { '/': 'title', '?': 'title', a: 'author', Z: 'push', s: 'board' };

// 鍵盤攔得到的鍵 → 種類；不是搜尋鍵回 null。`s` 只在 availableSearchKinds 含 board 的
// 畫面才攔（文章列表／看板列表／主功能表），其他選單的 s 是「跳到 s 開頭的項目」。
export function searchKindOfKey(key) {
  return Object.prototype.hasOwnProperty.call(KIND_OF_KEY, key) ? KIND_OF_KEY[key] : null;
}

// prompt 指紋。全部出自 pttbbs 原始碼（Big5 轉 UTF-8 後逐字抄）：
//   read.c#ask_filter_predicate：getdata(b_lines, 0, …)，已在搜尋結果裡
//   （MODE_SELECT）時改成「增加條件 …」。推文數那句在 CONFIG_OLD_RECOMMEND 下少了
//   「 (<0則搜噓文數) 」，所以只比前綴。
//   include/common.h:162 MSG_SELECT_BOARD（bbs.c#do_select、menu 的 s）與
//   board.c#board_cmd_search_global（看板列表的 s）：兩段式 prompt，輸入在第 1 列。
const BOTTOM_PROMPTS = {
  title: ['搜尋標題: ', '增加條件 標題: '],
  author: ['搜尋作者: ', '增加條件 作者: '],
  push: ['搜尋推文數高於多少', '增加條件 推文數: ']
};
const BOARD_PROMPT = '請輸入看板名稱(按空白鍵自動搜尋)';

function startsWithAny(text, prefixes) {
  return prefixes.some((p) => text.indexOf(p) === 0);
}

// facts：{ rowTexts, rows, curY }（CommandQueue 的 settle facts 就是這個形狀）。
// 回 true ＝ 這一幀就是 kind 的輸入 prompt，游標停在輸入列上。
export function isSearchPromptFrame(kind, facts) {
  const rowTexts = (facts && facts.rowTexts) || [];
  const rows = (facts && facts.rows) || rowTexts.length;
  if (kind === 'board') {
    return facts.curY === 1 && (rowTexts[1] || '').indexOf(BOARD_PROMPT) === 0;
  }
  const prefixes = BOTTOM_PROMPTS[kind];
  if (!prefixes) return false;
  return facts.curY === rows - 1 && startsWithAny(rowTexts[rows - 1] || '', prefixes);
}

// 推文數只收非零整數（可負＝噓文數）。PTT 端 `atoi(keyword) == 0` 就當取消
// （read.c ask_filter_predicate），送一個一定被丟掉的值只是多一趟。欄寬 7（含負號）。
export function normalizeSearchText(kind, text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return '';
  if (kind === 'push') {
    if (!/^-?\d{1,6}$/.test(t)) return '';
    return parseInt(t, 10) === 0 ? '' : String(parseInt(t, 10));
  }
  // 看板名稱：namecomplete 是 VGET_ASCII_ONLY（name.c#namecomplete_internal），
  // 非 ASCII 打進去也只會被丟掉 ⇒ 這裡先擋，彈窗才能說清楚。
  if (kind === 'board' && !/^[\x21-\x7e]+$/.test(t)) return '';
  return t;
}

// 從 buf 讀出判斷要的畫面事實（讀 buf 不讀 DOM，DOM 慢一幀）。buf 還沒建起來回 null。
export function searchGateFacts(core) {
  const buf = core && core.buf;
  if (!buf || typeof buf.getRowText !== 'function') return null;
  const rowTexts = [];
  for (let r = 0; r < buf.rows; ++r) rowTexts.push(buf.getRowText(r, 0, buf.cols));
  return {
    rowTexts: rowTexts,
    rows: buf.rows,
    curX: buf.cur_x,
    curY: buf.cur_y,
    // 游標停在反白輸入欄＝已經有一個 prompt 開著（使用者在打字），搜尋鍵是內容。
    inputField: typeof buf.isCursorOnInputField === 'function' && buf.isCursorOnInputField(),
    listOwner: listRenderOwnerOf(buf)
  };
}

// 這一幀可以開哪幾種搜尋（工具列的選單與鍵盤攔截共用同一個判準）。
//   文章列表 → 全部；看板列表 → 只有看板（看板列表的 / 是「看板中文關鍵字」，
//   board.c:2063，另一種東西，不接）；主功能表 → 只有看板（menu.c:767，只有
//   MMENU/TMENU/XMENU 的 s 是選擇看板，其他選單的 s 是跳到 s 開頭的項目）；
//   其他（文章、prompt、編輯器…）→ 無。
export function availableSearchKinds(facts) {
  if (!facts || facts.inputField) return [];
  if (facts.listOwner === OWNER_ARTICLE_LIST) return SEARCH_KINDS.slice();
  const ctx = boardListContextKind(facts);
  if (ctx === 'article-list') return SEARCH_KINDS.slice();
  if (ctx === 'brdlist' || ctx === 'brdlist-other') return ['board'];
  if (rowHasTitle((facts.rowTexts || [])[0] || '', MAIN_MENU)) return ['board'];
  return [];
}

// 鍵盤／IME 兩條攔截入口的判準。
export function shouldInterceptSearchKey(opts) {
  const o = opts || {};
  const kind = searchKindOfKey(o.key);
  if (!kind) return false;
  if (o.ctrlKey || o.altKey || o.metaKey) return false;
  if (!(o.prefs && o.prefs.searchKeyOpensModal)) return false;
  return availableSearchKinds(o.facts).indexOf(kind) >= 0;
}

// term_view 的鍵盤（onKeyDown）與 IME（onTextInput）兩條入口共用。e 為 null ＝ IME
// 上字（沒有修飾鍵）。回 true ＝彈窗開了，呼叫端吞掉這個鍵；core.openSearchModal
// 是 noop（ContextMenu 還沒 mount）時回 false ⇒ 照原生送出，**絕不吞了又不開**。
export function tryOpenSearchModal(core, key, e) {
  const kind = searchKindOfKey(key);
  if (!kind || !core || typeof core.openSearchModal !== 'function') return false;
  if (
    !shouldInterceptSearchKey({
      key: key,
      ctrlKey: !!(e && e.ctrlKey),
      altKey: !!(e && e.altKey),
      metaKey: !!(e && e.metaKey),
      prefs: readValuesWithDefault(),
      facts: searchGateFacts(core)
    })
  )
    return false;
  return !!core.openSearchModal(kind);
}

// 送出序列：先送搜尋鍵，**等 prompt 真的出現**才送關鍵字＋Enter。不可以一次送出：
// pttbbs 的 typeahead 會吞掉中間幀（協定 §2），而搜尋鍵沒被接受時（例如畫面在送出前
// 變了）關鍵字的每個字母都會落回列表按鍵 —— `a`/`Z`/`s`/數字全是指令。
export function buildSearchSteps(kind, text, cb) {
  const key = SEARCH_KEY_OF[kind];
  const value = normalizeSearchText(kind, text);
  if (!key || !value) return null;
  const c = cb || {};
  return [
    {
      keys: key,
      kind: 'search-open',
      expect: function(snapshot, facts) {
        return isSearchPromptFrame(kind, facts || {});
      },
      // prompt 沒出現＝PTT 不接受（站內信的推文數搜尋、沒權限…）：關鍵字絕不送。
      onFail: c.onFail
    },
    {
      // CommandQueue 綁的是 raw conn.send ⇒ Big5 轉碼要自己做（同
      // list_session._beginTextPassthrough）。
      keys: ansiHalfColorConv(u2b(value)) + '\r',
      kind: 'search-submit',
      onDone: c.onDone
    }
  ];
}

// 兩步在途的旗標（core.searchInFlight），由 serialized_op_gate 讀：期間使用者的鍵一律
// 吞掉＋提示。少了它，「搜尋鍵已上線、prompt 還沒畫出來」那一刻按的 Enter 會先到
// server，把空 prompt 送出（＝取消），關鍵字接著落到列表上變成指令（live 錄製檔
// live-2026-10-07T12-51-14：`/\f` → End → `\r` → 關鍵字永遠沒送）。
// 解除點：第二步完成／任一步失敗／被 flush；保底計時器防任何一條漏掉造成永久吞鍵。
export const SEARCH_INFLIGHT_MAX_MS = 15000;

function beginInFlight(core) {
  core.searchInFlight = true;
  clearTimeout(core._searchInFlightTimer);
  core._searchInFlightTimer = setTimeout(function() {
    endInFlight(core);
  }, SEARCH_INFLIGHT_MAX_MS);
}

function endInFlight(core) {
  core.searchInFlight = false;
  clearTimeout(core._searchInFlightTimer);
  core._searchInFlightTimer = null;
}

// 把旗標的解除接進每一步的終局 callback（保留呼叫端原本的 callback）。
function trackInFlight(core, steps) {
  const end = function() {
    endInFlight(core);
  };
  const wrap = function(fn) {
    return function(a, b) {
      end();
      if (fn) fn(a, b);
    };
  };
  steps.forEach(function(step, i) {
    step.onFail = wrap(step.onFail);
    step.onFlushed = end;
    if (i === steps.length - 1) step.onDone = wrap(step.onDone);
  });
  return steps;
}

// 送出。三條路，選誰由「現在誰在畫列表」決定（App.activeListSession 的同一個真相源）：
//   - 文章列表好讀／看板列表平滑捲動接管中 ⇒ 交給該 session 的多步 passthrough
//     （cursor sync 腿、進原生鏡像、序列化都在裡面，與 `v` prompt 同一條路）。
//   - 原生 ⇒ 直接排進共用 CommandQueue，第二步只在第一步 onDone 才排。
// 回 false ＝ 沒送（沒有可送的內容或沒有佇列）。
export function submitSearch(core, kind, text, cb) {
  const built = buildSearchSteps(kind, text, cb);
  if (!built || !core) return false;
  const steps = trackInFlight(core, built);
  const owner = typeof core.activeListSession === 'function' ? core.activeListSession() : null;
  if (owner && typeof owner._beginPassthroughBytes === 'function') {
    // 序列化交易進行中（開文／凍結中的指令）：線路歸它，同 list_session.onFunctionKey
    // 的守門。呼叫端負責提示，不可無聲吞掉。
    if (owner.state === 'opening' || (owner.state === 'functionMode' && owner._renderMode === 'frozen'))
      return false;
    beginInFlight(core);
    owner._beginPassthroughBytes(steps, { kind: 'search', hint: null });
    return true;
  }
  const queue = core.commandQueue;
  if (!queue) return false;
  beginInFlight(core);
  // 原生鏡像：文章好讀不會在列表上，這裡不必切 functionMode。
  const enqueue = function(i) {
    const step = steps[i];
    queue.enqueue({
      keys: step.keys,
      kind: step.kind,
      fullRepaint: i === 0,
      expect:
        step.expect ||
        function() {
          return true;
        },
      onDone: function(result) {
        if (step.onDone) step.onDone(result);
        if (i + 1 < steps.length) enqueue(i + 1);
      },
      onFail: step.onFail,
      onFlushed: step.onFlushed
    });
  };
  enqueue(0);
  return true;
}
