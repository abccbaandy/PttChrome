// 好讀累積長頁（buf.pageLines）的 TermChar 共用化（flyweight）。
//
// 為什麼：pageLines 每一格原本是 cloneRow 複製出來的獨立 TermChar。22000 行（≈千頁）的
// 文章＝176 萬個物件、約 148MB，佔 JS heap 的七成，GC 標記在 10 次 PgDn 內吃掉 219ms
// （量測見 docs/easy-reading.md「超長文」）。內容其實高度重複（空白＋少數幾種屬性組合），
// 所以「同字＋同屬性」的格子共用同一個物件即可。列仍是 TermChar[] ⇒ 消費端
// （rowToText、LinkSegmentBuilder、getText…）零改動。
//
// 前提（CONFIRMED 讀碼）：累積後的格子**不再被寫**——cloneRow 之後唯一的寫入點是
// term_view.blankRowLike（列表用，不進 pageLines）；term_buf 只寫活 buffer（buf.lines）。
// 共用之後任何一次就地改寫都會同時改到全篇所有同形的格子，所以 dev／測試下一律
// Object.freeze：違規在 strict mode（ES module）會直接 throw，不會靜默污染。
// 正式版不 freeze：萬一有漏網的寫入，退化成「畫錯幾格」而不是整頁炸掉。
//
// 鍵＝INTERN_FIELDS 的全部值。**TermChar 新增欄位必須同步加進 INTERN_FIELDS**，
// 否則只差在新欄位上的兩格會被併成同一個物件。守護 tests/unit/term_char_intern.test.js
// （拿真的 TermBuf 跑一輪寫入，所有格子的 own key 必須都在清單內）。
export const INTERN_FIELDS = Object.freeze([
  'ch',
  'fg',
  'bg',
  'bright',
  'invert',
  'blink',
  'underLine',
  'needUpdate',
  'isLeadByte',
  'startOfURL',
  'endOfURL',
  'partOfURL',
  'partOfKeyWord',
  'keyWordColor',
  'fullurl',
  'hyperlink'
]);

const FREEZE = !!(import.meta.env && import.meta.env.DEV);

// 池子的上限：超過就整個丟掉重來。丟掉不影響正確性——已經在 pageLines 裡的列照樣
// 持有它們的物件，只是之後的新列不再與舊列共用。實測一篇 22000 行的文章約數千種組合。
export const INTERN_POOL_MAX = 50000;

// prototype → Map(key → 共用格子)。實務上只有 TermChar 一種 prototype；分開存是為了
// 不讓「欄位相同、prototype 不同」的物件（測試的假 cell）互相頂替。
let pools = new Map();
let pooled = 0;

function keyOf(ch) {
  // \u0001 當分隔：ch 是字元（含全形字的 lead/trail），不會含控制字元。
  return (
    ch.ch + '\u0001' + ch.fg + '\u0001' + ch.bg + '\u0001' +
    (ch.bright ? 1 : 0) + (ch.invert ? 2 : 0) + (ch.blink ? 4 : 0) +
    (ch.underLine ? 8 : 0) + (ch.needUpdate ? 16 : 0) + (ch.isLeadByte ? 32 : 0) +
    (ch.startOfURL ? 64 : 0) + (ch.endOfURL ? 128 : 0) + (ch.partOfURL ? 256 : 0) +
    (ch.partOfKeyWord ? 512 : 0) + '\u0001' +
    ch.keyWordColor + '\u0001' + ch.fullurl + '\u0001' + ch.hyperlink
  );
}

export function internChar(ch) {
  const proto = Object.getPrototypeOf(ch);
  let pool = pools.get(proto);
  if (!pool) {
    pool = new Map();
    pools.set(proto, pool);
  }
  const key = keyOf(ch);
  let shared = pool.get(key);
  if (shared) return shared;
  if (pooled >= INTERN_POOL_MAX) {
    pools = new Map([[proto, (pool = new Map())]]);
    pooled = 0;
  }
  shared = Object.assign(Object.create(proto), ch);
  if (FREEZE) Object.freeze(shared);
  pool.set(key, shared);
  ++pooled;
  return shared;
}

// cloneRow 的共用化版本：給 buf.pageLines 的累積路徑用（term_view.accumulatePageLines／
// _accumulateReverse）。回傳的是新陣列（列參考仍是每次新的，renderer 的
// 「列參考相同 ⇒ 內容相同」前提不變），格子則是共用物件。
export function internRow(row) {
  const out = new Array(row.length);
  for (let i = 0; i < row.length; ++i) out[i] = internChar(row[i]);
  return out;
}

export function resetInternPoolForTest() {
  pools = new Map();
  pooled = 0;
}
