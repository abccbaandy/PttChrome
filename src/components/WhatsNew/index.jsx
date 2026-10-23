import { useEffect, useState } from "react";
import { i18n } from "../../js/i18n";
import { WHATS_NEW_ID, WHATS_NEW_PREVIEW } from "../../js/whats_new";
import "./WhatsNew.css";

// 更新後的新功能小卡（邏輯在 js/whats_new.js，設計見 docs/whats-new.md）。
// 狀態只從 pttchrome.whatsNew.onChange 來，這裡照畫。不是 modal：不搶 #t 焦點、
// 不擋打字（事件規則同 HomeDashboard：mousedown preventDefault、滑鼠事件不冒泡到 window）。
const keepFocus = (e) => {
  e.preventDefault();
  e.stopPropagation();
};
const swallow = (e) => {
  e.stopPropagation();
};

const fmt = (key, vars) =>
  String(i18n(key) || "").replace(/\{(\w+)\}/g, (m, k) =>
    vars && vars[k] != null ? String(vars[k]) : m,
  );

export const WhatsNewCard = ({ pttchrome }) => {
  const ctl = pttchrome && pttchrome.whatsNew;
  const [state, setState] = useState(() => (ctl ? ctl.state : null));
  const [expanded, setExpanded] = useState(false);
  const [mobile, setMobile] = useState(() => !!(pttchrome && pttchrome.mobile));

  useEffect(() => {
    if (!ctl || typeof ctl.onChange !== "function") return undefined;
    return ctl.onChange((s) => setState(s));
  }, [ctl]);
  useEffect(() => {
    if (!pttchrome || typeof pttchrome.onMobileChange !== "function")
      return undefined;
    return pttchrome.onMobileChange((m) => setMobile(!!m));
  }, [pttchrome]);

  if (!state || !state.visible || !state.items.length) return null;
  const items = state.items;
  const more = items.length - WHATS_NEW_PREVIEW;
  return (
    <div
      id={WHATS_NEW_ID}
      className="whatsNewCard"
      data-mobile={mobile ? "" : undefined}
      data-expanded={expanded ? "" : undefined}
      role="status"
      onMouseDown={keepFocus}
      onMouseUp={swallow}
      onClick={swallow}
      onContextMenu={swallow}
    >
      <div className="whatsNewHead">
        <span className="whatsNewTitle">{i18n("whatsNew_title")}</span>
        <button
          type="button"
          className="whatsNewClose"
          aria-label={i18n("whatsNew_close")}
          onMouseDown={keepFocus}
          onClick={(e) => {
            e.stopPropagation();
            ctl.dismiss();
          }}
        >
          ✕
        </button>
      </div>
      {expanded ? (
        <ul className="whatsNewList">
          {items.map((f) => (
            <li key={f.name}>
              <b>{f.name}</b>
              <span>{f.desc}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="whatsNewNames">
          {items
            .slice(0, WHATS_NEW_PREVIEW)
            .map((f) => f.name)
            .join(i18n("whatsNew_sep"))}
          {more > 0 ? fmt("whatsNew_more", { n: more }) : ""}
        </div>
      )}
      {!expanded && (
        <button
          type="button"
          className="whatsNewAll"
          onMouseDown={keepFocus}
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(true);
          }}
        >
          {i18n("whatsNew_showAll")}
        </button>
      )}
    </div>
  );
};

export default WhatsNewCard;
