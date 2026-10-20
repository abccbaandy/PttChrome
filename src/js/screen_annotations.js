// 逐列標註計算：把 TermChar[][] 的一整份畫面翻成「每一列要怎麼加工」的
// annotation 陣列（黑名單隱藏／樓層徽章／原PO id 範圍／推文者高亮／URL 修復／
// X mention／AID／Steamgifts 代碼／裸網域／圖文合併／同作者推文合併）。
//
// **零 DOM、零 React**：這裡只算資料，畫成什麼節點由 renderer 決定。原本住在
// src/components/Screen.jsx 裡，2026-08 核心渲染鏈去 React 化時原樣搬出來——
// 純 JS renderer 與（過渡期的）React <Screen> 共用同一份，逐列加工不得有第二份
// 實作（見 docs/enhanced-addon.md 踩坑：好讀/原生曾各複製一份而發散出 bug）。
import {
  rowToText,
  annotateComment,
  parseListAuthor,
  parseListTitleRaw,
  matchTitleBlacklist,
  isDeletedListRow,
  isListShapedRow,
  isListRowRead,
  blacklistNoticeText,
  FloorCounter,
  ModernCommentThread,
} from "./comment_parse";
import { detectFixableUrls } from "./url_fix";
import { detectWrappedUrls } from "./url_wrap";
import {
  detectBodyWrappedUrls,
  applyWrapUrlRange,
  bodyWrapFrontier,
} from "./body_wrap";
import { detectWrappedAids } from "./aid_wrap";
import { detectBareDomains } from "./bare_domain";
import { detectMentions } from "./mention_parse";
import { detectAids } from "./aid_parse";
import { articleHasSteamgifts, detectGiveawayCodes } from "./steamgifts_parse";
import {
  groupImageCaptionBlocks,
  maxCaptionCols,
  captionScanEnd,
} from "./image_caption_group";
import { buildCaptionSpans, applyAiKeep, spanKey } from "./caption_ai_logic";
import { applyAiFix, applyAiLink, domainKey, fixKey } from "./url_ai_logic";
import {
  groupSameAuthorRuns,
  buildMergedCommentChars,
} from "./comment_merge";
import { parseFunctionKeys } from "./footer_keys";
import { mergeRunKey } from "./screen_annotate_cache";
import { detectHiddenRow } from "./hidden_text";

// PttChrome pageState (see term_buf.js#setPageState): 2 = board list, 3 = reading.
export const PAGE_LIST = 2;
export const PAGE_READING = 3;

// NOTE: articleAuthor (原PO id) is tracked by term_view across page-downs and
// passed in via enhance — the "作者" header only appears on the first page, so we
// cannot re-derive it from `lines` here on later pages.

// dirty-row 逐列 patch 的守門（renderer 唯一的判準來源，見 render/screen.js
// #_buildNodes）。回 true ⇒ 這一組 enhance 之下，每一列的 annotation 只取決於
// 「該列自己的 chars」＋ annotationsKey 涵蓋的全域輸入 ⇒ renderer 可以只重畫
// server 這一幀真的寫過的列，其餘沿用上一幀的節點。
//
// 這個知識**刻意住在這裡而不是 term_view**：跨列耦合全部長在 computeAnnotations
// 裡，判準與被判的東西放同一個檔，日後新增跨列邏輯時漂移機率最低。
//
// PAGE_READING 一律排除，理由**不是**「原生看文章有跨列邏輯」——easyReading 為
// 假時它確實逐列獨立。真正的原因有兩個：
//   1. 「easyReading === true ＋ 活 buffer」的組合真的存在：term_view.redraw 的
//      functionMode 原生鏡像與「防黑守門」兩個分支都把 buf.lines 交進來，而
//      enhance.easyReading 仍是 true ⇒ FloorCounter／mergeCommentRun／mergeBlock
//      全開。只重畫 dirty 列會讓它後面所有推文列的樓號永久位移。
//   2. hasSteamgifts 是**文章層** gate（由整頁 texts 推出、可逐幀翻轉，見下方
//      computeAnnotations），目前只放進回傳的 cache，非 stableRows 時 cache 為
//      null ⇒ renderer 看不到它有沒有翻轉。
// 要放行 READING 必須先解決這兩件事。
//
// 註：推文者高亮**不在這裡**（也不在 annotation 裡）—— 它是 renderer 的 class 層
// 狀態（render/screen.js#setSelectedPusher）。切換它不影響任何一列的 annotation，
// 所以這個函式不必為它改動，別誤以為漏改。
export function annotationsAreRowIndependent(enhance) {
  // 沒有 enhance ⇒ computeAnnotations 直接回全空 annotations，逐列獨立成立。
  if (!enhance) return true;
  return enhance.pageState !== PAGE_READING;
}

// 功能鍵按鈕（`[d]刪除` / `(y)回應`）→ 逐列裝飾。
//
// 「掃哪幾列」由 term_view 算好放進 enhance.functionKeyRows（見 js/footer_keys
// #functionKeyRows），**不在這裡推導**：好讀累積長頁的 lines 是 buf.pageLines
// （數千列），`lines.length - 1` 是內文最後一行而不是狀態列，推導必錯。
// term_view 只在「非快照列（活 buffer）」的分支才給這個欄位 ⇒ 累積長頁永遠不會
// 進到這裡，增量快取零風險。
//
// **只寫 result[row]，絕不碰 base[row]**：base 是增量快取跨幀沿用的那一層，
// runCache / captionCache 的 `prevEntry.base === base[row]` 判準靠它的參考身分。
// 與 captionBlocks / mergeCommentRun 只寫 result 的既有分層一致。
//
// annotationsAreRowIndependent 刻意**不必**為此改動：功能鍵只取決於該列自己的
// chars，加上 enhance.functionKeyRows / onFunctionKey（兩者都已進 annotationsKey）
// ⇒ 正好落在該函式合約允許的範圍內。這段註解是寫給下一個人看的，別誤以為漏改。
export function applyFunctionKeys(result, lines, enhance) {
  const rows = enhance && enhance.functionKeyRows;
  if (!rows || !rows.length) return;
  const onFunctionKey = enhance.onFunctionKey;
  for (let k = 0; k < rows.length; ++k) {
    const row = rows[k];
    if (row < 0 || row >= lines.length) continue;
    const keys = parseFunctionKeys(lines[row]);
    if (!keys) continue;
    const fnKeys = keys.map((item) => ({
      startCol: item.startCol,
      endCol: item.endCol,
      label: item.label,
      // 閉包只捕捉靜態資料（keyBytes / label ＋引用穩定的 onFunctionKey），
      // 見 render/link_segment.js 的 fnKey 分支說明。
      onClick: onFunctionKey
        ? () => onFunctionKey(item.keyBytes, item.label)
        : null,
    }));
    result[row] = { ...(result[row] || {}), fnKeys };
  }
}

// 每列的附加偵測（auto-fix URL / X mention / AID / Steamgifts），逐列迴圈與
// 「連續同作者推文合併」塊共用——合併後的 chars 是重組的新序列，原列偵測到的
// col 範圍全部失效，必須對合併 chars 重跑一次。回傳值僅含有命中的鍵。
export function detectRowExtras(chars, text, ann, opts) {
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

// 好讀累積長頁的「前沿」：之後只往後接新列時，最早可能改變最終標註的那一列
// （computeAnnotations 的 fastFrom 用它跳過前綴）。**在 computeAnnotations 新增任何
// 跨列邏輯時必須同步這裡**（同 annotationsAreRowIndependent 的規則），否則快路徑會
// 沿用過期的前綴標註。目前的跨列耦合與各自的前沿：
//   runs  ：同作者推文合併——結尾那一串同作者推文（黑名單列透明）可能再接一則
//           ⇒ 那一串的第一列（groupSameAuthorRuns 的規則）。
//   wrap  ：內文跨行網址鏈——最後一列寫滿 maxcol 時鏈還開著（body_wrap.bodyWrapFrontier）。
//   blank ：手機文末補白——最後一個非空白列之後。
// 圖文合併塊不在這裡：它由呼叫端的 captionSettled 把關（掃描停點在前沿之前才放行）。
// 樓層（FloorCounter）、hidden text、steamgifts 是只往前推的累加，與前沿無關。
// 反向讀取的接合點標記不適用（反向期間不算前沿）。
function annotationFrontier(lines, texts, result, opts) {
  const n = lines.length;
  let f = n;
  if (opts.runs) {
    let r = n - 1;
    while (r >= 0 && result[r] && result[r].userid && result[r].hidden) --r;
    if (r >= 0 && result[r] && result[r].userid) {
      const u = result[r].userid;
      let k = r;
      while (k > 0) {
        const a = result[k - 1];
        if (a && a.userid && (a.hidden || a.userid === u)) --k;
        else break;
      }
      f = Math.min(f, k);
    }
  }
  if (opts.wrap) {
    // 與跨行網址偵測同一個 skip 判準（computeAnnotations 的 isSkipRow）。
    const skip = (row) => {
      const a = result[row];
      return !!(a && (a.pusher !== undefined || a.hidden));
    };
    f = Math.min(f, bodyWrapFrontier(lines, skip));
  }
  if (opts.blank) {
    let r = n;
    while (r > 0 && !texts[r - 1].trim()) --r;
    f = Math.min(f, r);
  }
  return f;
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
export function computeAnnotations(
  lines,
  enhance,
  mergeCaption,
  captionAi,
  aiKeep,
  aiLink,
  aiFix,
  reuse,
  shape,
) {
  const result = new Array(lines.length);
  if (!enhance) return { annotations: result, cache: null };
  const {
    blacklist,
    titleBlacklist,
    showFloorNumbers,
    highlightAuthor,
    articleAuthor,
    selfId,
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
    //
    // shape（可為 null ＝ 純 append）：反向讀取（End）把新頁插在接合點 J，前後綴的
    // 列參考都不變（screen_annotate_cache.spliceShape）。[insFrom, insTo) 是這一幀
    // 新插入的列，其餘列 prevOf(row) 對回上一幀的 index。純 append 時
    // insFrom＝上一幀長度、insTo＝n，prevOf 退化成恆等 —— 與導入 shape 之前逐字相同。
    const n = lines.length;
    // 反向讀取的接合點（null＝沒有在反向）。J 之後（tail）的列**不編樓層**：上面還
    // 有多少則推文未知；接合完成後 J 消失 ⇒ 快取鍵變 ⇒ 全量重算一次補上正確樓層。
    const J =
      easyReading && enhance.reverseJunction != null
        ? enhance.reverseJunction
        : null;
    let insFrom = reuse ? (shape ? shape.prefix : reuse.texts.length) : 0;
    let insTo = reuse ? (shape ? shape.prefix + shape.inserted : n) : n;
    const prevOf = (row) =>
      row < insFrom ? row : row >= insTo ? row - (insTo - insFrom) : -1;
    // 純 append（insTo === n）：前綴整段以 slice 沿用（原生複製），只算新列。
    const appendFrom = reuse && insTo === n ? insFrom : 0;
    let texts;
    if (appendFrom) {
      texts = reuse.texts.slice(0, appendFrom);
      for (let row = appendFrom; row < n; ++row)
        texts.push(rowToText(lines[row]));
    } else {
      texts = new Array(n);
      for (let row = 0; row < n; ++row) {
        const p = reuse ? prevOf(row) : -1;
        texts[row] = p >= 0 ? reuse.texts[p] : rowToText(lines[row]);
      }
    }
    // Steamgifts giveaway 代碼連結的文章層 gate（整篇提到 steamgifts 才啟用，
    // 見 steamgifts_parse.js）。偵測本體抽在 detectRowExtras（合併塊共用）。
    // 它是**逐列偵測的輸入**：一旦某一頁首次把它翻成 true，前面每一列的偵測條件
    // 都變了 ⇒ 這一幀退回全量重算（一篇文章最多發生一次）。
    let hasSteamgifts = reuse ? reuse.hasSteamgifts : false;
    if (!hasSteamgifts)
      hasSteamgifts = articleHasSteamgifts(
        reuse ? texts.slice(insFrom, insTo) : texts,
      );
    if (reuse && hasSteamgifts && !reuse.hasSteamgifts) {
      reuse = null;
      insFrom = 0;
      insTo = n;
    }
    // ---- 前沿快路徑（超長文每頁 O(新增列)，docs/easy-reading.md「長頁分塊」支柱 C）----
    // 上一幀收尾時算好前沿 F（cache.frontier，見 annotationFrontier）：之後**只往後接
    // 新列**時，只有 F 之後的列的最終標註可能改變（推文 run 接續、內文跨行網址鏈、文末
    // 補白）。成立條件：純 append、不在反向讀取、圖文塊已定型（分組掃描的停點在 F 之前，
    // 塊與其裝飾都在前綴內不再變）。成立時 [0,F) 的 result 整段沿用上一幀**同一批物件**，
    // 跨列掃描（跨行網址、推文 run）只從 F 起跑；回傳的 stablePrefix＝F 讓 renderer
    // 連前綴的節點都不必逐列比對（render/screen.js#_buildNodes）。
    // 不成立就是既有的全量／位移路徑，行為逐字不變。
    const fastFrom =
      reuse &&
      J == null &&
      insTo === n &&
      reuse.frontier != null &&
      reuse.frontier <= insFrom &&
      reuse.captionSettled
        ? reuse.frontier
        : 0;
    // 「開燈」偵測（軌 A／軌 B，見 js/hidden_text.js）。逐列獨立 ⇒ 純累加即可，
    // **不必**像 hasSteamgifts 那樣「首次翻 true 就全量重算」：那個是逐列偵測的
    // 輸入（會改變前面每一列的判定），這兩個只是輸出。
    // 掃 chars 而不是 texts —— 判準是顏色。成本 O(新增列 × 80)，比同一個分支裡
    // 已經在跑的兩次 groupImageCaptionBlocks（全量）便宜得多。
    let litRows = reuse ? reuse.litRows : 0;
    let erasedRows = reuse ? reuse.erasedRows : 0;
    for (let row = insFrom; row < insTo; ++row) {
      const hid = detectHiddenRow(lines[row]);
      if (hid.lit) ++litRows;
      if (hid.erased) ++erasedRows;
    }
    result.hasLitHidden = litRows > 0;
    result.hasErasedHidden = erasedRows > 0;
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
      selfId,
      // 新格式推文（comment_parse.parseModernCommentHeader）的「目前這一則」：跟
      // floorCounter 同一套只往前推的生命週期 ⇒ 增量時沿用、tail 不帶。
      modernThread:
        easyReading && reuse && reuse.modernThread
          ? reuse.modernThread
          : new ModernCommentThread(),
    };
    // tail（row ≥ J）用的 ctx：不帶計數器 ⇒ annotateComment 不編樓層、也不推進
    // head 那個計數器的狀態，所以 tail 列的 base 標註只取決於該列本身，插入新頁後
    // 可以原封沿用（位移重用的前提）。
    const tailCtx =
      J != null
        ? { ...ctx, floorCounter: undefined, modernThread: undefined }
        : ctx;
    // 反向期間，跨列掃描的輸入只到 J 為止（head 與 tail 在文章裡並不相鄰）。
    const headTexts = J != null ? texts.slice(0, J) : texts;
    // 圖文合併（好讀限定）：先重建整篇純文字做跨行分組（per-row 的 annotateComment
    // 看不到鄰列）。無論開關與否都要算——關閉時浮動按鈕的顯示條件也需要塊數。
    // 塊數取兩方向（上圖下文/上文下圖）的 max，讓純「上文下圖」文章也出得了按鈕。
    let captionBlocks;
    if (easyReading) {
      // 反向期間只對 head 分組：塊遇第一則推文就停，tail 幾乎全是推文；接合後
      // 全量重算時整篇再分一次。
      const imageFirstBlocks = groupImageCaptionBlocks(headTexts, "imageFirst");
      const captionFirstBlocks = groupImageCaptionBlocks(
        headTexts,
        "captionFirst",
      );
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
        const spans = buildCaptionSpans(headTexts, mergeCaption);
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
    // 候選按列存（rowCands[row] ＝ { d, f } 或 undefined），每幀依列序串起來：中段
    // 插入之後，「上一幀的扁平清單＋新列」就不再是列序了。
    const baseFrom = reuse && insTo === n ? insFrom : 0;
    const rowCands = baseFrom ? reuse.rowCands.slice(0, baseFrom) : new Array(n);
    const baseDomainCands = [];
    const baseFixCands = [];
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
    // 純 append：前綴以 slice 沿用（同 texts），迴圈只跑新列。
    const base = baseFrom ? reuse.base.slice(0, baseFrom) : new Array(n);
    if (baseFrom) {
      base.length = n;
      rowCands.length = n;
    }
    for (let row = baseFrom; row < n; ++row) {
      const p = reuse ? prevOf(row) : -1;
      if (p >= 0) {
        base[row] = reuse.base[p];
        rowCands[row] = reuse.rowCands[p];
        continue;
      }
      const text = texts[row];
      const ann =
        annotateComment(text, J != null && row >= J ? tailCtx : ctx) ||
        undefined;
      const dC = [];
      const fC = [];
      const { fixedUrls, mentions, aids, giveaways, bareDomains } = withUrlAi(
        detectRowExtras(lines[row], text, ann, detectOpts),
        dC,
        fC,
      );
      if (dC.length || fC.length) rowCands[row] = { d: dC, f: fC };
      let r = ann;
      if (fixedUrls) r = { ...(r || {}), fixedUrls };
      if (mentions) r = { ...(r || {}), mentions };
      if (aids) r = { ...(r || {}), aids };
      if (giveaways) r = { ...(r || {}), giveaways };
      if (bareDomains) r = { ...(r || {}), bareDomains };
      base[row] = r;
    }
    // 有候選的列（遞增）。純 append 時前綴沿用、只掃新列 ⇒ 串候選是 O(候選數)。
    let candRows;
    if (baseFrom) {
      candRows = reuse.candRows.slice();
      for (let row = baseFrom; row < n; ++row) if (rowCands[row]) candRows.push(row);
    } else {
      candRows = [];
      for (let row = 0; row < n; ++row) if (rowCands[row]) candRows.push(row);
    }
    for (let k = 0; k < candRows.length; ++k) {
      const c = rowCands[candRows[k]];
      for (let i = 0; i < c.d.length; ++i) baseDomainCands.push(c.d[i]);
      for (let i = 0; i < c.f.length; ++i) baseFixCands.push(c.f[i]);
    }
    // 前沿快路徑：前綴是上一幀**最終**的標註物件（已含跨行網址／推文合併裝飾）。
    for (let row = 0; row < fastFrom; ++row) result[row] = reuse.annotations[row];
    for (let row = fastFrom; row < n; ++row) result[row] = base[row];
    // 內文跨行連結（src/js/body_wrap.js）：被切成兩列的網址，兩列都渲染成同一條
    // <a>（href 是接好的完整網址）。逐列偵測兩層都只看得到殘段 ⇒ 只有這裡（手上
    // 有整份 lines）做得到。
    //
    // **只寫 result[row]，絕不碰 base[row]**——與 applyFunctionKeys 同一條規則：
    // base 的參考身分是 captionCache / runCache 的快取鍵。
    //
    // **刻意每幀全掃、不吃增量**：斷點可能剛好落在 append 邊界（左列在上一幀就
    // 算完、from 之後不會再跑到它），只掃新列必漏接。第一個條件就是單一格子的
    // isUrlCell，幾乎所有列瞬間出局，成本與同樣每幀全掃的 groupSameAuthorRuns /
    // groupImageCaptionBlocks 同級。
    //
    // 放在 caption / run 兩個裝飾 pass **之前**：它們用 {...result[row], ...extra}
    // 疊上去會保留 wrapUrls；而某一對 (r-1, r) 的判定在 pageLines append-only 之下
    // 不會改變，所以被烘進那兩個快取也安全。
    const wrapCache = new Map();
    if (autoFixUrl) {
      const isSkipRow = (row) => {
        const a = base[row];
        return !!(a && (a.pusher !== undefined || a.hidden));
      };
      // 反向期間 head 與 tail 分開掃：J-1 與 J 在文章裡不相鄰，不可接成一條網址。
      // 前沿快路徑：只從 fastFrom 起掃（前沿保證沒有鏈跨過它，見 body_wrap.bodyWrapFrontier）。
      const wrapped = fastFrom
        ? detectBodyWrappedUrls(lines.slice(fastFrom), (row) =>
            isSkipRow(row + fastFrom),
          ).map((w) => ({
            ...w,
            parts: w.parts.map((pt) => ({ ...pt, row: pt.row + fastFrom })),
          }))
        : J != null
          ? detectBodyWrappedUrls(lines.slice(0, J), isSkipRow).concat(
              detectBodyWrappedUrls(lines.slice(J), (row) =>
                isSkipRow(row + J),
              ).map((w) => ({
                ...w,
                parts: w.parts.map((pt) => ({ ...pt, row: pt.row + J })),
              })),
            )
          : detectBodyWrappedUrls(lines, isSkipRow);
      // 同一列可能有多段（依出現順序疊上去）。
      const rangesByRow = new Map();
      for (let k = 0; k < wrapped.length; ++k) {
        const w = wrapped[k];
        for (let i = 0; i < w.parts.length; ++i) {
          const p = w.parts[i];
          if (!rangesByRow.has(p.row)) rangesByRow.set(p.row, []);
          rangesByRow.get(p.row).push({
            startCol: p.startCol,
            endCol: p.endCol,
            href: w.href,
            preview: p.preview,
          });
        }
      }
      // 裝飾出來的物件要跨幀沿用（與 captionCache 同理）：applyWrapUrlRange 每次都
      // 回新物件，不快取的話這幾列的節點每翻一頁就重建一次（佔位盒 destroy 後重掛、
      // 圖片 remount）。身分＝base 參考＋這一列的 range 簽章；反向讀取位移後列號
      // 會變，所以鍵裡不放列號。
      const prevWrap = reuse ? reuse.wrapCache : null;
      // 快路徑只重掃 [fastFrom, n)：前綴列的快取項目原樣帶到下一幀（之後若走全量／
      // 位移路徑，它要拿整份快取找回前綴的裝飾物件）。
      if (fastFrom && prevWrap)
        for (const [k, v] of prevWrap) wrapCache.set(k, v);
      for (const [row, ranges] of rangesByRow) {
        const key = ranges
          .map((r) => r.startCol + ":" + r.endCol + ":" + r.preview + ":" + r.href)
          .join("|");
        const byKey = prevWrap && prevWrap.get(base[row]);
        let ann = byKey && byKey.get(key);
        if (!ann) {
          ann = result[row];
          for (let i = 0; i < ranges.length; ++i)
            ann = applyWrapUrlRange(ann, ranges[i]);
        }
        result[row] = ann;
        if (!wrapCache.has(base[row])) wrapCache.set(base[row], new Map());
        wrapCache.get(base[row]).set(key, ann);
      }
    }
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
    //
    // 前沿快路徑：只對 [fastFrom, n) 分組（前沿保證沒有 run 跨過它），兩張快取表就地
    // 沿用（上一幀前沿之後、這一幀沒再出現的 run 在迴圈後刪掉），前綴 run 的 AI 候選
    // 由 runCandsPrefix 接上 ⇒ 每頁不再是 O(run 數)。
    const runCache = fastFrom ? reuse.runCache : new Map();
    const runByFirstBase = fastFrom ? reuse.runByFirstBase : new Map();
    // 這一幀分組到的 run 與它們的快取項目（逐一對齊），收尾算前沿時用。
    let runs = [];
    const runEntries = [];
    if (easyReading && mergeSameAuthorComments) {
      const prevRuns = reuse ? reuse.runCache : null;
      const prevRunsByFirst = reuse ? reuse.runByFirstBase : null;
      if (fastFrom) {
        runs = groupSameAuthorRuns(result.slice(fastFrom), null).map((r) => ({
          ...r,
          rows: r.rows.map((x) => x + fastFrom),
        }));
        const pre = reuse.runCandsPrefix;
        for (let i = 0; i < pre.d.length; ++i) domainCands.push(pre.d[i]);
        for (let i = 0; i < pre.f.length; ++i) fixCands.push(pre.f[i]);
      } else {
        // 反向期間 run 在 J 斷開（head 最後一則與 tail 第一則在文章裡不相鄰）。
        runs = groupSameAuthorRuns(result, J);
      }
      const sameRefs = (e, run) => {
        if (!e || e.baseRefs.length !== run.rows.length) return false;
        for (let i = 0; i < run.rows.length; ++i)
          if (e.baseRefs[i] !== base[run.rows[i]]) return false;
        return true;
      };
      for (let k = 0; k < runs.length; ++k) {
        const run = runs[k];
        const rKey = mergeRunKey(run);
        const prevEntry = prevRuns && prevRuns.get(rKey);
        let entry = sameRefs(prevEntry, run) ? prevEntry : null;
        // 反向讀取插入一頁之後，tail 的 run 整批位移（mergeRunKey 含列號 ⇒ 撞不到）。
        // 以首列的 base 參考找回上一幀的同一個 run：列參考全同、相對間距全同 ⇒ 內容
        // 完全一樣，只是換了 index。首列的裝飾物件（不含列號）原樣沿用，最貴的
        // buildMergedCommentChars 不重跑；後續列的 { mergedIntoComment: 首列 } 帶列號，
        // 重建成新 index 的淺物件。
        if (!entry && prevRunsByFirst) {
          const cand = prevRunsByFirst.get(base[run.rows[0]]);
          if (sameRefs(cand, run) && cand.decorated.length) {
            const delta = run.rows[0] - cand.decorated[0][0];
            let aligned = cand.decorated.length === run.rows.length;
            for (let i = 0; aligned && i < run.rows.length; ++i)
              if (cand.decorated[i][0] + delta !== run.rows[i]) aligned = false;
            if (aligned) {
              const first = run.rows[0];
              entry = {
                ...cand,
                decorated: cand.decorated.map(([r, a], i) =>
                  i === 0
                    ? [first, a]
                    : [
                        r + delta,
                        { ...result[r + delta], mergedIntoComment: first },
                      ],
                ),
              };
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
            // 跨行 AID 接合（src/js/aid_wrap.js）：與上面的 url_wrap 完全對稱——被推文
            // 輸入欄切成兩則的 8 碼 AIDc，逐列偵測兩層都只看到殘段。產物形狀與
            // detectAids 相同 ⇒ 補上 onClick 後併進 aids，渲染／快取全部沿用。
            // 註：另一種切法（AID 完整、只有「(看板)」被切到下一則）在
            // aid_parse.parseBoardSuffix 處理，不經過這裡。
            if (detectOpts.easyReading && detectOpts.onAidClick) {
              const wrappedAids = detectWrappedAids(merged.chars, merged.breaks);
              if (wrappedAids.length) {
                const have = new Set(
                  (extras.aids || []).map((a) => a.startCol),
                );
                const add = wrappedAids
                  .filter((a) => !have.has(a.startCol))
                  .map((a) => ({
                    ...a,
                    onClick: () => detectOpts.onAidClick(a.aid, a.board),
                  }));
                if (add.length) {
                  extras = {
                    ...extras,
                    aids: (extras.aids || []).concat(add),
                  };
                }
              }
            }
            decorated.push([
              first,
              {
                ...firstAnn,
                // 合併塊是一個節點：塊裡任一則提到我 ⇒ 整塊左緣標示。
                ...(run.rows.some((r) => result[r] && result[r].mentionsSelf)
                  ? { mentionsSelf: true }
                  : null),
                mergeCommentRun: {
                  chars: merged.chars,
                  contentStart: merged.contentStart,
                  tailStart: merged.tailStart,
                  timeStart: merged.timeStart,
                  lineEnds: merged.lineEnds,
                  dateEnd: merged.dateEnd,
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
        runByFirstBase.set(base[run.rows[0]], entry);
        runEntries.push({ key: rKey, first: base[run.rows[0]], entry });
      }
      // 快路徑就地沿用的表：上一幀前沿之後的 run 這一幀沒再出現（例：run 多接了一則，
      // 鍵從 "a-b" 變 "a-c"）⇒ 刪掉，表的大小才不會每頁長一筆。
      if (fastFrom) {
        const live = new Set(runEntries.map((e) => e.entry));
        for (const t of reuse.tailRuns) {
          if (runCache.get(t.key) === t.entry && !live.has(t.entry))
            runCache.delete(t.key);
          if (runByFirstBase.get(t.first) === t.entry && !live.has(t.entry))
            runByFirstBase.delete(t.first);
        }
      }
    }
    // 反向讀取的接合點標記（淡虛線，main.css `.reverseJunction`）：tail 的第一列。
    // 每幀是新物件 ⇒ 只有這一列（以及上一幀是它、這一幀被推下去的那一列）重建。
    if (J != null && J < n) {
      result[J] = { ...(result[J] || {}), reverseJunction: true };
    }
    // 手機文末補白（docs/mobile.md「文末補白收起」）：pmore 把 EOF 之後的列清成空白，
    // 好讀長頁照收 ⇒ 推文區下面一大塊空白。最後一列非空白之後的空白列標起來，
    // render 端收起。跨列判斷 ⇒ 只在 PAGE_READING（annotationsAreRowIndependent 恆 false）。
    // 只寫 result[row]（同 applyFunctionKeys 的規則）；每幀新物件 ⇒ 長出新內容時
    // 這幾列的標註參考變了，節點重建、放回原高。
    if (enhance.commentCards) {
      for (let row = n - 1; row >= 0 && !texts[row].trim(); --row) {
        result[row] = { ...(result[row] || {}), trailingBlank: true };
      }
    }
    // 內容型簽章：好讀翻頁只是往後長，前面已判過的候選 key 不變 → effect 不重跑。
    result.domainCands = domainCands;
    result.domainCandsSig = domainCands.map(domainKey).join(",");
    result.fixCands = fixCands;
    result.fixCandsSig = fixCands.map(fixKey).join(",");
    applyFunctionKeys(result, lines, enhance);
    // ---- 給下一幀的前沿（見上方 fastFrom）----
    // 反向期間不算（tail 之後還會往 J 插入，前沿的前提「只往後接」不成立）。
    let frontier =
      J == null
        ? annotationFrontier(lines, texts, result, {
            runs: !!(easyReading && mergeSameAuthorComments),
            wrap: !!autoFixUrl,
            blank: !!enhance.commentCards,
          })
        : null;
    // 前沿只會往後走（推導見 annotationFrontier）。萬一沒有，下一幀走全量——寧可慢
    // 一幀也不拿可能過期的前綴。
    if (frontier != null && frontier < fastFrom) frontier = null;
    // 圖文塊已定型：分組掃描的停點在前沿之前（塊與其裝飾都落在不再重算的前綴裡）。
    let captionSettled = !easyReading;
    if (easyReading && frontier != null) {
      const brk = captionScanEnd(headTexts);
      captionSettled = brk >= 0 && brk < frontier;
    }
    // 前沿之前的 run 的 AI 候選（依 run 序），與前沿之後的 run（下一幀要重分組的那些）。
    let runCandsPrefix = { d: [], f: [] };
    const tailRuns = [];
    if (frontier != null) {
      const base0 = fastFrom ? reuse.runCandsPrefix : runCandsPrefix;
      const d = base0.d.slice();
      const f = base0.f.slice();
      for (let k = 0; k < runs.length; ++k) {
        const e = runEntries[k];
        if (runs[k].rows[0] < frontier) {
          for (let i = 0; i < e.entry.domainCands.length; ++i) d.push(e.entry.domainCands[i]);
          for (let i = 0; i < e.entry.fixCands.length; ++i) f.push(e.entry.fixCands[i]);
        } else tailRuns.push(e);
      }
      runCandsPrefix = { d, f };
    }
    return {
      annotations: result,
      // 這一幀的 result[0, stablePrefix) 與上一幀是同一批物件（renderer 據此跳過前綴）。
      stablePrefix: fastFrom,
      cache: {
        annotations: result,
        frontier,
        captionSettled,
        candRows,
        runCandsPrefix,
        tailRuns,
        texts,
        base,
        floorCounter: ctx.floorCounter,
        modernThread: ctx.modernThread,
        hasSteamgifts,
        litRows,
        erasedRows,
        domainCands: baseDomainCands,
        fixCands: baseFixCands,
        rowCands,
        captionCache,
        runCache,
        runByFirstBase,
        wrapCache,
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
      // 這一列必須先「長得像列表列」才准跑黑名單／才准掛 data-list-*。
      // 上面那兩個輸入（pageState、inListContext）都是**黏的**，從列表叫出來的
      // 整頁畫面（Ctrl-P 發文、板規、精華區…）會整份繼承它們 ⇒ 板規／分類提示列
      // 的 col≥29 一旦含到使用者的標題關鍵字就被換成通知列（2026-09-05 錄製檔：
      // 「種類：… 7.Vtub 8.自介」被 vtub 命中）。判準見 comment_parse#isListShapedRow。
      // 順帶修掉**真實列表畫面**上的同一類誤命中：表頭「編號 日期 作者 標題」與
      // footer「文章選讀 (y)回應(X)推文(^X)轉錄」以前也會被關鍵字（如「轉錄」）吃掉。
      // 逐列獨立性不受影響（只看該列自己的 chars），所以
      // annotationsAreRowIndependent 不必跟著改。
      if (!isListShapedRow(text)) continue;
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
      // listRead：已讀文章低亮（pref dimReadArticles）。**永遠標**，開關是容器 class
      // （render/screen.js#_setDimRead），切換 pref 不必重建任何一列。只看該列自己
      // 的 cell ⇒ 逐列獨立，annotationsAreRowIndependent 不必跟著改。刪除列在上面
      // 就 continue／不標（本來就是灰的）。
      const listRead = !deleted && isListRowRead(lines[row]);
      if (listAuthor || listTitle || listRead) {
        result[row] = {
          listAuthor: listAuthor || undefined,
          listTitle: listTitle || undefined,
          listRead: listRead || undefined,
        };
      }
    }
  }
  // 這一段涵蓋 PAGE_LIST / inListContext 分支，**以及 pageState 0/1/5/6 全部落空**
  // 的情形：result 在函式開頭就已配置好，else-if 鏈沒命中時是一份全 undefined 的
  // 陣列，直接寫進去合法。選單（pageState 1）的功能鍵就是靠這條路。
  applyFunctionKeys(result, lines, enhance);
  // 列表／原生 24 列畫面：列物件是 term_buf 就地改寫的活 buffer（不是快照），
  // 增量快取的前提（列參考不變 ⇒ 內容不變）在這裡**不成立**，故不回快取。
  return { annotations: result, cache: null };
}
