import MobileSheet from "../MobileSheet";
import { buildContextMenuEntries } from "./context_menu_entries";

// 手機的長按選單：同一份項目清單（context_menu_entries.js）畫成 bottom sheet。
// 「要不要開／開在誰身上」的判斷（touchLongPress、選取模式 disposition、清選取、黑名單
// 與前已讀後未讀的目標）全在 index.jsx#onContextMenu、render 之前就做完了，這裡只換外殼。
// 項目的 handler 自己會收起選單（index.jsx 的 onMenuSelect 等 update(initialState)）。
// 快捷鍵提示（Ctrl+C…）在手機上沒有意義，不畫。
export const ContextSheet = (props) => {
  const { pttchrome, open, onHide } = props;
  const entries = buildContextMenuEntries(props);
  return (
    <MobileSheet
      pttchrome={pttchrome}
      opened={open}
      onClose={onHide}
      sheetKey="context"
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
