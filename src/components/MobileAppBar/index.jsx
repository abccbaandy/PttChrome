import { useState, useEffect } from "react";
import { i18n } from "../../js/i18n";
import { EMPTY_APP_BAR } from "../../js/mobile_app_bar";
import "./MobileAppBar.css";

// 手機頂部 App Bar（docs/mobile.md「App Bar」）。只在 pttchrome.mobile 時渲染。
// 標題來自 App.onScreenContextChange（mobile_toolbar.js → mobile_app_bar.js），
// 與底部工具列同一次計算。**沒有返回鍵**：返回交給系統邊緣滑動／返回鍵
// （history_back_guard.js 把瀏覽器返回轉成 ←），不在頁面裡再模擬一顆。
//
// 跟工具列同一組事件規則：mousedown preventDefault（不搶 #t 焦點）、
// mousedown／mouseup／click stopPropagation（App 的滑鼠入口在 window，放過去會
// 把點 App Bar 當成點終端機）。
const keepFocus = (e) => {
  e.preventDefault();
  e.stopPropagation();
};
const swallow = (e) => {
  e.stopPropagation();
};

export const MobileAppBar = ({ pttchrome }) => {
  const [mobile, setMobile] = useState(() => !!pttchrome.mobile);
  const [appBar, setAppBar] = useState(EMPTY_APP_BAR);

  useEffect(() => {
    setMobile(!!pttchrome.mobile);
    if (typeof pttchrome.onMobileChange !== "function") return undefined;
    return pttchrome.onMobileChange((m) => setMobile(!!m));
  }, [pttchrome]);

  useEffect(() => {
    if (typeof pttchrome.onScreenContextChange !== "function") return undefined;
    return pttchrome.onScreenContextChange((c) =>
      setAppBar((c && c.appBar) || EMPTY_APP_BAR),
    );
  }, [pttchrome]);

  // 等待 PTT 回應的進度條（App._busyEvent ← mobile_busy.js）。
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (typeof pttchrome.onBusyChange !== "function") return undefined;
    return pttchrome.onBusyChange((b) => setBusy(!!b));
  }, [pttchrome]);

  if (!mobile) return null;

  return (
    <header
      id="mobileAppBar"
      className="nomouse_command mobileAppBar"
      data-kind={appBar.kind}
      onMouseDown={keepFocus}
      onMouseUp={swallow}
      onClick={swallow}
    >
      <div className="mobileAppBarText">
        <div className="mobileAppBarTitle" data-key="__title">
          {appBar.title || i18n("mobileAppBar_defaultTitle")}
        </div>
        {appBar.subtitle ? (
          <div className="mobileAppBarSubtitle" data-key="__subtitle">
            {appBar.subtitle}
          </div>
        ) : null}
      </div>
      {appBar.newMail ? (
        <span className="mobileAppBarBadge" data-key="__newMail" role="status">
          {i18n("mobileAppBar_newMail")}
        </span>
      ) : null}
      {busy ? (
        <div
          className="mobileAppBarProgress"
          data-key="__busy"
          role="progressbar"
          aria-label={i18n("mobileAppBar_busy")}
        />
      ) : null}
    </header>
  );
};

export default MobileAppBar;
