import { useEffect, useState } from "react";
import { IconSearch, IconPlus, IconX, IconStar } from "@tabler/icons-react";
import { i18n } from "../../js/i18n";
import { SEARCH_STATUS_ID } from "../../js/search_status";
import "./SearchStatus.css";

// 搜尋狀態列（邏輯在 js/search_status.js，設計見 docs/article-search.md「搜尋狀態列」）。
// 位置與顯示與否只從 pttchrome.searchStatus.onChange 來。
//
// 事件規則同 AidBackButton：mousedown preventDefault（不搶 #t 焦點）、滑鼠事件一律
// stopPropagation（App 的滑鼠入口在 window），App._onUploadLayer 也認 #searchStatus 放過。
const keepFocus = (e) => {
  e.preventDefault();
  e.stopPropagation();
};
const swallow = (e) => e.stopPropagation();

const KIND_KEY = {
  title: "searchStatus_title",
  author: "searchStatus_author",
  push: "searchStatus_push",
};

export function searchStatusLabel(conds) {
  if (!conds || !conds.length) return i18n("searchStatus_unknown");
  const parts = conds.map(
    (c) => i18n(KIND_KEY[c.kind]) + "「" + c.text + "」",
  );
  return i18n("searchStatus_searching") + parts.join("・");
}

// 文摘標示（P97）：只在手機列表卡片出現（判斷在 search_status.statusKind），同一個位置與事件規則。
// 「完整列表」＝替使用者按 Tab。
const DigestStatus = ({ ctl, mobile }) => (
  <div
    id={SEARCH_STATUS_ID}
    className={
      "nomouse_command searchStatus searchStatus--digest" +
      (mobile ? " searchStatus--mobile" : "")
    }
    data-search-status-kind="digest"
    role="status"
    onMouseDown={keepFocus}
    onMouseUp={swallow}
    onClick={swallow}
    onContextMenu={swallow}
  >
    <IconStar size={15} stroke={2} aria-hidden="true" />
    <span className="searchStatusLabel">{i18n("digestStatus_label")}</span>
    <button
      type="button"
      className="searchStatusBtn"
      data-search-status="leaveDigest"
      title={i18n("digestStatus_leaveTip")}
      onMouseDown={keepFocus}
      onClick={(e) => {
        e.stopPropagation();
        ctl.leaveDigest();
      }}
    >
      <span>{i18n("digestStatus_leave")}</span>
    </button>
  </div>
);

export const SearchStatus = ({ pttchrome }) => {
  const ctl = pttchrome && pttchrome.searchStatus;
  const [state, setState] = useState(() => (ctl ? ctl.state : null));

  useEffect(() => {
    if (!ctl || typeof ctl.onChange !== "function") return undefined;
    return ctl.onChange((s) => setState(s));
  }, [ctl]);

  if (!state || !state.visible) return null;
  if (state.kind === "digest")
    return <DigestStatus ctl={ctl} mobile={state.mobile} />;
  const label = searchStatusLabel(state.conds);
  return (
    <div
      id={SEARCH_STATUS_ID}
      className={
        "nomouse_command searchStatus" +
        (state.mobile ? " searchStatus--mobile" : "")
      }
      style={state.mobile ? undefined : { right: state.right + 8, top: state.top + 1 }}
      role="status"
      onMouseDown={keepFocus}
      onMouseUp={swallow}
      onClick={swallow}
      onContextMenu={swallow}
    >
      <IconSearch size={15} stroke={2} aria-hidden="true" />
      <span className="searchStatusLabel" title={label}>
        {label}
      </span>
      <button
        type="button"
        className="searchStatusBtn"
        data-search-status="add"
        title={i18n("searchStatus_addTip")}
        onMouseDown={keepFocus}
        onClick={(e) => {
          e.stopPropagation();
          ctl.addCondition();
        }}
      >
        <IconPlus size={14} stroke={2.2} aria-hidden="true" />
        <span>{i18n("searchStatus_add")}</span>
      </button>
      <button
        type="button"
        className="searchStatusBtn searchStatusBtn--close"
        data-search-status="leave"
        title={i18n("searchStatus_leaveTip")}
        aria-label={i18n("searchStatus_leaveTip")}
        onMouseDown={keepFocus}
        onClick={(e) => {
          e.stopPropagation();
          ctl.leave();
        }}
      >
        <IconX size={15} stroke={2.2} aria-hidden="true" />
      </button>
    </div>
  );
};

export default SearchStatus;
