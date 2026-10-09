import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useLayoutEffect,
} from "react";
import {
  IconThumbUp,
  IconMessageReply,
  IconMail,
  IconShare2,
  IconPencilPlus,
  IconSearch,
  IconKeyboard,
  IconDots,
} from "@tabler/icons-react";
import { i18n } from "../../js/i18n";
import MobileSheet from "../MobileSheet";
import {
  MOBILE_KEYPAD_ROWS,
  MOBILE_KEYPAD_EXTRA_ROW,
} from "../../js/mobile_layout";
import {
  EMPTY_TOOLBAR_CONTEXT,
  TOOLBAR_KEYS,
  THREAD_NAV_KEYS,
} from "../../js/mobile_toolbar";
import "./MobileToolbar.css";

// 手機底部導覽（docs/mobile.md「底部導覽」）。只在 pttchrome.mobile 時渲染。
// Material 風格：icon＋小字，動作依畫面換（App.onScreenContextChange ← mobile_toolbar.js）：
//   文章      推 X／回文 y／分享／按鍵／更多（更多裡有同主題前下首篇、列表前下篇）
//   信件      回信 y／按鍵／更多
//   文章列表  搜尋／發文 Ctrl+P／按鍵／更多
//   其他      搜尋（有可用種類時）／按鍵／更多
//   搜尋  直接開搜尋彈窗（不開子選單；種類在彈窗上方切，article_search.js）
//   按鍵  展開方向鍵面板（貼在工具列上方；含軟鍵盤開關與黏滯 Ctrl／Esc／Tab／Del）
//   更多  文章導覽／選取模式／設定／登出
// 沒有返回：交給系統邊緣滑動／返回鍵（history_back_guard.js）。
//
// 三條不可以踩的線（同舊按鍵列，守護 tests/unit/mobile_toolbar.test.jsx）：
//   1. 送鍵一律 view.sendKeyAsUser(keyName, mods)：走鍵盤同一條 onKeyDown 分派（文章好讀／
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

// 觸覺回饋：短震一下（Android Chrome；沒有 API／APK 沒給 VIBRATE 權限時靜默）。
export const HAPTIC_MS = 8;
const haptic = () => {
  try {
    if (typeof navigator !== "undefined" && navigator.vibrate)
      navigator.vibrate(HAPTIC_MS);
  } catch (e) {
    // 被瀏覽器擋（沒有 user activation 之類）就算了。
  }
};

// 登出確認的自動復原時間：按了第一下之後沒動作就收回，防口袋誤觸。
export const LOGOUT_CONFIRM_MS = 3000;

const ICON_PROPS = { size: 22, stroke: 1.75, "aria-hidden": true };

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
    (key, mods) => {
      // 等待進度條：接著真的送出 byte 才會亮（mobile_busy.js）。
      if (typeof pttchrome.noteUserAction === "function")
        pttchrome.noteUserAction();
      if (mods) pttchrome.view.sendKeyAsUser(key, mods);
      else pttchrome.view.sendKeyAsUser(key);
    },
    [pttchrome],
  );

  const sendAction = useCallback(
    (name) => {
      const k = TOOLBAR_KEYS[name];
      setPanel(null);
      setConfirmLogout(false);
      sendKey(k.key, k.mods);
    },
    [sendKey],
  );

  const togglePanel = useCallback((p) => {
    setConfirmLogout(false);
    setPanel((cur) => (cur === p ? null : p));
  }, []);

  // 「更多」sheet 的關閉（遮罩、拖把手、系統返回）。引用穩定：MobileSheet 拿它登記
  // 系統返回的關閉函式。
  const closeMore = useCallback(() => {
    setConfirmLogout(false);
    setPanel((cur) => (cur === "more" ? null : cur));
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

  // 系統分享面板（Web Share API）。**同步**呼叫：免費路徑要在這個 click 的 user
  // activation 內叫出 navigator.share（deep_link_controller.shareCurrentPostLink）。
  const onShare = useCallback(() => {
    setPanel(null);
    setConfirmLogout(false);
    const dl = pttchrome.deepLinkController;
    if (dl && typeof dl.shareCurrentPostLink === "function")
      dl.shareCurrentPostLink(context.appBar ? context.appBar.title : "");
  }, [pttchrome, context]);

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

  const navBtn = (key, Icon, label, onClick, opts) => {
    const o = opts || {};
    return (
      <button
        key={key}
        type="button"
        className={
          "nomouse_command mobileToolbarBtn pttRipple" +
          (o.active ? " active" : "")
        }
        aria-label={o.aria || label}
        aria-pressed={o.pressed}
        aria-expanded={o.expanded}
        data-key={key}
        onClick={() => {
          haptic();
          onClick();
        }}
      >
        <Icon {...ICON_PROPS} />
        <span className="mobileToolbarLabel">{label}</span>
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
  }

  // 「更多」是 bottom sheet（components/MobileSheet）：開著算 modal、系統返回＝收起。
  // 它畫在 portal 裡，不在工具列的事件攔截範圍內 —— 遮罩／項目的點擊靠 modalShown
  // 擋住 App 的滑鼠入口（MobileSheet 檔頭）。
  const moreSheet = (
    <MobileSheet
      pttchrome={pttchrome}
      opened={panel === "more"}
      onClose={closeMore}
      sheetKey="more"
    >
      <div data-panel="more">
        {context.threadNav ? (
          <div className="mobileToolbarNavGrid" data-key="__threadNav">
            {THREAD_NAV_KEYS.map((k) => (
              <button
                key={k.key}
                type="button"
                className="nomouse_command mobileSheetItem pttRipple"
                data-key={k.key}
                onClick={() => {
                  setPanel(null);
                  sendKey(k.key);
                }}
              >
                {i18n(k.label)}
              </button>
            ))}
          </div>
        ) : null}
        <button
          type="button"
          className={
            "nomouse_command mobileSheetItem pttRipple" +
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
          className="nomouse_command mobileSheetItem pttRipple"
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
            className="nomouse_command mobileSheetItem mobileSheetDanger pttRipple"
            data-key="__logout"
            onClick={() => setConfirmLogout(true)}
          >
            {i18n("mobileKeypad_logout")}
          </button>
        )}
      </div>
    </MobileSheet>
  );

  return (
    <div
      id="mobileToolbar"
      className="nomouse_command mobileToolbar"
      onMouseDown={keepFocus}
      onMouseUp={swallow}
      onClick={swallow}
    >
      {panelEl}
      {moreSheet}
      <nav className="nomouse_command mobileToolbarBar">
        {context.push &&
          navBtn(
            TOOLBAR_KEYS.push.key,
            IconThumbUp,
            i18n("mobileToolbar_push"),
            () => sendAction("push"),
            { aria: i18n("mobileKeypad_push") },
          )}
        {context.reply &&
          navBtn(
            "__reply",
            context.mail ? IconMail : IconMessageReply,
            i18n(
              context.mail ? "mobileToolbar_replyMail" : "mobileToolbar_reply",
            ),
            () => sendAction("reply"),
          )}
        {context.share &&
          navBtn("__share", IconShare2, i18n("mobileToolbar_share"), onShare)}
        {context.search.length > 0 &&
          navBtn(
            "__search",
            IconSearch,
            i18n("mobileToolbar_search"),
            onSearch,
          )}
        {context.post &&
          navBtn("__post", IconPencilPlus, i18n("mobileToolbar_post"), () =>
            sendAction("post"),
          )}
        {navBtn(
          "__keys",
          IconKeyboard,
          i18n("mobileToolbar_keys"),
          () => togglePanel("keys"),
          {
            active: panel === "keys",
            expanded: panel === "keys",
          },
        )}
        {navBtn(
          "__more",
          IconDots,
          i18n("mobileToolbar_more"),
          () => togglePanel("more"),
          {
            active: panel === "more",
            expanded: panel === "more",
          },
        )}
      </nav>
    </div>
  );
};

export default MobileToolbar;
