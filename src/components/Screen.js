import React from "react";
import Row from "./Row";
import ImagePreviewer, {
  of,
  resolveSrcToImageUrl,
  resolveWithImageDOM,
} from "./ImagePreviewer";
import {
  rowToText,
  annotateComment,
  parseListAuthor,
  parseListTitleRaw,
  matchTitleBlacklist,
  isDeletedListRow,
  blacklistNoticeText,
  FloorCounter,
} from "../js/comment_parse";
import { detectFixableUrls } from "../js/url_fix";
import { detectMentions } from "../js/mention_parse";
import { detectAids } from "../js/aid_parse";
import {
  groupImageCaptionBlocks,
  maxCaptionCols,
} from "../js/image_caption_group";
import MergeImageCaptionButton from "./MergeImageCaptionButton";

// NOTE: articleAuthor (原PO id) is tracked by term_view across page-downs and
// passed in via enhance — the "作者" header only appears on the first page, so we
// cannot re-derive it from `lines` here on later pages.

// PttChrome pageState (see term_buf.js#setPageState): 2 = board list, 3 = reading.
const PAGE_LIST = 2;
const PAGE_READING = 3;

// Per-row { floor } / { hidden } annotations for the Enhanced Add-on. Native grid
// is fixed-size, so a blacklisted row is hidden (visibility:hidden) rather than
// removed — removing it would desync the terminal grid. Floor numbers here count
// only within the visible page (cross-page numbering needs easy reading; see plan).
function computeAnnotations(lines, enhance, mergeCaption) {
  const result = new Array(lines.length);
  if (!enhance) return result;
  const {
    blacklist,
    titleBlacklist,
    showFloorNumbers,
    highlightAuthor,
    articleAuthor,
    selectedPusher,
    pageState,
    autoFixUrl,
    easyReading,
    enableXMention,
    inListContext,
    listEasyReading,
    onAidClick,
  } = enhance;
  const hasBlacklist = blacklist && blacklist.size > 0;
  const hasTitleBlacklist = titleBlacklist && titleBlacklist.length > 0;
  if (pageState === PAGE_READING) {
    // Floor numbers are shown only in easy reading, where the FloorCounter walks
    // the whole accumulated article (accurate). The native per-page counter resets
    // every page-down → inaccurate, so no floorCounter is passed there and
    // annotateComment skips floors entirely (see comment_parse.js). Auto-fix URL
    // detection below still runs on every row regardless of mode.
    const ctx = {
      blacklist,
      showFloorNumbers,
      floorCounter: easyReading ? new FloorCounter() : undefined,
      highlightAuthor,
      articleAuthor,
      selectedPusher,
    };
    // 圖文合併（好讀限定）：先重建整篇純文字做跨行分組（per-row 的 annotateComment
    // 看不到鄰列）。無論開關與否都要算——關閉時浮動按鈕的顯示條件也需要塊數。
    // 塊數取兩方向（上圖下文/上文下圖）的 max，讓純「上文下圖」文章也出得了按鈕。
    const texts = new Array(lines.length);
    for (let row = 0; row < lines.length; ++row) {
      texts[row] = rowToText(lines[row]);
    }
    let captionBlocks;
    if (easyReading) {
      const imageFirstBlocks = groupImageCaptionBlocks(texts, "imageFirst");
      const captionFirstBlocks = groupImageCaptionBlocks(texts, "captionFirst");
      result.imageCaptionBlockCount = Math.max(
        imageFirstBlocks.length,
        captionFirstBlocks.length,
      );
      captionBlocks =
        mergeCaption === "captionFirst" ? captionFirstBlocks : imageFirstBlocks;
    }
    for (let row = 0; row < lines.length; ++row) {
      const text = texts[row];
      const ann = annotateComment(text, ctx) || undefined;
      // Auto-fix runs on every row (article body included), independent of the
      // comment annotation. The fixed-URL line only renders in easy-reading mode
      // (see LinkSegmentBuilder); detection itself is cheap and returns [] for
      // almost every row.
      let fixedUrls;
      if (autoFixUrl) {
        const fixes = detectFixableUrls(text);
        if (fixes.length) fixedUrls = fixes;
      }
      // X(Twitter) @handle auto-links. Detect on the raw TermChar[] (DBCS-aware —
      // see mention_parse.js) and link every format-valid @handle. Existence
      // verification is currently OFF (unavatar's 25/day cap made it unusable; see
      // docs/enhanced-addon.md for the worker approach to bring it back), so a
      // mention that points at a non-existent account is still linked. Skip hidden
      // (blacklisted) rows, and same-author comment rows whose id is already
      // wrapped by authorIdStart/End (an overlapping mention <a> would fight it).
      let mentions;
      if (
        enableXMention &&
        !(ann && (ann.hidden || ann.authorIdStart !== undefined))
      ) {
        const found = detectMentions(lines[row]);
        for (let k = 0; k < found.length; ++k) {
          const m = found[k];
          (mentions || (mentions = [])).push({
            startCol: m.startCol,
            endCol: m.endCol,
            handle: m.handle,
            href: "https://x.com/" + m.handle,
          });
        }
      }
      // PTT article-code (AID) links, easy reading only: clicking one drives a
      // native key-sequence navigation (aid_navigation.js), which only makes
      // sense from within easy reading. A boardless #AID falls back to the
      // current article's board (tracked by term_view, like articleAuthor).
      // rowText lets aid_parse pick up the cross-post header board prefix
      // (※ [本文轉錄自 X 看板 #AID ]) that cells alone can't match.
      let aids;
      if (easyReading && onAidClick && !(ann && ann.hidden)) {
        const found = detectAids(lines[row], rowToText(lines[row]));
        for (let k = 0; k < found.length; ++k) {
          const a = found[k];
          (aids || (aids = [])).push({
            startCol: a.startCol,
            endCol: a.endCol,
            aid: a.aid,
            board: a.board,
            onClick: () => onAidClick(a.aid, a.board),
          });
        }
      }
      let r = ann;
      if (fixedUrls) r = { ...(r || {}), fixedUrls };
      if (mentions) r = { ...(r || {}), mentions };
      if (aids) r = { ...(r || {}), aids };
      result[row] = r;
    }
    // 開啟合併時把分組結果寫進 annotation：圖行掛 mergeBlock（render 成兩欄
    // wrapper），說明行掛 mergedInto（頂層 render null，改巢狀進右欄）。
    // captionMaxCols＝全部說明段最寬行的顯示欄數，右欄寬度據此動態決定（不換行）。
    if (captionBlocks && mergeCaption) {
      result.captionMaxCols = maxCaptionCols(texts, captionBlocks);
      for (let k = 0; k < captionBlocks.length; ++k) {
        const b = captionBlocks[k];
        result[b.imageRow] = { ...(result[b.imageRow] || {}), mergeBlock: b };
        for (let r = b.captionStart; r <= b.captionEnd; ++r) {
          result[r] = { ...(result[r] || {}), mergedInto: b.imageRow };
        }
      }
    }
  } else if (pageState === PAGE_LIST || inListContext) {
    // inListContext keeps list treatment alive across overlay prompts (e.g. the
    // v 設定已讀未讀記錄 sub-screen) whose status row stops parsing as LIST(2).
    // READING is the preceding `if`, so this never runs while reading an article.
    //
    // Two modes, keyed by listEasyReading (term_view passes it ONLY on the
    // buffer/frozen easy-reading WINDOW render calls; the native / functionMode
    // mirror paths omit it so a temporary switch back to native inside easy reading
    // looks the same as pure native mode — user request 2026-07):
    //   - easy-reading window (listEasyReading): deleted + blacklist rows are HIDDEN.
    //     MUST stay in sync with list_session.js#visibleListIndices (invariant 10).
    //     The window is already pre-filtered there, so this is belt-and-braces.
    //   - native list (no flag): deleted rows render as-is (native display, no hide /
    //     no invert); blacklisted rows render a deleted-style「（本文已被黑名單）」notice
    //     line instead of being hidden. (User rule 2026-07: 原生模式刪除文不動、黑名單
    //     改被刪除樣式；好讀暫時切回原生也走此路 → 不再變回反黑.)
    for (let row = 0; row < lines.length; ++row) {
      const text = rowToText(lines[row]);
      const deleted = isDeletedListRow(text);
      // Quick-add blacklist (right-click menu) needs every visible row's author
      // and raw-case title, independent of whether any blacklist is set yet —
      // exposed via Row as data-list-author / data-list-title.
      const listAuthor = deleted ? null : parseListAuthor(text);
      const listTitle = deleted ? "" : parseListTitleRaw(text);
      let blacklisted = false;
      // Title-keyword hit → the matched keyword; notice line shows it instead of
      // the author so the user knows WHICH rule fired. Author hit → null (the
      // notice's default author display already names the reason).
      let hitKeyword = null;
      if (!deleted && hasBlacklist) {
        if (listAuthor && blacklist.has(listAuthor)) blacklisted = true;
      }
      if (!deleted && !blacklisted && hasTitleBlacklist) {
        hitKeyword = matchTitleBlacklist(
          listTitle.toLowerCase(),
          titleBlacklist,
        );
        if (hitKeyword) blacklisted = true;
      }
      if (listEasyReading) {
        if (deleted || blacklisted) {
          result[row] = { hidden: true };
          continue;
        }
      } else if (blacklisted) {
        result[row] = {
          blacklistNotice: blacklistNoticeText(text, hitKeyword),
        };
        continue;
      }
      // native + deleted → no annotation (render exactly as the server sent it).
      if (listAuthor || listTitle) {
        result[row] = {
          listAuthor: listAuthor || undefined,
          listTitle: listTitle || undefined,
        };
      }
    }
  }
  return result;
}

export const Screen = React.forwardRef(function Screen(props, ref) {
  const {
    lines,
    enhance,
    forceWidth,
    enableLinkInlinePreview,
    enableLinkHoverPreview,
  } = props;

  const [currentHighlighted, setCurrentHighlighted] = React.useState(undefined);
  const [currentImagePreview, setCurrentImagePreview] =
    React.useState(undefined);
  const [pos, setPos] = React.useState({ left: undefined, top: undefined });
  // 好讀自動開圖「一鍵放大全部圖片至視窗寬度」開關；點任一張內嵌預覽圖切換。
  const [imagesEnlarged, setImagesEnlarged] = React.useState(false);
  // 好讀「圖左字右合併」（翻譯漫畫文）：浮動按鈕三態循環
  // null（關）→ "imageFirst"（上圖下文）→ "captionFirst"（上文下圖）→ null。
  // 與 imagesEnlarged 同生命週期——同篇 page-down 保留、換文章/退出再進
  // （articleId 變）即重置回關，所以不會發生「換到沒按鈕的文章卻還開著、關不掉」。
  const [mergeCaption, setMergeCaption] = React.useState(null);

  // 命令式 API：term_view 經 term_ui 的 ref.current.setCurrentHighlighted(row)
  // 設高亮列（鍵盤操作時）。取代 class instance method。
  React.useImperativeHandle(ref, () => ({ setCurrentHighlighted }), []);

  // 取代 getDerivedStateFromProps（render 期比較上一次 ref，React 官方 pattern）：
  // lines reference 改變（換頁/重渲染）即關掉開啟中的 hover 圖片預覽。
  // imagesEnlarged 改以 enhance.articleId 為準：好讀同篇 page-down 會 concat 出新
  // lines reference，但 articleId 不變，故放大狀態在同篇捲動載入時得以保留；換文章 /
  // 退出再進（articleId 變）才重置。
  const prevLinesRef = React.useRef(lines);
  const prevArticleIdRef = React.useRef(enhance && enhance.articleId);
  if (lines !== prevLinesRef.current) {
    prevLinesRef.current = lines;
    if (currentImagePreview !== undefined) setCurrentImagePreview(undefined);
  }
  const articleId = enhance && enhance.articleId;
  if (articleId !== prevArticleIdRef.current) {
    prevArticleIdRef.current = articleId;
    if (imagesEnlarged) setImagesEnlarged(false);
    if (mergeCaption) setMergeCaption(null);
  }

  // 事件委派：點到內嵌預覽圖（.hyperLinkPreview）即切換整頁圖片放大/縮小。
  // hover 預覽的 OnHover img 無此 class，不受影響。
  const handleImageClick = React.useCallback((e) => {
    const t = e.target;
    if (t && t.tagName === "IMG" && t.classList.contains("hyperLinkPreview")) {
      setImagesEnlarged((v) => !v);
    }
  }, []);

  const handleMouseMove = React.useCallback(
    ({ clientX, clientY }) => {
      if (currentImagePreview) setPos({ left: clientX, top: clientY });
    },
    [currentImagePreview],
  );

  const handleHyperLinkMouseOver = React.useCallback(
    ({ currentTarget: { href } }) => {
      if (enableLinkHoverPreview) {
        const preview = of(href)
          .then(resolveSrcToImageUrl)
          .then(resolveWithImageDOM);
        // 同 requestPreview：不可預覽連結立即 reject，消費端（ImagePreviewer
        // effect）晚一拍才掛 handler —— 先標記 handled，避免 unhandledrejection。
        preview.catch(() => {});
        setCurrentImagePreview(preview);
      }
    },
    [enableLinkHoverPreview],
  );

  const handleHyperLinkMouseOut = React.useCallback(() => {
    setCurrentImagePreview(undefined);
  }, []);

  // 按鈕切換純屬 Screen 內部 state；換回終端機輸入焦點（隱藏 input #t），
  // 否則按鈕吃掉鍵盤、方向鍵失效。
  const handleToggleMergeCaption = React.useCallback(() => {
    setMergeCaption((v) =>
      v === null ? "imageFirst" : v === "imageFirst" ? "captionFirst" : null,
    );
    const input = document.getElementById("t");
    if (input) input.focus();
  }, []);

  const annotations = computeAnnotations(lines, enhance, mergeCaption);
  // dropHidden: easy-reading accumulates a single growing scroll page, so a
  // blacklisted comment is removed entirely (render null → no DOM node, no blank
  // line). The fixed native grid instead keeps the row and hides it
  // (visibility:hidden via <Row hidden>) so the terminal alignment is preserved.
  // Rendering null does NOT shift the map index, so surviving rows keep their
  // absolute pageLines index in `row`/`data-row` and selection across the gap
  // (term_buf.getText uses the absolute row index) stays correct.
  const dropHidden = !!(enhance && enhance.dropHidden);
  // 圖文合併（好讀）：renderRow 抽成可重用——說明行從頂層移巢狀進右欄時沿用同一
  // render（row/data-row 保留絕對 pageLines index，term_buf.getText 的選取複製不壞）。
  const renderRow = (row) => {
    const ann = annotations[row];
    return (
      <Row
        key={row}
        chars={lines[row]}
        row={row}
        forceWidth={forceWidth}
        enableLinkInlinePreview={enableLinkInlinePreview}
        highlighted={currentHighlighted === row}
        floor={ann && ann.floor}
        hidden={ann && ann.hidden}
        pusher={ann && ann.pusher}
        listAuthor={ann && ann.listAuthor}
        listTitle={ann && ann.listTitle}
        pusherHighlight={ann && ann.pusherHighlight}
        authorIdStart={ann && ann.authorIdStart}
        authorIdEnd={ann && ann.authorIdEnd}
        fixedUrls={ann && ann.fixedUrls}
        mentions={ann && ann.mentions}
        aids={ann && ann.aids}
        blacklistNotice={ann && ann.blacklistNotice}
        onHyperLinkMouseOver={handleHyperLinkMouseOver}
        onHyperLinkMouseOut={handleHyperLinkMouseOut}
      />
    );
  };
  // 浮動「圖文並排」按鈕：好讀文章頁且偵測到 ≥2 個「圖＋說明」塊才出現。
  // 純結構啟發式（見 image_caption_group.js），不確定那段字是不是翻譯 →
  // opt-in 手動切換；state 在本元件、articleId 變即重置（見上）。
  const showMergeButton = !!(
    enhance &&
    enhance.easyReading &&
    enhance.pageState === PAGE_READING &&
    (annotations.imageCaptionBlockCount || 0) >= 2
  );
  // 右欄不換行：寬度＝最寬翻譯行的顯示欄數（半形1/全形2）× 半形字寬。
  // forceWidth 是全形字強制的像素寬 → 半形 ≈ forceWidth/2；+1 全形字寬當緩衝。
  // 上限 55% 交給 CSS max-width 守（極長行時退回換行，見 main.css pre-wrap）。
  const captionColStyle = annotations.captionMaxCols
    ? { width: (annotations.captionMaxCols / 2 + 1) * forceWidth }
    : undefined;
  return (
    <div
      id="mainContainer"
      className={imagesEnlarged ? "imagesEnlarged" : undefined}
      onMouseMove={handleMouseMove}
      onClick={handleImageClick}
    >
      {lines.map((chars, row) => {
        const ann = annotations[row];
        if (dropHidden && ann && ann.hidden) return null;
        // 說明行已併入所屬圖行的右欄（下方 mergeBlock 分支），頂層不重複 render。
        if (ann && ann.mergedInto !== undefined) return null;
        if (ann && ann.mergeBlock) {
          const { captionStart, captionEnd } = ann.mergeBlock;
          const captionRows = [];
          for (let r = captionStart; r <= captionEnd; ++r) {
            const cAnn = annotations[r];
            if (dropHidden && cAnn && cAnn.hidden) continue;
            captionRows.push(renderRow(r));
          }
          return (
            <div key={row} className="mergedImageBlock">
              <div className="mergedImageCol">{renderRow(row)}</div>
              <div className="mergedCaptionCol" style={captionColStyle}>
                {captionRows}
              </div>
            </div>
          );
        }
        return renderRow(row);
      })}
      {showMergeButton && (
        <MergeImageCaptionButton
          mode={mergeCaption}
          onToggle={handleToggleMergeCaption}
        />
      )}
      {currentImagePreview && (
        <ImagePreviewer
          request={currentImagePreview}
          component={ImagePreviewer.OnHover}
          left={pos.left}
          top={pos.top}
        />
      )}
    </div>
  );
});

export default Screen;
