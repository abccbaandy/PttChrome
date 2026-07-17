// Steamgifts giveaway 代碼自動連結。純邏輯（無 DOM/網路 → unit-testable）。
//
// Steam 板 [抽獎] 文慣例：遊戲名一行、下一行是 5 碼 giveaway 代碼（如 jQtf0）。
// 關鍵事實：https://www.steamgifts.com/giveaway/<code>/ 不帶遊戲名 slug 也有效
// （站方 redirect 到正式網址），所以不需要代碼↔遊戲名配對，只剩「哪列是代碼」。
//
// 防誤判兩層 gate（呼叫端 Screen#computeAnnotations 負責串接）：
//   1. 文章層：整篇出現 "steamgifts"（不分大小寫）才啟用偵測 —— 防一般文章的
//      5 碼短列（HELLO、版本號…）被誤連。
//   2. 列層：整列去除前後空白後恰為 5 碼英數（代碼固定 5 碼），推文/引文/夾在
//      句中的字串自然不命中。
//
// 代碼列是純 ASCII，rowToText 的字元 index 即 TermChar 欄位 index，無 DBCS 問題。

const CODE_RE = /^(\s*)([A-Za-z0-9]{5})\s*$/;

export function articleHasSteamgifts(texts) {
  if (!texts) return false;
  for (let i = 0; i < texts.length; ++i) {
    if (texts[i] && /steamgifts/i.test(texts[i])) return true;
  }
  return false;
}

// 回傳 [{ startCol, endCol, code, href }]；endCol 為 exclusive。
// 整列最多一個代碼（獨立成列的定義使然），不命中回傳 []。
export function detectGiveawayCodes(rowText) {
  if (!rowText) return [];
  const m = CODE_RE.exec(rowText);
  if (!m) return [];
  const startCol = m[1].length;
  const code = m[2];
  return [
    {
      startCol,
      endCol: startCol + code.length,
      code,
      href: "https://www.steamgifts.com/giveaway/" + code + "/",
    },
  ];
}
