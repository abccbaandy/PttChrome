// 跨行推文連結接合（無 DOM / 無網路，守護測試 tests/unit/url_wrap.test.js）。
//
// PTT 推文輸入欄有固定寬度上限，作者貼長網址時會被硬切成兩則連續推文：
//   → pttuser : ...DeepMind員工 https://i.imgur.c  08/09 15:35
//   → pttuser : om/Pn3XurX.jpeg                    08/09 15:35
// 兩層偵測都逐列做 ⇒ 都失效：TermBuf.uriRegEx 只看到殘段 https://i.imgur.c（渲染成
// 一個 404 連結），url_fix.detectFixableUrls 檔頭也明列「跨列斷開 URL out of scope」。
// 「連續同作者推文合併」（comment_merge.js）已經把同一位作者的連續推文重組成一個含
// '\n' cell 的 TermChar[]，接合所需的上下文全在手上——本模組只做「在換行邊界把 URL
// 接回去」這一件事。輸出形狀刻意與 detectFixableUrls 一致（{original,fixed,host,gray}）
// ⇒ 直接併進 fixedUrls，渲染（FixedUrlLine 的 ↳ 行）／快取／AI 閘門全部沿用。
//
// **不改寫原文**：殘段仍照原樣顯示，只是塊下方多一行修好的連結。誤判成本因此很低。
//
// ---- 為何這裡可以用寬度，comment_merge 卻不行 ----
// comment_merge.js 檔頭記著「勿再加回 gap 門檻猜續行」：中文散文「剛好寫滿一句話」
// 與「被輸入欄切斷」在畫面上完全同形，寬度單獨用判不出來。本模組的寬度只是**必要
// 條件之一**，真正的判別力來自「斷點兩側併起來是一個合法 URL（TLD 允許清單）」。
// 三個訊號缺一不可：
//   1. leftFull   左邊那則寫滿內容欄（comment_merge 依 pttbbs 算式推導，見該檔檔頭）
//   2. 時間戳     兩則相差 ≤ 1 分鐘（被切斷的續推幾乎都在同一分鐘送出）
//   3. URL 形狀   併起來要有合法 host（TLDS）＋（scheme 或 path）
// 外加一條反向守門：左片段本身已以媒體副檔名收尾 ⇒ 那是「作者剛好寫滿的完整網址」，
// 不接。
import { TLDS, endsWithMediaExt } from './url_fix';
import { withinOneMinute, isDbcsCell } from './comment_break';

// URL 字元類：與 url_fix.js 的 PATH / TermBuf.uriRegEx 的 host+path 類一致（純
// ASCII、不含空白），加上 scheme 會用到的字元。
const URL_CHAR_RE = /[A-Za-z0-9_#!:.?+=&%@\-/$^,;|*~'()]/;
const SCHEME_RE = /^(?:https?|ftp|telnet):\/\//i;
// host：label(.label)* + '.' + 允許清單 TLD。TLDS 已依長度排序（長的優先），\b 擋掉
// 「TLD 只是更長 label 的前綴」（i.imgur.comfoo 不成立）。
const HOST_RE = new RegExp(
  '^([A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.(?:' + TLDS.join('|') + '))\\b',
  'i'
);

const MAX_PER_BLOCK = 3;

function isUrlCell(chars, i) {
  const c = chars[i];
  return !!c && !isDbcsCell(chars, i) && URL_CHAR_RE.test(c.ch);
}

// 併起來的字串是不是一個值得連的網址 → { fixed, host }，否則 null。
function validateJoined(joined) {
  const hasScheme = SCHEME_RE.test(joined);
  const rest = joined.replace(SCHEME_RE, '');
  const m = HOST_RE.exec(rest);
  if (!m) return null;
  const after = rest.slice(m[0].length).replace(/^:\d+/, '');
  // host 之後只能是空的或路徑；其他形狀（如 host 後面直接接字母）不認。
  if (after && after[0] !== '/') return null;
  const hasPath = after.length > 1 && after[0] === '/';
  // 無 scheme 又無路徑 ⇒ url_fix 的 gray 那一類（產物只是首頁連結、證據薄弱），
  // 這裡直接排除——接合本來就該是「網址被切斷」而不是「兩個字剛好像網域」。
  if (!hasScheme && !hasPath) return null;
  return {
    fixed: hasScheme ? joined : 'https://' + joined,
    host: m[1].toLowerCase(),
  };
}

// detectWrappedUrls(chars, breaks) -> Array<{ original, fixed, host, gray, wrapped }>
// chars／breaks 來自 comment_merge.buildMergedCommentChars。絕大多數塊回 []。
export function detectWrappedUrls(chars, breaks) {
  if (!chars || !breaks || !breaks.length) return [];
  const out = [];
  const seen = new Set();
  for (let k = 0; k < breaks.length; ++k) {
    const br = breaks[k];
    if (!br.leftFull) continue; // 上一則沒被輸入欄寫滿 ⇒ 不是截斷
    if (!withinOneMinute(br.leftTime, br.rightTime)) continue;
    // 右片段必須從**下一則內容的第 0 欄**接續（換行 cell 的下一格就是），
    // 中間有空白就不是續行。
    if (!isUrlCell(chars, br.index + 1)) continue;
    let r = br.index + 1;
    while (isUrlCell(chars, r + 1)) ++r;
    // 左片段：緊貼換行 cell 往左取連續 URL 字元。
    if (!isUrlCell(chars, br.index - 1)) continue;
    let l = br.index - 1;
    while (isUrlCell(chars, l - 1)) --l;
    let left = '';
    for (let i = l; i < br.index; ++i) left += chars[i].ch;
    let right = '';
    for (let i = br.index + 1; i <= r; ++i) right += chars[i].ch;
    // 反向守門：左片段自己就以媒體副檔名收尾 ⇒ 完整網址剛好寫滿，不是殘段。
    if (endsWithMediaExt(left)) continue;
    const v = validateJoined(left + right);
    if (!v) continue;
    if (seen.has(v.fixed)) continue;
    seen.add(v.fixed);
    out.push({
      original: left + '\n' + right,
      fixed: v.fixed,
      host: v.host,
      gray: false, // 規則層自己就敢認 ⇒ 不進 AI 閘門（applyAiFix 無條件保留）
      wrapped: true,
    });
    if (out.length >= MAX_PER_BLOCK) break;
  }
  return out;
}
