import HyperLink from "./HyperLink";
import ImagePreviewer, { requestPreview } from "../ImagePreviewer";

// One "auto-fixed URL" line, rendered BELOW the original article line (the original
// text is never rewritten — see src/js/url_fix.js). It is always a clickable link;
// the ImagePreviewer is always mounted and the resolver decides whether to auto-open
// (non-previewable / errored links render nothing, exactly like the normal inline
// preview path). requestPreview() is promise-cached so re-renders stay stable.
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
    <ImagePreviewer
      request={requestPreview(href)}
      component={ImagePreviewer.Inline}
    />
  </div>
);

export default FixedUrlLine;
