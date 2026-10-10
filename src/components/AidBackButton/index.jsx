import { useState, useEffect } from "react";
import { IconArrowBackUp } from "@tabler/icons-react";
import { i18n } from "../../js/i18n";
import { readValuesWithDefault } from "../../js/pref_storage";
import "./AidBackButton.css";

// AID 跳文後的「返回原文」（aid_navigation.js 的 back stack）。桌機／手機同一顆：
// 浮在終端機上緣置中（手機在 App Bar 正下方），樣式見 AidBackButton.css。
//
// 狀態不在這裡：aid_navigation._updateBackButton → view.showBackButton／hideBackButton
// 是 (active, stack) 的純投影，這裡只訂閱 view.onAidBackChange 照畫。
//
// 事件規則同 MobileAppBar：mousedown preventDefault（不搶 #t 焦點）、
// mousedown／mouseup／click stopPropagation（App 的滑鼠入口在 window，放過去會
// 把點按鈕當成點終端機——滑鼠瀏覽開著時會順便送游標指令給 PTT）。
const keepFocus = (e) => {
  e.preventDefault();
  e.stopPropagation();
};
const swallow = (e) => {
  e.stopPropagation();
};

export const AidBackButton = ({ pttchrome }) => {
  const view = pttchrome && pttchrome.view;
  const [back, setBack] = useState(() => (view && view.aidBack) || null);

  useEffect(() => {
    if (!view || typeof view.onAidBackChange !== "function") return undefined;
    setBack(view.aidBack || null);
    return view.onAidBackChange((b) => setBack(b || null));
  }, [view]);

  if (!back) return null;
  const text = back.label
    ? i18n("aidBack_to") + " " + back.label
    : i18n("aidBack_default");
  const hotkey = readValuesWithDefault().aidNavBackKey;
  return (
    <button
      type="button"
      id="aidBackButton"
      className="nomouse_command aidBackButton"
      title={i18n("aidBack_tooltip") + (hotkey ? ` (${hotkey})` : "")}
      onMouseDown={keepFocus}
      onMouseUp={swallow}
      onClick={(e) => {
        e.stopPropagation();
        if (back.onClick) back.onClick();
      }}
    >
      <IconArrowBackUp size={18} stroke={2} aria-hidden="true" />
      <span className="aidBackButtonLabel">{text}</span>
    </button>
  );
};

export default AidBackButton;
