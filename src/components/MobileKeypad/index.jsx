import { useState, useEffect, useCallback } from "react";
import { i18n } from "../../js/i18n";
import { MOBILE_KEYPAD_ROWS } from "../../js/mobile_layout";
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
const swallow = (e) => {
  e.stopPropagation();
};
const keepFocus = (e) => {
  e.preventDefault();
  e.stopPropagation();
};

export const MobileKeypad = ({ pttchrome, hidden }) => {
  const [mobile, setMobile] = useState(() => !!pttchrome.mobile);
  const [open, setOpen] = useState(false);
  const [keyboard, setKeyboard] = useState(() => !!pttchrome.softKeyboard);

  useEffect(() => {
    setMobile(!!pttchrome.mobile);
    // 測試常用假的 pttchrome 渲染 ContextMenu，沒有這支就當作永遠不是手機。
    if (typeof pttchrome.onMobileChange !== "function") return undefined;
    // softKeyboard 也可能被 App 自己歸零（Android 返回鍵收起鍵盤，見
    // App._onVisualViewport），鍵盤鈕的亮燈要跟著它，不能只信自己按下時的回傳值。
    return pttchrome.onMobileChange((m, kb) => {
      setMobile(m);
      setKeyboard(!!m && !!kb);
    });
  }, [pttchrome]);

  const sendKey = useCallback(
    (key) => {
      pttchrome.view.sendKeyAsUser(key);
    },
    [pttchrome],
  );

  const onKeyboard = useCallback(() => {
    setKeyboard(pttchrome.toggleSoftKeyboard());
  }, [pttchrome]);

  if (!mobile || hidden) return null;

  return (
    <div
      id="mobileKeypad"
      className="nomouse_command mobileKeypad"
      onMouseDown={keepFocus}
      onMouseUp={swallow}
      onClick={swallow}
    >
      {open && (
        <div className="nomouse_command mobileKeypadGrid">
          {MOBILE_KEYPAD_ROWS.map((row, r) =>
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
                onClick={() => setOpen(false)}
              >
                ✕
              </button>
            ),
          ])}
        </div>
      )}
      {!open && (
        <button
          type="button"
          className="nomouse_command mobileKeypadFab"
          aria-label={i18n("mobileKeypad_toggle")}
          data-key="__open"
          onClick={() => setOpen(true)}
        >
          ⌨
        </button>
      )}
    </div>
  );
};

export default MobileKeypad;
