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
import { detectBareDomains } from "../js/bare_domain";
import { detectMentions } from "../js/mention_parse";
import { detectAids } from "../js/aid_parse";
import {
  articleHasSteamgifts,
  detectGiveawayCodes,
} from "../js/steamgifts_parse";
import {
  groupImageCaptionBlocks,
  maxCaptionCols,
} from "../js/image_caption_group";
import {
  buildCaptionSpans,
  applyAiKeep,
  spanKey,
  spanNeedsAi,
} from "../js/caption_ai_logic";
import {
  captionAiAvailability,
  classifySpans,
  destroyCaptionAi,
} from "../js/caption_ai";
import { applyAiFix, applyAiLink, domainKey, fixKey } from "../js/url_ai_logic";
import {
  classifyBrokenUrls,
  classifyDomains,
  destroyUrlAi,
} from "../js/url_ai";
import {
  groupSameAuthorRuns,
  buildMergedCommentChars,
} from "../js/comment_merge";
import { computeAnchoredScrollTop, offsetTopWithin } from "../js/scroll_anchor";
import MergeImageCaptionButton from "./MergeImageCaptionButton";
import MergeImageCaptionAiButton from "./MergeImageCaptionAiButton";

// NOTE: articleAuthor (原PO id) is tracked by term_view across page-downs and
// passed in via enhance — the "作者" header only appears on the first page, so we
// cannot re-derive it from `lines` here on later pages.

// PttChrome pageState (see term_buf.js#setPageState): 2 = board list, 3 = reading.
const PAGE_LIST = 2;
const PAGE_READING = 3;

// 每列的附加偵測（auto-fix URL / X mention / AID / Steamgifts），逐列迴圈與
// 「連續同作者推文合併」塊共用——合併後的 chars 是重組的新序列，原列偵測到的
// col 範圍全部失效，必須對合併 chars 重跑一次。回傳值僅含有命中的鍵。
function detectRowExtras(chars, text, ann, opts) {
  const {
    autoFixUrl,
    enableXMention,
    easyReading,
    onAidClick,
    hasSteamgifts,
    bareDomainLink,
  } = opts;
  // Auto-fix runs on every row (article body included), independent of the
  // comment annotation. The fixed-URL line only renders in easy-reading mode
  // (see LinkSegmentBuilder); detection itself is cheap and returns [] for
  // almost every row.
  // rowText 隨候選帶走：gray 候選的 AI prompt 與 cache key 都需要整列上下文。
  let fixedUrls;
  if (autoFixUrl) {
    const fixes = detectFixableUrls(text);
    if (fixes.length) fixedUrls = fixes.map((f) => ({ ...f, rowText: text }));
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
    const found = detectMentions(chars);
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
    const found = detectAids(chars, text);
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
  // Steamgifts giveaway 代碼連結：文章層 gate（hasSteamgifts）通過後逐列抓
  // 「獨立成列的 5 碼英數」。
  let giveaways;
  if (hasSteamgifts && !(ann && ann.hidden)) {
    const found = detectGiveawayCodes(text);
    if (found.length) giveaways = found;
  }
  // 裸網域自動連結（src/js/bare_domain.js）：無 scheme、無路徑的網域原位變可點。
  // 與 fixedUrls 天然不重疊（那邊的候選必含空白或路徑，這邊兩者都排除），唯一
  // 例外是「example.com /badpath.jpg」這種——同一個 host 已被修好的深連結涵蓋，
  // 不再重複掛一個指向首頁的連結。mentions 的 @ 前綴已在 bare_domain 內排除。
  let bareDomains;
  if (bareDomainLink && !(ann && ann.hidden)) {
    let found = detectBareDomains(chars, text);
    if (found.length && fixedUrls) {
      found = found.filter(
        (d) =>
          !fixedUrls.some((f) => f.original.toLowerCase().includes(d.host)),
      );
    }
    // rowText 隨候選帶走：AI 複核的 prompt 與 cache key 都需要整列上下文
    // （同一個 host 在不同句子裡本來就該有不同答案）。
    if (found.length) bareDomains = found.map((d) => ({ ...d, rowText: text }));
  }
  return { fixedUrls, mentions, aids, giveaways, bareDomains };
}

// Per-row { floor } / { hidden } annotations for the Enhanced Add-on. Native grid
// is fixed-size, so a blacklisted row is hidden (visibility:hidden) rather than
// removed — removing it would desync the terminal grid. Floor numbers here count
// only within the visible page (cross-page numbering needs easy reading; see plan).
function computeAnnotations(
  lines,
  enhance,
  mergeCaption,
  captionAi,
  aiKeep,
  aiLink,
  aiFix,
) {
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
    bareDomainLink,
    easyReading,
    enableXMention,
    mergeSameAuthorComments,
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
      // 裝置端 AI 校正（opt-in，另一顆浮動按鈕）：規則只取「最近一段」，遇到
      // 說明被空行切成多段的翻譯漫畫文就只配到第一段。AI 只回答「由近而遠保留
      // 幾段」，applyAiKeep 據此重建塊；沒有答案的塊原封不動（見
      // caption_ai_logic.js 的零回歸不變量）。
      if (captionAi && mergeCaption) {
        const spans = buildCaptionSpans(texts, mergeCaption);
        result.captionSpans = spans;
        // 內容型簽章：好讀翻頁會重算 spans，內容沒變就不該重跑推論。
        result.captionSpansSig = spans.map(spanKey).join(",");
        if (aiKeep) {
          const keepByRow = {};
          for (const s of spans) {
            const k = aiKeep[spanKey(s)];
            if (k !== undefined) keepByRow[s.imageRow] = k;
          }
          captionBlocks = applyAiKeep(captionBlocks, spans, keepByRow);
        }
      }
    }
    // Steamgifts giveaway 代碼連結的文章層 gate（整篇提到 steamgifts 才啟用，
    // 見 steamgifts_parse.js）。偵測本體抽在 detectRowExtras（合併塊共用）。
    const detectOpts = {
      autoFixUrl,
      bareDomainLink,
      enableXMention,
      easyReading,
      onAidClick,
      hasSteamgifts: articleHasSteamgifts(texts),
    };
    // 裸網域 AI 複核：全頁的灰色候選收成一份清單（含推文合併塊重跑出來的），
    // effect 依內容簽章決定要不要推論。收集用的是**套用判決之前**的候選，簽章
    // 才不會因為 AI 撤掉某個連結而抖動。
    //
    // URL 修復的 gray 候選走**相反方向**：規則層不敢認（那個形狀與英文句號同形，
    // 見 url_fix.js 檔頭），所以預設不修，AI 判 true 才放行。故 applyAiFix 無論
    // AI 開關與否都要套——AI 關 ⇒ aiFix 恆為空 ⇒ gray 全部不修，正是預設行為。
    // 注意 detectRowExtras 內 bareDomains 的重疊過濾用的是**未過濾**的 fixedUrls，
    // 不然 AI 撤掉一筆修復會讓原本被壓住的裸網域連結冒出來。
    const domainCands = [];
    const fixCands = [];
    const withUrlAi = (extras) => {
      let out = extras;
      if (extras.bareDomains) {
        for (const d of extras.bareDomains) if (d.gray) domainCands.push(d);
        out = { ...out, bareDomains: applyAiLink(extras.bareDomains, aiLink) };
      }
      if (extras.fixedUrls) {
        for (const f of extras.fixedUrls) if (f.gray) fixCands.push(f);
        const kept = applyAiFix(extras.fixedUrls, aiFix);
        out = { ...out, fixedUrls: kept.length ? kept : undefined };
      }
      return out;
    };
    for (let row = 0; row < lines.length; ++row) {
      const text = texts[row];
      const ann = annotateComment(text, ctx) || undefined;
      const { fixedUrls, mentions, aids, giveaways, bareDomains } = withUrlAi(
        detectRowExtras(lines[row], text, ann, detectOpts),
      );
      let r = ann;
      if (fixedUrls) r = { ...(r || {}), fixedUrls };
      if (mentions) r = { ...(r || {}), mentions };
      if (aids) r = { ...(r || {}), aids };
      if (giveaways) r = { ...(r || {}), giveaways };
      if (bareDomains) r = { ...(r || {}), bareDomains };
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
    // 連續同作者推文合併（好讀限定；設定 mergeSameAuthorComments，預設開）：
    // run 首列掛 mergeCommentRun（合併 chars＋對合併 chars 重跑的偵測），其餘列掛
    // mergedIntoComment（頂層 render null）。一則一行，**作者在第一則、時間在最後
    // 一則**（時間戳沿用原 cell，故配色同原生且可複製）；樓層徽章只顯示 run 首則。
    // 與圖文合併天然不重疊（caption 分組遇第一則推文即停）。FloorCounter／黑名單
    // 完全不動——樓層仍逐則計數，合併只是 render 層重組（見 comment_merge.js）。
    if (easyReading && mergeSameAuthorComments) {
      const runs = groupSameAuthorRuns(result);
      for (let k = 0; k < runs.length; ++k) {
        const run = runs[k];
        const merged = buildMergedCommentChars(lines, run);
        if (!merged) continue; // 任一列切不出邊界 → fail-safe 還原逐列
        const first = run.rows[0];
        const firstAnn = result[first];
        const mText = rowToText(merged.chars);
        result[first] = {
          ...firstAnn,
          mergeCommentRun: {
            chars: merged.chars,
            contentStart: merged.contentStart,
            ...withUrlAi(
              detectRowExtras(merged.chars, mText, firstAnn, detectOpts),
            ),
          },
        };
        for (let n = 1; n < run.rows.length; ++n) {
          result[run.rows[n]] = {
            ...result[run.rows[n]],
            mergedIntoComment: first,
          };
        }
      }
    }
    // 內容型簽章：好讀翻頁只是往後長，前面已判過的候選 key 不變 → effect 不重跑。
    result.domainCands = domainCands;
    result.domainCandsSig = domainCands.map(domainKey).join(",");
    result.fixCands = fixCands;
    result.fixCandsSig = fixCands.map(fixKey).join(",");
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
  // 裝置端 AI 校正（第二顆浮動按鈕，per-session）：captionAi 是開關，aiKeep 是
  // 「spanKey → 保留段數」的結果 cache（內容型 key，好讀翻頁不重跑推論）。
  const [captionAi, setCaptionAi] = React.useState(false);
  const [aiKeep, setAiKeep] = React.useState({});
  const [aiPending, setAiPending] = React.useState(0);
  // 模型是否真的就緒。光看 window.LanguageModel 存不存在不夠：Chromium 也有這個
  // global，但 availability() 會回 'unavailable'（沒有模型元件）——那種情況下按鈕
  // 按下去只會每塊 fallback 回規則，等於一顆沒有作用的按鈕。
  const [aiReady, setAiReady] = React.useState(false);
  // 裸網域連結的 AI 複核結果 cache：domainKey → boolean。只有明確 false 會撤掉
  // 規則已允許的連結（單向收縮，見 url_ai_logic.js）。沒有浮動按鈕——這是「壓
  // 誤判」而不是使用者要切換的排版，設定頁勾了就在背景跑。
  const [aiLink, setAiLink] = React.useState({});
  // URL 修復 gray 候選的 AI 複核結果 cache：fixKey → boolean。方向相反——只有
  // 明確 true 才**放行**一筆規則層不敢認的修復（見 url_ai_logic.js applyAiFix）。
  const [aiFix, setAiFix] = React.useState({});

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
    // AI 結果是 per-article 的：換文章一律丟掉（spanKey 只保證同一篇內唯一）。
    if (captionAi) setCaptionAi(false);
    if (Object.keys(aiKeep).length) setAiKeep({});
    // 同理：domainKey 含整列文字，換文章的舊判斷沒有沿用價值。
    if (Object.keys(aiLink).length) setAiLink({});
    if (Object.keys(aiFix).length) setAiFix({});
  }

  // 事件委派：點到內嵌預覽圖（.hyperLinkPreview）即切換整頁圖片放大/縮小。
  // hover 預覽的 OnHover img 無此 class，不受影響。
  //
  // 縮放會讓整份內容高度驟變，而捲動容器（.main）的 scrollTop 不變 → 視窗相對文章
  // 整個位移，被點的那張圖跑出視野。故點擊當下（React 19 的 setState 尚未 commit，
  // 這裡讀到的是**舊 layout**，正是我們要的 before 值）先記下錨點，交給下方的
  // useLayoutEffect 在 commit 後、paint 前補回捲動位置（無閃爍）。
  // 量測一律用 offsetTop/offsetHeight，不可用 getBoundingClientRect——見
  // scroll_anchor.js 開頭的座標系規則（.main 與 img 各有 transform scale）。
  const containerRef = React.useRef(null);
  const anchorRef = React.useRef(null);
  const handleImageClick = React.useCallback((e) => {
    const t = e.target;
    if (t && t.tagName === "IMG" && t.classList.contains("hyperLinkPreview")) {
      const container = containerRef.current;
      const scroller = container && container.closest(".main");
      anchorRef.current = scroller
        ? {
            el: t,
            scroller,
            topBefore: offsetTopWithin(t, container),
            heightBefore: t.offsetHeight,
            scrollBefore: scroller.scrollTop,
          }
        : null; // 拿不到捲動容器就單純切換，不補償（不 crash）。
      setImagesEnlarged((v) => !v);
    }
  }, []);

  // 錨點補償：只在「本次 render 由點圖觸發」時作用（anchorRef 有值），故不影響
  // page-down concat lines、換文章重置、mergeCaption 切換等其他 render 路徑。
  React.useLayoutEffect(() => {
    const a = anchorRef.current;
    anchorRef.current = null; // 無條件清空，避免殘留污染下一次 render。
    if (!a || !a.el.isConnected || !containerRef.current) return;
    a.scroller.scrollTop = computeAnchoredScrollTop({
      topBefore: a.topBefore,
      heightBefore: a.heightBefore,
      scrollBefore: a.scrollBefore,
      topAfter: offsetTopWithin(a.el, containerRef.current),
      heightAfter: a.el.offsetHeight,
      maxScroll: a.scroller.scrollHeight - a.scroller.clientHeight,
    });
  }, [imagesEnlarged]);

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
    setMergeCaption((v) => {
      const next =
        v === null ? "imageFirst" : v === "imageFirst" ? "captionFirst" : null;
      // 循環回「還原排版」時把 AI 一起關掉（畫面上沒有合併塊，AI 開著沒有意義）。
      if (next === null) setCaptionAi(false);
      return next;
    });
    const input = document.getElementById("t");
    if (input) input.focus();
  }, []);

  // AI 按鈕：關 → 開（若尚未合併就順手開成「上圖下文」），再按一次只關 AI，
  // 手動合併狀態保留（兩顆按鈕互不吃掉對方的狀態）。
  const handleToggleCaptionAi = React.useCallback(() => {
    setCaptionAi((v) => {
      if (!v) setMergeCaption((m) => m || "imageFirst");
      return !v;
    });
    const input = document.getElementById("t");
    if (input) input.focus();
  }, []);

  const annotations = computeAnnotations(
    lines,
    enhance,
    mergeCaption,
    captionAi,
    aiKeep,
    aiLink,
    aiFix,
  );

  // spans 每次 render 重算（reference 不穩），但內容簽章穩定 → effect 只在
  // 「候選段內容真的變了」時重跑：好讀翻頁只是往後長，前面的塊不重複推論。
  const spansRef = React.useRef(null);
  spansRef.current = annotations.captionSpans;
  const aiKeepRef = React.useRef(aiKeep);
  aiKeepRef.current = aiKeep;
  const spansSig = annotations.captionSpansSig;
  React.useEffect(() => {
    if (!captionAi) return undefined;
    const todo = (spansRef.current || []).filter(
      (s) => spanNeedsAi(s) && aiKeepRef.current[spanKey(s)] === undefined,
    );
    if (!todo.length) return undefined;
    const controller =
      typeof AbortController === "function" ? new AbortController() : null;
    let cancelled = false;
    setAiPending(todo.length);
    // 逐塊推論、逐塊回填：規則結果早就畫出來了，AI 只是漸進式修正，不擋畫面。
    classifySpans(todo, {
      signal: controller ? controller.signal : undefined,
      onResult: (span, r) => {
        if (cancelled) return;
        setAiKeep((prev) => ({ ...prev, [spanKey(span)]: r.keep }));
        setAiPending((p) => (p > 0 ? p - 1 : 0));
      },
    })
      .catch(() => {})
      .then(() => {
        if (!cancelled) setAiPending(0);
      });
    return () => {
      cancelled = true;
      if (controller) controller.abort();
      setAiPending(0); // 關掉 AI / 換頁重算時，殘留的「推論中」計數不可留在按鈕上
    };
  }, [captionAi, spansSig]);

  // 裸網域 AI 複核：與 caption AI 同形的漸進式推論，但**沒有浮動按鈕**——規則
  // 結果早就畫出來了，AI 只是逐個撤掉誤連，不擋畫面也不需要使用者操作。
  const urlAiEnabled = !!(enhance && enhance.urlAiEnabled);
  const domainCandsRef = React.useRef(null);
  domainCandsRef.current = annotations.domainCands;
  const aiLinkRef = React.useRef(aiLink);
  aiLinkRef.current = aiLink;
  const domainCandsSig = annotations.domainCandsSig;
  React.useEffect(() => {
    if (!urlAiEnabled) return undefined;
    const seen = new Set();
    const todo = (domainCandsRef.current || []).filter((c) => {
      const k = domainKey(c);
      if (seen.has(k) || aiLinkRef.current[k] !== undefined) return false;
      seen.add(k); // 同一列在合併塊裡會出現兩次，只問一次
      return true;
    });
    if (!todo.length) return undefined;
    const controller =
      typeof AbortController === "function" ? new AbortController() : null;
    let cancelled = false;
    classifyDomains(todo, {
      signal: controller ? controller.signal : undefined,
      onResult: (cand, r) => {
        // link === null（逾時／垃圾回覆／不支援）不寫進 cache：留著 undefined
        // 等於「沒有判決」→ 連結保留，也不會被記成永久答案。
        if (cancelled || r.link === null) return;
        setAiLink((prev) => ({ ...prev, [domainKey(cand)]: r.link }));
      },
    }).catch(() => {});
    return () => {
      cancelled = true;
      if (controller) controller.abort();
    };
  }, [urlAiEnabled, domainCandsSig]);

  // URL 修復 gray 候選的複核。與上面同形，差別只在方向：這裡答 true 才把一筆
  // 規則層不敢認的修復放行出來（沒答／答 false ⇒ 維持不修）。
  const fixAiEnabled = !!(enhance && enhance.fixAiEnabled);
  const fixCandsRef = React.useRef(null);
  fixCandsRef.current = annotations.fixCands;
  const aiFixRef = React.useRef(aiFix);
  aiFixRef.current = aiFix;
  const fixCandsSig = annotations.fixCandsSig;
  React.useEffect(() => {
    if (!fixAiEnabled) return undefined;
    const seen = new Set();
    const todo = (fixCandsRef.current || []).filter((c) => {
      const k = fixKey(c);
      if (seen.has(k) || aiFixRef.current[k] !== undefined) return false;
      seen.add(k); // 同一列在合併塊裡會出現兩次，只問一次
      return true;
    });
    if (!todo.length) return undefined;
    const controller =
      typeof AbortController === "function" ? new AbortController() : null;
    let cancelled = false;
    classifyBrokenUrls(todo, {
      signal: controller ? controller.signal : undefined,
      onResult: (cand, r) => {
        // link === null 不寫 cache：留 undefined＝「沒有判決」→ 不放行，也不會
        // 被記成永久答案（下次重算還有機會問到）。
        if (cancelled || r.link === null) return;
        setAiFix((prev) => ({ ...prev, [fixKey(cand)]: r.link }));
      },
    }).catch(() => {});
    return () => {
      cancelled = true;
      if (controller) controller.abort();
    };
  }, [fixAiEnabled, fixCandsSig]);

  // 卸載時關掉 base session（模型常駐佔記憶體）。
  React.useEffect(() => () => destroyCaptionAi(), []);
  React.useEffect(() => () => destroyUrlAi(), []);

  // 可用性探測：只在設定啟用時查一次（availability() 不會觸發下載）。
  const captionAiEnabled = !!(enhance && enhance.captionAiEnabled);
  React.useEffect(() => {
    if (!captionAiEnabled) {
      setAiReady(false);
      return undefined;
    }
    let alive = true;
    captionAiAvailability().then((a) => alive && setAiReady(a === "available"));
    return () => {
      alive = false;
    };
  }, [captionAiEnabled]);
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
        giveaways={ann && ann.giveaways}
        bareDomains={ann && ann.bareDomains}
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
  // AI 校正鈕：再多兩個條件——設定啟用（預設關）＋模型 availability 為
  // 'available'。不支援／模型沒下載的環境（Firefox/Safari/未下載的 Chrome）
  // 連按鈕都不出現，行為與沒這功能時完全相同。
  const showCaptionAiButton = !!(showMergeButton && aiReady);
  // 右欄不換行：寬度＝最寬翻譯行的顯示欄數（半形1/全形2）× 半形字寬。
  // forceWidth 是全形字強制的像素寬 → 半形 ≈ forceWidth/2；+1 全形字寬當緩衝。
  // 上限 55% 交給 CSS max-width 守（極長行時退回換行，見 main.css pre-wrap）。
  const captionColStyle = annotations.captionMaxCols
    ? { width: (annotations.captionMaxCols / 2 + 1) * forceWidth }
    : undefined;
  return (
    <div
      id="mainContainer"
      ref={containerRef}
      className={imagesEnlarged ? "imagesEnlarged" : undefined}
      onMouseMove={handleMouseMove}
      onClick={handleImageClick}
    >
      {lines.map((chars, row) => {
        const ann = annotations[row];
        if (dropHidden && ann && ann.hidden) return null;
        // 說明行已併入所屬圖行的右欄（下方 mergeBlock 分支），頂層不重複 render。
        if (ann && ann.mergedInto !== undefined) return null;
        // 連續同作者推文：後續列已併進 run 首列的合併段落，頂層不重複 render。
        if (ann && ann.mergedIntoComment !== undefined) return null;
        if (ann && ann.mergeCommentRun) {
          const m = ann.mergeCommentRun;
          // data-row＝run 首列的絕對 pageLines index。塊內複製以 DOM 選取為準
          // （^C 走 window.getSelection().toString()，term_view.js）；getText 的
          // col 對映在合併段內失真，已知取捨（同 mergedImageBlock 的脈絡）。
          // 懸掛縮排寬度＝首則內容起始欄 × 半形字寬（forceWidth 是全形字像素寬）
          // → 第 2 則起與第一則的內容對齊（main.css .mergedCommentBlock）。
          return (
            <div
              key={row}
              className="mergedCommentBlock"
              style={{
                "--merged-comment-indent": `${(m.contentStart * forceWidth) / 2}px`,
              }}
            >
              <Row
                chars={m.chars}
                row={row}
                forceWidth={forceWidth}
                enableLinkInlinePreview={enableLinkInlinePreview}
                highlighted={currentHighlighted === row}
                floor={ann.floor}
                pusher={ann.pusher}
                pusherHighlight={ann.pusherHighlight}
                authorIdStart={ann.authorIdStart}
                authorIdEnd={ann.authorIdEnd}
                fixedUrls={m.fixedUrls}
                mentions={m.mentions}
                aids={m.aids}
                giveaways={m.giveaways}
                bareDomains={m.bareDomains}
                onHyperLinkMouseOver={handleHyperLinkMouseOver}
                onHyperLinkMouseOut={handleHyperLinkMouseOut}
              />
            </div>
          );
        }
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
      {showCaptionAiButton && (
        <MergeImageCaptionAiButton
          active={captionAi}
          pending={captionAi ? aiPending : 0}
          onToggle={handleToggleCaptionAi}
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
