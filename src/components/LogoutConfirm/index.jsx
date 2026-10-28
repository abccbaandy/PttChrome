import { useEffect } from "react";
import { createPortal } from "react-dom";
import { IconLogout, IconPower } from "@tabler/icons-react";
import { i18n } from "../../js/i18n";
import "./LogoutConfirm.css";

// 登出確認（手機「更多」→ 登出）：像 Android 關機選單，整個畫面蓋上遮罩、中間放大按鈕。
//   空白處  取消
//   登出    只登出（logout_session，PTT 正常離站流程）
//   登出並關閉 App  登出完（server 關線）再關掉 APK；canQuit（原生宣告 quitApp）才有這顆
// 規則同 MobileSheet：開著＝modal（App.setModalOpen 具名來源）、系統返回＝取消
//（registerSheetDismiss）。畫在 portal，但 React 事件照 React 樹冒泡回 MobileToolbar 根節點的
// stopPropagation；遮罩點擊另外靠 modalShown 擋住 App 的滑鼠入口。
// 守護 tests/unit/mobile_toolbar.test.jsx、offline e2e mobile_toolbar「登出確認」。
export const LOGOUT_CONFIRM_Z_INDEX = 3100; // 高於 MobileSheet（3000）

const MODAL_SOURCE = "logoutConfirm";

export const LogoutConfirm = ({ pttchrome, canQuit, onLogout, onCancel }) => {
  useEffect(() => {
    if (!pttchrome || typeof pttchrome.setModalOpen !== "function")
      return undefined;
    pttchrome.setModalOpen(MODAL_SOURCE, true);
    return () => pttchrome.setModalOpen(MODAL_SOURCE, false);
  }, [pttchrome]);

  useEffect(() => {
    if (!pttchrome || typeof pttchrome.registerSheetDismiss !== "function")
      return undefined;
    return pttchrome.registerSheetDismiss(onCancel);
  }, [pttchrome, onCancel]);

  const onBackdrop = (e) => {
    if (e.target === e.currentTarget) onCancel();
  };

  const action = (key, Icon, label, quit) => (
    <button
      type="button"
      className={
        "nomouse_command logoutConfirmAction pttRipple" +
        (quit ? " logoutConfirmDanger" : "")
      }
      data-key={key}
      onClick={() => onLogout(quit)}
    >
      <span className="logoutConfirmIcon">
        <Icon size={30} stroke={1.75} aria-hidden="true" />
      </span>
      <span className="logoutConfirmLabel">{label}</span>
    </button>
  );

  return createPortal(
    <div
      className="nomouse_command logoutConfirm"
      data-key="__logoutConfirm"
      role="dialog"
      aria-modal="true"
      aria-label={i18n("mobileKeypad_logout")}
      style={{ zIndex: LOGOUT_CONFIRM_Z_INDEX }}
      onClick={onBackdrop}
    >
      <div className="logoutConfirmActions" onClick={onBackdrop}>
        {action("__logoutOnly", IconLogout, i18n("mobileKeypad_logout"), false)}
        {canQuit
          ? action(
              "__logoutQuit",
              IconPower,
              i18n("mobileKeypad_logoutQuit"),
              true,
            )
          : null}
      </div>
      <div className="logoutConfirmHint">
        {i18n("mobileKeypad_logoutCancelHint")}
      </div>
    </div>,
    document.body,
  );
};

export default LogoutConfirm;
