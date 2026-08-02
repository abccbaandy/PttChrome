// 好讀模式「連續同作者推文合併」純邏輯（無 DOM / 無網路，unit 守護：
// tests/unit/comment_merge.test.js）。
//
// 規則（2026-08 使用者定案）：連續同 userid 的推文列合併成一塊，**一則一行**——
// 只去掉第 2 則起重複的「型別符＋作者 id」前綴與行尾時間戳，內容對齊首則的內容
// 起始欄（懸掛縮排，main.css .mergedCommentBlock）。跨作者各自分開
// （A A A B A A → A B A）；跨型別（推/噓/→）照合——PTT 同帳號短時間連推會自動
// 降為 →，要求同型別會斷掉最常見 case；塊首顯示第一則的型別符號。黑名單 hidden
// 列透明（好讀本來就整列移除，視覺上前後同作者相鄰）。FloorCounter／黑名單判定
// 完全不動：合併只是 render 層（Screen#computeAnnotations 之後的重組），樓層仍按
// 原始逐則計數。
//
// ---- 為何不猜「被輸入欄截斷的續行」（勿再加回 gap 門檻） ----
// 舊版（2026-07）會把「行尾剩餘空白 < 門檻」的列當成打滿被切斷，與下一則直接
// 串接，好把「漲到120」+「0？」復原成「1200？」。2026-08 反查 pttbbs 證實此路
// 不通，已整組拆除：
//   bbs.c#recommend        maxlength = 78 - 3(lead) - 6(date) - 1(space) - 6(time)
//                                        [- 15 if BRD_IPLOGRECMD 或 guest] - strlen(myid)
//   comments.c#FormatCommentString  "type id:%-maxlength(msg)" + tail
//   vtuikit.c#vgetstring   可輸入上限 iend+1 < len；全形另需 len - iend >= 3
//   term.ptt.cc 實測       ':' 後多一格 → 內容欄 [3+len(id)+2, 66)（IP 板 [.., 51)），
//                          時間戳固定 col 67..77，全行 78 欄
// 也就是說「作者剛好寫滿一句話」與「被輸入欄切斷」在畫面上**完全同形**（實例：
// AI_Art M.1785606011 三連推的第 2 則，內容 50 bytes ＝ 10 字 id 的理論上限），
// 任何寬度門檻都判不出來。唯一還有訊息量的訊號是行尾時間戳（真被截斷的續行幾乎
// 都在同一分鐘送出），但仍是啟發式 → 使用者決定不猜：一則一行等於「原生畫面減去
// 重複雜訊」，不可能斷錯，代價只是被截斷的句子分兩行顯示（原生本來就長這樣）。
//
// 所有邊界掃描都在 TermChar cell 上做：型別符/id/時間戳/IP 全是 ASCII
// （cell==char），只有內容區有 DBCS——內容整段 slice、不逐字解讀，故不需
// text↔cell 對映（rowToText 的 DBCS 收合在這裡不會發生）。

// 推文列佈局（見 comment_parse.js COMMENT_RE / COMMENT_USERID_COL）：
//   cols 0-1 型別符（推/噓/→，DBCS lead+trail）、col 2 空格、col 3 起 ASCII id、
//   可選空格（Stock 板 BRD_ALIGNEDCMT 的 id 補空格）、':'、空格、內容、
//   padding、可選 IP（BRD_IPLOGRECMD 板）、" MM/DD HH:MM" 時間戳、行尾空白。
const ASCII_ID_RE = /[0-9A-Za-z]/;
const TAIL_TIME_RE = /(\d{1,2}\/\d{2} \d{2}:\d{2})$/; // 鏡像 string_util COMMENT_TIME_RE
const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

// 一列推文的內容 cell 邊界：{ start, end, time, timeStart }（[start, end) 為內容、
// time 為該則時間戳字串、timeStart 為它的起始欄——合併塊要把最後一則的時間戳
// cell 原樣接到段尾）。切不出完整形狀回傳 null——caller 對整個 run fail-safe 還原
// 逐列渲染，寧可不合併也不錯切（同 parseListAuthor 的失敗安全原則）。
export function commentContentCells(chars) {
  if (!chars || chars.length < 8) return null;
  // ---- 內容起點：跳過 2-cell 型別符 + 空格 + id（可選補空格）+ ':' + 空格 ----
  if (!chars[2] || chars[2].ch !== ' ') return null;
  let i = 3;
  const idStart = i;
  while (i < chars.length && chars[i] && ASCII_ID_RE.test(chars[i].ch)) ++i;
  if (i === idStart) return null;
  while (i < chars.length && chars[i] && chars[i].ch === ' ') ++i;
  if (!chars[i] || chars[i].ch !== ':') return null;
  ++i;
  if (chars[i] && chars[i].ch === ' ') ++i;
  const start = i;
  // ---- 內容終點：右端剝行尾空白 → 時間戳 → 空白 → 可選 IPv4 → 空白 ----
  let e = chars.length - 1;
  const isSpace = (k) => chars[k] && chars[k].ch === ' ';
  while (e >= start && isSpace(e)) --e;
  // 時間戳（"MM/DD HH:MM"，月份 1-2 位）全 ASCII：從右往左收集足夠的尾字串再比對。
  let tail = '';
  for (let k = e; k >= start && e - k < 12; --k) {
    const c = chars[k];
    if (!c || c.ch.charCodeAt(0) > 0x7f || c.isLeadByte) break;
    tail = c.ch + tail;
  }
  const tm = tail.match(TAIL_TIME_RE);
  if (!tm) return null;
  const time = tm[1];
  e -= time.length;
  if (!isSpace(e)) return null; // 時間戳前必有空白（COMMENT_TIME_RE 的 \s）
  const timeStart = e + 1;
  while (e >= start && isSpace(e)) --e;
  // 可選 IP（BRD_IPLOGRECMD 板）：緊鄰時間戳左側、被空白隔開的嚴格 IPv4 token。
  let tok = '';
  let k = e;
  while (k >= start && chars[k] && /[\d.]/.test(chars[k].ch) && !chars[k].isLeadByte) {
    tok = chars[k].ch + tok;
    --k;
  }
  if (tok && IPV4_RE.test(tok) && (k < start || (chars[k] && chars[k].ch === ' '))) {
    e = k;
    while (e >= start && isSpace(e)) --e;
  }
  return { start, end: e + 1, time, timeStart };
}

// 逐列 annotation（Screen#computeAnnotations 產出，推文列帶 userid / hidden）→
// 合併 run 清單 [{ userid, rows }]（rows 為可見推文列 index、≥2 才成 run）。
export function groupSameAuthorRuns(anns) {
  const runs = [];
  let current = null;
  const close = () => {
    if (current && current.rows.length >= 2) runs.push(current);
    current = null;
  };
  for (let i = 0; i < anns.length; ++i) {
    const a = anns[i];
    if (a && a.userid) {
      if (a.hidden) continue; // 黑名單列透明：不斷 run、不入 run
      if (current && current.userid === a.userid) current.rows.push(i);
      else {
        close();
        current = { userid: a.userid, rows: [i] };
      }
    } else {
      close(); // 非推文列（含只有 fixedUrls 之類的 annotation）斷 run
    }
  }
  close();
  return runs;
}

// run → 合併後的 TermChar[]：首列前綴「推 id: 」保留原色（**作者在第一則**），
// 其後各列內容 slice 以換行 cell 逐則分行，末行補上**最後一則**原列「內容尾 →
// 時間戳結束」整段（padding＋可選 IP＋時間）→ 時間**置右對齊到與原生相同的欄**
// （使用者 2026-08 定案：作者在頭、時間在尾且比照原生位置）。全部沿用原列 cell
// ——配色與原生一致、且是一般文字可被 getSelection 選取複製（舊版是
// .mergedCommentTime React 節點＋user-select:none，不可複製）。回傳：
//   chars        合併後的 cell 陣列
//   contentStart 首則內容起始欄 → 懸掛縮排寬度（Screen 換算像素）
// run 中任一列切不出邊界回傳 null（caller 還原逐列渲染）。
//
// 內容 cell 都沿用 lines 內的既有 TermChar 實例——絕不可自造 plain object，
// prototype 方法（isStartOfURL 等）一剝離 LinkSegmentBuilder 就 runtime 崩潰
// （pageLines JSON-clone 事故的同型地雷，見 CLAUDE.md 測試段）。內容 slice 保留
// URL flag，推文裡的連結／inline 圖片預覽照常。唯一的合成 cell 是換行：以
// Object.create 繼承來源空格 cell 的 prototype 再覆寫 ch='\n'（clone 而非
// mutate——原 cell 屬於 buf，直接改會污染畫面），配合 .mergedCommentBlock 的
// pre-wrap 渲染成真換行。
export function buildMergedCommentChars(lines, run) {
  const infos = [];
  for (const r of run.rows) {
    const info = commentContentCells(lines[r]);
    if (!info) return null;
    infos.push(info);
  }
  const firstRow = lines[run.rows[0]];
  const out = firstRow.slice(0, infos[0].start);
  const prefixLen = out.length;
  // 換行 cell 樣板：col 2 的空格（必存在、預設屬性、無 URL flag）。
  const spaceSrc = firstRow[2];
  const newlineCell = () =>
    Object.assign(Object.create(Object.getPrototypeOf(spaceSrc)), spaceSrc, {
      ch: '\n',
    });
  let lastContentful = -1;
  for (let n = 0; n < run.rows.length; ++n) {
    const rowChars = lines[run.rows[n]];
    const info = infos[n];
    if (info.end <= info.start) continue; // 空內容列：跳過
    if (out.length > prefixLen) out.push(newlineCell());
    for (let c = info.start; c < info.end; ++c) out.push(rowChars[c]);
    lastContentful = n;
  }
  if (lastContentful < 0) return null; // 整組空內容：沒東西可合併
  // 末行接上該列「內容尾 → 時間戳結束」整段（padding＋可選 IP＋時間）**原樣**。
  // run 內必為同 userid ⇒ 各列 info.start 相同 ⇒ 合併末行的左緣偏移等於原列的，
  // 故時間戳落在與原生逐列渲染完全相同的欄（置右對齊），不需任何 CSS 定位。
  const lastRow = lines[run.rows[lastContentful]];
  const lastInfo = infos[lastContentful];
  const tailEnd = lastInfo.timeStart + lastInfo.time.length;
  for (let c = lastInfo.end; c < tailEnd; ++c) out.push(lastRow[c]);
  return { chars: out, contentStart: infos[0].start };
}
