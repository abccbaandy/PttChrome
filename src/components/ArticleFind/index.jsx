import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconChevronDown, IconChevronUp, IconX } from "@tabler/icons-react";
import { i18n } from "../../js/i18n";
import "./ArticleFind.css";

// 手機文章內找字的找字列（P75，邏輯在 js/article_find.js）。App Bar 正下方一條：輸入框、
// 第幾個／共幾個、上一個、下一個、✕。狀態只從 pttchrome.articleFind.onChange 來。
// 開著＝modal（App.setModalOpen 具名來源）：輸入框打的字不可落進終端機送給 PTT；文章照樣可以滑。
// 系統返回＝收起（registerSheetDismiss）。畫在 body 底下的 portal，不在 #BBSWindow 裡。
const MODAL_SOURCE = "articleFind";

const fmt = (key, vars) =>
  String(i18n(key) || "").replace(/\{(\w+)\}/g, (m, k) =>
    vars && vars[k] != null ? String(vars[k]) : m,
  );

const Bar = ({ pttchrome, ctl, state }) => {
  const inputRef = useRef(null);
  const [text, setText] = useState(state.query || "");
  const close = useCallback(() => ctl.close(), [ctl]);

  useEffect(() => {
    if (!pttchrome || typeof pttchrome.setModalOpen !== "function")
      return undefined;
    pttchrome.setModalOpen(MODAL_SOURCE, true);
    return () => pttchrome.setModalOpen(MODAL_SOURCE, false);
  }, [pttchrome]);

  useEffect(() => {
    if (!pttchrome || typeof pttchrome.registerSheetDismiss !== "function")
      return undefined;
    return pttchrome.registerSheetDismiss(close);
  }, [pttchrome, close]);

  useEffect(() => {
    if (inputRef.current) inputRef.current.focus();
  }, []);

  const count = !state.query.trim()
    ? ""
    : state.total
      ? fmt("articleFind_count", { n: state.index + 1, total: state.total })
      : i18n("articleFind_none");

  return (
    <div
      className="articleFindBar"
      data-article-find
      role="search"
      onMouseDown={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        className="articleFindInput"
        type="search"
        enterKeyHint="search"
        autoComplete="off"
        aria-label={i18n("articleFind_placeholder")}
        placeholder={i18n("articleFind_placeholder")}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          ctl.setQuery(e.target.value);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) ctl.prev();
            else ctl.next();
          } else if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
      />
      <span className="articleFindCount" data-article-find-count aria-live="polite">
        {count}
      </span>
      <button
        type="button"
        className="articleFindBtn"
        data-article-find-prev
        aria-label={i18n("articleFind_prev")}
        disabled={!state.total}
        onClick={() => ctl.prev()}
      >
        <IconChevronUp size={22} />
      </button>
      <button
        type="button"
        className="articleFindBtn"
        data-article-find-next
        aria-label={i18n("articleFind_next")}
        disabled={!state.total}
        onClick={() => ctl.next()}
      >
        <IconChevronDown size={22} />
      </button>
      <button
        type="button"
        className="articleFindBtn"
        data-article-find-close
        aria-label={i18n("articleFind_close")}
        onClick={close}
      >
        <IconX size={22} />
      </button>
    </div>
  );
};

export const ArticleFindBar = ({ pttchrome }) => {
  const ctl = pttchrome && pttchrome.articleFind;
  const [state, setState] = useState(() => (ctl ? ctl.state : null));
  useEffect(() => {
    if (!ctl || typeof ctl.onChange !== "function") return undefined;
    return ctl.onChange((s) => setState(s));
  }, [ctl]);
  if (!state || !state.open || typeof document === "undefined") return null;
  return createPortal(
    <Bar pttchrome={pttchrome} ctl={ctl} state={state} />,
    document.body,
  );
};

export default ArticleFindBar;
