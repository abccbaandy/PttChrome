import HyperLink from "./HyperLink";
import LazyInlinePreview from "../LazyInlinePreview";

// One "auto-fixed URL" line, rendered BELOW the original article line (the original
// text is never rewritten — see src/js/url_fix.js). It is always a clickable link;
// the preview is mounted lazily (LazyInlinePreview — 捲到附近才解析／載入，捲遠了
// 卸掉) and the resolver then decides whether to auto-open (non-previewable /
// errored links render nothing, exactly like the normal inline preview path).
export const FixedUrlLine = ({ href, onMouseOver, onMouseOut }) => (
  <div className="fixedUrlLine">
    <span className="fixedUrlLabel" title="自動修復的連結">
      ↳
    </span>
    <HyperLink
      href={href}
      inner={href}
      onMouseOver={onMouseOver}
      onMouseOut={onMouseOut}
    />
    <LazyInlinePreview href={href} />
  </div>
);

export default FixedUrlLine;
