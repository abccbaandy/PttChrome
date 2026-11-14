import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconX } from "@tabler/icons-react";
import { i18n } from "../../js/i18n";
import { readEffectivePrefs } from "../../js/pref_storage";
import { normalizeMobileFontPx } from "../../js/mobile_layout";
import "./SelectTextPage.css";

// 手機「選取文字」頁（P81）：全螢幕、留邊、自動換行的純文字，選取交給系統（把手、放大鏡、
// 複製工具列都是 Android 原生的）。狀態只從 pttchrome.selectTextPage.onChange 來
// （js/select_text_page.js），這裡照畫。
// 規則同 LogoutConfirm：開著＝modal（App.setModalOpen 具名來源，終端機鍵盤／滑鼠入口讓位）、
// 系統返回＝關掉（registerSheetDismiss）。畫在 body 底下的 portal：不在 #BBSWindow 裡 ⇒ 長按
// 不會開我們的選單，原生選取照常。一個 byte 都不送。
export const SELECT_TEXT_PAGE_Z_INDEX = 3200; // 高於 MobileSheet（3000）與登出確認（3100）

const MODAL_SOURCE = "selectTextPage";
const COPIED_MS = 1500;

// 選取範圍有沒有落在這一頁的文字裡（別處殘留的選取不算）。
function selectionIn(el) {
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  if (!el || !sel || sel.isCollapsed || !sel.rangeCount) return "";
  const range = sel.getRangeAt(0);
  if (!el.contains(range.commonAncestorContainer)) return "";
  return sel.toString();
}

const Page = ({ pttchrome, ctl, state }) => {
  const bodyRef = useRef(null);
  // 按下按鈕那一刻的選取：手指點按鈕時瀏覽器可能先把選取清掉才發 click（同 MobileToolbar
  // 的 pressSelectionRef），所以在 pointerdown 先記下來。
  const pressSelectionRef = useRef("");
  const [copied, setCopied] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);

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

  // 終端機那邊的選取（選取模式留下的）先清掉：這一頁的複製鈕只認這一頁裡的選取。
  useEffect(() => {
    try {
      window.getSelection().removeAllRanges();
    } catch (e) {
      // 沒有 selection API 就算了。
    }
  }, []);

  useEffect(() => {
    const onSel = () => setHasSelection(!!selectionIn(bodyRef.current));
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, []);

  // 從長按選單開的：捲到長按的那一行（放在畫面上方約 1/3）。
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body || state.focusIndex < 0) return;
    const line = body.querySelector(`[data-line="${state.focusIndex}"]`);
    if (!line) return;
    const delta =
      line.getBoundingClientRect().top - body.getBoundingClientRect().top;
    body.scrollTop = Math.max(0, body.scrollTop + delta - body.clientHeight / 3);
  }, [state.focusIndex]);

  const onPressDown = () => {
    pressSelectionRef.current = selectionIn(bodyRef.current);
  };

  const onSelectAll = () => {
    const body = bodyRef.current;
    if (!body) return;
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(body);
    sel.removeAllRanges();
    sel.addRange(range);
  };

  const onCopy = () => {
    const text = selectionIn(bodyRef.current) || pressSelectionRef.current;
    pressSelectionRef.current = "";
    if (!text || typeof pttchrome.doCopy !== "function") return;
    Promise.resolve(pttchrome.doCopy(text)).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_MS);
    });
  };

  return createPortal(
    <div
      className="nomouse_command selectTextPage"
      data-key="__selectTextPage"
      role="dialog"
      aria-modal="true"
      aria-label={i18n("selectText_title")}
      style={{ zIndex: SELECT_TEXT_PAGE_Z_INDEX }}
    >
      <div className="selectTextPageHeader">
        <span className="selectTextPageTitle">{i18n("selectText_title")}</span>
        <span className="selectTextPageHint">{i18n("selectText_hint")}</span>
        <button
          type="button"
          className="selectTextPageClose pttRipple"
          data-key="__selectTextClose"
          aria-label={i18n("selectText_close")}
          title={i18n("selectText_close")}
          onClick={close}
        >
          <IconX size={22} stroke={2} aria-hidden="true" />
        </button>
      </div>
      <div
        className="selectTextPageBody"
        ref={bodyRef}
        data-select-text-body=""
        // 比終端機大一號：跟著手機字級（設定頁「手機字級」）走。
        style={{
          fontSize:
            normalizeMobileFontPx(readEffectivePrefs().mobileFontSize) + 1,
        }}
      >
        {state.lines.map((l, i) => (
          <div key={l.row} className="selectTextPageLine" data-line={i} data-row={l.row}>
            {l.text || " "}
          </div>
        ))}
      </div>
      <div className="selectTextPageFooter">
        <button
          type="button"
          className="selectTextPageBtn pttRipple"
          data-key="__selectTextAll"
          onClick={onSelectAll}
        >
          {i18n("selectText_selectAll")}
        </button>
        <button
          type="button"
          className="selectTextPageBtn selectTextPagePrimary pttRipple"
          data-key="__selectTextCopy"
          // 不用 disabled：手指點按鈕時系統可能先清掉選取（selectionchange 先到）⇒ 按鈕在 click
          // 之前就變成 disabled、click 被吃掉。只改外觀，按下去沒選取就什麼都不做。
          data-empty={!hasSelection && !copied ? "" : undefined}
          onPointerDown={onPressDown}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onCopy}
        >
          {i18n(copied ? "selectText_copied" : "selectText_copy")}
        </button>
      </div>
    </div>,
    document.body,
  );
};

export const SelectTextPage = ({ pttchrome }) => {
  const ctl = pttchrome && pttchrome.selectTextPage;
  const [state, setState] = useState(() => (ctl ? ctl.state : null));

  useEffect(() => {
    if (!ctl || typeof ctl.onChange !== "function") return undefined;
    return ctl.onChange((s) => setState(s));
  }, [ctl]);

  if (!state || !state.open) return null;
  return <Page pttchrome={pttchrome} ctl={ctl} state={state} />;
};

export default SelectTextPage;
