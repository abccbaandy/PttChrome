import { useEffect, useState } from "react";
import { i18n } from "../../js/i18n";
import { COMMENT_FILTER_BAR_ID } from "../../js/comment_filter";
import "./CommentFilterBar.css";

// 推文篩選（P29）的橫幅：「只顯示 xxx 的推文 ✕」。狀態只從 view.onCommentFilterChange 來，
// 按 ✕ ＝ view.clearCommentFilter()。不是 modal：不搶 #t 焦點（事件規則同 HomeDashboard）。
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
  const label = String(i18n(bannerKey(filter)) || "").replace(
    "{id}",
    filter.userid || "",
  );
  return (
    <div
      id={COMMENT_FILTER_BAR_ID}
      className="commentFilterBar"
      data-mobile={mobile ? "" : undefined}
      role="status"
      onMouseDown={keepFocus}
      onMouseUp={swallow}
      onClick={swallow}
      onContextMenu={swallow}
    >
      <span className="commentFilterLabel">{label}</span>
      <button
        type="button"
        className="commentFilterClose"
        aria-label={i18n("commentFilter_clear")}
        title={i18n("commentFilter_clear")}
        onMouseDown={keepFocus}
        onClick={(e) => {
          e.stopPropagation();
          view.clearCommentFilter();
        }}
      >
        ✕
      </button>
    </div>
  );
};

export default CommentFilterBar;
