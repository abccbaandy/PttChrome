// 一列的「範圍型裝飾」組裝：把 TermChar[] 切成一段段，替每一段決定要不要包成
// <a>（URL／X mention／AID／Steamgifts 代碼／裸網域）、要不要插樓層徽章、要不要包
// 原PO id 或部分底色的 wrapper，最後吐出這一列的 DOM。
//
// 原 src/components/Row/LinkSegmentBuilder.jsx（含 HyperLink / FixedUrlLine 兩個
// 小元件）的純 JS 版。狀態機與邊界判定一字未改，只有產物從 React element 換成
// DOM 節點；所有 class / data-* 都是外部契約，見 CLAUDE.md 與 golden。
import cx from "classnames";
import { el } from "./dom";
import { isDBCSLead } from "../js/string_util";
import ColorSegmentBuilder from "./color_segment";
import { createInlinePreviewSlot } from "./inline_preview_slot";

// Comment lines are "推 userid: ...". The marker (推/噓/→) is a 2-column DBCS
// char (cols 0-1) and col 2 is the space before the user id — that gap is where
// the floor number is shown (matching the original script).
const FLOOR_BADGE_COL = 2;

// 超連結錨點。class="y" 是舊版 HyperLink 的產物，main.css 與 pttchrome 的
// isAnchorTarget（closest('a')）都吃它。
function hyperLink(href, inner, onMouseOver, onMouseOut) {
  const a = el(
    "a",
    { class: "y", href, rel: "noreferrer", target: "_blank" },
    inner,
  );
  if (onMouseOver) a.addEventListener("mouseover", onMouseOver);
  if (onMouseOut) a.addEventListener("mouseout", onMouseOut);
  return a;
}

// 一條「自動修復的連結」，渲染在原文那一列**下面**（原文永遠不改寫，見
// src/js/url_fix.js）。它一定是可點的連結；預覽走延遲載入（捲到附近才解析／載入，
// 捲遠了卸掉），resolver 再決定要不要自動開圖（不可預覽／失敗的連結什麼都不畫，
// 與一般的自動開圖路徑相同）。
function fixedUrlLine(href, onMouseOver, onMouseOut, slots, sizeMode) {
  const slot = createInlinePreviewSlot(href, sizeMode);
  slots.push(slot);
  return el("div", { class: "fixedUrlLine" }, [
    el("span", { class: "fixedUrlLabel", title: "自動修復的連結" }, "↳"),
    hyperLink(href, href, onMouseOver, onMouseOut),
    slot.el,
  ]);
}

export class LinkSegmentBuilder {
  constructor(
    row,
    enableLinkInlinePreview,
    forceWidth,
    highlightClass,
    highlightColStart,
    onHyperLinkMouseOver,
    onHyperLinkMouseOut,
    floor,
    authorIdStart,
    authorIdEnd,
    fixedUrls,
    mentions,
    aids,
    giveaways,
    bareDomains,
    sizeMode,
    fnKeys,
  ) {
    this.row = row;
    this.forceWidth = forceWidth;
    // 游標底色 class（'b1'..'b15'）或 undefined＝這一列不上色。顏色由 pref 決定，
    // 決策與對映都在 js/cursor_highlight.js —— 這裡**不可以**再硬寫 b2。
    this.highlightClass = highlightClass;
    // 底色從第幾欄畫起（0/undefined＝整列，DOM 與 2026-08 之前一字不動）。>0 時
    // 底色改掛在一個從該欄包到行尾的 span 上，class **不**掛在 bbsline span ——
    // 那是 block 級元素，掛上去就是滿版。範圍與可點區同源（防誤觸模式，見
    // js/mouse_regions.clickableColStart），三種範圍（列表標題欄／選單選項欄／
    // 推文內容欄）都是「到行尾」⇒ 只有開邊界、沒有關邊界。
    // 沒有底色 class 就沒有包裝的必要（也不該憑空多切一段 segment 出來）。
    this.highlightColStart =
      highlightClass && highlightColStart > 0 ? highlightColStart : 0;
    this._inHighlight = false;
    this._highlightWrap = null;
    // 前一格是不是 DBCS lead byte ⇒ **這一格是 trail**，切段切在這裡會把字拆掉
    // （見 readChar 的開邊界）。判定與 ColorSegmentBuilder 同一套**交替狀態**
    // （單看位元組值不夠，理由見 readChar 結尾），不看 ch.isLeadByte —— 那個旗標
    // 由 term_buf.updateCharAttr 標，不保證都在。
    this._prevWasLead = false;
    this.onHyperLinkMouseOver = onHyperLinkMouseOver;
    this.onHyperLinkMouseOut = onHyperLinkMouseOut;
    this.floor = floor;
    // 註：合併塊的時間戳不走額外節點——它是最後一則的原始 cell，直接併進 chars
    // 尾端（見 comment_merge.js），所以這裡沒有額外分支。
    // Same-author (原PO) highlight: wrap cols [authorIdStart, authorIdEnd) — the
    // pusher's user id — in a .commentByAuthor span so only the id is tinted.
    // undefined → not a 原PO comment, skip all wrap logic.
    this.authorIdStart = authorIdStart;
    this.authorIdEnd = authorIdEnd;
    this._inAuthor = false;
    this._authorWrap = null;
    // X(Twitter) @handle auto-links: cols [startCol, endCol) of each mention
    // (src/js/mention_parse.js). Indexed by start column; _mention holds the one
    // currently being consumed so saveSegment wraps it in an <a>. Like the URL
    // href, a mention closes the current segment at its boundaries — but it gets
    // a plain .xMention link, no hover/inline preview.
    this._mentionStart = null;
    if (mentions && mentions.length) {
      this._mentionStart = new Map();
      for (let k = 0; k < mentions.length; ++k) {
        this._mentionStart.set(mentions[k].startCol, mentions[k]);
      }
    }
    this._mention = null;
    // PTT article-code (AID) links: cols [startCol, endCol) of each #XXXXXXXX
    // token (src/js/aid_parse.js). Same boundary mechanics as mentions, but the
    // click navigates in-app (aid.onClick) instead of opening a new tab.
    this._aidStart = null;
    if (aids && aids.length) {
      this._aidStart = new Map();
      for (let k = 0; k < aids.length; ++k) {
        this._aidStart.set(aids[k].startCol, aids[k]);
      }
    }
    this._aid = null;
    // Steamgifts giveaway 代碼連結：cols [startCol, endCol) of each stand-alone
    // 5-char code (src/js/steamgifts_parse.js). Same boundary mechanics as
    // mentions — plain external link, new tab.
    this._giveawayStart = null;
    if (giveaways && giveaways.length) {
      this._giveawayStart = new Map();
      for (let k = 0; k < giveaways.length; ++k) {
        this._giveawayStart.set(giveaways[k].startCol, giveaways[k]);
      }
    }
    this._giveaway = null;
    // 裸網域自動連結（src/js/bare_domain.js）：cols [startCol, endCol) of each
    // scheme-less、path-less 網域。同樣的開/關邊界機制，但**原位**變成連結（不像
    // fixedUrls 另起一行）→ 原生 24 列 grid 的對齊不受影響，兩個模式都能用。
    this._bareDomainStart = null;
    if (bareDomains && bareDomains.length) {
      this._bareDomainStart = new Map();
      for (let k = 0; k < bareDomains.length; ++k) {
        this._bareDomainStart.set(bareDomains[k].startCol, bareDomains[k]);
      }
    }
    this._bareDomain = null;
    // 功能鍵按鈕（src/js/footer_keys.js）：cols [startCol, endCol) of each
    // `[d]` / `(y)` / `(^X)` token（範圍**含括號**，所以邊界必落在 ASCII 格上，
    // 不可能切在 DBCS 的 trail cell 中間）。開/關邊界機制與 mention 完全相同。
    //
    // 用 <a> 是**刻意**的：pttchrome 的 App.mouse_click 有一條 isAnchorTarget 早退
    // （優先權第 4 條，見 docs/mouse.md），它讓功能鍵自動贏過所有滑鼠瀏覽分支
    // ⇒ App.mouse_click 一行都不用改。
    this._fnKeyStart = null;
    if (fnKeys && fnKeys.length) {
      this._fnKeyStart = new Map();
      for (let k = 0; k < fnKeys.length; ++k) {
        this._fnKeyStart.set(fnKeys[k].startCol, fnKeys[k]);
      }
    }
    this._fnKey = null;
    //
    this.segs = [];
    // Auto-fixed URLs (src/js/url_fix.js) render on extra lines below the article
    // line — only in easy-reading (inline-preview) mode, so the fixed 24-row native
    // grid keeps its alignment, identical to the auto-open-image gate.
    this.enableLinkInlinePreview = enableLinkInlinePreview;
    this.fixedUrls = fixedUrls;
    this.inlineLinkPreviews = enableLinkInlinePreview ? [] : false;
    // 這一列建立的延遲載入佔位盒。列被換掉時 renderer 必須逐一 destroy()，
    // 否則 IntersectionObserver / ResizeObserver / React root 全部留著。
    this.slots = [];
    this.sizeMode = sizeMode || "normal";
    // 多行 row（目前只有好讀的推文合併塊：chars 內含 '\n' cell）→ 逐行切成獨立的
    // bbsline 群組，每行的自動開圖接在**該行**下面（跟文章內文一樣），而不是全部
    // 堆到整塊最後（使用者 2026-08 回報）。單行 row 走原本的結構，DOM 一字不動。
    this.lineGroups = [];
    //
    this.colorSegBuilder = null;
    this.col = null;
    this.href = null;
  }

  // Push a built segment to the current target: the author-id wrapper while
  // inside the user-id range, then the partial-highlight wrapper while inside
  // the tinted column range, otherwise the row's top-level segment list.
  // 兩個包裝不會重疊：作者 id 在 cols [3, 3+len)，而部分底色的三種起始欄都在它右邊
  // （推文內容欄）或在完全不同的畫面上（列表／選單）。
  _pushSeg(node) {
    if (this._inAuthor) this._authorWrap.push(node);
    else if (this._inHighlight) this._highlightWrap.push(node);
    else this.segs.push(node);
  }

  // 部分底色包裝收尾：把 [highlightColStart, 行尾) 的段落包成一個帶底色 class 的
  // span。build() 與 _flushLine()（合併推文塊的行邊界）都會呼叫。
  _flushHighlightWrap() {
    if (this._highlightWrap && this._highlightWrap.length) {
      // .cursorHighlight 只是**識別用**的標記（沒有樣式）：底色 class 本身是 b1..b15，
      // 而那些同時也是 ANSI 背景色的 class ⇒ 光看 bN 分不出「這是光棒」還是「這格
      // 本來就有底色」。測試與除錯靠這個標記定位光棒。
      this.segs.push(
        el(
          "span",
          { class: cx("cursorHighlight", this.highlightClass) },
          this._highlightWrap,
        ),
      );
    }
    this._highlightWrap = null;
    this._inHighlight = false;
  }

  // '\n' cell＝行邊界：收掉目前這行的 segs 與它的自動開圖，開新的一行。
  _flushLine() {
    if (this._inHighlight) this._flushHighlightWrap();
    this.lineGroups.push({
      segs: this.segs,
      previews: this.inlineLinkPreviews,
    });
    this.segs = [];
    this.inlineLinkPreviews = this.enableLinkInlinePreview ? [] : false;
  }

  _flushAuthorWrap() {
    if (this._authorWrap && this._authorWrap.length) {
      this.segs.push(
        el("span", { class: "commentByAuthor" }, this._authorWrap),
      );
    }
    this._authorWrap = null;
    this._inAuthor = false;
  }

  saveSegment() {
    const element = this.colorSegBuilder.build();
    if (this._mention) {
      // X mention → plain external link (X-blue via .xMention), no ImagePreviewer.
      this._pushSeg(
        el(
          "a",
          {
            class: "xMention",
            href: this._mention.href,
            rel: "noreferrer",
            target: "_blank",
          },
          element,
        ),
      );
    } else if (this._aid) {
      // AID → in-app navigation link; preventDefault keeps the # href inert.
      // data-aid / data-board 是給右鍵選單用的：那個 href="#" 只是佔位，右鍵端
      // 必須靠 className + 這兩個屬性才認得出「這是文章代碼，不是一條網址」。
      // board 可能是空字串（沒寫看板的 #AID）⇒ 右鍵端用目前文章的看板遞補。
      const aid = this._aid;
      const a = el(
        "a",
        {
          class: "aidLink",
          href: "#",
          "data-aid": aid.aid,
          "data-board": aid.board || "",
          title: `跳至文章 #${aid.aid}${aid.board ? ` (${aid.board})` : ""}`,
        },
        element,
      );
      a.addEventListener("click", (e) => {
        e.preventDefault();
        if (aid.onClick) aid.onClick();
      });
      this._pushSeg(a);
    } else if (this._giveaway) {
      // Steamgifts giveaway 代碼 → 外部連結（無 slug，站方自動 redirect）。
      this._pushSeg(
        el(
          "a",
          {
            class: "sgGiveawayLink",
            href: this._giveaway.href,
            title: "Steamgifts giveaway",
            rel: "noreferrer",
            target: "_blank",
          },
          element,
        ),
      );
    } else if (this._bareDomain) {
      // 裸網域 → 原位外部連結。掛 hover 預覽（圖床裸網域仍可預覽；非圖 resolver
      // 自然 reject），但**不推** inline 預覽——裸網域絕大多數不是圖，每個都試著
      // 開圖只會製造無謂的請求（與 X mention 同樣的取捨）。
      const a = el(
        "a",
        {
          class: "bareDomainLink",
          href: this._bareDomain.href,
          title: this._bareDomain.href,
          rel: "noreferrer",
          target: "_blank",
        },
        element,
      );
      if (this.onHyperLinkMouseOver)
        a.addEventListener("mouseover", this.onHyperLinkMouseOver);
      if (this.onHyperLinkMouseOut)
        a.addEventListener("mouseout", this.onHyperLinkMouseOut);
      this._pushSeg(a);
    } else if (this._fnKey) {
      // 功能鍵 → 送出那個按鍵。href="#" **一定要 preventDefault**：本 app 用 URL
      // hash 做 deep link（docs/deep-link.md），漏掉會塞垃圾 hash 甚至觸發跳文解析。
      //
      // onClick 閉包**只捕捉靜態資料**（keyBytes / label ＋ 那個引用穩定的
      // enhance.onFunctionKey）。捕捉任何逐幀狀態都會踩到 render/screen.js 的
      // outerHTML 節點重用：重建出來的節點因 HTML 相同被丟棄、留下舊閉包
      // ⇒「按鈕點了送到上一幀的東西」，且完全看不出來。
      //
      // 這個 <a> **不得插入任何文字節點**：term_view.countCol 遞迴累加
      // u2b(textContent).length，多一個字就讓選取／ANSI 複製的 col 反查錯位
      // （title 屬性不算文字節點，可以放）。
      const fnKey = this._fnKey;
      const a = el(
        "a",
        {
          class: "fnKey",
          href: "#",
          "data-fnkey": fnKey.label,
          title: `按 ${fnKey.label}`,
        },
        element,
      );
      a.addEventListener("click", (e) => {
        e.preventDefault();
        if (fnKey.onClick) fnKey.onClick();
      });
      this._pushSeg(a);
    } else if (this.href) {
      this._pushSeg(
        hyperLink(
          this.href,
          element,
          this.onHyperLinkMouseOver,
          this.onHyperLinkMouseOut,
        ),
      );
      // 延遲載入：捲到附近才解析網址並掛預覽，捲遠了再卸掉釋放已解碼的點陣圖
      // （見 inline_preview_slot.js / lazy_media.js）。長文一次 287 張圖全部載入
      // 且永不釋放，正是「記憶體吃滿」的來源。
      if (this.inlineLinkPreviews) {
        const slot = createInlinePreviewSlot(this.href, this.sizeMode);
        this.slots.push(slot);
        this.inlineLinkPreviews.push(slot.el);
      }
    } else {
      this._pushSeg(el("span", null, element));
    }
    this.colorSegBuilder = null;
  }

  // 徽章是零寬盒（不位移等寬格線），數字包一層 .floorBadgeNum 供 CSS 以
  // translateX(-100%) 靠「作者 id 起始欄」向左生長 → 3 位數以上往推/噓/→ 標記字
  // 方向溢出，作者 id 永遠不被蓋（見 main.css .floorBadge）。--wide 給高位數補深色底。
  floorBadge() {
    const f = this.floor;
    const text = String(f.seq);
    return el(
      "span",
      {
        class: cx("floorBadge", { "floorBadge--wide": text.length >= 3 }),
        // JSX 的布林簡寫 `data-floor` 在 React 下輸出 data-floor="true"。
        "data-floor": "true",
        title: `第${f.seq}樓 ${f.type}${f.sub}`,
      },
      el("span", { class: "floorBadgeNum" }, text),
    );
  }

  readChar(ch, i) {
    // 行邊界（合併塊的合成 cell）：不進 segment——換行改由 DOM 的區塊邊界表達，
    // 這樣每行的自動開圖才有地方掛（見 _flushLine / build）。
    if (ch.ch === "\n") {
      if (this.colorSegBuilder !== null) this.saveSegment();
      if (this._inAuthor) this._flushAuthorWrap();
      // 範圍型連結（mention/AID/giveaway/裸網域）的關閉邊界是 `i === endCol`，而
      // 這個 return 走在那些檢查**之前** ⇒ endCol 剛好落在換行 cell 上時永遠關不掉，
      // 狀態外溢到後續每一行（合併塊整塊被畫底線，使用者 2026-08 回報）。
      // comment_merge 會剝掉每則的行尾空白，所以「範圍結束＝換行前一格」是常態。
      // 上面的 saveSegment() 之後才清：那一段仍要用當下的狀態包成正確的 <a>。
      // 這些候選的字元類都不含 '\n'，範圍不可能跨越換行 ⇒ 無條件清空是安全的。
      this._mention = null;
      this._aid = null;
      this._giveaway = null;
      this._bareDomain = null;
      this._fnKey = null;
      this._prevWasLead = false;
      this._flushLine();
      return;
    }
    // 切點落在雙寬字的 **trail cell** 上時往後推一格（整個字留在底色外）。
    // 直接切下去的後果：ColorSegmentBuilder 的 `lead` 是 per-segment 狀態，待配對的
    // lead byte 會隨舊 builder 被丟棄，trail byte 再在新 builder 裡被當成 ASCII 畫出來
    // ⇒「自動搜尋」變「自動搜M」，該字從 2 格縮成 1 格、後面整段左移、游標錯位
    // （使用者 2026-08 回報：看板列表按 s 的搜尋畫面，底色起始欄 30 正好是「尋」的
    // trail）。底色起始欄是與內容無關的固定欄號，只有它會踩到；mention／AID／
    // giveaway／功能鍵／作者 id 的邊界依定義都落在 ASCII 格上。
    // 守護：tests/unit/highlight_col_dbcs.test.js。
    if (
      this.highlightColStart > 0 &&
      i === this.highlightColStart &&
      this._prevWasLead
    ) {
      this.highlightColStart = i + 1;
    }
    // 部分底色的開邊界：從這一欄起到行尾都包進帶底色的 span。
    if (this.highlightColStart > 0 && i === this.highlightColStart) {
      if (this.colorSegBuilder !== null) this.saveSegment();
      this._inHighlight = true;
      this._highlightWrap = [];
    }
    // Open the 原PO id wrapper at the first column of the user id. floor (col 2)
    // is inserted before this, so it stays outside the wrapper.
    if (this.authorIdStart !== undefined && i === this.authorIdStart) {
      if (this.colorSegBuilder !== null) this.saveSegment();
      this._inAuthor = true;
      this._authorWrap = [];
    }
    // Close it once we move past the id (this column is no longer the user id).
    if (this._inAuthor && i === this.authorIdEnd) {
      if (this.colorSegBuilder !== null) this.saveSegment();
      this._flushAuthorWrap();
    }
    // Insert the floor number into the gap before the user id (inside the line).
    if (this.floor && i === FLOOR_BADGE_COL && !this._floorInserted) {
      if (this.colorSegBuilder !== null) this.saveSegment();
      this._pushSeg(this.floorBadge());
      this._floorInserted = true;
    }
    // X mention boundaries: close the current segment when leaving a mention range
    // (so it gets wrapped as <a>) and again when entering one (so the prefix text
    // doesn't). _mention stays set through the handle's columns; saveSegment reads
    // it. Mentions live in body/comment text, away from the floor/author columns,
    // so they don't overlap those wrappers.
    if (this._mention && i === this._mention.endCol) {
      if (this.colorSegBuilder !== null) this.saveSegment();
      this._mention = null;
    }
    if (this._mentionStart !== null && this._mentionStart.has(i)) {
      if (this.colorSegBuilder !== null) this.saveSegment();
      this._mention = this._mentionStart.get(i);
    }
    // AID link boundaries — same open/close dance as mentions above.
    if (this._aid && i === this._aid.endCol) {
      if (this.colorSegBuilder !== null) this.saveSegment();
      this._aid = null;
    }
    if (this._aidStart !== null && this._aidStart.has(i)) {
      if (this.colorSegBuilder !== null) this.saveSegment();
      this._aid = this._aidStart.get(i);
    }
    // Steamgifts giveaway 代碼邊界 — same open/close dance as mentions above.
    if (this._giveaway && i === this._giveaway.endCol) {
      if (this.colorSegBuilder !== null) this.saveSegment();
      this._giveaway = null;
    }
    if (this._giveawayStart !== null && this._giveawayStart.has(i)) {
      if (this.colorSegBuilder !== null) this.saveSegment();
      this._giveaway = this._giveawayStart.get(i);
    }
    // 裸網域邊界 — same open/close dance as mentions above. bare_domain.js 已排除
    // 落在 uriRegEx 標記範圍內的候選，所以與下方的 isStartOfURL 分支不會重疊。
    if (this._bareDomain && i === this._bareDomain.endCol) {
      if (this.colorSegBuilder !== null) this.saveSegment();
      this._bareDomain = null;
    }
    if (this._bareDomainStart !== null && this._bareDomainStart.has(i)) {
      if (this.colorSegBuilder !== null) this.saveSegment();
      this._bareDomain = this._bareDomainStart.get(i);
    }
    // 功能鍵邊界 — same open/close dance as mentions above.
    if (this._fnKey && i === this._fnKey.endCol) {
      if (this.colorSegBuilder !== null) this.saveSegment();
      this._fnKey = null;
    }
    if (this._fnKeyStart !== null && this._fnKeyStart.has(i)) {
      if (this.colorSegBuilder !== null) this.saveSegment();
      this._fnKey = this._fnKeyStart.get(i);
    }
    if (this.colorSegBuilder !== null && ch.isStartOfURL()) {
      this.saveSegment();
    }
    if (this.colorSegBuilder === null) {
      this.colorSegBuilder = new ColorSegmentBuilder(this.forceWidth);
      this.col = i;
      this.href = ch.isStartOfURL() ? ch.getFullURL() : null;
    }
    this.colorSegBuilder.readChar(ch);
    // 交替狀態，**不可**寫成 `isDBCSLead(ch.ch)`：Big5 的 trail byte 有一半
    // （0xA1..0xFE）與 lead 值域重疊 ⇒ 連續中文字時每一格都被當成 lead，開邊界的
    // +1 會一路連鎖右移，直到撞上 trail byte < 0x81 的字才停（使用者 2026-08-23
    // 回報的看板列表：底色該從 col 30「火」起，卻推到「北」＝少三個字）。
    // 上一格是 lead ⇒ 這一格必是它的 trail，不可能同時是下一個字的 lead。
    // 判定與 ColorSegmentBuilder 的 `this.lead` 同一套。
    this._prevWasLead = !this._prevWasLead && isDBCSLead(ch.ch);
    if (ch.isEndOfURL()) {
      this.saveSegment();
    }
  }

  _fixedUrlLines() {
    const out = [];
    if (
      this.enableLinkInlinePreview &&
      this.fixedUrls &&
      this.fixedUrls.length > 0
    ) {
      for (let i = 0; i < this.fixedUrls.length; ++i) {
        out.push(
          fixedUrlLine(
            this.fixedUrls[i].fixed,
            this.onHyperLinkMouseOver,
            this.onHyperLinkMouseOut,
            this.slots,
            this.sizeMode,
          ),
        );
      }
    }
    return out;
  }

  build() {
    if (this.colorSegBuilder !== null) {
      this.saveSegment();
    }
    // Safety net: a user id running to the end of the line never gets its close
    // boundary, so flush any still-open wrapper here.
    if (this._inAuthor) this._flushAuthorWrap();
    // 部分底色**只有開邊界**（一律包到行尾）⇒ 這裡才是它的收尾點。
    if (this._inHighlight) this._flushHighlightWrap();
    if (this.lineGroups.length) {
      // 多行：每行輸出一組「bbsline span ＋ 該行的自動開圖 div」，與單行結構同形。
      // 預覽 div 即使是空的也照樣輸出——它是區塊盒，正好把下一行的 inline 內容擠到
      // 新的一行（單行路徑本來就這樣做），所以不需要額外的包裝層。
      this._flushLine();
      const children = [];
      for (let i = 0; i < this.lineGroups.length; ++i) {
        const g = this.lineGroups[i];
        children.push(
          el(
            "span",
            {
              class: cx(this.highlightColStart ? null : this.highlightClass),
              "data-type": "bbsline",
              "data-row": this.row,
            },
            g.segs,
          ),
        );
        children.push(el("div", null, g.previews));
      }
      children.push(this._fixedUrlLines());
      return el("div", null, children);
    }
    return el("div", null, [
      el(
        "span",
        {
          class: cx(this.highlightColStart ? null : this.highlightClass),
          "data-type": "bbsline",
          "data-row": this.row,
        },
        this.segs,
      ),
      el("div", null, this.inlineLinkPreviews),
      this._fixedUrlLines(),
    ]);
  }
}

LinkSegmentBuilder.accumulator = (builder, ch, i) => {
  builder.readChar(ch, i);
  return builder;
};

export default LinkSegmentBuilder;
