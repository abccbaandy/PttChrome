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
  MOBILE_KEYPAD_PUSH_KEY,
  KEYPAD_DRAG_THRESHOLD_PX,
  clampKeypadPos,
  loadKeypadPos,
  saveKeypadPos,
} from "../../js/mobile_layout";
import "./MobileKeypad.css";

// 手機模式的虛擬按鍵列（docs/mobile.md）。只在 pttchrome.mobile 時渲染。
//
// 三條不可以踩的線：
//   1. 送鍵一律 view.sendKeyAsUser(keyName)：走鍵盤同一條 onKeyDown 分派（文章好讀／
//      列表好讀／原生三種語意）。不可 view._send（列表好讀底下是在序列化交易中途
//      插隊），也不可 App.onFunctionKey（文章好讀會先切 functionMode，PgDn 就變成
//      送給 PTT 而不是捲動）。
//   2. mousedown 必須 preventDefault：它的預設動作是把焦點移到按鈕上 ⇒ #t 失焦 ⇒
//      軟鍵盤收起、實體鍵盤打不進終端機。click 照常觸發。
//   3. mousedown／mouseup／click 必須 stopPropagation：App 的滑鼠入口掛在 window
//      （pttchrome.jsx），放過去就會把這一下當成點終端機 ⇒ 按鍵之外又多送一次滑鼠
//      瀏覽動作。React 的 stopPropagation 會停掉原生事件（在 root 容器上），到不了
//      window。
//
// 浮動位置：right/bottom（px，離視窗右／下緣）存 localStorage（mobile_layout 的
// load/saveKeypadPos），不寫 prefs。展開時拖把手鍵、收合時直接拖圓鈕（位移超過
// KEYPAD_DRAG_THRESHOLD_PX 才算拖，否則是點擊＝展開）。
const swallow = (e) => {
  e.stopPropagation();
};
const keepFocus = (e) => {
  e.preventDefault();
  e.stopPropagation();
};

// 登出確認的自動復原時間：按了第一下之後沒動作就收回，防口袋誤觸。
export const LOGOUT_CONFIRM_MS = 3000;

export const MobileKeypad = ({ pttchrome, hidden }) => {
  const [mobile, setMobile] = useState(() => !!pttchrome.mobile);
  const [open, setOpen] = useState(false);
  const [keyboard, setKeyboard] = useState(() => !!pttchrome.softKeyboard);
  const [selectMode, setSelectMode] = useState(
    () => !!pttchrome.mobileSelectMode,
  );
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [pos, setPos] = useState(() => loadKeypadPos());
  const rootRef = useRef(null);
  const dragRef = useRef(null);
  // 收合圓鈕剛被拖過：接下來那一次 click 不算展開。
  const suppressClickRef = useRef(false);

  useEffect(() => {
    setMobile(!!pttchrome.mobile);
    // 測試常用假的 pttchrome 渲染 ContextMenu，沒有這支就當作永遠不是手機。
    if (typeof pttchrome.onMobileChange !== "function") return undefined;
    // softKeyboard 也可能被 App 自己歸零（Android 返回鍵收起鍵盤，見
    // App._onVisualViewport），鍵盤鈕的亮燈要跟著它，不能只信自己按下時的回傳值。
    return pttchrome.onMobileChange((m, kb, sel) => {
      setMobile(m);
      setKeyboard(!!m && !!kb);
      setSelectMode(!!m && !!sel);
    });
  }, [pttchrome]);

  useEffect(() => {
    if (!confirmLogout) return undefined;
    const t = setTimeout(() => setConfirmLogout(false), LOGOUT_CONFIRM_MS);
    return () => clearTimeout(t);
  }, [confirmLogout]);

  // 夾回視窗內：展開／收合（尺寸變了）、轉向／視窗縮放時。
  const reclamp = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos((p) => {
      const next = clampKeypadPos(p, {
        vw: window.innerWidth,
        vh: window.innerHeight,
        w: r.width,
        h: r.height,
      });
      return next.right === p.right && next.bottom === p.bottom ? p : next;
    });
  }, []);
  useLayoutEffect(() => {
    if (mobile && !hidden) reclamp();
  }, [mobile, hidden, open, confirmLogout, reclamp]);
  useEffect(() => {
    window.addEventListener("resize", reclamp);
    return () => window.removeEventListener("resize", reclamp);
  }, [reclamp]);

  const sendKey = useCallback(
    (key) => {
      pttchrome.view.sendKeyAsUser(key);
    },
    [pttchrome],
  );

  const onKeyboard = useCallback(() => {
    setKeyboard(pttchrome.toggleSoftKeyboard());
  }, [pttchrome]);

  const onSelectMode = useCallback(() => {
    if (typeof pttchrome.setMobileSelectMode !== "function") return;
    setSelectMode(pttchrome.setMobileSelectMode(!pttchrome.mobileSelectMode));
  }, [pttchrome]);

  const onLogoutYes = useCallback(() => {
    setConfirmLogout(false);
    if (typeof pttchrome.startLogout === "function") pttchrome.startLogout();
  }, [pttchrome]);

  // ---- 拖曳（pointer events；把手與收合圓鈕共用）----
  const onDragStart = useCallback(
    (e) => {
      const el = rootRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      dragRef.current = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        start: pos,
        w: r.width,
        h: r.height,
        moved: false,
        last: pos,
      };
      if (e.currentTarget.setPointerCapture)
        e.currentTarget.setPointerCapture(e.pointerId);
    },
    [pos],
  );
  const onDragMove = useCallback((e) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < KEYPAD_DRAG_THRESHOLD_PX) return;
    d.moved = true;
    d.last = clampKeypadPos(
      { right: d.start.right - dx, bottom: d.start.bottom - dy },
      { vw: window.innerWidth, vh: window.innerHeight, w: d.w, h: d.h },
    );
    setPos(d.last);
  }, []);
  const onDragEnd = useCallback((e) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    dragRef.current = null;
    if (!d.moved) return;
    suppressClickRef.current = true;
    saveKeypadPos(d.last);
  }, []);
  const dragHandlers = {
    onPointerDown: onDragStart,
    onPointerMove: onDragMove,
    onPointerUp: onDragEnd,
    onPointerCancel: onDragEnd,
  };

  if (!mobile || hidden) return null;

  const style = {
    right: pos.right + "px",
    bottom: `calc(${pos.bottom}px + var(--kb-inset, 0px))`,
  };

  const actionRow = confirmLogout
    ? [
        <span
          key="__logoutAsk"
          className="mobileKeypadAsk"
          data-key="__logoutAsk"
        >
          {i18n("mobileKeypad_logoutConfirm")}
        </span>,
        <button
          key="__logoutYes"
          type="button"
          className="nomouse_command mobileKeypadKey mobileKeypadDanger"
          aria-label={i18n("mobileKeypad_logoutYes")}
          data-key="__logoutYes"
          onClick={onLogoutYes}
        >
          ✓
        </button>,
        <button
          key="__logoutNo"
          type="button"
          className="nomouse_command mobileKeypadKey mobileKeypadAux"
          aria-label={i18n("mobileKeypad_logoutNo")}
          data-key="__logoutNo"
          onClick={() => setConfirmLogout(false)}
        >
          ✕
        </button>,
      ]
    : [
        <button
          key={MOBILE_KEYPAD_PUSH_KEY}
          type="button"
          className="nomouse_command mobileKeypadKey"
          aria-label={i18n("mobileKeypad_push")}
          data-key={MOBILE_KEYPAD_PUSH_KEY}
          onClick={() => sendKey(MOBILE_KEYPAD_PUSH_KEY)}
        >
          推
        </button>,
        <button
          key="__select"
          type="button"
          className={
            "nomouse_command mobileKeypadKey mobileKeypadAux" +
            (selectMode ? " active" : "")
          }
          aria-label={i18n("mobileKeypad_select")}
          aria-pressed={selectMode}
          data-key="__select"
          onClick={onSelectMode}
        >
          選取
        </button>,
        <button
          key="__logout"
          type="button"
          className="nomouse_command mobileKeypadKey mobileKeypadWide"
          aria-label={i18n("mobileKeypad_logout")}
          data-key="__logout"
          onClick={() => setConfirmLogout(true)}
        >
          登出
        </button>,
        <button
          key="__drag"
          type="button"
          className="nomouse_command mobileKeypadKey mobileKeypadAux mobileKeypadDrag"
          aria-label={i18n("mobileKeypad_drag")}
          data-key="__drag"
          {...dragHandlers}
        >
          ⠿
        </button>,
      ];

  return (
    <div
      id="mobileKeypad"
      ref={rootRef}
      className="nomouse_command mobileKeypad"
      style={style}
      onMouseDown={keepFocus}
      onMouseUp={swallow}
      onClick={swallow}
    >
      {open && (
        <div className="nomouse_command mobileKeypadGrid">
          {MOBILE_KEYPAD_ROWS.map((row) =>
            row.map((k) => (
              <button
                key={k.key}
                type="button"
                className="nomouse_command mobileKeypadKey"
                aria-label={k.aria}
                data-key={k.key}
                onClick={() => sendKey(k.key)}
              >
                {k.label}
              </button>
            )),
          ).flatMap((btns, r) => [
            ...btns,
            r === 0 ? (
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
            ) : (
              <button
                key="__close"
                type="button"
                className="nomouse_command mobileKeypadKey mobileKeypadAux"
                aria-label={i18n("mobileKeypad_toggle")}
                data-key="__close"
                onClick={() => {
                  setConfirmLogout(false);
                  setOpen(false);
                }}
              >
                ✕
              </button>
            ),
          ])}
          {actionRow}
        </div>
      )}
      {!open && (
        <button
          type="button"
          className="nomouse_command mobileKeypadFab"
          aria-label={i18n("mobileKeypad_toggle")}
          data-key="__open"
          {...dragHandlers}
          onClick={() => {
            if (suppressClickRef.current) {
              suppressClickRef.current = false;
              return;
            }
            setOpen(true);
          }}
        >
          ⌨
        </button>
      )}
    </div>
  );
};

export default MobileKeypad;
