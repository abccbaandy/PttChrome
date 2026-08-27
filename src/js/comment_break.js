// 合併推文塊「換行邊界」的共用判準（無 DOM / 無網路）。
//
// comment_merge.buildMergedCommentChars 會在兩則推文之間插一個 '\n' cell，並在
// breaks[] 交出接合線索（leftFull / leftTime / rightTime）。跨行接合有兩個消費端
// ——url_wrap.js（網址被輸入欄切斷）與 aid_wrap.js（AID 8 碼被切斷）——它們共用
// 同一組「時間戳相差 ≤ 1 分鐘」與「這一格是不是 DBCS 的一半」判準，故抽在這裡，
// **不得複製第二份**（發散出去就是兩種行為）。
// 守護測試：tests/unit/comment_break.test.js（另有 url_wrap / aid_wrap 的整合守護）。

const TIME_RE = /^(\d{1,2})\/(\d{1,2}) (\d{2}):(\d{2})$/;

// 時間戳 "MM/DD HH:MM" → 分鐘數。月長一律當 31 天：只用來比「差 ≤ 1 分鐘」，
// 短月月底跨日會多算成差 2 天 ⇒ 判成不接，方向是安全的。
export function toMinutes(t) {
  const m = TIME_RE.exec(t || '');
  if (!m) return null;
  return ((+m[1] * 31 + +m[2]) * 24 + +m[3]) * 60 + +m[4];
}

export function withinOneMinute(a, b) {
  const ma = toMinutes(a);
  const mb = toMinutes(b);
  if (ma === null || mb === null) return false;
  return Math.abs(mb - ma) <= 1;
}

// 這一格是 DBCS 的一半嗎（lead 或 trail）。**必須看旗標不能只看 ch**：Big5 的
// trail byte 可能剛好是 0x40（'@'）這種合法 URL／AID 字元（見
// docs/enhanced-addon.md 踩坑 A）。越界（undefined）一律當 true＝不可用。
export function isDbcsCell(chars, i) {
  const c = chars[i];
  if (!c) return true;
  if (c.isLeadByte) return true;
  const prev = chars[i - 1];
  return !!(prev && prev.isLeadByte);
}
