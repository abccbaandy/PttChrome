// Cloud-sync flow tests against the official Firebase Emulator Suite: the
// real modular SDK talking to local Auth/Firestore emulators, with the repo's
// firestore.rules enforced. Run via `yarn test:integration` (wraps
// `firebase emulators:exec`, which sets the *_EMULATOR_HOST / GCLOUD_PROJECT
// env both the tests and src/js/pref_sync.js key off). Requires Java (the
// Firestore emulator is a jar). Kept separate from jest.config.js so
// `yarn test:unit` stays fast and offline.
// Outer per-test guard must exceed the in-test poll deadline (POLL_DEADLINE_MS in
// tests/integration/pref_sync.test.js — derived from the same env), with room for a
// couple of sequential polls in one test.
const pollDeadline =
  Number(process.env.INTEGRATION_TIMEOUT_MS) ||
  (process.env.CI ? 30000 : 10000);

module.exports = {
  testEnvironment: "node",
  setupFiles: ["<rootDir>/tests/integration/setup.js"],
  testMatch: ["**/tests/integration/**/*.test.js"],
  testTimeout: pollDeadline * 2 + 10000
};
