// 手機好讀文章的檔頭卡片（docs/mobile.md「收起終端機標頭／狀態列」）。只在
// enhance.commentCards（＝手機換行版面＋穩定列，term_view._renderScreenLines）時由
// render/screen.js#_renderRow 取代 buildRow；桌機零改動（golden 快照不經過這裡）。
//
// pmore 的檔頭（mbbsd/pmore.c `_fh_disp_heads` ＝ 作者／標題／時間／轉信，最多
// FH_HEADERS=4 列）之後，第 fh.lines 列是整列 `─` 的分隔線（同檔 "header separator
// line"，bpref.rawmode＝MFDISP_RAW_NA 時才畫）。手機上：
//   作者  → 作者 id（暱稱），看板欄拿掉（已在 App Bar 副標）
//   標題  → 完整標題，可換行（App Bar 只放得下截斷版）
//   時間／轉信 → 淡色小字
//   分隔線 → 收起（render/collapsed_row.js）
// 判斷**只看該列自己**（列號 ＜ ARTICLE_META_MAX_ROWS ＋ 該列文字的形狀）⇒ dirty-row
// patch 的列獨立前提不破。反向讀取／從中段開始時第 0 列不是檔頭，形狀不吻合就照舊畫。
// 開燈的純文字模式（`作者: x (y) 看板: z`）同樣吃得下（parseArticleHeader 的冒號形狀）。
//
// 文字不走 LinkSegmentBuilder（檔頭沒有連結；`.wpadding` 會被 fixedResize 改寬）。
// 保留的外部契約：外層 span[type=bbsrow][srow]、內層 [data-type=bbsline][data-row]
// （選取複製反查）。**不得宣告 user-select**（css_user_select.test.js）。
import { el } from "./dom";
import { buildCollapsedRow } from "./collapsed_row";
import {
  rowToText,
  parseArticleHeader,
  parseArticleTitle,
} from "../js/comment_parse";

// 檔頭最多 4 列＋分隔線 1 列。
export const ARTICLE_META_MAX_ROWS = 5;

const AUTHOR_RE = /^\s*作者[:：]?\s+(.*?)\s*(?:看板[:：]?\s+\S+\s*)?$/;
const TIME_RE = /^\s*(時間|轉信)[:：]?\s+(.*?)\s*$/;
const RULE_RE = /^\s*─{8,}\s*$/;

// 該列是檔頭的哪一種（不是回 null）。
export function articleMetaKind(chars, row) {
  if (!(row >= 0 && row < ARTICLE_META_MAX_ROWS) || !chars) return null;
  const text = rowToText(chars);
  if (row === 0) return parseArticleHeader(text) ? "author" : null;
  if (parseArticleTitle(text)) return "title";
  if (TIME_RE.test(text)) return "time";
  if (RULE_RE.test(text)) return "rule";
  return null;
}

function line(row, cls, children) {
  return el(
    "span",
    { type: "bbsrow", srow: row, class: "articleMeta " + cls },
    el("span", { "data-type": "bbsline", "data-row": row }, children),
  );
}

// 檔頭列 → 節點；不是檔頭回 null（呼叫端照舊 buildRow）。
export function buildArticleMetaRow(chars, row) {
  const kind = articleMetaKind(chars, row);
  if (!kind) return null;
  if (kind === "rule") return buildCollapsedRow(row, "articleMetaRule");
  const text = rowToText(chars);
  if (kind === "author") {
    const m = AUTHOR_RE.exec(text);
    const who = (m && m[1]) || text.trim();
    return line(row, "articleMeta--author", [
      el("span", { class: "articleMetaLabel" }, "作者"),
      el("span", { class: "articleMetaValue" }, who),
    ]);
  }
  if (kind === "title") {
    return line(row, "articleMeta--title", [
      el("span", { class: "articleMetaValue" }, parseArticleTitle(text)),
    ]);
  }
  const t = TIME_RE.exec(text);
  return line(row, "articleMeta--time", [
    el("span", { class: "articleMetaLabel" }, t[1]),
    el("span", { class: "articleMetaValue" }, t[2]),
  ]);
}
