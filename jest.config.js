// Unit tests for the pure Enhanced Add-on logic + Row rendering.
// E2E (tests/e2e/*.spec.js) is Playwright and is intentionally excluded here.
// babel-jest picks up the "test" env in package.json#babel (CommonJS modules).
module.exports = {
  testEnvironment: "node",
  setupFiles: ["<rootDir>/tests/unit/setup.js"],
  testMatch: ["**/tests/unit/**/*.test.js"],
  // Webpack-only asset imports (cursor PNGs in term_buf, component CSS …) are not
  // JS; map them to a stub so DOM-coupled modules stay importable in unit tests.
  moduleNameMapper: {
    "\\.(png|gif|bmp|jpe?g|svg|css)$": "<rootDir>/tests/unit/asset_stub.js"
  }
};
