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
  parseListTitle,
  matchTitleBlacklist,
  isDeletedListRow,
  FloorCounter,
} from "../js/comment_parse";
import { detectFixableUrls } from "../js/url_fix";
import { detectMentions } from "../js/mention_parse";

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
function computeAnnotations(lines, enhance) {
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
    for (let row = 0; row < lines.length; ++row) {
      const text = rowToText(lines[row]);
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
      let r = ann;
      if (fixedUrls) r = { ...(r || {}), fixedUrls };
      if (mentions) r = { ...(r || {}), mentions };
      result[row] = r;
    }
  } else if (pageState === PAGE_LIST || inListContext) {
    // inListContext keeps list blacklist hiding alive across overlay prompts (e.g.
    // the v 設定已讀未讀記錄 sub-screen) whose status row stops parsing as LIST(2).
    // READING is the preceding `if`, so this never runs while reading an article.
    // Deleted-article rows are hidden unconditionally (they cannot be opened),
    // so this branch runs even with an empty blacklist. MUST stay in sync with
    // list_session.js#visibleListIndices (invariant 10).
    for (let row = 0; row < lines.length; ++row) {
      const text = rowToText(lines[row]);
      let hide = isDeletedListRow(text);
      if (!hide && hasBlacklist) {
        const author = parseListAuthor(text);
        if (author && blacklist.has(author)) hide = true;
      }
      if (!hide && hasTitleBlacklist) {
        if (matchTitleBlacklist(parseListTitle(text), titleBlacklist))
          hide = true;
      }
      if (hide) result[row] = { hidden: true };
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
        setCurrentImagePreview(
          of(href).then(resolveSrcToImageUrl).then(resolveWithImageDOM),
        );
      }
    },
    [enableLinkHoverPreview],
  );

  const handleHyperLinkMouseOut = React.useCallback(() => {
    setCurrentImagePreview(undefined);
  }, []);

  const annotations = computeAnnotations(lines, enhance);
  // dropHidden: easy-reading accumulates a single growing scroll page, so a
  // blacklisted comment is removed entirely (render null → no DOM node, no blank
  // line). The fixed native grid instead keeps the row and hides it
  // (visibility:hidden via <Row hidden>) so the terminal alignment is preserved.
  // Rendering null does NOT shift the map index, so surviving rows keep their
  // absolute pageLines index in `row`/`data-row` and selection across the gap
  // (term_buf.getText uses the absolute row index) stays correct.
  const dropHidden = !!(enhance && enhance.dropHidden);
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
        return (
          <Row
            key={row}
            chars={chars}
            row={row}
            forceWidth={forceWidth}
            enableLinkInlinePreview={enableLinkInlinePreview}
            highlighted={currentHighlighted === row}
            floor={ann && ann.floor}
            hidden={ann && ann.hidden}
            pusher={ann && ann.pusher}
            pusherHighlight={ann && ann.pusherHighlight}
            authorIdStart={ann && ann.authorIdStart}
            authorIdEnd={ann && ann.authorIdEnd}
            fixedUrls={ann && ann.fixedUrls}
            mentions={ann && ann.mentions}
            onHyperLinkMouseOver={handleHyperLinkMouseOver}
            onHyperLinkMouseOut={handleHyperLinkMouseOut}
          />
        );
      })}
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
