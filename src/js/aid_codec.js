// AIDc（PTT 文章代碼）⇄ 檔名 `M.<v1>.A.<v2>` 的雙向換算，外加 ptt.cc 文章網址的拆解。
//
// 純函式：吃字串、回字串／物件，不碰 DOM／網路（tests/unit/aid_codec.test.js）。
// 「辨識」畫面上哪一段是 AID 在 aid_parse.js，「URL 合約」在 deep_link.js；這裡只做換算。
//
// 為什麼可以離線算：AIDc 只編碼檔名中段，看板名不在裡面（所以短碼 → 完整網址永遠需要
// 外部提供看板）。實作逐條對照 pttbbs @ 3rd_script/pttbbs/mbbsd/aids.c：
//
//   fn2aidu   (aids.c:6-51)   aidu = ((type & 0xf) << 44) | ((v1 & 0xffffffff) << 12) | (v2 & 0xfff)
//                             type: 'M' → 0（一般文章）、'G' → 1（精華區）
//                             v1  : 32-bit unix timestamp（檔名十進位那段）
//                             v2  : 檔名最後三碼十六進位；舊檔名可能整段不存在 ⇒ 0
//   aidu2aidc (aids.c:56-74)  以 AIDC_TABLE 逐位取模填滿 buf[0..7] ⇒ **恆 8 字**
//   aidu2fn   (aids.c:79-89)  snprintf("%c.%d.A.%03X") ⇒ hex 大寫、補滿 3 位
//   aidc2aidu (aids.c:91-125) aidu = (aidu << 6) | v，遇空白／'@' 停止、遇非法字元回 0
//
// 檔名的權威 regex 在 pttbbs/docs/aids.txt:49：
//   /^(M|G)\.(\d+)\.A(?:\.([0-9A-F]{3}))?$/
// ——`.A` 後面**可以沒有**十六進位那段（舊程式產出的檔名），那時 v2 視為 0。
//
// 位元運算刻意不用 `<<`：aidu 最大 2^48，而 JS 的位元運算只有 32-bit（`1 << 44` 會
// 得到 4096）。改用乘除法，全程落在 2^53 內仍然精確，也不必動用 BigInt。
//
// 2038 之後 pttbbs 自己會印出負的 v1（aids.c:87 把 unsigned 丟進 %d）；我方一律輸出
// 無號十進位，不模擬那個溢位。

// aids.c:58 的 aidu2aidc_table，64 字。
const AIDC_TABLE =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";
const AIDC_LEN = 8;
// 2^44 / 2^12 / 0xfff + 1，取代 C 的 <<44 / <<12 / &0xfff。
const TYPE_SCALE = 17592186044416;
const V1_SCALE = 4096;
const V2_MOD = 4096;
const V1_MOD = 4294967296;

// AIDc 恆為 8 字（產生端 aidu2aidc 的 buf 就是 8 格）——與 aid_parse.js 的
// AID_LEN / isAidChar、deep_link.js 的 AID_RE 是同一組規則。
const AIDC_RE = /^[0-9A-Za-z_-]{8}$/;

// 檔名（可含 ptt.cc 網址尾巴的 .html）。hex 放寬到 1~3 位且大小寫皆吃：產生端一定是
// 三位大寫，但手打的連結不該因為打了 `.a` 就整條失效。
const FN_RE = /^([MG])\.(\d{1,10})\.A(?:\.([0-9A-Fa-f]{1,3}))?$/;

// pttbbs 板名：brdname[IDLEN + 1]，IDLEN = 12。上限放寬到 32 只是防呆用的長度閘門
// （真的不存在的板名交給 PTT 自己回「找不到看板」比較誠實），字元集則必須收緊：
// 這個字串會被原樣送進 `s<board>\r`，不可以夾雜控制字元或空白。
// deep_link.js 直接 import 這一份，不要再抄第二份。
export const BOARD_RE = /^[0-9A-Za-z][0-9A-Za-z_.-]{1,31}$/;

// 只有 ptt.cc 的網頁版文章網址算數。其他站台長得再像也不是這篇文章。
const PTT_HOSTS = ["www.ptt.cc", "ptt.cc"];
const ARTICLE_PATH_RE = /^\/bbs\/([^/]+)\/([^/]+?)\/?$/;

export function isAidc(aid) {
  return typeof aid === "string" && AIDC_RE.test(aid);
}

// "M.1786265274.A.5E3"（尾巴可帶 .html）→ "1gU3xHKD"；不是合法檔名回 null。
export function fnToAid(fn) {
  if (typeof fn !== "string") return null;
  const bare = fn.replace(/\.html$/i, "");
  const m = FN_RE.exec(bare);
  if (!m) return null;
  const v1 = parseInt(m[2], 10);
  // 檔名那段是 32-bit time_t；超出範圍的數字不是時間戳，是別的東西。
  if (!(v1 >= 0) || v1 >= V1_MOD) return null;
  const v2 = m[3] ? parseInt(m[3], 16) : 0;
  const type = m[1] === "M" ? 0 : 1;
  let aidu = type * TYPE_SCALE + v1 * V1_SCALE + v2;
  let out = "";
  for (let i = 0; i < AIDC_LEN; ++i) {
    out = AIDC_TABLE.charAt(aidu % 64) + out;
    aidu = Math.floor(aidu / 64);
  }
  return out;
}

// "1gU3xHKD" → "M.1786265274.A.5E3"；不是 8 字合法 AIDc 回 null。
// 回傳的是**檔名**（不含 .html）——要組網址的人自己接。
export function aidToFn(aid) {
  if (!isAidc(aid)) return null;
  let aidu = 0;
  for (let i = 0; i < aid.length; ++i) {
    const v = AIDC_TABLE.indexOf(aid.charAt(i));
    if (v < 0) return null;
    aidu = aidu * 64 + v;
  }
  const type = Math.floor(aidu / TYPE_SCALE) % 16;
  const v1 = Math.floor(aidu / V1_SCALE) % V1_MOD;
  const v2 = aidu % V2_MOD;
  // aids.c:87 的 "%03X"：大寫、補滿三位。
  const hex = v2.toString(16).toUpperCase().padStart(3, "0");
  return (type === 0 ? "M" : "G") + "." + v1 + ".A." + hex;
}

// https://www.ptt.cc/bbs/<Board>/M.<v1>.A.<v2>.html → { board, aid } | null。
// 也吃 pttbbs USE_AID_URL 那種尾段直接是 AIDc、且沒有 .html 的形式（aids/bbs.c:395-417）。
export function parseArticleUrl(href) {
  if (typeof href !== "string") return null;
  let url;
  try {
    url = new URL(href);
  } catch (e) {
    return null;
  }
  if (PTT_HOSTS.indexOf(url.hostname) < 0) return null;
  const m = ARTICLE_PATH_RE.exec(url.pathname);
  if (!m) return null;
  const board = m[1];
  if (!BOARD_RE.test(board)) return null;
  const tail = m[2];
  const aid = fnToAid(tail) || (isAidc(tail) ? tail : null);
  return aid ? { board: board, aid: aid } : null;
}
