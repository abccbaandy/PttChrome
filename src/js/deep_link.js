// Deep link (外部連結 → 直接跳到某篇文章) 的 URL 解析與組裝。
//
// 純函式：吃字串、回字串／物件，不碰 window.location / history。呼叫端
// (main.jsx / deep_link_controller.js) 才負責讀寫瀏覽器狀態，所以整組行為可以
// 在 unit test 裡驗完（tests/unit/deep_link.test.js）。
//
// 格式決策：**hash 為主**。
//   - GitHub Pages 沒有 404.html fallback（也刻意不加），path-based 的
//     /Gossiping/1abcDEFG 會直接吃 GitHub 的 404 頁；hash 一定拿得到 index.html。
//   - hash 不會送到 server，也不會進 Referer。
//   - 同一個分頁再貼一次連結只觸發 hashchange，不重載、不重新登入。
//
// 產生用的正規形式刻意做到最短、讓人手打得出來（需求：其他程式要能輕鬆手組）：
//   https://<站台>/#<Board>/<AID>
//   https://example.github.io/pttchrome/#Gossiping/1gIeu-3A
// 另外相容兩種只吃不產的形式，讓既有的 key=value 習慣也能用：
//   #aid=<AID>&board=<Board>      （順序不拘）
//   ?board=<Board>&aid=<AID>      （query，會整頁重載）

// AIDc 恆為 8 字，字元集 "0123456789A-Za-z-_"（pttbbs mbbsd/aids.c aidu2aidc）
// —— 與 aid_parse.js 的 AID_LEN / isAidChar 同一組規則，那裡是逐格掃描版。
const AID_RE = /^[0-9A-Za-z_-]{8}$/;

// pttbbs 板名：brdname[IDLEN + 1]，IDLEN = 12。上限放寬到 32 只是防呆用的長度
// 閘門（真的不存在的板名交給 PTT 自己回「找不到看板」比較誠實），字元集則必須
// 收緊：這個字串會被原樣送進 `s<board>\r`，不可以夾雜控制字元或空白。
const BOARD_RE = /^[0-9A-Za-z][0-9A-Za-z_.-]{1,31}$/;

// #<Board>/<AID>，允許前導斜線（#/Gossiping/1abcDEFG 也吃）
const PATH_FORM_RE = /^\/?([^/]+)\/([^/]+)\/?$/;

const QUERY_KEYS = ["board", "aid"];

// 型別檢查不可省：RegExp#test 會先把參數轉成字串，BOARD_RE.test(null) 拿到的是
// "null" ⇒ 通過，於是 buildDeepLink(base, null, aid) 會產出 "#null/<aid>"。
function isValid(board, aid) {
  return (
    typeof board === "string" &&
    typeof aid === "string" &&
    BOARD_RE.test(board) &&
    AID_RE.test(aid)
  );
}

// decodeURIComponent 對半截的 % 序列會 throw；壞字串一律當成「沒有 deep link」。
function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch (e) {
    return null;
  }
}

function fromPair(board, aid) {
  if (!board || !aid) return null;
  const b = safeDecode(board);
  const a = safeDecode(aid);
  if (b === null || a === null) return null;
  return isValid(b, a) ? { board: b, aid: a } : null;
}

function parseHash(hash) {
  // location.hash 含前導 '#'；空字串 / 單獨一個 '#' 都沒東西可解。
  const raw = hash.charAt(0) === "#" ? hash.slice(1) : hash;
  if (!raw) return null;
  // key=value 形式優先判斷：'aid=…&board=…' 不含 '/'，不會誤入路徑形式。
  if (raw.indexOf("=") >= 0) {
    const params = new URLSearchParams(raw);
    return fromPair(params.get("board"), params.get("aid"));
  }
  const m = PATH_FORM_RE.exec(raw);
  return m ? fromPair(m[1], m[2]) : null;
}

// href → { board, aid } | null。hash 先於 query（正規形式優先），兩者都不合法
// 就回 null＝這不是一個 deep link，照常開站。
export function parseDeepLink(href) {
  let url;
  try {
    url = new URL(href);
  } catch (e) {
    return null;
  }
  const fromHash = parseHash(url.hash);
  if (fromHash) return fromHash;
  return fromPair(url.searchParams.get("board"), url.searchParams.get("aid"));
}

// 分享用連結。刻意只保留 origin + pathname：目前的 query 可能帶著這台機器才有
// 意義的東西（?site= 之類），不該跟著散出去。
export function buildDeepLink(baseHref, board, aid) {
  if (!isValid(board, aid)) return null;
  let url;
  try {
    url = new URL(baseHref);
  } catch (e) {
    return null;
  }
  return url.origin + url.pathname + "#" + board + "/" + aid;
}

// 消費掉 deep link 後要呼叫（history.replaceState 用）：不然使用者按 F5 會再跳
// 一次，而那時他早就人在別篇文章了。只拆掉 deep-link 參數，其餘 query 原樣留著。
export function stripDeepLink(href) {
  let url;
  try {
    url = new URL(href);
  } catch (e) {
    return href;
  }
  if (parseHash(url.hash)) url.hash = "";
  if (fromPair(url.searchParams.get("board"), url.searchParams.get("aid"))) {
    for (let i = 0; i < QUERY_KEYS.length; ++i)
      url.searchParams.delete(QUERY_KEYS[i]);
  }
  // URL#toString 對「有 search 但清空了」會留下一個裸 '?'，補掉它。
  return url.toString().replace(/\?(?=#|$)/, "");
}
