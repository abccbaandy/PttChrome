import { Fragment } from "react";
import cx from "classnames";
import HyperLink from "./HyperLink";
import ColorSegmentBuilder from "./ColorSegmentBuilder";
import ImagePreviewer, { requestPreview } from "../ImagePreviewer";
import FixedUrlLine from "./FixedUrlLine";

// Comment lines are "推 userid: ...". The marker (推/噓/→) is a 2-column DBCS
// char (cols 0-1) and col 2 is the space before the user id — that gap is where
// the floor number is shown (matching the original script).
const FLOOR_BADGE_COL = 2;

export class LinkSegmentBuilder {
  constructor(
    row,
    enableLinkInlinePreview,
    forceWidth,
    highlighted,
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
  ) {
    this.row = row;
    this.forceWidth = forceWidth;
    this.highlighted = highlighted;
    this.onHyperLinkMouseOver = onHyperLinkMouseOver;
    this.onHyperLinkMouseOut = onHyperLinkMouseOut;
    this.floor = floor;
    // 註：合併塊的時間戳不走 React 節點——它是最後一則的原始 cell，直接併進
    // chars 尾端（見 comment_merge.js），所以這裡沒有額外分支。
    // Same-author (原PO) highlight: wrap cols [authorIdStart, authorIdEnd) — the
    // pusher's user id — in a .commentByAuthor span so only the id is tinted.
    // undefined → not a 原PO comment, skip all wrap logic.
    this.authorIdStart = authorIdStart;
    this.authorIdEnd = authorIdEnd;
    this._inAuthor = false;
    this._authorWrap = null;
    // X(Twitter) @handle auto-links: cols [startCol, endCol) of each VERIFIED
    // mention (src/js/mention_parse.js + x_handle_verify.js). Indexed by start
    // column; _mention holds the one currently being consumed so saveSegment wraps
    // it in an <a>. Like the URL href, a mention closes the current segment at its
    // boundaries — but it gets a plain .xMention link, no hover/inline preview.
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
    //
    this.segs = [];
    // Auto-fixed URLs (src/js/url_fix.js) render on extra lines below the article
    // line — only in easy-reading (inline-preview) mode, so the fixed 24-row native
    // grid keeps its alignment, identical to the auto-open-image gate.
    this.enableLinkInlinePreview = enableLinkInlinePreview;
    this.fixedUrls = fixedUrls;
    this.inlineLinkPreviews = enableLinkInlinePreview ? [] : false;
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
  // inside the user-id range, otherwise the row's top-level segment list.
  _pushSeg(node) {
    if (this._inAuthor) this._authorWrap.push(node);
    else this.segs.push(node);
  }

  // '\n' cell＝行邊界：收掉目前這行的 segs 與它的自動開圖，開新的一行。
  _flushLine() {
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
        <span key="authorId" className="commentByAuthor">
          {this._authorWrap}
        </span>,
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
        <a
          key={`m${this.col}`}
          className="xMention"
          href={this._mention.href}
          rel="noreferrer"
          target="_blank"
        >
          {element}
        </a>,
      );
    } else if (this._aid) {
      // AID → in-app navigation link; preventDefault keeps the # href inert.
      const aid = this._aid;
      this._pushSeg(
        <a
          key={`a${this.col}`}
          className="aidLink"
          href="#"
          title={`跳至文章 #${aid.aid}${aid.board ? ` (${aid.board})` : ""}`}
          onClick={(e) => {
            e.preventDefault();
            if (aid.onClick) aid.onClick();
          }}
        >
          {element}
        </a>,
      );
    } else if (this._giveaway) {
      // Steamgifts giveaway 代碼 → 外部連結（無 slug，站方自動 redirect）。
      this._pushSeg(
        <a
          key={`g${this.col}`}
          className="sgGiveawayLink"
          href={this._giveaway.href}
          title="Steamgifts giveaway"
          rel="noreferrer"
          target="_blank"
        >
          {element}
        </a>,
      );
    } else if (this._bareDomain) {
      // 裸網域 → 原位外部連結。掛 hover 預覽（圖床裸網域仍可預覽；非圖 resolver
      // 自然 reject），但**不推** inline ImagePreviewer——裸網域絕大多數不是圖，
      // 每個都試著開圖只會製造無謂的請求（與 X mention 同樣的取捨）。
      this._pushSeg(
        <a
          key={`b${this.col}`}
          className="bareDomainLink"
          href={this._bareDomain.href}
          title={this._bareDomain.href}
          rel="noreferrer"
          target="_blank"
          onMouseOver={this.onHyperLinkMouseOver}
          onMouseOut={this.onHyperLinkMouseOut}
        >
          {element}
        </a>,
      );
    } else if (this.href) {
      this._pushSeg(
        <HyperLink
          key={this.col}
          href={this.href}
          inner={element}
          data-scol={this.col}
          data-srow={this.row}
          onMouseOver={this.onHyperLinkMouseOver}
          onMouseOut={this.onHyperLinkMouseOut}
        />,
      );
      // TODO: Modularize this.
      if (this.inlineLinkPreviews) {
        this.inlineLinkPreviews.push(
          <ImagePreviewer
            key={`${this.col}-${this.href}`}
            request={requestPreview(this.href)}
            component={ImagePreviewer.Inline}
          />,
        );
      }
    } else {
      this._pushSeg(<span key={this.col}>{element}</span>);
    }
    this.colorSegBuilder = null;
  }

  // 徽章是零寬盒（不位移等寬格線），數字包一層 .floorBadgeNum 供 CSS 以
  // translateX(-100%) 靠「作者 id 起始欄」向左生長 → 3 位數以上往推/噓/→ 標記字
  // 方向溢出，作者 id 永遠不被蓋（見 main.css .floorBadge）。--wide 給高位數補深色底。
  floorBadge() {
    const f = this.floor;
    const text = String(f.seq);
    return (
      <span
        key="floor"
        className={cx("floorBadge", { "floorBadge--wide": text.length >= 3 })}
        data-floor
        title={`第${f.seq}樓 ${f.type}${f.sub}`}
      >
        <span className="floorBadgeNum">{text}</span>
      </span>
    );
  }

  readChar(ch, i) {
    // 行邊界（合併塊的合成 cell）：不進 segment——換行改由 DOM 的區塊邊界表達，
    // 這樣每行的自動開圖才有地方掛（見 _flushLine / build）。
    if (ch.ch === "\n") {
      if (this.colorSegBuilder !== null) this.saveSegment();
      if (this._inAuthor) this._flushAuthorWrap();
      this._flushLine();
      return;
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
    if (this.colorSegBuilder !== null && ch.isStartOfURL()) {
      this.saveSegment();
    }
    if (this.colorSegBuilder === null) {
      this.colorSegBuilder = new ColorSegmentBuilder(this.forceWidth);
      this.col = i;
      this.href = ch.isStartOfURL() ? ch.getFullURL() : null;
    }
    this.colorSegBuilder.readChar(ch);
    if (ch.isEndOfURL()) {
      this.saveSegment();
    }
  }

  build() {
    if (this.colorSegBuilder !== null) {
      this.saveSegment();
    }
    // Safety net: a user id running to the end of the line never gets its close
    // boundary, so flush any still-open wrapper here.
    if (this._inAuthor) this._flushAuthorWrap();
    if (this.lineGroups.length) {
      // 多行：每行輸出一組「bbsline span ＋ 該行的自動開圖 div」，與單行結構同形。
      // 預覽 div 即使是空的也照樣輸出——它是區塊盒，正好把下一行的 inline 內容擠到
      // 新的一行（單行路徑本來就這樣做），所以不需要額外的包裝層。
      this._flushLine();
      return (
        <div>
          {this.lineGroups.map((g, i) => (
            <Fragment key={i}>
              <span
                className={cx({ b2: this.highlighted })}
                data-type="bbsline"
                data-row={this.row}
              >
                {g.segs}
              </span>
              <div>{g.previews}</div>
            </Fragment>
          ))}
          {this.enableLinkInlinePreview &&
            this.fixedUrls &&
            this.fixedUrls.length > 0 &&
            this.fixedUrls.map(({ fixed }, i) => (
              <FixedUrlLine
                key={`fix-${i}-${fixed}`}
                href={fixed}
                onMouseOver={this.onHyperLinkMouseOver}
                onMouseOut={this.onHyperLinkMouseOut}
              />
            ))}
        </div>
      );
    }
    return (
      <div>
        <span
          className={cx({ b2: this.highlighted })}
          data-type="bbsline"
          data-row={this.row}
        >
          {this.segs}
        </span>
        <div>{this.inlineLinkPreviews}</div>
        {this.enableLinkInlinePreview &&
          this.fixedUrls &&
          this.fixedUrls.length > 0 &&
          this.fixedUrls.map(({ fixed }, i) => (
            <FixedUrlLine
              key={`fix-${i}-${fixed}`}
              href={fixed}
              onMouseOver={this.onHyperLinkMouseOver}
              onMouseOut={this.onHyperLinkMouseOut}
            />
          ))}
      </div>
    );
  }
}

LinkSegmentBuilder.accumulator = (builder, ch, i) => {
  builder.readChar(ch, i);
  return builder;
};

export default LinkSegmentBuilder;
