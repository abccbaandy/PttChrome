import { useEffect, useState } from "react";
import { i18n } from "../../js/i18n";
import {
  FAST_SCROLL_ID,
  FAST_SCROLL_HANDLE_H,
  FAST_SCROLL_HANDLE_W,
} from "../../js/list_fast_scroll";
import "./ListFastScroll.css";

// 列表快速捲動把手（P30，邏輯在 js/list_fast_scroll.js，設計見 docs/easy-reading-list.md
// 「快速捲動把手」）。位置與顯示與否只從 pttchrome.listFastScroll.onChange 來。
//
// 事件：pointer 事件＋setPointerCapture（滑鼠與觸控同一套；手指拖出把手也跟得到）。
// pointerdown preventDefault（不搶 #t 焦點、不出相容的 mousedown），滑鼠事件一律
// stopPropagation（App 的滑鼠入口在 window）；data-own-control ＋ App._onUploadLayer
// 也認 #listFastScrollHandle 放過。CSS touch-action:none ⇒ 拖把手時瀏覽器不捲頁面。
const swallow = (e) => e.stopPropagation();

export const ListFastScroll = ({ pttchrome }) => {
  const ctl = pttchrome && pttchrome.listFastScroll;
  const [state, setState] = useState(() => (ctl ? ctl.state : null));

  useEffect(() => {
    if (!ctl || typeof ctl.onChange !== "function") return undefined;
    return ctl.onChange((s) => setState(s));
  }, [ctl]);

  if (!state || !state.visible) return null;
  const handleTop =
    state.top + state.frac * (state.height - FAST_SCROLL_HANDLE_H);
  const left = state.right - FAST_SCROLL_HANDLE_W;
  return (
    <>
      <div
        id={FAST_SCROLL_ID}
        data-own-control="1"
        role="slider"
        tabIndex={-1}
        aria-label={i18n("listFastScroll_label")}
        aria-orientation="vertical"
        aria-valuemin={1}
        aria-valuemax={state.hi}
        aria-valuenow={state.num != null ? state.num : undefined}
        className={
          "nomouse_command listFastScroll" +
          (state.dragging ? " listFastScroll--dragging" : "")
        }
        style={{ top: handleTop, left }}
        onPointerDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (e.currentTarget.setPointerCapture)
            e.currentTarget.setPointerCapture(e.pointerId);
          ctl.dragStart(e.clientY);
        }}
        onPointerMove={(e) => {
          e.stopPropagation();
          ctl.dragMove(e.clientY);
        }}
        onPointerUp={(e) => {
          e.stopPropagation();
          ctl.dragEnd(true);
        }}
        onPointerCancel={() => ctl.dragEnd(false)}
        onMouseDown={swallow}
        onMouseUp={swallow}
        onClick={swallow}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <span className="listFastScrollGrip" aria-hidden="true" />
      </div>
      {state.dragging && state.num != null ? (
        <div
          className="listFastScrollBubble"
          aria-hidden="true"
          style={{
            top: handleTop + FAST_SCROLL_HANDLE_H / 2,
            right: Math.max(8, window.innerWidth - left + 6),
          }}
        >
          {i18n("listFastScroll_num").replace("{n}", String(state.num))}
        </div>
      ) : null}
    </>
  );
};

export default ListFastScroll;
