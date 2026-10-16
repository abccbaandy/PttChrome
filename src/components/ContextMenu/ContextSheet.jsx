import { useRef } from "react";
import MobileSheet from "../MobileSheet";
import { buildContextMenuEntries } from "./context_menu_entries";
import { floatMenuPlacement } from "../../js/sheet_placement";

// 手機的長按選單：同一份項目清單（context_menu_entries.js）畫在 MobileSheet 外殼裡。
// 「要不要開／開在誰身上」的判斷（touchLongPress、選取模式 disposition、清選取、黑名單
// 與前已讀後未讀的目標）全在 index.jsx#onContextMenu、render 之前就做完了，這裡只換外殼。
// 項目的 handler 自己會收起選單（index.jsx 的 onMenuSelect 等 update(initialState)）。
// 快捷鍵提示（Ctrl+C…）在手機上沒有意義，不畫。
// menuAnchor（長按的那一列＋觸點 x）：選單像原生浮動選單一樣浮在它旁邊——手指移動距離
// 短、也不蓋住它（js/sheet_placement.js；選中文章外框才看得到）。量不到 ⇒ 退回貼底 sheet。
export const ContextSheet = (props) => {
  const { pttchrome, open, onHide, menuAnchor } = props;
  // mobile：全選／圖片上傳／設為全部已讀改放工具列「更多」（MobileToolbar）。
  const entries = buildContextMenuEntries({ ...props, mobile: true });
  // 收起時 menuAnchor 已被清成 null：沿用開著時的位置，退場動畫才不會中途跳到底部。
  const placementRef = useRef(undefined);
  if (open || placementRef.current === undefined) {
    placementRef.current = floatMenuPlacement({
      anchor: menuAnchor,
      viewportWidth: typeof window !== "undefined" ? window.innerWidth : 0,
      viewportHeight: typeof window !== "undefined" ? window.innerHeight : 0,
    });
  }
  return (
    <MobileSheet
      pttchrome={pttchrome}
      opened={open}
      onClose={onHide}
      sheetKey="context"
      float={placementRef.current}
    >
      {entries.map((it) =>
        it.type === "divider" ? (
          <div key={it.key} className="mobileSheetDivider" role="separator" />
        ) : (
          <button
            key={it.key}
            type="button"
            className={
              "mobileSheetItem pttRipple" +
              (it.className ? " " + it.className : "")
            }
            data-cmenu={it.key}
            disabled={it.disabled}
            onClick={it.onClick}
          >
            <span>{it.label}</span>
            {it.preview ? (
              <span className="mobileSheetItemPreview">{it.preview}</span>
            ) : null}
          </button>
        ),
      )}
    </MobileSheet>
  );
};

export default ContextSheet;
