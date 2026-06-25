// CDN-coupled dependency major-version guard.
//
// webpack.config.js externalises these libs via WebpackCdnPlugin and builds the
// CDN URL from the *installed* version (e.g. bootstrap@<installed>/dist/...).
// A major bump therefore silently swaps the asset the browser loads — and our
// other tests do NOT catch it:
//   - unit/integration run in node/jsdom and never load the CDN bundle;
//   - offline-e2e loads it in a real browser but the breakage is pure CSS
//     (react-bootstrap@0.31 emits Bootstrap-3 class names; Bootstrap 4/5 renamed
//     them, so widgets render unstyled but throw no error → suite stays green).
//
// This test pins the major of each CDN-externalised dep so an accidental major
// bump (e.g. a grouped dependabot PR) fails CI loudly instead of shipping a
// broken UI. When intentionally migrating a lib, bump the expected major here
// together with the migration work.
//
// Keep ALLOWED_MAJOR in sync with the `modules` list in webpack.config.js.
const ALLOWED_MAJOR = {
  // react-bootstrap@0.31 emits Bootstrap-3 markup; 4/5 renamed the CSS classes.
  bootstrap: 3,
  // react / react-dom / react-test-renderer / react-bootstrap are all on 16.
  react: 16,
  "react-dom": 16,
  jquery: 3,
  hammerjs: 2,
};

const majorOf = (pkg) =>
  parseInt(require(`${pkg}/package.json`).version.split(".")[0], 10);

describe("CDN-coupled deps stay on their supported major", () => {
  it.each(Object.entries(ALLOWED_MAJOR))(
    "%s is installed at major %i",
    (pkg, expectedMajor) => {
      expect(majorOf(pkg)).toBe(expectedMajor);
    }
  );
});
