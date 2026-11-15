import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { i18n } from "../../js/i18n";
import {
  COMMENT_BAR_HEIGHT,
  COMMENT_BAR_ID,
  COMMENT_BAR_MAX_LINES,
  commentBarCounter,
  commentBarText,
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
//
// 列表模式（state.mode === 'list'，P90）：列表上 PTT 畫著推文類型選單時，同一條列蓋在選單上。
// 送出走 bar.submitList（長推文狀態機替使用者按類型鍵→內容→y）；✕／Esc／系統返回＝bar.cancelList
// （替使用者送 PTT 原生的取消）。禁噓板不出「噓」。累積頁的尾端空白（.commentBarShown）只給文章。
//
// 長推文看得到全文：輸入框是 textarea（Enter 照樣送出，不換行；貼上的換行換成空白）。
// 打字中（聚焦，或手機收合展開中）跟著內容往上長高，最多 COMMENT_BAR_MAX_LINES 行；
// 手機再改成上下兩層——輸入框獨佔一整列吃滿寬，推／噓／→、計數、送出排在下面。
// 沒聚焦就縮回單行原樣。實際列高用 ResizeObserver 量，回報給 bar.setHeight（下一篇
// 卡片、導覽軸讓位）並寫進 --comment-bar-h（累積頁尾端的空白跟著加高）。
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
  const [focused, setFocusedState] = useState(false);
  const inputRef = useRef(null);
  const rootRef = useRef(null);
  const visible = !!(state && state.visible);
  const listMode = !!(state && state.mode === "list");
  const booAllowed = !state || state.booAllowed !== false;
  // P91：PTT 已經直接給 → 輸入列（作者本人／90 秒內連推）⇒ 類型只剩 →，提示照 PTT 原話。
  const arrowOnly = !!(state && state.arrowOnly);
  const notice = (state && state.notice) || "";
  const prefill = state && state.prefill;
  const foldedOpen = !!(state && state.folded && state.expanded);
  // 正在打字：輸入框長高；手機改上下兩層。收合展開中焦點下一幀才到，先排好版面不跳一下。
  const active = visible && (focused || foldedOpen);
  const stacked = active && !!(state && state.mobile);
  const barWidth = state ? state.width : 0;
  const barHeight = (state && state.height) || COMMENT_BAR_HEIGHT;
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
    root.classList.toggle("commentBarShown", visible && !listMode);
    return () => root.classList.remove("commentBarShown");
  }, [visible, listMode]);

  // 換模式（文章 ↔ 列表）或列表換了一篇：輸入框的字與類型是給上一個目標的，清掉。
  // 列收起時元件只 return null、state 留著 ⇒ 不清就會把 A 篇打到一半的字按 Enter 推到 B 篇。
  const listTarget = state && state.listTarget;
  const targetKey = listMode
    ? "list:" +
      (listTarget
        ? [
            listTarget.board,
            listTarget.num,
            listTarget.author,
            listTarget.date,
            listTarget.subject,
          ].join("\u0001")
        : "")
    : "article";
  const lastTargetKey = useRef(targetKey);
  useEffect(() => {
    if (lastTargetKey.current === targetKey) return;
    lastTargetKey.current = targetKey;
    setText("");
    setType("push");
  }, [targetKey]);

  // 禁噓板（列表模式讀到的類型選單沒有 2.）：選著噓就改回推。
  useEffect(() => {
    if (arrowOnly && type !== "arrow") setType("arrow");
    else if (!booAllowed && type === "boo") setType("push");
  }, [booAllowed, arrowOnly, type]);
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--comment-bar-h",
      barHeight + "px",
    );
  }, [barHeight]);

  // 輸入框高度：打字中＝內容高（上限 COMMENT_BAR_MAX_LINES 行，再多框內捲）；沒在打字＝CSS 的單行高。
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    if (!active) {
      el.style.height = "";
      el.style.overflowY = "";
      return;
    }
    el.style.height = "auto";
    const cs = getComputedStyle(el);
    const frame =
      parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const max = parseFloat(cs.lineHeight) * COMMENT_BAR_MAX_LINES + pad + frame;
    const want = el.scrollHeight + frame;
    el.style.height = Math.min(want, max) + "px";
    el.style.overflowY = want > max + 0.5 ? "auto" : "hidden";
  }, [active, stacked, text, barWidth, visible]);

  // 列的實際高度回報給 bar（下一篇卡片／導覽軸讓位）。
  useEffect(() => {
    const el = rootRef.current;
    if (!visible || !el || !bar || typeof bar.setHeight !== "function")
      return undefined;
    if (typeof ResizeObserver !== "function") return undefined;
    const ro = new ResizeObserver(() => bar.setHeight(el.offsetHeight));
    ro.observe(el);
    return () => {
      ro.disconnect();
      bar.setHeight(COMMENT_BAR_HEIGHT);
    };
  }, [visible, bar]);

  const setFocused = useCallback(
    (on) => {
      if (pttchrome && pttchrome.setModalOpen)
        pttchrome.setModalOpen("commentBar", on);
    },
    [pttchrome],
  );
  // 列被收起時輸入框跟著卸載，不會有 blur ⇒ 這裡補解除。
  useEffect(() => {
    if (!visible) {
      setFocused(false);
      setFocusedState(false);
    }
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

  // 列表模式（P90）：列出現到聚焦之間打的字被擋在終端機的 #t（comment_bar.js#_holdTerminalKeys），
  // 聚焦時接過來接在輸入框後面。已經聚焦著（換了一篇）不會再有 focus 事件 ⇒ 聚焦請求那邊也收一次。
  const takePending = useCallback(() => {
    if (!bar || typeof bar.takePendingInput !== "function") return;
    const pending = bar.takePendingInput();
    if (pending) setText((cur) => commentBarText(cur + pending));
  }, [bar]);

  // 展開時聚焦（等一幀：列這一幀才 mount）。手機會叫出鍵盤。
  const focusN = state ? state.focusN : 0;
  useEffect(() => {
    if (!focusN) return undefined;
    const id = requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) el.focus();
      if (el && document.activeElement === el) takePending();
      else if (bar && typeof bar.releasePendingInput === "function")
        bar.releasePendingInput();
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
      const inset =
        parseFloat(root.style.getPropertyValue("--vv-kb-inset")) || 0;
      if (inset > 0) seen = true;
      else if (seen) collapse();
    };
    vv.addEventListener("resize", onResize);
    return () => vv.removeEventListener("resize", onResize);
  }, [foldedOpen, collapse]);

  const submit = useCallback(() => {
    if (!text.trim() || !pttchrome) return;
    if (listMode) {
      const r = bar && bar.submitList ? bar.submitList({ text, type }) : null;
      if (r && r.ok) {
        setText("");
        setType("push");
        if (inputRef.current) inputRef.current.blur();
        return;
      }
      const key =
        r && r.reason === "dropped"
          ? "commentBar_listDropped"
          : r && r.reason === "tooMany"
            ? "commentBar_listTooMany"
            : r && r.reason === "empty"
              ? null
              : "commentBar_listGone";
      if (key) pttchrome.view?.flashListHint?.(i18n(key), 4000);
      return;
    }
    if (!pttchrome.openQuickPush) return;
    if (pttchrome.openQuickPush({ text, type })) {
      setText("");
      setType("push");
      if (inputRef.current) inputRef.current.blur();
    }
  }, [pttchrome, bar, listMode, text, type]);

  const cancelList = useCallback(() => {
    if (bar && typeof bar.cancelList === "function") bar.cancelList();
  }, [bar]);

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
        if (listMode) cancelList();
        else e.currentTarget.blur();
      }
    },
    [submit, listMode, cancelList],
  );

  if (!visible) return null;

  return (
    <div
      ref={rootRef}
      id={COMMENT_BAR_ID}
      className={
        "commentBar" +
        (state.mobile ? " commentBar--mobile" : "") +
        (foldedOpen ? " commentBar--unfolded" : "") +
        (active ? " commentBar--active" : "") +
        (stacked ? " commentBar--stacked" : "") +
        (listMode ? " commentBar--list" : "") +
        (state.coverExtra ? " commentBar--cover" : "")
      }
      data-comment-mode={listMode ? "list" : "article"}
      style={{
        left: state.left,
        width: state.width,
        // 手機：輸入框叫出的鍵盤蓋住底部導覽 ⇒ 列浮到鍵盤上緣（--vv-kb-inset 由
        // App._onVisualViewport 寫，不碰終端機幾何）。
        bottom: `max(${state.bottom}px, var(--vv-kb-inset, 0px))`,
        // 釘下緣、高度隨內容：打字中輸入框長高時列往上長。
        minHeight: COMMENT_BAR_HEIGHT + ((state && state.coverExtra) || 0),
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
        {TYPES.filter((t) =>
          arrowOnly ? t.value === "arrow" : booAllowed || t.value !== "boo",
        ).map((t) => (
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
      {arrowOnly && notice ? (
        <span className="commentBarNotice" data-comment-notice="">
          {notice}
        </span>
      ) : null}
      <textarea
        ref={inputRef}
        className="commentBarInput"
        name="commentBarText"
        rows={1}
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="send"
        placeholder={i18n("commentBar_placeholder")}
        value={text}
        onChange={(e) => setText(commentBarText(e.target.value))}
        onKeyDown={onKeyDown}
        onFocus={() => {
          setFocused(true);
          setFocusedState(true);
          takePending();
        }}
        onBlur={() => {
          setFocused(false);
          setFocusedState(false);
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
      {listMode && (
        <button
          type="button"
          className="commentBarClose"
          data-comment-cancel=""
          aria-label={i18n("commentBar_listCancel")}
          title={i18n("commentBar_listCancel")}
          onMouseDown={keepFocus}
          onClick={(e) => {
            e.stopPropagation();
            cancelList();
          }}
        >
          ✕
        </button>
      )}
    </div>
  );
};

export default CommentBar;
