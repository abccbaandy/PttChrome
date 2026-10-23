import { useEffect, useState } from "react";
import { IconX } from "@tabler/icons-react";
import { i18n } from "../../js/i18n";
import { BOARD_TABS_ID } from "../../js/board_tabs";
import "./BoardTabs.css";

// 看板分頁（邏輯在 js/board_tabs.js，設計見 docs/board-tabs.md）。位置與顯示與否只從
// pttchrome.boardTabs.onChange 來。
//   - 桌機：疊在終端機第 1 列（文章列表的按鍵提示列）上，現在這個板反白；× 與右鍵關掉。
//   - 手機：App Bar 右邊（標題就是現在這個板 ⇒ 只列別的板），長按關掉。
// 事件規則同 AidBackButton：mousedown preventDefault（不搶 #t 焦點）、滑鼠事件一律
// stopPropagation（App 的滑鼠入口在 window），App._onUploadLayer 也認 #boardTabs 放過。
const keepFocus = (e) => {
  e.preventDefault();
  e.stopPropagation();
};
const swallow = (e) => e.stopPropagation();

export const BoardTabs = ({ pttchrome }) => {
  const ctl = pttchrome && pttchrome.boardTabs;
  const [state, setState] = useState(() => (ctl ? ctl.state : null));

  useEffect(() => {
    if (!ctl || typeof ctl.onChange !== "function") return undefined;
    return ctl.onChange((s) => setState(s));
  }, [ctl]);

  if (!state || !state.visible) return null;
  const cur = (state.current || "").toLowerCase();
  const tabs = state.mobile
    ? state.tabs.filter((n) => n.toLowerCase() !== cur)
    : state.tabs;
  return (
    <div
      id={BOARD_TABS_ID}
      className={"boardTabs" + (state.mobile ? " boardTabs--mobile" : "")}
      role="tablist"
      aria-label={i18n("boardTabs_label")}
      style={
        state.mobile
          ? undefined
          : {
              left: state.left,
              top: state.top,
              width: state.width,
              height: state.rowHeight,
            }
      }
      onMouseDown={keepFocus}
      onMouseUp={swallow}
      onClick={swallow}
      onContextMenu={swallow}
    >
      {tabs.map((name) => {
        const active = name.toLowerCase() === cur;
        return (
          <span
            key={name}
            className={"boardTab" + (active ? " is-active" : "")}
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              className="boardTabName"
              data-board-tab={name}
              title={
                active ? name : i18n("boardTabs_openTip").replace("{0}", name)
              }
              onMouseDown={keepFocus}
              onClick={(e) => {
                e.stopPropagation();
                ctl.open(name);
              }}
              onContextMenu={(e) => {
                // 右鍵（手機長按）＝關掉這個分頁，不開瀏覽器選單。
                e.preventDefault();
                e.stopPropagation();
                ctl.close(name);
              }}
            >
              {name}
            </button>
            {!active && !state.mobile && (
              <button
                type="button"
                className="boardTabClose"
                data-board-tab-close={name}
                aria-label={i18n("boardTabs_closeTip").replace("{0}", name)}
                title={i18n("boardTabs_closeTip").replace("{0}", name)}
                onMouseDown={keepFocus}
                onClick={(e) => {
                  e.stopPropagation();
                  ctl.close(name);
                }}
              >
                <IconX size={12} stroke={2.4} aria-hidden="true" />
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
};

export default BoardTabs;
