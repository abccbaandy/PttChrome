// 好讀累積頁的「增量重算」判準（純邏輯，無 DOM／無 React；unit 守護：
// tests/unit/screen_annotate_cache.test.js）。
//
// ---- 為什麼需要這層 ----
// 好讀文章模式每收到一頁回應就同步重繪**整份累積頁**（term_buf.notify →
// view.update → redraw → _renderScreenLines(buf.pageLines) → renderInto 的
// flushSync）。Screen#computeAnnotations 原本每幀對全部 n 列重跑 rowToText /
// annotateComment / detectRowExtras，React 也重建 n 個 <Row> ⇒ 每頁 O(n)、整篇
// O(n²)。實錄 ptt-debug-20260809（EZsoft 8512 行）翻頁週期從 55ms 惡化到 1196ms，
// 越過 PAGE_DOWN_GRACE_MS(600) 後 watchdog 誤判掉包 → 補送 PageDown → P4 吞頁 →
// 缺頁自癒 → 「讀到一半跳回第一頁 / 卡住不讀」。效能是那組 bug 的根因。
//
// ---- 可以增量的根據 ----
// 累積是**純 append**：term_view.accumulatePageLines 的 append 分支寫
// `pageLines = pageLines.concat(新尾巴)`，舊列的 TermChar[] 物件參考永不變動
// （cloneRow 只在 append 當下複製一次）。所以「上一次的 lines 是這一次的前綴」
// ⟺ 這是一次單純的往後長，前面每一列的標註結果都仍然成立。
//
// rebuild（換文章／缺頁自癒 Home）、list 模式的視窗重建、functionMode 的原生
// 24 列鏡像，全都會產生**新的 row 物件**或更短的陣列 ⇒ reusablePrefix 自然掉到
// 0 或小於 prev.length ⇒ 呼叫端退回全量重算。不需要任何額外的旗標。

// 上一次與這一次 lines 的共同前綴長度（比較的是**列物件參考**，不是內容）。
// 呼叫端只有在 `reusablePrefix(prev, next) === prev.length && next.length >= prev.length`
// 時才可以重用快取——中途換掉任何一列都代表那不是 append。
export function reusablePrefix(prevLines, nextLines) {
  if (!prevLines || !nextLines) return 0;
  const n = Math.min(prevLines.length, nextLines.length);
  let i = 0;
  while (i < n && prevLines[i] === nextLines[i]) ++i;
  return i;
}

// 純 append 判定（上面那條規則的具名版本，避免呼叫端各自拼一次）。
export function isAppendOnly(prevLines, nextLines) {
  if (!prevLines || !nextLines) return false;
  if (nextLines.length < prevLines.length) return false;
  return reusablePrefix(prevLines, nextLines) === prevLines.length;
}

// Set / Array / 純值 → 穩定字串。blacklist 是 Set、titleBlacklist 是 Array，兩者
// 的**參考**會隨偏好重讀而換掉（readValuesWithDefault 每次都建新的），所以只能比
// 內容；排序後 join 讓「同一組黑名單」永遠得到同一個簽章。
function stable(v) {
  if (v == null) return '';
  if (v instanceof Set) return Array.from(v).sort().join(',');
  if (Array.isArray(v)) return v.join(',');
  if (typeof v === 'object') {
    const keys = Object.keys(v).sort();
    let s = '';
    for (let i = 0; i < keys.length; ++i) s += keys[i] + '=' + v[keys[i]] + ';';
    return s;
  }
  return String(v);
}

// 影響**每一列**標註／渲染的輸入 → 一組快取鍵。任何一項變動（改設定、選推文者
// 高亮、切圖文合併、AI 回填新判決…）都讓整份快取失效並全量重算：那是一次性的
// 使用者操作，長文卡一幀可接受；真正要防的是「每頁翻頁都全量重算」。
//
// 刻意**不含** currentHighlighted：它一次只影響兩列，由呼叫端逐列處理，不該把
// 整份快取炸掉（原生模式滑鼠瀏覽每移動一列就換一次）。
// 刻意**不含** articleId：它變動時 lines 一定也被 rebuild 換掉了。
//
// refs 放無法字串化又必須逐一比對的東西（onAidClick 的閉包會進 aids 的 onClick，
// 換了就得重算）。
//
// 也刻意**不含** enhance.changedRows / enhance.rowIdentityStable：那兩個是給 render
// 層做逐列節點重用的 hint（見 render/screen.js#_buildNodes），不影響任何一列算出
// 來的 annotation。這個函式是白名單式列舉，新增 render hint 時不必來改它——但也
// 不要順手把它們加進來，否則每一幀 changedRows 都是新陣列 ⇒ 快取永遠失效。
export function annotationsKey(input) {
  const e = (input && input.enhance) || {};
  const sig = [
    stable(e.blacklist),
    stable(e.titleBlacklist),
    stable(e.showFloorNumbers),
    stable(e.highlightAuthor),
    stable(e.articleAuthor),
    stable(e.selectedPusher),
    stable(e.pageState),
    stable(e.autoFixUrl),
    stable(e.bareDomainLink),
    stable(e.easyReading),
    stable(e.enableXMention),
    stable(e.mergeSameAuthorComments),
    stable(e.inListContext),
    stable(e.listEasyReading),
    stable(e.dropHidden),
    // 功能鍵按鈕：**一定要在**。列表好讀視窗走 rowIdentityStable，render/screen.js
    // 的節點重用條件是 `rowIdentityStable || !changedRows.has(row)` ⇒ changedRows
    // 根本不參與判斷。漏了它，切 pref 之後 row 1 / row 23 的節點會被無條件沿用，
    // 按鈕該出現不出現、該消失不消失，直到視窗捲動換掉那些列物件為止。
    stable(e.functionKeyRows),
    stable(input.mergeCaption),
    stable(input.captionAi),
    stable(input.aiKeep),
    stable(input.aiLink),
    stable(input.aiFix),
    stable(input.forceWidth),
    stable(input.enableLinkInlinePreview),
    stable(input.enableLinkHoverPreview)
  ].join('|');
  return {
    sig: sig,
    refs: [
      e.onAidClick,
      e.onFunctionKey,
      input.onHyperLinkMouseOver,
      input.onHyperLinkMouseOut
    ]
  };
}

export function sameKey(a, b) {
  if (!a || !b) return false;
  if (a.sig !== b.sig) return false;
  if (a.refs.length !== b.refs.length) return false;
  for (let i = 0; i < a.refs.length; ++i) if (a.refs[i] !== b.refs[i]) return false;
  return true;
}

// 「連續同作者推文合併」的一個 run 的身分。命中即可重用上一幀算好的
// mergeCommentRun 物件（buildMergedCommentChars 會重建 TermChar 陣列、又要對合併
// 後的 chars 再跑一次 detectRowExtras，是這條路徑最貴的一段）。
// rows 可能不連續（黑名單 hidden 列在 groupSameAuthorRuns 被 continue 跳過），
// 故整串 join 而不是只記首尾。
export function mergeRunKey(run) {
  if (!run) return '';
  return run.userid + '@' + run.rows.join(',');
}
