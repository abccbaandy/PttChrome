import { useEffect, useState } from "react";
import { i18n } from "../../js/i18n";
import { COMMENT_FILTER_BAR_ID } from "../../js/comment_filter";
import "./CommentFilterBar.css";

// 推文篩選（P29）的橫幅：一排切換鈕「全部｜推｜噓｜原 PO」（P41），點一下就換、目前那個亮起來；
// 「只看這個人」另外多一顆亮著的帳號鈕。狀態只從 view.onCommentFilterChange 來，
// 「全部」＝ view.clearCommentFilter()。不是 modal：不搶 #t 焦點（事件規則同 HomeDashboard）。
// 一個 byte 都不送（docs/comment-filter.md）。
const keepFocus = (e) => {
  e.preventDefault();
  e.stopPropagation();
};
const swallow = (e) => {
  e.stopPropagation();
};

// 只看推／噓（P39）沒有帳號；其餘是「只看這個人／原 PO」。
function bannerKey(filter) {
  if (filter.type === "噓") return "commentFilter_bannerBoo";
  if (filter.type === "推") return "commentFilter_bannerPush";
  return filter.op ? "commentFilter_bannerOp" : "commentFilter_banner";
}

// 目前亮哪一顆：'push'｜'boo'｜'op'｜'user'。「只看這個人」點的剛好是原 PO ⇒ 算原 PO。
export function activeFilterChip(filter, author) {
  if (!filter) return "all";
  if (filter.type === "推") return "push";
  if (filter.type === "噓") return "boo";
  if (filter.op || (author && filter.userid === author)) return "op";
  return "user";
}

export const CommentFilterBar = ({ pttchrome }) => {
  const view = pttchrome && pttchrome.view;
  const [filter, setFilter] = useState(null);
  const [mobile, setMobile] = useState(() => !!(pttchrome && pttchrome.mobile));

  useEffect(() => {
    if (!view || typeof view.onCommentFilterChange !== "function") return undefined;
    return view.onCommentFilterChange((f) => setFilter(f));
  }, [view]);
  useEffect(() => {
    if (!pttchrome || typeof pttchrome.onMobileChange !== "function")
      return undefined;
    return pttchrome.onMobileChange((m) => setMobile(!!m));
  }, [pttchrome]);

  if (!filter) return null;
  const author =
    typeof view.articleAuthorId === "function" ? view.articleAuthorId() : null;
  const active = activeFilterChip(filter, author);
  const label = String(i18n(bannerKey(filter)) || "").replace(
    "{id}",
    filter.userid || "",
  );

  const chips = [];
  if (active === "user")
    chips.push({ key: "user", text: filter.userid, run: null });
  chips.push({ key: "all", text: i18n("commentFilter_chipAll"), run: () => view.clearCommentFilter() });
  chips.push({ key: "push", text: i18n("commentFilter_chipPush"), run: () => view.setCommentTypeFilter("推") });
  chips.push({ key: "boo", text: i18n("commentFilter_chipBoo"), run: () => view.setCommentTypeFilter("噓") });
  if (author)
    chips.push({ key: "op", text: i18n("commentFilter_chipOp"), run: () => view.setCommentFilter(author, true) });

  return (
    <div
      id={COMMENT_FILTER_BAR_ID}
      className="commentFilterBar"
      data-mobile={mobile ? "" : undefined}
      role="group"
      aria-label={label}
      title={label}
      onMouseDown={keepFocus}
      onMouseUp={swallow}
      onClick={swallow}
      onContextMenu={swallow}
    >
      {chips.map((c) => (
        <button
          key={c.key}
          type="button"
          className="commentFilterChip"
          data-filter={c.key}
          aria-pressed={c.key === active ? "true" : "false"}
          title={c.key === "all" ? i18n("commentFilter_clear") : undefined}
          onMouseDown={keepFocus}
          onClick={(e) => {
            e.stopPropagation();
            if (c.key !== active && c.run) c.run();
          }}
        >
          {c.text}
        </button>
      ))}
    </div>
  );
};

export default CommentFilterBar;
