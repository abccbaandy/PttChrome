// 「這個推文鍵要不要改開長推文輸入框？」——攔截端與右鍵選單共用的述詞。
//
// 抽成模組而不是寫在呼叫端：三條使用者入口分屬兩層（term_view 是舊式 prototype
// 物件、pttchrome 是 App、ContextMenu 是 React），純函式吃 App-ish 值三邊都能直接
// 呼叫，unit 也不必造實例。同一慣例見 serialized_op_gate.js / function_key_plan.js
// / mouse_gates.js。
//
// **只讀 e.key / ctrlKey / altKey / metaKey**，不讀 e.code / e.target / e.isTrusted
// ——term_view.sendKeyAsUser 合成的 KeyboardEvent 沒有那些欄位（見該函式的硬規則
// 2），在這裡讀就會讓合成事件靜默走上不同分支。
//
// **文章列表刻意不攔**（pageState 2）。不只是範圍取捨：LongPushSession.start() 的
// 游標錨點要從**文章標頭**（作者／標題兩行）取，在列表啟動時那兩行不在畫面上 ⇒
// 只剩落地幀的弱錨點，等於拆掉唯一擋住「推到別篇」的機制（docs/long-push.md
// 「游標錨定」）。列表按 X 一律維持 PTT 原生行為。

import { parsePagerFooterContext, parseStatusRow } from './string_util';

// CONFIRMED（pttbbs mbbsd/more.c:90-93）：pager 的 key handler 只有這兩個 case 回
// RET_DORECOMMEND ⇒ 只有它們是「推文鍵」。**小寫 x 不是**（pager 完全沒綁，列表
// 是 NULL，站內信才是轉寄）。底列的 (X%)推文 會被 footer_keys.tokenizeKeyGroup 拆
// 成兩顆按鈕（keyBytes 各為 'X' / '%'），所以功能鍵那條也要吃同一個集合。
export function isPushKey(key) {
  return key === 'X' || key === '%';
}

// 「現在這個畫面按 X 推得了文嗎」——右鍵選單項目要不要出現、攔截的第一段，
// 兩處共用**同一個**呼叫（push_screen 的分歧前車之鑑，見 docs/image-upload.md）。
//
// 站內信（currstat == RMAIL）的 pager 把 X 當別的快捷鍵，送過去等於亂按。
// parsePagerFooterContext 只能單向推論，所以用「不是 mail」而非「是 reading」——
// footer 會因為寬度不夠整段消失（string_util.js 的說明）。
export function longPushAvailable(opts) {
  const o = opts || {};
  const prefs = o.prefs || {};
  return (
    !!prefs.enableLongPush &&
    o.pageState === 3 &&
    parsePagerFooterContext(o.lastRowText) !== 'mail'
  );
}

// 「pageState 3 是**這一幀**的事實，還是上一幀留下來的？」
//
// term_buf.setPageState 沒有 reset 分支：prompt 幀（s 切板／/ 搜尋／# 打 AID，底列
// 被 prompt 蓋掉且非空）三條判斷全不命中 ⇒ 沿用上一幀的 3。少了這道，使用者按 s
// 打看板名 XBOX 的第一個字就會被吞去開長推文輸入框。
// 用的正是 setPageState 判 READING 的同一個函式，不是第二套判準。
export function atPagerStatusRow(lastRowText) {
  return !!parseStatusRow(lastRowText || '');
}

// key：鍵盤傳 e.key，功能鍵按鈕傳 keyBytes，IME 傳上字的文字——三條入口同一個判準。
//
// **shiftKey 刻意不看**：X 與 % 本來就要按 Shift，把它列入排除條件等於整個功能失效。
export function shouldInterceptPushKey(opts) {
  const o = opts || {};
  if (!isPushKey(o.key)) return false;
  if (o.ctrlKey || o.altKey || o.metaKey) return false;
  const prefs = o.prefs || {};
  // 新開關從屬於 enableLongPush：longPushAvailable 第一項就是總開關，關掉總開關時
  // 攔截必定失效，不靠兩處各記一次。
  if (!prefs.pushKeyOpensLongPush) return false;
  if (!longPushAvailable({ prefs, pageState: o.pageState, lastRowText: o.lastRowText }))
    return false;
  return atPagerStatusRow(o.lastRowText);
}

// App-ish 物件 → 上面幾個純函式要的畫面事實（形狀比照 serializedOpHint(core)）。
// 讀 buf 不讀 DOM（DOM 慢一幀，docs/enhanced-addon.md 踩坑 A）。
// buf 還沒建起來／假 ctx 沒有 getRowText 時回 null ＝ 不攔截（攔不到的退化結果就是
// 今天的原生行為，永遠不會壞事）。
export function pushGateFacts(core) {
  const buf = core && core.buf;
  if (!buf || typeof buf.getRowText !== 'function') return null;
  return {
    pageState: buf.pageState,
    lastRowText: buf.getRowText(buf.rows - 1, 0, buf.cols)
  };
}
