import { useEffect, useId, useRef, useState, useCallback } from "react";
import { Drawer } from "@mantine/core";
import { useReducedMotion } from "@mantine/hooks";
import "./MobileSheet.css";

// 手機 bottom sheet（docs/mobile.md「Bottom sheet」）：「更多」、長按選單、搜尋彈窗在手機上
// 的外殼。底層是 Mantine Drawer（position bottom）：遮罩點了就收、slide-up 動畫
// （prefers-reduced-motion 時不動）。
//
// 三條規則：
//   1. 開著＝modal：經 App.setModalOpen 具名來源（每個實例自己一個 id）推導，不直接寫
//      modalShown。遮罩是一般 div，點下去的 click 會到 window 上的 App 滑鼠入口 ——
//      靠 modalShown 早退，才不會被當成點終端機（送鍵給 PTT）。
//   2. 系統返回（邊緣滑動／返回鍵）＝收起 sheet：開著時向 App.registerSheetDismiss 登記，
//      history_back_guard 在送 ← 之前先問 App.dismissTopSheet()。接住原生返回，不自己模擬。
//   3. 拖曳把手往下拉超過 SHEET_DISMISS_DRAG_PX 收起；只有把手區接手勢，內容照常捲動。
// float：長按選單不貼底，改浮在長按的那一列旁邊（js/sheet_placement.js#floatMenuPlacement
// 的結果）——手指移動距離短、也不蓋住那一列。浮動時沒有拖曳把手（遮罩／返回照樣收起）。
// footer：固定在捲動區下方的列（送出鍵），內容再長、鍵盤再高都看得到，不必先收鍵盤
// 才點得到（LongPushModal 手機版）。
// z-index 高於底部工具列（2500）與 App Bar：sheet 開著時兩條 bar 都在遮罩下面。
export const SHEET_Z_INDEX = 3000;
export const SHEET_DISMISS_DRAG_PX = 80;
// 與 MobileSheet.css .mobileSheet 的 max-height 同一式（inline maxHeight 要跟它取 min）。
const SHEET_CSS_MAX_HEIGHT = "calc(100dvh - 48px - var(--vv-kb-inset, 0px))";

export const MobileSheet = ({
  pttchrome,
  opened,
  onClose,
  title,
  children,
  sheetKey,
  float = null,
  footer = null,
  closeOnClickOutside = true,
}) => {
  const reduceMotion = useReducedMotion();
  const id = useId();
  const [drag, setDrag] = useState(0);
  const startY = useRef(null);

  useEffect(() => {
    if (!pttchrome || typeof pttchrome.setModalOpen !== "function")
      return undefined;
    const source = "mobileSheet" + id;
    pttchrome.setModalOpen(source, !!opened);
    return () => pttchrome.setModalOpen(source, false);
  }, [pttchrome, opened, id]);

  useEffect(() => {
    if (
      !opened ||
      !pttchrome ||
      typeof pttchrome.registerSheetDismiss !== "function"
    )
      return undefined;
    return pttchrome.registerSheetDismiss(onClose);
  }, [pttchrome, opened, onClose]);

  useEffect(() => {
    if (!opened) setDrag(0);
  }, [opened]);

  const onPointerDown = useCallback((e) => {
    startY.current = e.clientY;
    if (e.currentTarget.setPointerCapture)
      e.currentTarget.setPointerCapture(e.pointerId);
  }, []);
  const onPointerMove = useCallback((e) => {
    if (startY.current == null) return;
    setDrag(Math.max(0, e.clientY - startY.current));
  }, []);
  const onPointerEnd = useCallback(
    (e) => {
      if (startY.current == null) return;
      const dy = e.clientY - startY.current;
      startY.current = null;
      setDrag(0);
      if (dy > SHEET_DISMISS_DRAG_PX) onClose();
    },
    [onClose],
  );

  const handle = (
    <div
      className="mobileSheetHandle"
      data-sheet-handle
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      <span />
    </div>
  );

  return (
    <Drawer
      opened={!!opened}
      onClose={onClose}
      closeOnClickOutside={closeOnClickOutside}
      position="bottom"
      size="auto"
      withCloseButton={false}
      zIndex={SHEET_Z_INDEX}
      lockScroll={false}
      returnFocus={false}
      transitionProps={{
        // 浮動選單從貼著對象的那個角長出來（像原生浮動選單），貼底 sheet 照舊往上滑。
        transition: float
          ? float.side === "above"
            ? "pop-bottom-left"
            : "pop-top-left"
          : "slide-up",
        duration: reduceMotion ? 0 : float ? 120 : 200,
      }}
      classNames={{
        inner: "mobileSheetInner" + (float ? " mobileSheetInnerFloat" : ""),
        content:
          "mobileSheetContent" + (float ? " mobileSheetContentFloat" : ""),
        body: "mobileSheetBody",
      }}
      styles={
        float
          ? {
              content: {
                top: float.top != null ? `${float.top}px` : "auto",
                bottom: float.bottom != null ? `${float.bottom}px` : "auto",
                left: `${float.left}px`,
                width: `${float.width}px`,
              },
            }
          : undefined
      }
    >
      <div
        className="mobileSheet nomouse_command"
        data-sheet={sheetKey}
        data-position={float ? "float" : "bottom"}
        data-float-side={float ? float.side : undefined}
        style={{
          ...(drag ? { transform: `translateY(${drag}px)` } : null),
          // CSS 的上限（扣鍵盤）照樣算：取兩者較小者。
          ...(float
            ? {
                maxHeight: `min(${Math.round(float.maxHeight)}px, ${SHEET_CSS_MAX_HEIGHT})`,
              }
            : null),
        }}
      >
        {float ? null : handle}
        {title ? <div className="mobileSheetTitle">{title}</div> : null}
        <div className="mobileSheetScroll">{children}</div>
        {footer ? <div className="mobileSheetFooter">{footer}</div> : null}
      </div>
    </Drawer>
  );
};

export default MobileSheet;
