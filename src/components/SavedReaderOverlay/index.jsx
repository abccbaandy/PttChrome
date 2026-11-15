import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { IconX, IconWorld } from "@tabler/icons-react";
import { i18n } from "../../js/i18n";
import { SAVED_READER_CLOSE_MESSAGE } from "../../js/saved_articles";
import "./SavedReaderOverlay.css";

// 離線文章的唯讀頁（js/saved_articles.js#open）：全螢幕 iframe 載 `?saved=<key>`。
// 不另開分頁：APK 的 WebView 開不了新分頁（window.open 一律被原生轉交外部瀏覽器，本站網址又被
// App Link 解析回 App ⇒ 點了沒反應）。iframe 同源（同一個 IndexedDB）、唯讀頁不 connect()
// ⇒ 後面的活連線原封不動，關掉就回到原本的畫面；「前往線上版本」用這條連線開那一篇。
// 規則同 SelectTextPage：開著＝modal（App.setModalOpen 具名來源，終端機鍵盤／焦點讓位）、
// 系統返回＝關掉（registerSheetDismiss）。
export const SAVED_READER_Z_INDEX = 3150; // 高於 MobileSheet（3000）與登出確認（3100）

const MODAL_SOURCE = "savedReader";

const Overlay = ({ pttchrome, saved, reader }) => {
  const close = useCallback(() => saved.closeReader(), [saved]);

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

  // iframe 裡按 Esc（唯讀頁吞掉按鍵，外面收不到）：唯讀頁 postMessage 過來。只認同源。
  useEffect(() => {
    const onMessage = (e) => {
      if (e.origin !== window.location.origin) return;
      if (e.data && e.data.type === SAVED_READER_CLOSE_MESSAGE) close();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [close]);

  // 開不了（沒連線、忙）時提示一下，唯讀頁留著。
  const [onlineFailed, setOnlineFailed] = useState(false);
  const openOnline = () => {
    if (!saved.openOnline()) setOnlineFailed(true);
  };

  return createPortal(
    <div
      className="nomouse_command savedReaderOverlay"
      data-key="__savedReader"
      data-saved-reader={reader.key}
      role="dialog"
      aria-modal="true"
      aria-label={i18n("saved_readerTitle")}
      style={{ zIndex: SAVED_READER_Z_INDEX }}
    >
      <div className="savedReaderOverlayHeader">
        <span className="savedReaderOverlayTitle">
          {reader.title || i18n("saved_readerTitle")}
        </span>
        <button
          type="button"
          className="savedReaderOverlayOnline pttRipple"
          data-key="__savedReaderOnline"
          title={i18n(onlineFailed ? "saved_onlineFailed" : "saved_openOnline")}
          onClick={openOnline}
        >
          <IconWorld size={18} stroke={1.75} aria-hidden="true" />
          <span>
            {i18n(onlineFailed ? "saved_onlineFailed" : "saved_openOnline")}
          </span>
        </button>
        <button
          type="button"
          className="savedReaderOverlayClose pttRipple"
          data-key="__savedReaderClose"
          aria-label={i18n("saved_readerClose")}
          title={i18n("saved_readerClose")}
          onClick={close}
        >
          <IconX size={22} stroke={2} aria-hidden="true" />
        </button>
      </div>
      <iframe
        className="savedReaderOverlayFrame"
        src={reader.url}
        title={i18n("saved_readerTitle")}
      />
    </div>,
    document.body,
  );
};

export const SavedReaderOverlay = ({ pttchrome }) => {
  const saved = pttchrome && pttchrome.savedArticles;
  const [reader, setReader] = useState(() => (saved ? saved.reader : null));

  useEffect(() => {
    if (!saved || typeof saved.onReaderChange !== "function") return undefined;
    return saved.onReaderChange((r) => setReader(r));
  }, [saved]);

  if (!reader) return null;
  return <Overlay pttchrome={pttchrome} saved={saved} reader={reader} />;
};

export default SavedReaderOverlay;
