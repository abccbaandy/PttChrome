// Unit tests for the pure Enhanced Add-on logic + Row rendering.
// E2E (tests/e2e/*.spec.js) is Playwright and is intentionally excluded here.
// babel-jest picks up the "test" env in package.json#babel (CommonJS modules).
module.exports = {
  testEnvironment: "node",
  setupFiles: ["<rootDir>/tests/unit/setup.js"],
  testMatch: ["**/tests/unit/**/*.test.js"]
};
