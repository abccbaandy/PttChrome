// 終端機畫面的渲染控制器（原 src/components/Screen.jsx 的純 JS 版）。
//
// 它擁有 #mainContainer，四個核心模組（文章列表／列表好讀／文章／文章好讀）全部
// 走這一條路徑——**不可以有第二條**。2026-06 的教訓（舊 docs 坑 #11 / commit
// 06696b9、63139be）：好讀曾直接竄改 #mainContainer，React 樹的 Row 節點變成
// detached，切回 React 路徑後更新全打在 detached 節點上 ⇒ 畫面永久凍結。
//
// 對外介面刻意與舊的 React handle 相容，term_view 一行都不用改：
//   update(props)                 ← term_ui.renderScreen
//   setCursorHighlight({row,cls,col}) ← term_view.applyCursorHighlight
//   setSelectedPusher(userid)     ← term_view.togglePusherHighlight
//
// 逐列標註仍走 src/js/screen_annotations.js（與 React 版共用的純函式）。
// 兩層快取的**判準**一字沿用舊版，只是產物從 React element 換成 DOM 節點：
//   1. 標註層 — screen_annotate_cache 的 annotationsKey/sameKey/isAppendOnly，
//      只在 enhance.stableRows（好讀累積長頁的快照列）為真時啟用。
//   2. 節點層 — 列參考 + annotation 參考 + 該列高亮狀態都沒變就沿用同一個 DOM 節點。
// 沒有這兩層，8000 列的累積頁每頁都要重建 8000 列（長文「越讀越慢」的來源，
// 見 screen_annotate_cache.js 檔頭的實測）。
import { el } from "./dom";
import { buildRow } from "./row";
import {
  createMergeImageCaptionButton,
  createMergeImageCaptionAiButton,
} from "./merge_buttons";
import { createSignatureTask } from "./signature_task";
import React from "react";
import ImagePreviewer, {
  of,
  resolveSrcToImageUrl,
  resolveWithImageDOM,
} from "../components/ImagePreviewer";
import { renderInto, unmountFrom } from "../js/react_root";
import {
  PAGE_READING,
  computeAnnotations,
  annotationsAreRowIndependent,
} from "../js/screen_annotations";
import { isPusherHighlighted } from "../js/comment_parse";
import { spanKey, spanNeedsAi } from "../js/caption_ai_logic";
import {
  captionAiAvailability,
  classifySpans,
  destroyCaptionAi,
} from "../js/caption_ai";
import { domainKey, fixKey } from "../js/url_ai_logic";
import {
  classifyBrokenUrls,
  classifyDomains,
  destroyUrlAi,
} from "../js/url_ai";
import { invalidateInlinePreviewHeights } from "./inline_preview_slot";
import { computeAnchoredScrollTop, offsetTopWithin } from "../js/scroll_anchor";
import {
  annotationsKey,
  sameKey,
  isAppendOnly,
} from "../js/screen_annotate_cache";

// 游標底色的「沒有」值。凍結成模組常數讓「已經是不上色」的重複呼叫在比較階段就
// 被吃掉。col＝底色從第幾欄畫起（0＝整列），與可點區同源
// （js/mouse_regions.clickableColStart）。
const NO_HIGHLIGHT = Object.freeze({ row: -1, cls: null, col: 0 });
// 推文者高亮的整列底色（main.css .pusherHighlight）。
const PUSHER_HIGHLIGHT_CLASS = "pusherHighlight";

// 一列被丟棄時要收掉它建立的延遲載入佔位盒（IntersectionObserver /
// ResizeObserver / ImagePreviewer 的 React root）。React 卸載時自動做的事，
// 純 JS 必須自己做——這是去 React 化唯一新增的洩漏面。
function disposeNode(node) {
  if (!node) return;
  const slots = node.__slots;
  if (!slots) return;
  for (let i = 0; i < slots.length; ++i) slots[i].destroy();
  node.__slots = null;
}

export class ScreenController {
  constructor(screenRoot) {
    this.screenRoot = screenRoot;
    this.container = el("div", { id: "mainContainer" });
    screenRoot.appendChild(this.container);

    // 最後一次 update() 的 props（互動 state 改變時據此重畫）。
    this.props = null;

    // ---- 互動狀態（原本是 Screen 的 11 個 useState）----
    // 游標底色：要上色的列 + color.css 背景 class + 起始欄。row -1 / cls null ＝
    // 不上色；col 0 ＝ 整列，col > 0 ＝ 只有 [col, 行尾) 上色。決策全在
    // js/cursor_highlight.js，套用入口是 term_view.applyCursorHighlight。
    this.highlight = NO_HIGHLIGHT;
    // 推文者高亮（點推文列 → 該作者的每一則整列 tint）。與 highlight 同性質：
    // 純互動狀態、只影響 class，**不進 annotation、不進 annotationsKey**
    // （理由見 js/screen_annotate_cache.js 的「刻意不含」段）。真相源仍是
    // term_view._selectedPusher，這裡由 update() 同步進來。
    this._selectedPusher = null;
    // DOM 上實際套著的那個值。兩者不同 ⇒ 有沿用的節點還帶著舊 class，_render
    // 收尾補一次對帳（正常翻頁兩者相等 ⇒ 零成本）。
    this._appliedPusher = null;
    this._hoverPreview = undefined;
    this._hoverPos = { left: undefined, top: undefined };
    // 好讀自動開圖「一鍵放大全部圖片至視窗寬度」；點任一張內嵌預覽圖切換。
    this._imagesEnlarged = false;
    // 好讀「圖左字右合併」三態：null（關）→ "imageFirst" → "captionFirst" → null。
    // 與 imagesEnlarged 同生命週期——同篇 page-down 保留、換文章／退出再進
    // （articleId 變）才重置，所以不會「換到沒按鈕的文章卻還開著、關不掉」。
    this._mergeCaption = null;
    // 裝置端 AI 校正（第二顆浮動按鈕，per-session）。
    this._captionAi = false;
    this._aiKeep = {};
    this._aiPending = 0;
    // 模型是否真的就緒。光看 window.LanguageModel 存不存在不夠：Chromium 也有這個
    // global，但 availability() 會回 'unavailable'（沒有模型元件）——那種情況下
    // 按鈕按下去只會每塊 fallback 回規則，等於一顆沒有作用的按鈕。
    this._aiReady = false;
    // 裸網域連結的 AI 複核結果 cache：domainKey → boolean。只有明確 false 會撤掉
    // 規則已允許的連結（單向收縮，見 url_ai_logic.js）。
    this._aiLink = {};
    // URL 修復 gray 候選的 AI 複核結果 cache：fixKey → boolean。方向相反——只有
    // 明確 true 才**放行**一筆規則層不敢認的修復。
    this._aiFix = {};

    // ---- 渲染狀態 ----
    this._cache = null; // { key, lines, cache, annotations, nodes, highlight }
    // 上一幀的渲染條件，dirty-row 逐列 patch 用（見 _buildNodes）。與 _cache
    // **刻意分離**：_cache 是「標註增量」的載體、只有好讀累積長頁（stableRows）
    // 才有；_prevFrame 是「節點重用」的載體、每一幀都寫。攪在一起會讓原生／列表
    // 的節點重用被綁上 stableRows 的前提（列參考不變 ⇒ 內容不變），那個前提在活
    // buffer 上不成立。
    this._prevFrame = null; // { lines, key, highlight, sizeMode, rowIndependent }
    this._nodes = []; // 上一幀每一列的節點（null ＝ 這一列不佔版面）
    this._annotations = []; // 上一幀的 annotations（與 _nodes 逐列對齊）
    this._liveSlots = new Set(); // 目前掛著的佔位盒（imagesEnlarged 切換要通知）
    this._overlayNodes = []; // 尾端固定浮層（兩顆按鈕 + hover 預覽宿主）
    this._captionAiEnabledSeen = null;
    this._availabilityToken = 0;

    // 事件委派：點到內嵌預覽圖（.hyperLinkPreview）即切換整頁圖片放大/縮小。
    // hover 預覽的 OnHover img 無此 class，不受影響。
    this._onContainerClick = this._onContainerClick.bind(this);
    this._onContainerMouseMove = this._onContainerMouseMove.bind(this);
    this.onHyperLinkMouseOver = this.onHyperLinkMouseOver.bind(this);
    this.onHyperLinkMouseOut = this.onHyperLinkMouseOut.bind(this);
    this.container.addEventListener("click", this._onContainerClick);
    this.container.addEventListener("mousemove", this._onContainerMouseMove);

    this._mergeButton = null;
    this._aiButton = null;
    this._hoverHost = null;

    this._initAiTasks();
  }

  // ---------------------------------------------------------------- AI 任務
  // 三套裝置端推論都是「內容簽章變了才重跑、逐筆回填、不擋畫面」，抽在
  // signature_task.js。舊版是三段幾乎相同的 useEffect。
  _initAiTasks() {
    this._captionAiTask = createSignatureTask(
      (todo, ctx) => {
        this._aiPending = todo.length;
        this._syncAiButton();
        // 逐塊推論、逐塊回填：規則結果早就畫出來了，AI 只是漸進式修正。
        classifySpans(todo, {
          signal: ctx.signal,
          onResult: (span, r) => {
            if (ctx.isCancelled()) return;
            this._aiKeep = { ...this._aiKeep, [spanKey(span)]: r.keep };
            this._aiPending = this._aiPending > 0 ? this._aiPending - 1 : 0;
            this._rerender();
          },
        })
          .catch(() => {})
          .then(() => {
            if (ctx.isCancelled()) return;
            this._aiPending = 0;
            this._syncAiButton();
          });
      },
      {
        // 關掉 AI／換頁重算時，殘留的「推論中」計數不可留在按鈕上。
        onCancel: () => {
          this._aiPending = 0;
          this._syncAiButton();
        },
      },
    );

    this._urlAiTask = createSignatureTask((todo, ctx) => {
      classifyDomains(todo, {
        signal: ctx.signal,
        onResult: (cand, r) => {
          // link === null（逾時／垃圾回覆／不支援）不寫進 cache：留著 undefined
          // 等於「沒有判決」→ 連結保留，也不會被記成永久答案。
          if (ctx.isCancelled() || r.link === null) return;
          this._aiLink = { ...this._aiLink, [domainKey(cand)]: r.link };
          this._rerender();
        },
      }).catch(() => {});
    });

    this._fixAiTask = createSignatureTask((todo, ctx) => {
      classifyBrokenUrls(todo, {
        signal: ctx.signal,
        onResult: (cand, r) => {
          if (ctx.isCancelled() || r.link === null) return;
          this._aiFix = { ...this._aiFix, [fixKey(cand)]: r.link };
          this._rerender();
        },
      }).catch(() => {});
    });
  }

  // ------------------------------------------------------------------- 入口
  update(props) {
    const prev = this.props;
    // lines 參考改變（換頁／重渲染）即關掉開啟中的 hover 圖片預覽。
    if (
      prev &&
      props.lines !== prev.lines &&
      this._hoverPreview !== undefined
    ) {
      this._hoverPreview = undefined;
    }
    // imagesEnlarged 以 enhance.articleId 為準：好讀同篇 page-down 會 concat 出新
    // lines 參考但 articleId 不變，放大狀態因此在同篇捲動載入時保留；換文章／退出
    // 再進（articleId 變）才重置。
    const articleId = props.enhance && props.enhance.articleId;
    const prevArticleId = prev && prev.enhance && prev.enhance.articleId;
    if (prev && articleId !== prevArticleId) {
      this._imagesEnlarged = false;
      this._mergeCaption = null;
      // AI 結果是 per-article 的：換文章一律丟掉（spanKey 只保證同一篇內唯一；
      // domainKey 含整列文字，舊判斷也沒有沿用價值）。
      this._captionAi = false;
      this._aiKeep = {};
      this._aiLink = {};
      this._aiFix = {};
    }
    // selectedPusher 由 term_view 帶進來（它仍是唯一真相），但 render 時一律讀
    // this._selectedPusher —— setCursorHighlight 慢路徑那種「不換 props 的
    // _render()」才不會讀到過期值。這行同時是**新建 controller 的種子**。
    this._selectedPusher =
      (props.enhance && props.enhance.selectedPusher) || null;
    this.props = props;
    this._render();
  }

  // 游標底色的套用點。term_view.applyCursorHighlight 是唯一呼叫者。
  //
  // 快路徑：整列底色（col 0，絕大多數情形）只是把 class 從舊列搬到新列，**不重畫**
  // ——舊版走 useState 會讓整個 Screen re-render（靠元素快取 bailout 才不致於重建
  // 每一列）。col > 0 的部分底色是包在 LinkSegmentBuilder 建的 wrapper span 裡，
  // 沒有辦法只換 class，退回重畫。
  setCursorHighlight(next) {
    const prev = this.highlight;
    const state = next || NO_HIGHLIGHT;
    if (
      prev.row === state.row &&
      prev.cls === state.cls &&
      prev.col === state.col
    )
      return;
    this.highlight = state;
    if (prev.col === 0 && state.col === 0) {
      if (prev.row >= 0 && prev.cls)
        this._toggleRowClass(prev.row, prev.cls, false);
      if (state.row >= 0 && state.cls)
        this._toggleRowClass(state.row, state.cls, true);
      if (this._cache) this._cache.highlight = state;
      // 快路徑已經把 class 搬到正確的列上了 ⇒ 那些節點現在就是「新 highlight 下
      // 該有的樣子」，下一幀沿用它們是對的。不同步的話下一幀的 frame gate 會因為
      // highlight 對不上而整批重建（結果正確，但白白浪費）。
      if (this._prevFrame) this._prevFrame.highlight = state;
      return;
    }
    this._render();
  }

  // 推文者高亮的套用點。term_view.togglePusherHighlight 是唯一呼叫者。
  // 與 setCursorHighlight 的快路徑同構：**絕對不呼叫 _render()**，只把 class 搬到
  // 正確的列上。走重畫的年代 = 整份好讀長頁重算 + 每一列節點重建（症狀見
  // js/comment_parse.js#isPusherHighlighted 的註解）。
  setSelectedPusher(userid) {
    const next = userid || null;
    if (this._selectedPusher === next) return;
    this._selectedPusher = next;
    this._syncPusherClasses();
  }

  destroy() {
    this._captionAiTask.stop();
    this._urlAiTask.stop();
    this._fixAiTask.stop();
    destroyCaptionAi();
    destroyUrlAi();
    for (let i = 0; i < this._nodes.length; ++i) disposeNode(this._nodes[i]);
    this._nodes = [];
    this._annotations = [];
    this._liveSlots.clear();
    if (this._hoverHost) unmountFrom(this._hoverHost);
    this.container.removeEventListener("click", this._onContainerClick);
    this.container.removeEventListener("mousemove", this._onContainerMouseMove);
    this.container.remove();
    this._cache = null;
    this._prevFrame = null;
  }

  // --------------------------------------------------------------- 事件處理
  // 縮放會讓整份內容高度驟變，而捲動容器（.main）的 scrollTop 不變 → 視窗相對文章
  // 整個位移，被點的那張圖跑出視野。故點擊當下先記下錨點（此時讀到的還是**舊
  // layout**，正是我們要的 before 值），套用後立刻補回捲動位置。
  // 量測一律用 offsetTop/offsetHeight，不可用 getBoundingClientRect——見
  // scroll_anchor.js 開頭的座標系規則（.main 與 img 各有 transform scale）。
  _onContainerClick(e) {
    const t = e.target;
    if (!t || t.tagName !== "IMG" || !t.classList.contains("hyperLinkPreview"))
      return;
    const scroller = this.container.closest(".main");
    const anchor = scroller
      ? {
          el: t,
          scroller,
          topBefore: offsetTopWithin(t, this.container),
          heightBefore: t.offsetHeight,
          scrollBefore: scroller.scrollTop,
        }
      : null; // 拿不到捲動容器就單純切換，不補償（不 crash）。
    this._setImagesEnlarged(!this._imagesEnlarged);
    if (!anchor || !anchor.el.isConnected) return;
    anchor.scroller.scrollTop = computeAnchoredScrollTop({
      topBefore: anchor.topBefore,
      heightBefore: anchor.heightBefore,
      scrollBefore: anchor.scrollBefore,
      topAfter: offsetTopWithin(anchor.el, this.container),
      heightAfter: anchor.el.offsetHeight,
      maxScroll: anchor.scroller.scrollHeight - anchor.scroller.clientHeight,
    });
  }

  _onContainerMouseMove(e) {
    if (this._hoverPreview === undefined) return;
    this._hoverPos = { left: e.clientX, top: e.clientY };
    this._syncHoverPreview();
  }

  onHyperLinkMouseOver(e) {
    if (!this.props || !this.props.enableLinkHoverPreview) return;
    const href = e.currentTarget.href;
    // 座標要在這一刻就記下：本函式結尾會立刻渲染一次預覽，而 _hoverPos 原本只有
    // mousemove 會填 ⇒ 滑進連結後、第一次 mousemove 之前那一幀座標是 undefined，
    // OnHover 的 `left + 20` 算成 NaN（主控台噴 "`NaN` is an invalid value for
    // the `left` css style property"）。守護 tests/unit/hover_preview_position。
    if (Number.isFinite(e.clientX) && Number.isFinite(e.clientY)) {
      this._hoverPos = { left: e.clientX, top: e.clientY };
    }
    const preview = of(href)
      .then(resolveSrcToImageUrl)
      .then(resolveWithImageDOM);
    // 同 requestPreview：不可預覽連結立即 reject，消費端（ImagePreviewer effect）
    // 晚一拍才掛 handler —— 先標記 handled，避免 unhandledrejection。
    preview.catch(() => {});
    this._hoverPreview = preview;
    this._syncHoverPreview();
  }

  onHyperLinkMouseOut() {
    if (this._hoverPreview === undefined) return;
    this._hoverPreview = undefined;
    this._syncHoverPreview();
  }

  // 按鈕切換純屬本控制器的內部狀態；換回終端機輸入焦點（隱藏 input #t），
  // 否則按鈕吃掉鍵盤、方向鍵失效。
  _refocusTerminal() {
    const input = document.getElementById("t");
    if (input) input.focus();
  }

  _toggleMergeCaption() {
    const v = this._mergeCaption;
    const next =
      v === null ? "imageFirst" : v === "imageFirst" ? "captionFirst" : null;
    // 循環回「還原排版」時把 AI 一起關掉（畫面上沒有合併塊，AI 開著沒有意義）。
    if (next === null) this._captionAi = false;
    this._mergeCaption = next;
    // 左欄比全寬窄（.mergedImageCol .easyReadingImg { max-width:100% }）⇒ 圖片顯示
    // 寬度改變 ⇒ 之前量到的 pinned 高度過期，必須在重畫前作廢。
    this.notifyLayoutChanged();
    this._rerender();
    this._refocusTerminal();
  }

  // AI 按鈕：關 → 開（若尚未合併就順手開成「上圖下文」），再按一次只關 AI，
  // 手動合併狀態保留（兩顆按鈕互不吃掉對方的狀態）。
  _toggleCaptionAi() {
    if (!this._captionAi && !this._mergeCaption)
      this._mergeCaption = "imageFirst";
    this._captionAi = !this._captionAi;
    this._rerender();
    this._refocusTerminal();
  }

  // imagesEnlarged 不需要重建任何一列：容器 class 決定圖片尺寸，佔位盒只要知道
  // 現在是哪個模式（分模式各記一筆高度，見 lazy_media.recordSlotHeight）。
  _setImagesEnlarged(next) {
    if (this._imagesEnlarged === next) return;
    this._imagesEnlarged = next;
    this.container.classList.toggle("imagesEnlarged", next);
    const mode = next ? "enlarged" : "normal";
    for (const slot of this._liveSlots) slot.setSizeMode(mode);
  }

  // 版面**寬度**改變的唯一入口（字級／視窗 resize 走 term_view.setTermFontSize，
  // 圖左字右合併走 _toggleMergeCaption）。佔位盒記的 pinned 高度是在舊寬度下量到
  // 的，換寬度就過期；aspect（原尺寸）與寬度無關，一律保留讓替身盒接手。
  // **不含 imagesEnlarged**：那是 sizeMode，本來就分模式各記一筆高度。
  notifyLayoutChanged() {
    invalidateInlinePreviewHeights();
    for (const slot of this._liveSlots) slot.invalidatePinned();
  }

  // ----------------------------------------------------------------- 渲染
  _rerender() {
    if (this.props) this._render();
  }

  _render() {
    const { lines, enhance, forceWidth, enableLinkInlinePreview } = this.props;

    // ---- 增量重算快取（好讀文章累積頁專用）----
    // 前提由 `enhance.stableRows` 帶進來，term_view 只在渲染 buf.pageLines（好讀
    // 累積的長頁）時給。那裡的列是 cloneRow 出來的**快照**，append 之後永不再被
    // 寫，所以「列物件參考相同 ⇒ 內容相同」成立。原生 24 列畫面與列表視窗則是
    // term_buf 就地改寫的活 buffer：參考相同但內容每幀在變，套快取會畫出上一幀。
    const cacheKey = annotationsKey({
      enhance,
      mergeCaption: this._mergeCaption,
      captionAi: this._captionAi,
      aiKeep: this._aiKeep,
      aiLink: this._aiLink,
      aiFix: this._aiFix,
      forceWidth,
      enableLinkInlinePreview,
      enableLinkHoverPreview: this.props.enableLinkHoverPreview,
      onHyperLinkMouseOver: this.onHyperLinkMouseOver,
      onHyperLinkMouseOut: this.onHyperLinkMouseOut,
    });
    const stableRows = !!(enhance && enhance.stableRows);
    const prevCache = this._cache;
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
      this._mergeCaption,
      this._captionAi,
      this._aiKeep,
      this._aiLink,
      this._aiFix,
      reusable ? reusable.cache : null,
    );
    const annotations = computed.annotations;

    this._syncAiTasks(annotations, enhance);

    // ---- dirty-row 逐列 patch 的整幀輸入（非 stableRows 專用）----
    // rowIndependent：這組 enhance 之下，每一列的 annotation 是不是只取決於該列
    //   自己（判準住在 screen_annotations.js，那裡才看得到所有跨列耦合）。
    // changedRows：term_view 從 buf.lineChangeds 帶下來的「server 這一幀寫了哪些
    //   列」。只有 lines 直接來自 buf.lines 的分支會給；沒給就是 null（＝這一幀
    //   不知道誰髒 ⇒ 不走 dirty-row 路徑）。
    const rowIndependent = annotationsAreRowIndependent(enhance);
    const changedRows =
      enhance && enhance.changedRows ? new Set(enhance.changedRows) : null;
    const nodes = this._buildNodes(lines, annotations, reusable, stableRows, {
      key: cacheKey,
      rowIndependent,
      changedRows,
    });
    this._cache =
      computed.cache && stableRows
        ? {
            key: cacheKey,
            lines,
            cache: computed.cache,
            annotations,
            nodes,
            highlight: this.highlight,
          }
        : null;
    this._nodes = nodes;
    // 與 _nodes 逐列對齊，_syncPusherClasses 據此判斷哪些列是推文列。
    this._annotations = annotations;
    // 必須排在 _buildNodes 之後：那裡讀的是**上一幀**的 _prevFrame。
    this._prevFrame = {
      lines,
      key: cacheKey,
      highlight: this.highlight,
      sizeMode: this._sizeMode(),
      rowIndependent,
    };

    this._syncOverlays(annotations, enhance);
    this._patchRows(nodes);
    // 沿用上一幀的節點不會自己更新 pusher class（它不在 annotation 裡）。只有
    // 「欄位被 update(props) 換掉、卻沒經過 setSelectedPusher」時才需要補一次；
    // 正常翻頁 append 兩者相等 ⇒ 這裡零成本，O(新增列) 的不變量不破。
    if (this._appliedPusher !== this._selectedPusher) this._syncPusherClasses();
  }

  // ---- 每列節點快取 ----
  // 重用條件三件（與舊版 Screen.jsx 的元素快取一字對應）：列內容（chars 參考，由
  // isAppendOnly 保證）、最終 annotation 物件參考、以及這一列的高亮狀態。
  // mergeBlock 列例外——它的內容還取決於右欄那些說明行的 annotation，條件不只自己
  // 這一列，直接重建（只有使用者手動開「圖文並排」時才存在，且塊數有限）。
  _buildNodes(lines, annotations, reusable, stableRows, frame) {
    const prevNodes = reusable ? reusable.nodes : null;
    const prevAnnotations = reusable ? reusable.annotations : null;
    const prevHighlight = reusable ? reusable.highlight : NO_HIGHLIGHT;
    // 顏色（cls）或起始欄（col）換掉時整批失效——使用者在設定頁改底色／切防誤觸
    // 才會發生，罕見到不值得逐列記住上一次用的值。
    const sameHighlightCls =
      prevHighlight.cls === this.highlight.cls &&
      prevHighlight.col === this.highlight.col;
    const oldNodes = this._nodes;

    // ---- dirty-row 逐列 patch：整幀守門（原生／列表，非 stableRows）----
    // 通過的話，下面的逐列迴圈對「這一幀沒被寫過的列」**完全不建節點、不序列化**
    // ——省掉 buildRow + 兩次 outerHTML。任何一條不成立就退回既有的全量路徑
    // （每列重建 + outerHTML 比對），行為與導入這層之前逐字相同。
    // sizeMode 要另外比：annotationsKey 刻意不含它（_setImagesEnlarged 走 slot
    // 廣播、不重畫），但它會進 buildRow ⇒ 是節點重用的前提之一。
    const pf = stableRows ? null : this._prevFrame;
    const frameReuse =
      !!pf &&
      frame.rowIndependent &&
      pf.rowIndependent &&
      sameKey(pf.key, frame.key) &&
      pf.sizeMode === this._sizeMode() &&
      pf.highlight.cls === this.highlight.cls &&
      pf.highlight.col === this.highlight.col;
    const prevLines = frameReuse ? pf.lines : null;
    const frameHighlightRow = pf ? pf.highlight.row : -1;
    const changedRows = frame.changedRows;
    // 這批列是快照（存進去之後不再就地改寫）⇒ 列參考相同即內容相同。列表好讀的
    // 視窗（buffer/frozen）才有，見 term_view.buildListWindowLines。
    const rowIdentityStable = !!(
      this.props.enhance && this.props.enhance.rowIdentityStable
    );

    const nodes = new Array(lines.length);
    for (let row = 0; row < lines.length; ++row) {
      const ann = annotations[row];
      if (
        prevNodes &&
        row < prevNodes.length &&
        prevAnnotations[row] === ann &&
        sameHighlightCls &&
        (prevHighlight.row === row) === (this.highlight.row === row) &&
        !(ann && ann.mergeBlock)
      ) {
        nodes[row] = prevNodes[row];
        continue;
      }
      // ---- dirty-row 逐列重用 ----
      // prevLines[row] === lines[row] 是**承重條件**，一次擋掉三件事：
      //   1. 原生 24 列 ↔ 列表視窗 24 列互換（長度相同、來源不同）
      //   2. buf.lines ↔ buf.pageLines 互換
      //   3. term_buf.scroll() 的 unshift/pop/splice 把列物件換到別的 index
      // 所以呼叫端不需要自我宣告「這一幀是什麼來源」——那種 token 漏傳沒人擋得住。
      // 原生／列表的 lines 是 term_buf 就地改寫的活 buffer，列參考相同**不**代表
      // 內容相同，故必須再配一個「誰髒」的來源：changedRows（server 這一幀寫過的
      // 列）或 rowIdentityStable（這批列是快照）。
      if (
        frameReuse &&
        oldNodes[row] &&
        prevLines[row] === lines[row] &&
        (frameHighlightRow === row) === (this.highlight.row === row) &&
        (rowIdentityStable || (changedRows && !changedRows.has(row)))
      ) {
        // 沿用的節點會被下面的 keep 集合收錄 ⇒ 不會被誤 dispose
        // （守護：tests/unit/render_dispose.test.js）。
        nodes[row] = oldNodes[row];
        continue;
      }
      const built = this._buildRowNode(row, lines, annotations);
      // 原生／列表（非 stableRows）每幀都要重算，但畫面內容往往一字未變。序列化
      // 比對後沿用舊節點，可以省掉整列的 DOM 抽換——選取範圍與捲動位置因此不會
      // 每 30ms 被打斷一次。長頁走上面的參考快取，不必付這個序列化成本。
      if (!stableRows && built && oldNodes[row]) {
        const have = oldNodes[row];
        if (have.outerHTML === built.outerHTML) {
          disposeNode(built);
          nodes[row] = have;
          continue;
        }
      }
      nodes[row] = built;
    }
    // 這一幀沒有留下來的舊節點：收掉它們的佔位盒。
    const keep = new Set();
    for (let i = 0; i < nodes.length; ++i) if (nodes[i]) keep.add(nodes[i]);
    for (let i = 0; i < oldNodes.length; ++i) {
      if (oldNodes[i] && !keep.has(oldNodes[i])) disposeNode(oldNodes[i]);
    }
    return nodes;
  }

  // 單一列 → DOM 節點（null ＝ 這一列不佔版面：黑名單 dropHidden、已併進圖文合併
  // 右欄、已併進同作者推文塊）。
  _buildRowNode(row, lines, annotations) {
    const { enhance, forceWidth, enableLinkInlinePreview } = this.props;
    // dropHidden: 好讀累積成一整份長捲頁，黑名單推文整列移除（不留空行）。固定的
    // 原生 grid 則保留該列並隱藏（visibility:hidden），以維持終端機對齊。移除**不會**
    // 位移其餘列的 row/data-row（絕對 pageLines index），跨缺口的選取複製才不會錯位。
    const dropHidden = !!(enhance && enhance.dropHidden);
    const ann = annotations[row];
    if (dropHidden && ann && ann.hidden) return null;
    // 說明行已併入所屬圖行的右欄；連續同作者推文的後續列已併進 run 首列。
    if (ann && ann.mergedInto !== undefined) return null;
    if (ann && ann.mergedIntoComment !== undefined) return null;

    if (ann && ann.mergeCommentRun) {
      const m = ann.mergeCommentRun;
      // data-row＝run 首列的絕對 pageLines index。塊內複製以 DOM 選取為準
      // （^C 走 window.getSelection().toString()）；getText 的 col 對映在合併段內
      // 失真，已知取捨（同 mergedImageBlock 的脈絡）。
      // 懸掛縮排寬度＝首則內容起始欄 × 半形字寬（forceWidth 是全形字像素寬）
      // → 第 2 則起與第一則的內容對齊（main.css .mergedCommentBlock）。
      const built = buildRow({
        chars: m.chars,
        row,
        forceWidth,
        enableLinkInlinePreview,
        highlightClass:
          this.highlight.row === row ? this.highlight.cls : undefined,
        highlightColStart:
          this.highlight.row === row ? this.highlight.col : undefined,
        floor: ann.floor,
        pusher: ann.pusher,
        pusherContentCol: ann.contentCol,
        pusherHighlight: isPusherHighlighted(ann, this._selectedPusher),
        authorIdStart: ann.authorIdStart,
        authorIdEnd: ann.authorIdEnd,
        fixedUrls: m.fixedUrls,
        mentions: m.mentions,
        aids: m.aids,
        giveaways: m.giveaways,
        bareDomains: m.bareDomains,
        onHyperLinkMouseOver: this.onHyperLinkMouseOver,
        onHyperLinkMouseOut: this.onHyperLinkMouseOut,
        sizeMode: this._sizeMode(),
      });
      const wrapper = el(
        "div",
        {
          class: "mergedCommentBlock",
          style: {
            "--merged-comment-indent": `${(m.contentStart * forceWidth) / 2}px`,
          },
        },
        built.node,
      );
      this._adopt(wrapper, built.slots);
      return wrapper;
    }

    if (ann && ann.mergeBlock) {
      const { captionStart, captionEnd } = ann.mergeBlock;
      const slots = [];
      const image = this._renderRow(row, lines, annotations, slots);
      const captionRows = [];
      for (let r = captionStart; r <= captionEnd; ++r) {
        const cAnn = annotations[r];
        if (dropHidden && cAnn && cAnn.hidden) continue;
        captionRows.push(this._renderRow(r, lines, annotations, slots));
      }
      // 右欄不換行：寬度＝最寬翻譯行的顯示欄數（半形1/全形2）× 半形字寬。
      // forceWidth 是全形字強制的像素寬 → 半形 ≈ forceWidth/2；+1 全形字寬當緩衝。
      // 上限 55% 交給 CSS max-width 守（極長行時退回換行，見 main.css pre-wrap）。
      const captionColStyle = annotations.captionMaxCols
        ? { width: `${(annotations.captionMaxCols / 2 + 1) * forceWidth}px` }
        : undefined;
      const wrapper = el("div", { class: "mergedImageBlock" }, [
        el("div", { class: "mergedImageCol" }, image),
        el(
          "div",
          { class: "mergedCaptionCol", style: captionColStyle },
          captionRows,
        ),
      ]);
      this._adopt(wrapper, slots);
      return wrapper;
    }

    const slots = [];
    const node = this._renderRow(row, lines, annotations, slots);
    this._adopt(node, slots);
    return node;
  }

  // 一列的 <Row> 等價物。抽出來是因為圖文合併時說明行要從頂層移進右欄，兩處必須
  // 用同一份渲染（row/data-row 保留絕對 pageLines index，選取複製才不壞）。
  _renderRow(row, lines, annotations, slots) {
    const { forceWidth, enableLinkInlinePreview } = this.props;
    const ann = annotations[row];
    const built = buildRow({
      chars: lines[row],
      row,
      forceWidth,
      enableLinkInlinePreview,
      highlightClass:
        this.highlight.row === row ? this.highlight.cls : undefined,
      highlightColStart:
        this.highlight.row === row ? this.highlight.col : undefined,
      floor: ann && ann.floor,
      hidden: ann && ann.hidden,
      pusher: ann && ann.pusher,
      pusherContentCol: ann && ann.contentCol,
      listAuthor: ann && ann.listAuthor,
      listTitle: ann && ann.listTitle,
      pusherHighlight: isPusherHighlighted(ann, this._selectedPusher),
      authorIdStart: ann && ann.authorIdStart,
      authorIdEnd: ann && ann.authorIdEnd,
      fixedUrls: ann && ann.fixedUrls,
      mentions: ann && ann.mentions,
      aids: ann && ann.aids,
      giveaways: ann && ann.giveaways,
      bareDomains: ann && ann.bareDomains,
      // 功能鍵按鈕。**上面的 mergeCommentRun 合併分支刻意不傳**：那條路的 chars 是
      // comment_merge.buildMergedCommentChars 重組的新序列，原列的 col 範圍全部失效
      // （同理它對 mentions/aids 也改用 m.* 而非 ann.*）。功能鍵列永遠不是推文列。
      fnKeys: ann && ann.fnKeys,
      blacklistNotice: ann && ann.blacklistNotice,
      onHyperLinkMouseOver: this.onHyperLinkMouseOver,
      onHyperLinkMouseOut: this.onHyperLinkMouseOut,
      sizeMode: this._sizeMode(),
    });
    for (let i = 0; i < built.slots.length; ++i) slots.push(built.slots[i]);
    return built.node;
  }

  _sizeMode() {
    return this._imagesEnlarged ? "enlarged" : "normal";
  }

  // 把這一列建立的佔位盒掛到它的頂層節點上，並記進存活集合（imagesEnlarged 切換
  // 要逐一通知）。節點被丟棄時由 disposeNode 收掉。
  _adopt(node, slots) {
    node.__slots = slots;
    for (let i = 0; i < slots.length; ++i) {
      const slot = slots[i];
      this._liveSlots.add(slot);
      const origDestroy = slot.destroy;
      slot.destroy = () => {
        this._liveSlots.delete(slot);
        origDestroy();
      };
    }
  }

  // 把容器的列區塊調成 `nodes` 的樣子。逐位置比對＋就地搬移：沒變的節點原封不動
  // 留在 DOM 裡（好讀累積頁的常態是純 append，這裡就只會做 appendChild）。
  //
  // 列表好讀的平滑捲動（enhance.listScroll）多一層：body 那 20 列住在一個固定高度、
  // overflow:hidden 的視口節點裡，用它的 scrollTop 表達**次列位移**（畫面因此停得住
  // 半列的位置）。header/footer 留在容器直系子層 ⇒ 不會跟著捲、也不必靠不透明背景
  // 去蓋住捲進來的內容。列節點本身完全沒變（data-row／內容／快取都一樣），只是換了
  // 父節點。
  _patchRows(nodes) {
    const ls = this.props.enhance && this.props.enhance.listScroll;
    // 列區塊的右邊界＝第一個浮層節點（浮層永遠排在最後）。取 isConnected 的那個：
    // 拿到一個已經被移出 DOM 的節點當終點，下面的清理迴圈會一路把浮層也掃掉。
    const stop = this._overlayNodes.find((n) => n.isConnected) || null;
    if (!ls) {
      // 非列表好讀：視口節點若還在，會因為不在 nodes 裡而被下面的清理迴圈移除。
      this._patchInto(this.container, nodes, stop);
      return;
    }
    const bodyEnd = ls.bodyStart + ls.bodyRows;
    const bodyNodes = nodes.slice(ls.bodyStart, bodyEnd);
    // overscan 列排在 footer 之後（term_view.buildListWindowLines 的註解說明了
    // 為什麼不能插在 body 裡：footer 的 data-row 是外部契約）。
    if (ls.overscan && nodes.length > bodyEnd + 1)
      bodyNodes.push(nodes[bodyEnd + 1]);
    const view = this._ensureBodyView(ls);
    const outer = nodes
      .slice(0, ls.bodyStart)
      .concat([view], nodes.slice(bodyEnd, bodyEnd + 1));
    this._patchInto(this.container, outer, stop);
    this._patchInto(view, bodyNodes, null);
    view.scrollTop = ls.offsetPx || 0;
  }

  // 列表好讀 body 的捲動視口。高度＝body 列數 × 列高（版面總高不變：它取代的就是
  // 那 20 列），內容多一列時由 overflow:hidden 裁掉。
  _ensureBodyView(ls) {
    if (!this._bodyView) this._bodyView = el("div", { class: "listBodyView" });
    const h = (ls.viewportPx || 0) + "px";
    if (this._bodyView.style.height !== h) this._bodyView.style.height = h;
    return this._bodyView;
  }

  // 次列位移的快路徑（term_view → ListSession._setScrollFrac）：捲動沒有跨列時
  // 只有 scrollTop 變，整幀重繪是白工（滾輪動畫是每幀觸發的）。
  setListScrollOffset(px) {
    if (this._bodyView) this._bodyView.scrollTop = px || 0;
  }

  _patchInto(parent, nodes, stop) {
    let cursor = parent.firstChild;
    for (let i = 0; i < nodes.length; ++i) {
      const want = nodes[i];
      if (!want) continue;
      if (cursor === want) {
        cursor = cursor.nextSibling;
        continue;
      }
      parent.insertBefore(want, cursor);
    }
    // 走到這裡，所有要留的列都已經排在 cursor 之前；cursor 到浮層之間的都是舊的。
    while (cursor && cursor !== stop) {
      const next = cursor.nextSibling;
      cursor.remove();
      cursor = next;
    }
  }

  // ------------------------------------------------------------- 尾端浮層
  // 兩顆浮動按鈕與 hover 圖片預覽住在 #mainContainer 尾端，位置固定、不參與列 diff。
  // 需要顯示的組合改變時整段重排（一次至多 3 個節點，且只在使用者操作時發生）。
  _syncOverlays(annotations, enhance) {
    // 浮動「圖文並排」按鈕：好讀文章頁且偵測到 ≥2 個「圖＋說明」塊才出現。純結構
    // 啟發式（見 image_caption_group.js），不確定那段字是不是翻譯 → opt-in 手動切換。
    const showMergeButton = !!(
      enhance &&
      enhance.easyReading &&
      enhance.pageState === PAGE_READING &&
      (annotations.imageCaptionBlockCount || 0) >= 2
    );
    // AI 校正鈕：再多兩個條件——設定啟用（預設關）＋模型 availability 為
    // 'available'。不支援／模型沒下載的環境（Firefox/Safari/未下載的 Chrome）
    // 連按鈕都不出現，行為與沒這功能時完全相同。
    this._probeAiAvailability(enhance);
    const showCaptionAiButton = !!(showMergeButton && this._aiReady);

    const wanted = [];
    if (showMergeButton) {
      if (!this._mergeButton) {
        this._mergeButton = createMergeImageCaptionButton(() =>
          this._toggleMergeCaption(),
        );
      }
      this._mergeButton.update(this._mergeCaption);
      wanted.push(this._mergeButton.el);
    }
    if (showCaptionAiButton) {
      if (!this._aiButton) {
        this._aiButton = createMergeImageCaptionAiButton(() =>
          this._toggleCaptionAi(),
        );
      }
      this._aiButton.update(
        this._captionAi,
        this._captionAi ? this._aiPending : 0,
      );
      wanted.push(this._aiButton.el);
    }
    if (this._hoverPreview !== undefined) {
      if (!this._hoverHost) this._hoverHost = el("div", null);
      wanted.push(this._hoverHost);
    }

    const same =
      wanted.length === this._overlayNodes.length &&
      wanted.every((n, i) => n === this._overlayNodes[i]);
    if (!same) {
      for (let i = 0; i < this._overlayNodes.length; ++i) {
        this._overlayNodes[i].remove();
      }
      for (let i = 0; i < wanted.length; ++i) {
        this.container.appendChild(wanted[i]);
      }
      this._overlayNodes = wanted;
    }
    this._syncHoverPreview();
  }

  _syncAiButton() {
    if (!this._aiButton) return;
    this._aiButton.update(
      this._captionAi,
      this._captionAi ? this._aiPending : 0,
    );
  }

  _syncHoverPreview() {
    if (this._hoverPreview === undefined) {
      if (this._hoverHost && this._hoverHost.isConnected) {
        unmountFrom(this._hoverHost);
        this._hoverHost.remove();
        this._overlayNodes = this._overlayNodes.filter(
          (n) => n !== this._hoverHost,
        );
      }
      return;
    }
    if (!this._hoverHost) this._hoverHost = el("div", null);
    if (!this._hoverHost.isConnected) {
      this.container.appendChild(this._hoverHost);
      this._overlayNodes.push(this._hoverHost);
    }
    renderInto(
      this._hoverHost,
      React.createElement(ImagePreviewer, {
        request: this._hoverPreview,
        component: ImagePreviewer.OnHover,
        left: this._hoverPos.left,
        top: this._hoverPos.top,
      }),
    );
  }

  // 可用性探測：只在設定啟用時查一次（availability() 不會觸發下載）。
  _probeAiAvailability(enhance) {
    const enabled = !!(enhance && enhance.captionAiEnabled);
    if (enabled === this._captionAiEnabledSeen) return;
    this._captionAiEnabledSeen = enabled;
    const token = ++this._availabilityToken;
    if (!enabled) {
      this._aiReady = false;
      return;
    }
    captionAiAvailability().then((a) => {
      if (token !== this._availabilityToken) return;
      const ready = a === "available";
      if (ready === this._aiReady) return;
      this._aiReady = ready;
      this._rerender();
    });
  }

  // 三套推論的簽章同步。收集 todo 的去重規則與舊版逐條相同。
  _syncAiTasks(annotations, enhance) {
    this._captionAiTask.sync(this._captionAi, annotations.captionSpansSig, () =>
      (annotations.captionSpans || []).filter(
        (s) => spanNeedsAi(s) && this._aiKeep[spanKey(s)] === undefined,
      ),
    );
    this._urlAiTask.sync(
      !!(enhance && enhance.urlAiEnabled),
      annotations.domainCandsSig,
      () => {
        const seen = new Set();
        return (annotations.domainCands || []).filter((c) => {
          const k = domainKey(c);
          if (seen.has(k) || this._aiLink[k] !== undefined) return false;
          seen.add(k); // 同一列在合併塊裡會出現兩次，只問一次
          return true;
        });
      },
    );
    this._fixAiTask.sync(
      !!(enhance && enhance.fixAiEnabled),
      annotations.fixCandsSig,
      () => {
        const seen = new Set();
        return (annotations.fixCands || []).filter((c) => {
          const k = fixKey(c);
          if (seen.has(k) || this._aiFix[k] !== undefined) return false;
          seen.add(k);
          return true;
        });
      },
    );
  }

  // 整列底色的快路徑：把 class 掛上／拿掉那一列的 bbsline span。合併推文塊會有
  // 多個同 data-row 的 bbsline（每行一個），全部一起處理。
  // cls 可能是**多個 class**（"cursorBrighten b2"：提亮與底色兩種樣式疊在同一列，
  // 見 js/cursor_highlight.cursorHighlightClasses）⇒ 必須拆 token 再進 classList，
  // 直接丟整串會噴 InvalidCharacterError（空字串同樣會噴，故一併濾掉）。
  _toggleRowClass(row, cls, on) {
    const tokens = String(cls || "")
      .split(/\s+/)
      .filter(Boolean);
    if (!tokens.length) return;
    const spans = this.container.querySelectorAll(
      `[data-type="bbsline"][data-row="${row}"]`,
    );
    for (let i = 0; i < spans.length; ++i) {
      if (on) spans[i].classList.add(...tokens);
      else spans[i].classList.remove(...tokens);
    }
  }

  // 一列的頂層節點 → 該掛 .pusherHighlight 的那個元素。合併推文塊的頂層是
  // div.mergedCommentBlock，class 要下在裡面那個 span[type="bbsrow"]（與
  // _buildRowNode 的合併分支交給 buildRow 的位置同一個）。
  _pusherRowTarget(node) {
    if (!node) return null;
    if (node.getAttribute && node.getAttribute("type") === "bbsrow")
      return node;
    return node.querySelector ? node.querySelector('[type="bbsrow"]') : null;
  }

  // 逐列把 .pusherHighlight 對帳到 _selectedPusher。只走推文列（ann.pusher 存在），
  // 長頁的內文列完全不碰。
  _syncPusherClasses() {
    const nodes = this._nodes;
    const anns = this._annotations || [];
    for (let row = 0; row < nodes.length; ++row) {
      const ann = anns[row];
      if (!ann || !ann.pusher) continue;
      // null ＝ 這一列不佔版面（dropHidden 移除／已併進合併塊）。
      const node = this._pusherRowTarget(nodes[row]);
      if (!node) continue;
      if (isPusherHighlighted(ann, this._selectedPusher)) {
        node.classList.add(PUSHER_HIGHLIGHT_CLASS);
      } else if (node.classList.contains(PUSHER_HIGHLIGHT_CLASS)) {
        node.classList.remove(PUSHER_HIGHLIGHT_CLASS);
        // classList.remove 會留下 class=""，而 el() 對 undefined 是**不輸出屬性**
        // （見 render/dom.js）⇒ 不清掉的話「切一次再切回來」與「從沒切過」的 DOM
        // 不等值：golden 快照與 outerHTML 節點重用比對都會失準。
        if (!node.className) node.removeAttribute("class");
      }
    }
    this._appliedPusher = this._selectedPusher;
  }
}

export default ScreenController;
