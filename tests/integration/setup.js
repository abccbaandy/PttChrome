// Node test env (no jsdom): pref_sync/pref_storage only touch
// window.localStorage, so a Map-backed shim is enough. jsdom is avoided on
// purpose — under it the Firestore browser build would speak WebChannel/XHR
// (flaky without a real browser); in the node env the SDK's node build
// speaks gRPC to the emulator instead.
const store = new Map();
global.window = {
  localStorage: {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
    clear: () => store.clear()
  }
};

// `yarn test:integration` (firebase emulators:exec) sets these; the fallbacks
// cover running `vitest run --project integration` directly against an
// already-running `firebase emulators:start`. Ports match firebase.json.
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || "demo-pttchrome";
process.env.FIREBASE_AUTH_EMULATOR_HOST =
  process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";
process.env.FIRESTORE_EMULATOR_HOST =
  process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8089";
