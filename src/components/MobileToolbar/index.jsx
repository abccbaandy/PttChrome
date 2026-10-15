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
  IconPencilPlus,
  IconSearch,
  IconKeyboard,
  IconDots,
  IconRefresh,
  IconArrowBarToDown,
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
  toolbarSlots,
} from "../../js/mobile_toolbar";
import "./MobileToolbar.css";

// 手機底部導覽（docs/mobile.md「底部導覽」）。只在 pttchrome.mobile 時渲染。
// Material 風格：icon＋小字，動作依畫面換（App.onScreenContextChange ← mobile_toolbar.js）：
//   固定 6 格（mobile_toolbar.toolbarSlots；位置不隨畫面變，不能用的反灰）：
//     1 主要（文章＝推 X、列表／主功能表＝搜尋）  2 次要（回文 y／回信、文章列表＝發文 Ctrl+P）
//     3 重整（冷卻中反灰＋倒數）  4 到底 End  5 按鍵  6 更多（分享、同主題前下首篇、列表前下篇…）
//   重整  screen_refresh（列表 s<板>⏎／看板列表 /⏎／文章重開並還原位置），與 F5 同一個入口
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

// 重整倒數的重讀間隔：秒數靠 Math.ceil 取整，250ms 讓跳秒最多晚 1/4 秒。
export const COOLDOWN_TICK_MS = 250;

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

  // 跳到第一篇未讀：與桌機快捷鍵（預設 F7）同一個入口（unread_jump.js）。
  const onUnreadJump = useCallback(() => {
    setPanel(null);
    setConfirmLogout(false);
    const u = pttchrome.unreadJump;
    if (!u || typeof u.start !== "function") return;
    if (typeof pttchrome.noteUserAction === "function")
      pttchrome.noteUserAction();
    u.start();
  }, [pttchrome]);

  // 重新整理：與桌機 F5 同一個入口（冷卻、忙碌提示都在 ScreenRefresh 裡）。
  const onRefresh = useCallback(() => {
    setPanel(null);
    setConfirmLogout(false);
    const r = pttchrome.screenRefresh;
    if (!r || typeof r.refresh !== "function") return;
    if (typeof pttchrome.noteUserAction === "function")
      pttchrome.noteUserAction();
    r.refresh("toolbar");
  }, [pttchrome]);

  // 重整冷卻的倒數（秒，0 ＝可以重整）。冷卻一開始（不論從工具列、F5 或下拉）
  // ScreenRefresh 會通知一次，之後自己每 250ms 重讀剩餘時間直到歸零。
  const [cooldownSec, setCooldownSec] = useState(0);
  useEffect(() => {
    const r = pttchrome.screenRefresh;
    if (!r || typeof r.onCooldown !== "function") return undefined;
    let timer = null;
    const tick = () => {
      const sec = Math.ceil(r.cooldownLeftMs() / 1000);
      setCooldownSec(sec);
      timer = sec > 0 ? setTimeout(tick, COOLDOWN_TICK_MS) : null;
    };
    const off = r.onCooldown(() => {
      clearTimeout(timer);
      tick();
    });
    tick();
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [pttchrome]);

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

  // 固定格位（mobile_toolbar.toolbarSlots）：位置不隨畫面變，不能用的反灰不藏。
  const refreshDisabled = !context.refresh || cooldownSec > 0;
  const renderSlot = (slot, i) => {
    switch (slot) {
      case "push":
        return navBtn(
          TOOLBAR_KEYS.push.key,
          IconThumbUp,
          i18n("mobileToolbar_push"),
          () => sendAction("push"),
          { aria: i18n("mobileKeypad_push") },
        );
      case "search":
        return navBtn(
          "__search",
          IconSearch,
          i18n("mobileToolbar_search"),
          onSearch,
        );
      case "reply":
        return navBtn(
          "__reply",
          context.mail ? IconMail : IconMessageReply,
          i18n(
            context.mail ? "mobileToolbar_replyMail" : "mobileToolbar_reply",
          ),
          () => sendAction("reply"),
        );
      case "post":
        return navBtn(
          "__post",
          IconPencilPlus,
          i18n("mobileToolbar_post"),
          () => sendAction("post"),
        );
      case "refresh":
        // 冷卻中：反灰＋倒數秒數取代 label（倒數由 screenRefresh.cooldownLeftMs 驅動，
        // F5／下拉觸發的冷卻一樣會顯示）。
        return navBtn(
          "__refresh",
          IconRefresh,
          cooldownSec > 0
            ? cooldownSec + i18n("mobileToolbar_secUnit")
            : i18n("mobileToolbar_refresh"),
          onRefresh,
          {
            disabled: refreshDisabled,
            aria: i18n("mobileToolbar_refresh"),
            extraClass: cooldownSec > 0 ? " cooling" : "",
          },
        );
      case "end":
        return navBtn(
          "__end",
          IconArrowBarToDown,
          i18n("mobileToolbar_end"),
          () => sendAction("end"),
          { disabled: !context.end },
        );
      case "keys":
        return navBtn(
          "__keys",
          IconKeyboard,
          i18n("mobileToolbar_keys"),
          () => togglePanel("keys"),
          { active: panel === "keys", expanded: panel === "keys" },
        );
      case "more":
        return navBtn(
          "__more",
          IconDots,
          i18n("mobileToolbar_more"),
          () => togglePanel("more"),
          { active: panel === "more", expanded: panel === "more" },
        );
      default:
        // 這個畫面沒有這一格的動作：佔位，寬度照算，旁邊的按鈕才不會挪位置。
        return (
          <span
            key={"__slot" + i}
            className="mobileToolbarBtn mobileToolbarSlotEmpty"
            data-slot-empty={i}
            aria-hidden="true"
          />
        );
    }
  };

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
          (o.active ? " active" : "") +
          (o.extraClass || "")
        }
        disabled={!!o.disabled}
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
        {context.unreadJump ? (
          <button
            type="button"
            className="nomouse_command mobileSheetItem pttRipple"
            data-key="__unreadJump"
            onClick={onUnreadJump}
          >
            {i18n("mobileToolbar_unreadJump")}
          </button>
        ) : null}
        {context.share ? (
          <button
            type="button"
            className="nomouse_command mobileSheetItem pttRipple"
            data-key="__share"
            onClick={onShare}
          >
            {i18n("mobileToolbar_share")}
          </button>
        ) : null}
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
        {toolbarSlots(context).map((slot, i) => renderSlot(slot, i))}
      </nav>
    </div>
  );
};

export default MobileToolbar;
