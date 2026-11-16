import { truncateMiddle } from "../../js/context_menu_items";

// P95：手機「複製本篇連結」一區三列（PTT 網址／AID／分享連結），每列＝名稱＋下面一行淡色
// 預覽（點下去實際會複製的字）。長按選單（ContextSheet）與「更多」面板（MobileToolbar）共用。
// 手機沒有 hover，桌機那種「停在膠囊上看預覽」做不到 ⇒ 三種各自攤開。
// 預覽用中段省略：網址最能認出是哪篇的是尾巴的檔名，CSS 的 ellipsis 只會砍尾巴。
// 讀不到本篇代碼時 preview 是 null ⇒ 只畫名稱（點下去照樣由 deep_link_controller 補按 Q）。
// 長按選單的浮動卡片比「更多」面板窄（Pixel 7 寬約 300px），12px 字 40 字元會被 CSS 再砍掉
// 尾巴的 .html ⇒ 36（兩處量過都完整）。
export const LINK_ROW_PREVIEW_MAX = 36;

const LinkRows = ({ label, items, itemClassName, ...rest }) => (
  <div
    className="mobileSheetLinkRows"
    role="group"
    aria-label={label}
    {...rest}
  >
    <span className="mobileSheetLinkRowsLabel">{label}</span>
    {items.map((it) => (
      <button
        key={it.key}
        type="button"
        className={
          "mobileSheetItem mobileSheetLinkItem pttRipple" +
          (itemClassName ? " " + itemClassName : "")
        }
        onClick={it.onClick}
        {...it.attrs}
      >
        <span>{it.label}</span>
        {it.preview ? (
          <span className="mobileSheetItemPreview">
            {truncateMiddle(it.preview, LINK_ROW_PREVIEW_MAX)}
          </span>
        ) : null}
      </button>
    ))}
  </div>
);

export default LinkRows;
