import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useLayoutEffect,
} from "react";
import { i18n } from "../../js/i18n";
import {
  MOBILE_KEYPAD_ROWS,
  MOBILE_KEYPAD_EXTRA_ROW,
  MOBILE_KEYPAD_PUSH_KEY,
} from "../../js/mobile_layout";
import { EMPTY_TOOLBAR_CONTEXT } from "../../js/mobile_toolbar";
import "./MobileToolbar.css";

// 手機底部工具列（docs/mobile.md「底部工具列」）。只在 pttchrome.mobile 時渲染。
// 取代 2026-09 的浮動按鍵列：常用動作固定在底部，按鈕依畫面顯示
// （App.onScreenContextChange ← mobile_toolbar.js）：
//   推    文章裡才有（送 X ⇒ 預設開長推文，與實體鍵盤同一條分派）
//   搜尋  直接開搜尋彈窗（不開子選單；種類在彈窗上方切）。文章列表：標題／作者／推文數／
//         看板；看板列表、主功能表：看板（article_search.js）
//   按鍵  展開方向鍵面板（貼在工具列上方；含軟鍵盤開關與黏滯 Ctrl／Esc／Tab／Del）
//   更多  選取模式／設定／登出
//
// 三條不可以踩的線（同舊按鍵列，守護 tests/unit/mobile_toolbar.test.jsx）：
//   1. 送鍵一律 view.sendKeyAsUser(keyName)：走鍵盤同一條 onKeyDown 分派（文章好讀／
//      列表好讀／原生三種語意）。不可 view._send（列表好讀底下是在序列化交易中途
//      插隊），也不可 App.onFunctionKey（文章好讀會先切 functionMode）。
//   2. mousedown 必須 preventDefault：預設動作會把焦點移到按鈕上 ⇒ #t 失焦 ⇒
//      軟鍵盤收起、實體鍵盤打不進終端機。
//   3. mousedown／mouseup／click 必須 stopPropagation：App 的滑鼠入口掛在 window，
//      放過去就會把這一下當成點終端機。彈出的小選單也畫在 root 底下（不用 Mantine
//      Menu 的 portal），同一道 stopPropagation 就罩得住。
const swallow = (e) => {
  e.stopPropagation();
};
const keepFocus = (e) => {
  e.preventDefault();
  e.stopPropagation();
};

// 登出確認的自動復原時間：按了第一下之後沒動作就收回，防口袋誤觸。
export const LOGOUT_CONFIRM_MS = 3000;

export const MobileToolbar = ({
  pttchrome,
  hidden,
  onOpenSearch,
  onOpenSettings,
}) => {
  const [mobile, setMobile] = useState(() => !!pttchrome.mobile);
  const [keyboard, setKeyboard] = useState(() => !!pttchrome.softKeyboard);
  const [selectMode, setSelectMode] = useState(
    () => !!pttchrome.mobileSelectMode,
  );
  const [ctrl, setCtrl] = useState(() => !!pttchrome.mobileCtrlArmed);
  const [context, setContext] = useState(EMPTY_TOOLBAR_CONTEXT);
  // null | 'keys' | 'more'：同一時間只開一個面板。
  const [panel, setPanel] = useState(null);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const keysRef = useRef(null);

  useEffect(() => {
    setMobile(!!pttchrome.mobile);
    // 測試常用假的 pttchrome 渲染 ContextMenu，沒有這支就當作永遠不是手機。
    if (typeof pttchrome.onMobileChange !== "function") return undefined;
    // 這些狀態都可能被 App 自己改（Android 返回鍵收鍵盤、Ctrl 用掉就解除），亮燈要跟
    // App 走，不能只信自己按下時的回傳值。
    return pttchrome.onMobileChange((m, kb, sel, c) => {
      setMobile(m);
      setKeyboard(!!m && !!kb);
      setSelectMode(!!m && !!sel);
      setCtrl(!!m && !!c);
    });
  }, [pttchrome]);

  useEffect(() => {
    if (typeof pttchrome.onScreenContextChange !== "function") return undefined;
    return pttchrome.onScreenContextChange((c) =>
      setContext(c || EMPTY_TOOLBAR_CONTEXT),
    );
  }, [pttchrome]);

  useEffect(() => {
    if (!confirmLogout) return undefined;
    const t = setTimeout(() => setConfirmLogout(false), LOGOUT_CONFIRM_MS);
    return () => clearTimeout(t);
  }, [confirmLogout]);

  // 按鍵面板蓋住的高度回報給 App（終端機排在它上面，見 setMobileKeysPanelInset）。
  const visible = mobile && !hidden;
  useLayoutEffect(() => {
    if (typeof pttchrome.setMobileKeysPanelInset !== "function")
      return undefined;
    const el = keysRef.current;
    pttchrome.setMobileKeysPanelInset(
      visible && panel === "keys" && el ? el.offsetHeight : 0,
    );
    return undefined;
  }, [pttchrome, visible, panel]);
  useEffect(
    () => () => {
      if (typeof pttchrome.setMobileKeysPanelInset === "function")
        pttchrome.setMobileKeysPanelInset(0);
    },
    [pttchrome],
  );

  const sendKey = useCallback(
    (key) => {
      pttchrome.view.sendKeyAsUser(key);
    },
    [pttchrome],
  );

  const togglePanel = useCallback((p) => {
    setConfirmLogout(false);
    setPanel((cur) => (cur === p ? null : p));
  }, []);

  const onKeyboard = useCallback(() => {
    setKeyboard(pttchrome.toggleSoftKeyboard());
  }, [pttchrome]);

  const onCtrl = useCallback(() => {
    if (typeof pttchrome.setMobileCtrlArmed !== "function") return;
    setCtrl(pttchrome.setMobileCtrlArmed(!pttchrome.mobileCtrlArmed));
  }, [pttchrome]);

  const onSelectMode = useCallback(() => {
    if (typeof pttchrome.setMobileSelectMode !== "function") return;
    setSelectMode(pttchrome.setMobileSelectMode(!pttchrome.mobileSelectMode));
    setPanel(null);
  }, [pttchrome]);

  // 不開子選單：直接開搜尋彈窗，預設種類＝這個畫面可用的第一種（文章列表＝標題，
  // 看板列表／主功能表＝看板），要換種類在彈窗上方切。
  const onSearch = useCallback(() => {
    setPanel(null);
    setConfirmLogout(false);
    if (onOpenSearch && context.search.length) onOpenSearch(context.search[0]);
  }, [onOpenSearch, context]);

  const onSettings = useCallback(() => {
    setPanel(null);
    if (onOpenSettings) onOpenSettings();
  }, [onOpenSettings]);

  const onLogoutYes = useCallback(() => {
    setConfirmLogout(false);
    setPanel(null);
    if (typeof pttchrome.startLogout === "function") pttchrome.startLogout();
  }, [pttchrome]);

  if (!visible) return null;

  const keyBtn = (k, extraClass) => (
    <button
      key={k.key}
      type="button"
      className={"nomouse_command mobileKeypadKey" + (extraClass || "")}
      aria-label={k.aria}
      data-key={k.key}
      onClick={() => sendKey(k.key)}
    >
      {k.label}
    </button>
  );

  const toolBtn = (key, label, onClick, opts) => {
    const o = opts || {};
    return (
      <button
        key={key}
        type="button"
        className={
          "nomouse_command mobileToolbarBtn" + (o.active ? " active" : "")
        }
        aria-label={o.aria || label}
        aria-pressed={o.pressed}
        aria-expanded={o.expanded}
        data-key={key}
        onClick={onClick}
      >
        {label}
      </button>
    );
  };

  let panelEl = null;
  if (panel === "keys") {
    panelEl = (
      <div
        id="mobileKeypad"
        ref={keysRef}
        className="nomouse_command mobileKeypadGrid"
      >
        {MOBILE_KEYPAD_ROWS[0].map((k) => keyBtn(k))}
        <button
          key="__keyboard"
          type="button"
          className={
            "nomouse_command mobileKeypadKey mobileKeypadAux" +
            (keyboard ? " active" : "")
          }
          aria-label={i18n("mobileKeypad_keyboard")}
          aria-pressed={keyboard}
          data-key="__keyboard"
          onClick={onKeyboard}
        >
          ⌨
        </button>
        {MOBILE_KEYPAD_ROWS[1].map((k) => keyBtn(k))}
        <button
          key="__ctrl"
          type="button"
          className={
            "nomouse_command mobileKeypadKey mobileKeypadAux" +
            (ctrl ? " active" : "")
          }
          aria-label={i18n("mobileKeypad_ctrl")}
          aria-pressed={ctrl}
          data-key="__ctrl"
          onClick={onCtrl}
        >
          Ctrl
        </button>
        {MOBILE_KEYPAD_EXTRA_ROW.map((k) => keyBtn(k, " mobileKeypadWide2"))}
      </div>
    );
  } else if (panel === "more") {
    panelEl = (
      <div
        className="nomouse_command mobileToolbarMenu mobileToolbarMenuEnd"
        data-panel="more"
      >
        <button
          type="button"
          className={
            "nomouse_command mobileToolbarMenuItem" +
            (selectMode ? " active" : "")
          }
          aria-pressed={selectMode}
          data-key="__select"
          onClick={onSelectMode}
        >
          {i18n("mobileKeypad_select")}
        </button>
        <button
          type="button"
          className="nomouse_command mobileToolbarMenuItem"
          data-key="__settings"
          onClick={onSettings}
        >
          {i18n("mobileToolbar_settings")}
        </button>
        {confirmLogout ? (
          <div className="mobileToolbarAsk" data-key="__logoutAsk">
            <span>{i18n("mobileKeypad_logoutConfirm")}</span>
            <button
              type="button"
              className="nomouse_command mobileToolbarMenuItem mobileKeypadDanger"
              aria-label={i18n("mobileKeypad_logoutYes")}
              data-key="__logoutYes"
              onClick={onLogoutYes}
            >
              ✓
            </button>
            <button
              type="button"
              className="nomouse_command mobileToolbarMenuItem"
              aria-label={i18n("mobileKeypad_logoutNo")}
              data-key="__logoutNo"
              onClick={() => setConfirmLogout(false)}
            >
              ✕
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="nomouse_command mobileToolbarMenuItem"
            data-key="__logout"
            onClick={() => setConfirmLogout(true)}
          >
            {i18n("mobileKeypad_logout")}
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      id="mobileToolbar"
      className="nomouse_command mobileToolbar"
      onMouseDown={keepFocus}
      onMouseUp={swallow}
      onClick={swallow}
    >
      {panelEl}
      <div className="nomouse_command mobileToolbarBar">
        {context.push &&
          toolBtn(
            MOBILE_KEYPAD_PUSH_KEY,
            "推",
            () => sendKey(MOBILE_KEYPAD_PUSH_KEY),
            {
              aria: i18n("mobileKeypad_push"),
            },
          )}
        {context.search.length > 0 &&
          toolBtn("__search", i18n("mobileToolbar_search"), onSearch)}
        {toolBtn(
          "__keys",
          i18n("mobileToolbar_keys"),
          () => togglePanel("keys"),
          {
            active: panel === "keys",
            expanded: panel === "keys",
          },
        )}
        {toolBtn(
          "__more",
          i18n("mobileToolbar_more"),
          () => togglePanel("more"),
          {
            active: panel === "more",
            expanded: panel === "more",
          },
        )}
      </div>
    </div>
  );
};

export default MobileToolbar;
