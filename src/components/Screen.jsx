import React from "react";
import Row from "./Row";
import ImagePreviewer, {
  of,
  PreviewHrefContext,
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
import { detectWrappedUrls } from "../js/url_wrap";
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
import {
  annotationsKey,
  sameKey,
  isAppendOnly,
  mergeRunKey,
} from "../js/screen_annotate_cache";
import { PreviewSizeModeContext } from "./LazyInlinePreview";
import MergeImageCaptionButton from "./MergeImageCaptionButton";
import MergeImageCaptionAiButton from "./MergeImageCaptionAiButton";

// NOTE: articleAuthor (原PO id) is tracked by term_view across page-downs and
// passed in via enhance — the "作者" header only appears on the first page, so we
// cannot re-derive it from `lines` here on later pages.

// PttChrome pageState (see term_buf.js#setPageState): 2 = board list, 3 = reading.
const PAGE_LIST = 2;
const PAGE_READING = 3;

// 游標底色的「沒有」值。凍結成模組常數（而不是每次 new 一個 literal）讓
// 「已經是不上色」的重複呼叫在 useState 的 Object.is 比較就被吃掉，不觸發 render。
const NO_HIGHLIGHT = Object.freeze({ row: -1, cls: null });

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
//
// `reuse`（可為 null）＝ 上一幀留下的可重用狀態，只有在「這一幀是上一幀的純
// append 且所有全域輸入未變」時由呼叫端交進來（見 screen_annotate_cache.js）。
// 有它時逐列偵測只跑新增的列，把好讀長文的每頁成本從 O(文章) 壓回 O(新增列)。
// 回傳 { annotations, cache }：cache 要原封不動存回去給下一幀當 reuse。
function computeAnnotations(
  lines,
  enhance,
  mergeCaption,
  captionAi,
  aiKeep,
  aiLink,
  aiFix,
  reuse,
) {
  const result = new Array(lines.length);
  if (!enhance) return { annotations: result, cache: null };
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
    // ---- 增量重算的起點（見 screen_annotate_cache.js 檔頭）----
    // reuse 非 null ⇒ 這一幀只是把新的一頁接在後面：前綴的 texts / base 標註 /
    // 樓層計數器 / AI 候選清單全部沿用，下面所有逐列工作只跑 [from, n)。
    const n = lines.length;
    let from = reuse ? reuse.texts.length : 0;
    const texts = new Array(n);
    for (let row = 0; row < from; ++row) texts[row] = reuse.texts[row];
    for (let row = from; row < n; ++row) texts[row] = rowToText(lines[row]);
    // Steamgifts giveaway 代碼連結的文章層 gate（整篇提到 steamgifts 才啟用，
    // 見 steamgifts_parse.js）。偵測本體抽在 detectRowExtras（合併塊共用）。
    // 它是**逐列偵測的輸入**：一旦某一頁首次把它翻成 true，前面每一列的偵測條件
    // 都變了 ⇒ 這一幀退回全量重算（一篇文章最多發生一次）。
    let hasSteamgifts = reuse ? reuse.hasSteamgifts : false;
    if (!hasSteamgifts)
      hasSteamgifts = articleHasSteamgifts(from ? texts.slice(from) : texts);
    if (reuse && hasSteamgifts && !reuse.hasSteamgifts) {
      reuse = null;
      from = 0;
    }
    // Floor numbers are shown only in easy reading, where the FloorCounter walks
    // the whole accumulated article (accurate). The native per-page counter resets
    // every page-down → inaccurate, so no floorCounter is passed there and
    // annotateComment skips floors entirely (see comment_parse.js). Auto-fix URL
    // detection below still runs on every row regardless of mode.
    const ctx = {
      blacklist,
      showFloorNumbers,
      // 增量時沿用**同一個**計數器實例：它只會往前推進，只餵新列即與全量重算等價
      // （樓層編號依賴前面所有列，重新 new 一個會從 1 重數）。
      floorCounter: easyReading
        ? reuse
          ? reuse.floorCounter
          : new FloorCounter()
        : undefined,
      highlightAuthor,
      articleAuthor,
      selectedPusher,
    };
    // 圖文合併（好讀限定）：先重建整篇純文字做跨行分組（per-row 的 annotateComment
    // 看不到鄰列）。無論開關與否都要算——關閉時浮動按鈕的顯示條件也需要塊數。
    // 塊數取兩方向（上圖下文/上文下圖）的 max，讓純「上文下圖」文章也出得了按鈕。
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
    const detectOpts = {
      autoFixUrl,
      bareDomainLink,
      enableXMention,
      easyReading,
      onAidClick,
      hasSteamgifts,
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
    //
    // 候選收集分成兩段陣列，順序必須與全量重算完全一致（簽章是 join 出來的）：
    // 先是逐列（依列序），再是合併推文塊（依 run 序）。故逐列的收在
    // baseDomainCands/baseFixCands（可跨幀沿用），合併塊的每幀從 run 快取重播。
    const baseDomainCands = reuse ? reuse.domainCands.slice() : [];
    const baseFixCands = reuse ? reuse.fixCands.slice() : [];
    const withUrlAi = (extras, dCands, fCands) => {
      let out = extras;
      if (extras.bareDomains) {
        for (const d of extras.bareDomains) if (d.gray) dCands.push(d);
        out = { ...out, bareDomains: applyAiLink(extras.bareDomains, aiLink) };
      }
      if (extras.fixedUrls) {
        for (const f of extras.fixedUrls) if (f.gray) fCands.push(f);
        const kept = applyAiFix(extras.fixedUrls, aiFix);
        out = { ...out, fixedUrls: kept.length ? kept : undefined };
      }
      return out;
    };
    // base[row] ＝「合流裝飾之前」的逐列標註。分成 base / result 兩層是為了物件
    // **參考穩定**：沒有被圖文合併或推文合併裝飾到的列，result[row] 就是上一幀那
    // 同一個物件 ⇒ 下面的 <Row> 元素快取才有得重用（React 才會 bailout）。
    const base = new Array(n);
    for (let row = 0; row < from; ++row) base[row] = reuse.base[row];
    for (let row = from; row < n; ++row) {
      const text = texts[row];
      const ann = annotateComment(text, ctx) || undefined;
      const { fixedUrls, mentions, aids, giveaways, bareDomains } = withUrlAi(
        detectRowExtras(lines[row], text, ann, detectOpts),
        baseDomainCands,
        baseFixCands,
      );
      let r = ann;
      if (fixedUrls) r = { ...(r || {}), fixedUrls };
      if (mentions) r = { ...(r || {}), mentions };
      if (aids) r = { ...(r || {}), aids };
      if (giveaways) r = { ...(r || {}), giveaways };
      if (bareDomains) r = { ...(r || {}), bareDomains };
      base[row] = r;
    }
    for (let row = 0; row < n; ++row) result[row] = base[row];
    const domainCands = baseDomainCands.slice();
    const fixCands = baseFixCands.slice();
    // 開啟合併時把分組結果寫進 annotation：圖行掛 mergeBlock（render 成兩欄
    // wrapper），說明行掛 mergedInto（頂層 render null，改巢狀進右欄）。
    // captionMaxCols＝全部說明段最寬行的顯示欄數，右欄寬度據此動態決定（不換行）。
    // 塊本身每幀重算（groupImageCaptionBlocks 遇第一則推文即 break，成本只有前言
    // 段），但**裝飾出來的 annotation 物件要能跨幀重用**，否則前言段每一列的 <Row>
    // 每幀都得重建。身分＝塊座標 ＋ 該列的 base 參考，兩者都沒變就沿用舊物件。
    const captionCache = new Map();
    if (captionBlocks && mergeCaption) {
      result.captionMaxCols = maxCaptionCols(texts, captionBlocks);
      const prevCaption = reuse ? reuse.captionCache : null;
      const decorate = (row, key, extra) => {
        const prevEntry = prevCaption && prevCaption.get(row);
        result[row] =
          prevEntry && prevEntry.key === key && prevEntry.base === base[row]
            ? prevEntry.ann
            : { ...(result[row] || {}), ...extra };
        captionCache.set(row, { key, base: base[row], ann: result[row] });
      };
      for (let k = 0; k < captionBlocks.length; ++k) {
        const b = captionBlocks[k];
        const bKey = b.imageRow + ":" + b.captionStart + "-" + b.captionEnd;
        decorate(b.imageRow, bKey, { mergeBlock: b });
        for (let r = b.captionStart; r <= b.captionEnd; ++r) {
          decorate(r, bKey, { mergedInto: b.imageRow });
        }
      }
    }
    // 連續同作者推文合併（好讀限定；設定 mergeSameAuthorComments，預設開）：
    // run 首列掛 mergeCommentRun（合併 chars＋對合併 chars 重跑的偵測），其餘列掛
    // mergedIntoComment（頂層 render null）。一則一行，**作者在第一則、時間在最後
    // 一則**（時間戳沿用原 cell，故配色同原生且可複製）；樓層徽章只顯示 run 首則。
    // 與圖文合併天然不重疊（caption 分組遇第一則推文即停）。FloorCounter／黑名單
    // 完全不動——樓層仍逐則計數，合併只是 render 層重組（見 comment_merge.js）。
    //
    // 這是長文最貴的一段：buildMergedCommentChars 會重建整塊 TermChar 陣列，還要對
    // 合併後的 chars **再跑一次** detectRowExtras，而 8000 行的長文幾乎整篇都是推文。
    // 故以 run 身分（mergeRunKey）＋ 該 run 每一列的 base 參考當快取鍵：翻頁只可能
    // 改變**最後一個** run（新的一則接在後面），前面所有 run 直接重播上一幀的結果，
    // 連裝飾出來的 annotation 物件都是同一個（元素快取才有得重用）。
    const runCache = new Map();
    if (easyReading && mergeSameAuthorComments) {
      const prevRuns = reuse ? reuse.runCache : null;
      const runs = groupSameAuthorRuns(result);
      for (let k = 0; k < runs.length; ++k) {
        const run = runs[k];
        const rKey = mergeRunKey(run);
        const prevEntry = prevRuns && prevRuns.get(rKey);
        let entry = null;
        if (prevEntry && prevEntry.baseRefs.length === run.rows.length) {
          entry = prevEntry;
          for (let i = 0; i < run.rows.length; ++i) {
            if (prevEntry.baseRefs[i] !== base[run.rows[i]]) {
              entry = null;
              break;
            }
          }
        }
        if (!entry) {
          const merged = buildMergedCommentChars(lines, run);
          const runDomainCands = [];
          const runFixCands = [];
          // 空的 decorated ＝ 任一列切不出邊界 → fail-safe 還原逐列。也一併進快取，
          // 免得每幀重試同一個切不動的 run。
          const decorated = [];
          if (merged) {
            const first = run.rows[0];
            const firstAnn = result[first];
            const mText = rowToText(merged.chars);
            let extras = detectRowExtras(
              merged.chars,
              mText,
              firstAnn,
              detectOpts,
            );
            // 跨行連結接合（src/js/url_wrap.js）：只有合併塊做得到——被 PTT 推文
            // 輸入欄切成兩則的網址，逐列偵測兩層都看不見，要有 run 的換行邊界才接
            // 得回來。產物形狀與 detectFixableUrls 相同 ⇒ 併進 fixedUrls 後渲染／
            // 快取／AI 閘門全部沿用（gray 恆為 false，不進 AI）。
            if (detectOpts.autoFixUrl) {
              const wrapped = detectWrappedUrls(merged.chars, merged.breaks);
              if (wrapped.length) {
                const have = new Set(
                  (extras.fixedUrls || []).map((f) => f.fixed),
                );
                const add = wrapped.filter((w) => !have.has(w.fixed));
                if (add.length) {
                  extras = {
                    ...extras,
                    fixedUrls: (extras.fixedUrls || []).concat(add),
                  };
                }
              }
            }
            decorated.push([
              first,
              {
                ...firstAnn,
                mergeCommentRun: {
                  chars: merged.chars,
                  contentStart: merged.contentStart,
                  ...withUrlAi(extras, runDomainCands, runFixCands),
                },
              },
            ]);
            for (let i = 1; i < run.rows.length; ++i) {
              decorated.push([
                run.rows[i],
                { ...result[run.rows[i]], mergedIntoComment: first },
              ]);
            }
          }
          entry = {
            baseRefs: run.rows.map((r) => base[r]),
            decorated,
            domainCands: runDomainCands,
            fixCands: runFixCands,
          };
        }
        for (let i = 0; i < entry.decorated.length; ++i) {
          result[entry.decorated[i][0]] = entry.decorated[i][1];
        }
        for (let i = 0; i < entry.domainCands.length; ++i) {
          domainCands.push(entry.domainCands[i]);
        }
        for (let i = 0; i < entry.fixCands.length; ++i) {
          fixCands.push(entry.fixCands[i]);
        }
        runCache.set(rKey, entry);
      }
    }
    // 內容型簽章：好讀翻頁只是往後長，前面已判過的候選 key 不變 → effect 不重跑。
    result.domainCands = domainCands;
    result.domainCandsSig = domainCands.map(domainKey).join(",");
    result.fixCands = fixCands;
    result.fixCandsSig = fixCands.map(fixKey).join(",");
    return {
      annotations: result,
      cache: {
        texts,
        base,
        floorCounter: ctx.floorCounter,
        hasSteamgifts,
        domainCands: baseDomainCands,
        fixCands: baseFixCands,
        captionCache,
        runCache,
      },
    };
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
  // 列表／原生 24 列畫面：列物件是 term_buf 就地改寫的活 buffer（不是快照），
  // 增量快取的前提（列參考不變 ⇒ 內容不變）在這裡**不成立**，故不回快取。
  return { annotations: result, cache: null };
}

export const Screen = React.forwardRef(function Screen(props, ref) {
  const {
    lines,
    enhance,
    forceWidth,
    enableLinkInlinePreview,
    enableLinkHoverPreview,
  } = props;

  // 游標底色：要上色的列 + 要用的 color.css 背景 class。row -1 / cls null ＝ 不上色。
  // 來源同時涵蓋滑鼠 hover 與鍵盤游標，決策全在 js/cursor_highlight.js，套用入口是
  // term_view.applyCursorHighlight —— 這裡只負責把 class 掛到那一列。
  const [highlight, setHighlight] = React.useState(NO_HIGHLIGHT);
  const [currentImagePreview, setCurrentImagePreview] =
    React.useState(undefined);
  // hover 預覽對應的原文連結：只為了讓 OnHover 能回報代理狀態徽章（見
  // PreviewHrefContext / js/proxy_status.js）。與 currentImagePreview 同生同滅。
  const [hoverPreviewHref, setHoverPreviewHref] = React.useState(undefined);
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

  // 命令式 API：term_view 經 term_ui 的 ref.current.setCursorHighlight({row, cls})
  // 設游標底色列。取代 class instance method。
  React.useImperativeHandle(
    ref,
    () => ({ setCursorHighlight: setHighlight }),
    [],
  );

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
        setHoverPreviewHref(href);
      }
    },
    [enableLinkHoverPreview],
  );

  const handleHyperLinkMouseOut = React.useCallback(() => {
    setCurrentImagePreview(undefined);
    setHoverPreviewHref(undefined);
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

  // ---- 增量重算快取（好讀文章累積頁專用）----
  // 前提由 `enhance.stableRows` 帶進來，term_view 只在渲染 buf.pageLines（好讀累積
  // 的長頁）時給。那裡的列是 cloneRow 出來的**快照**，append 之後永不再被寫，所以
  // 「列物件參考相同 ⇒ 內容相同」成立。原生 24 列畫面與列表視窗則是 term_buf 就地
  // 改寫的活 buffer：參考相同但內容每幀在變，套快取會畫出上一幀的內容。
  const cacheRef = React.useRef(null);
  const cacheKey = annotationsKey({
    enhance,
    mergeCaption,
    captionAi,
    aiKeep,
    aiLink,
    aiFix,
    forceWidth,
    enableLinkInlinePreview,
    enableLinkHoverPreview,
    onHyperLinkMouseOver: handleHyperLinkMouseOver,
    onHyperLinkMouseOut: handleHyperLinkMouseOut,
  });
  const stableRows = !!(enhance && enhance.stableRows);
  const prevCache = cacheRef.current;
  const reusable =
    stableRows &&
    prevCache &&
    sameKey(prevCache.key, cacheKey) &&
    isAppendOnly(prevCache.lines, lines)
      ? prevCache
      : null;
  const computed = computeAnnotations(
    lines,
    enhance,
    mergeCaption,
    captionAi,
    aiKeep,
    aiLink,
    aiFix,
    reusable ? reusable.cache : null,
  );
  const annotations = computed.annotations;

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
        highlightClass={highlight.row === row ? highlight.cls : undefined}
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
  // 單一列 → React node（null ＝ 這一列不佔版面：黑名單 dropHidden、已併進圖文
  // 合併右欄、已併進同作者推文塊）。抽成函式是為了讓下面的元素快取能逐列決定
  // 「重用上一幀的 element」還是「重建」。
  const buildRowNode = (row) => {
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
            highlightClass={highlight.row === row ? highlight.cls : undefined}
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
  };
  // ---- 每列 React element 快取 ----
  // React 對 `oldProps === newProps` 的 fiber 走 bailoutOnAlreadyFinishedWork，整個
  // 子樹直接跳過；交回**同一個** element 物件即可拿到它。沒有這層的話，8000 列的
  // 累積頁每頁都要重跑 8000 次 LinkSegmentBuilder（每列 80 個 TermChar → 數十個
  // element），這是長文「越讀越慢」的另一半。
  //
  // 重用條件三件：列內容（chars 參考，由 isAppendOnly 保證）、最終 annotation 物件
  // 參考、以及這一列的高亮狀態。mergeBlock 列例外——它的內容還取決於右欄那些說明
  // 行的 annotation，條件不只自己這一列，直接重建（只有使用者手動開「圖文並排」時
  // 才存在，且塊數有限）。
  const prevElements = reusable ? reusable.elements : null;
  const prevAnnotations = reusable ? reusable.annotations : null;
  const prevHighlight = reusable ? reusable.highlight : NO_HIGHLIGHT;
  // 顏色（cls）換掉時整批失效——使用者在設定頁改底色才會發生，罕見到不值得逐列
  // 記住上一次用的 class。逐列則只比「這一列是不是那條光棒」。
  const sameHighlightCls = prevHighlight.cls === highlight.cls;
  const elements = new Array(lines.length);
  for (let row = 0; row < lines.length; ++row) {
    const ann = annotations[row];
    if (
      prevElements &&
      row < prevElements.length &&
      prevAnnotations[row] === ann &&
      sameHighlightCls &&
      (prevHighlight.row === row) === (highlight.row === row) &&
      !(ann && ann.mergeBlock)
    ) {
      elements[row] = prevElements[row];
      continue;
    }
    elements[row] = buildRowNode(row);
  }
  cacheRef.current =
    computed.cache && stableRows
      ? {
          key: cacheKey,
          lines,
          cache: computed.cache,
          annotations,
          elements,
          highlight,
        }
      : null;
  return (
    // 延遲載入佔位盒（LazyInlinePreview）卸載時會把當下高度釘進 min-height 防塌陷，
    // 那個高度只在同一尺寸模式下成立 —— 放大態釘的高度若留到縮小態就是永久假空白
    // （ptt-debug-20260815-112407）。故把模式一併播下去，與下面的 className 同一次
    // render 更新，useLayoutEffect 的捲動錨定量到的才是撤除 min-height 後的新 layout。
    <PreviewSizeModeContext.Provider
      value={imagesEnlarged ? "enlarged" : "normal"}
    >
      <div
        id="mainContainer"
        ref={containerRef}
        className={imagesEnlarged ? "imagesEnlarged" : undefined}
        onMouseMove={handleMouseMove}
        onClick={handleImageClick}
      >
        {elements}
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
          <PreviewHrefContext.Provider value={hoverPreviewHref}>
            <ImagePreviewer
              request={currentImagePreview}
              component={ImagePreviewer.OnHover}
              left={pos.left}
              top={pos.top}
            />
          </PreviewHrefContext.Provider>
        )}
      </div>
    </PreviewSizeModeContext.Provider>
  );
});

export default Screen;
