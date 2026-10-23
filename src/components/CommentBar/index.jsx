import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { i18n } from "../../js/i18n";
import {
  COMMENT_BAR_HEIGHT,
  COMMENT_BAR_ID,
  commentBarCounter,
} from "../../js/comment_bar";
import "./CommentBar.css";

// 好讀文章底部常駐推文列（邏輯在 js/comment_bar.js，設計見 docs/long-push.md
// 「底部常駐推文列」）。位置與顯示與否只從 pttchrome.commentBar.onChange 來。
//
// 送出走 pttchrome.openQuickPush（ContextMenu 注入，同 openLongPushModal 的合約：
// 回 true ＝接手了）。接手之後輸入框清空——內容已經進了長推文草稿，送不出去時錯誤框
// 或長推文輸入框會把它還給使用者。
//
// 焦點：輸入框拿到焦點時登記成 modal 來源 "commentBar"，終端機不會把焦點搶回隱藏的
// #t；離開（blur、Esc、列被收起）就解除，App.setModalOpen 會把焦點還給 #t。
// 手機收合（state.folded）：列平常不畫，底部導覽的「推文」呼叫 bar.expand() 才出現並聚焦；
// 送出、離開輸入框、收鍵盤（Android 收鍵盤不會 blur，看 --vv-kb-inset 歸零）就 bar.collapse()，
// 系統返回由 bar 登記的 sheet dismiss 收。
// 滑鼠：App 的滑鼠入口在 window ⇒ 列上的事件一律 stopPropagation，且 App._onUploadLayer
// 認 #commentBar 放過（不會被當成點終端機）。
const TYPES = [
  { value: "push", key: "commentBar_push" },
  { value: "boo", key: "commentBar_boo" },
  { value: "arrow", key: "commentBar_arrow" },
];

const swallow = (e) => e.stopPropagation();
// 按鈕不搶焦點：點類型時輸入框（或終端機）的焦點照舊。
const keepFocus = (e) => {
  e.preventDefault();
  e.stopPropagation();
};

export const CommentBar = ({ pttchrome }) => {
  const bar = pttchrome && pttchrome.commentBar;
  const [state, setState] = useState(() => (bar ? bar.state : null));
  const [text, setText] = useState("");
  const [type, setType] = useState("push");
  const inputRef = useRef(null);
  const visible = !!(state && state.visible);
  const prefill = state && state.prefill;
  const foldedOpen = !!(state && state.folded && state.expanded);
  // 打字時右邊的「剩 N 字／會分成 N 則」（只算字，不送鍵）。上限問 bar（有快取）。
  const counter = useMemo(() => {
    if (!state || !state.counter || !bar || typeof bar.maxBytes !== "function")
      return null;
    return commentBarCounter(text, bar.maxBytes());
  }, [state, bar, text]);

  useEffect(() => {
    if (!bar || typeof bar.onChange !== "function") return undefined;
    return bar.onChange((s) => setState(s));
  }, [bar]);

  // 累積頁尾端多留一條列高的空白（main.css `.commentBarShown`），最後一列才捲得出來。
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("commentBarShown", visible);
    root.style.setProperty("--comment-bar-h", COMMENT_BAR_HEIGHT + "px");
    return () => root.classList.remove("commentBarShown");
  }, [visible]);

  const setFocused = useCallback(
    (on) => {
      if (pttchrome && pttchrome.setModalOpen)
        pttchrome.setModalOpen("commentBar", on);
    },
    [pttchrome],
  );
  // 列被收起時輸入框跟著卸載，不會有 blur ⇒ 這裡補解除。
  useEffect(() => {
    if (!visible) setFocused(false);
  }, [visible, setFocused]);
  useEffect(() => () => setFocused(false), [setFocused]);

  // 「回覆這則」之類的預填：換類型、填字、游標放到最後並聚焦（手機會叫出鍵盤）。
  // 等一幀再聚焦：選單關掉時會把焦點還給終端機，要排在它後面。
  const prefillN = prefill ? prefill.n : 0;
  useEffect(() => {
    if (!prefill) return undefined;
    setType(prefill.type);
    setText(prefill.text);
    const id = requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const end = el.value.length;
      el.setSelectionRange(end, end);
    });
    return () => cancelAnimationFrame(id);
    // 只看請求序號：同一個請求不重填（使用者改了字之後重畫不可以被蓋回去）。
  }, [prefillN]);

  // 展開時聚焦（等一幀：列這一幀才 mount）。手機會叫出鍵盤。
  const focusN = state ? state.focusN : 0;
  useEffect(() => {
    if (!focusN) return undefined;
    const id = requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) el.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [focusN]);

  const collapse = useCallback(() => {
    if (bar && typeof bar.collapse === "function") bar.collapse();
  }, [bar]);

  // 收合模式展開中：鍵盤看過出現、之後收起 ⇒ 收回列（Android 返回鍵先收鍵盤，不會 blur）。
  useEffect(() => {
    const vv = typeof window !== "undefined" && window.visualViewport;
    if (!foldedOpen || !vv) return undefined;
    const root = document.documentElement;
    let seen = false;
    const onResize = () => {
      const inset = parseFloat(root.style.getPropertyValue("--vv-kb-inset")) || 0;
      if (inset > 0) seen = true;
      else if (seen) collapse();
    };
    vv.addEventListener("resize", onResize);
    return () => vv.removeEventListener("resize", onResize);
  }, [foldedOpen, collapse]);

  const submit = useCallback(() => {
    if (!text.trim() || !pttchrome || !pttchrome.openQuickPush) return;
    if (pttchrome.openQuickPush({ text, type })) {
      setText("");
      setType("push");
      if (inputRef.current) inputRef.current.blur();
    }
  }, [pttchrome, text, type]);

  const onKeyDown = useCallback(
    (e) => {
      // 輸入框裡的按鍵一律不外洩（window 上還有 F4／F5 之類的攔截）。IME 組字中的
      // Enter 是選字，不是送出。
      e.stopPropagation();
      if (e.nativeEvent && e.nativeEvent.isComposing) return;
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.currentTarget.blur();
      }
    },
    [submit],
  );

  if (!visible) return null;

  return (
    <div
      id={COMMENT_BAR_ID}
      className={
        "commentBar" +
        (state.mobile ? " commentBar--mobile" : "") +
        (foldedOpen ? " commentBar--unfolded" : "")
      }
      style={{
        left: state.left,
        width: state.width,
        // 手機：輸入框叫出的鍵盤蓋住底部導覽 ⇒ 列浮到鍵盤上緣（--vv-kb-inset 由
        // App._onVisualViewport 寫，不碰終端機幾何）。
        bottom: `max(${state.bottom}px, var(--vv-kb-inset, 0px))`,
        height: COMMENT_BAR_HEIGHT,
      }}
      onMouseDown={swallow}
      onMouseUp={swallow}
      onClick={swallow}
      onContextMenu={swallow}
    >
      <div
        className="commentBarTypes"
        role="radiogroup"
        aria-label={i18n("commentBar_type")}
      >
        {TYPES.map((t) => (
          <button
            key={t.value}
            type="button"
            role="radio"
            aria-checked={type === t.value}
            data-comment-type={t.value}
            className={
              "commentBarType commentBarType--" +
              t.value +
              (type === t.value ? " is-active" : "")
            }
            onMouseDown={keepFocus}
            onClick={(e) => {
              e.stopPropagation();
              setType(t.value);
            }}
          >
            {i18n(t.key)}
          </button>
        ))}
      </div>
      <input
        ref={inputRef}
        className="commentBarInput"
        name="commentBarText"
        type="text"
        autoComplete="off"
        enterKeyHint="send"
        placeholder={i18n("commentBar_placeholder")}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          if (foldedOpen) collapse();
        }}
      />
      {counter && (
        <span
          className={
            "commentBarCounter" +
            (counter.segments > 1 ? " commentBarCounter--split" : "")
          }
          data-comment-counter=""
          aria-live="polite"
        >
          {counter.segments > 1
            ? i18n("commentBar_segments").replace("{0}", counter.segments)
            : i18n("commentBar_remaining").replace("{0}", counter.remaining)}
        </span>
      )}
      <button
        type="button"
        className="commentBarSend"
        data-comment-send=""
        disabled={!text.trim()}
        onMouseDown={keepFocus}
        onClick={(e) => {
          e.stopPropagation();
          submit();
        }}
      >
        {i18n("commentBar_send")}
      </button>
    </div>
  );
};

export default CommentBar;
