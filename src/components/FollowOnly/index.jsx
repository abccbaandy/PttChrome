import { useEffect, useState } from "react";
import { IconStar, IconStarFilled } from "@tabler/icons-react";
import { i18n } from "../../js/i18n";
import { FOLLOW_ONLY_ID } from "../../js/follow_only";
import "./FollowOnly.css";

// 只看關注的切換鈕（P36，邏輯在 js/follow_only.js，設計見 docs/list-row-filter.md「只看關注」）。
// 位置與顯示與否只從 pttchrome.followOnly.onChange 來。
//
// 事件規則同 SearchStatus：mousedown preventDefault（不搶 #t 焦點）、滑鼠事件一律
// stopPropagation（App 的滑鼠入口在 window），App._onUploadLayer 也認 #followOnlyChip 放過。
const keepFocus = (e) => {
  e.preventDefault();
  e.stopPropagation();
};
const swallow = (e) => e.stopPropagation();

export const FollowOnly = ({ pttchrome }) => {
  const ctl = pttchrome && pttchrome.followOnly;
  const [state, setState] = useState(() => (ctl ? ctl.state : null));

  useEffect(() => {
    if (!ctl || typeof ctl.onChange !== "function") return undefined;
    return ctl.onChange((s) => setState(s));
  }, [ctl]);

  // 手機：切換入口在工具列「更多」；浮動鈕只在整段都被收起時出現（這時沒有卡片會被蓋到，
  // 而且畫面不能只剩一片空白卻不知道為什麼）。
  if (!state || !state.visible || (state.mobile && !state.empty)) return null;
  const Icon = state.on ? IconStarFilled : IconStar;
  const label = state.empty
    ? i18n("followOnly_empty")
    : i18n("followOnly_label");
  return (
    <button
      type="button"
      id={FOLLOW_ONLY_ID}
      className={
        "nomouse_command followOnlyChip" +
        (state.on ? " followOnlyChip--on" : "") +
        (state.mobile ? " followOnlyChip--mobile" : "")
      }
      style={
        state.mobile
          ? undefined
          : { right: state.right + 8, top: state.top + 1 }
      }
      aria-pressed={state.on ? "true" : "false"}
      title={i18n("followOnly_tip")}
      onMouseDown={keepFocus}
      onMouseUp={swallow}
      onContextMenu={swallow}
      onClick={(e) => {
        e.stopPropagation();
        ctl.toggle();
      }}
    >
      <Icon size={15} stroke={2} aria-hidden="true" />
      <span className="followOnlyLabel">{label}</span>
    </button>
  );
};

export default FollowOnly;
