// Pure merge/sanitize logic for preference cloud sync (no DOM, no network) —
// unit-tested in tests/unit/pref_sync_logic.test.js. Side effects (Firebase
// SDK loading, auth, Firestore I/O) live in pref_sync.js.

// Strip fields that must never leave this machine before uploading.
// Credentials live in the browser credential manager (see auto_login.js):
// the password obviously must not reach Firestore, and the username is
// local-only too — devices clear it once the browser store is proven, so a
// synced copy would propagate that "" and break legacy login on devices
// without the Credential Management API (Firefox/Safari).
export const sanitizeForCloud = values => {
  const { autoLoginPassword, autoLoginUser, ...rest } = values;
  return rest;
};

// Merge cloud prefs over local ones: cloud wins for every synced key, the
// credentials always keep the local value (also neutralizes legacy cloud
// docs that still carry autoLoginUser), and defaults backfill keys missing
// from both (schema evolution: an old cloud doc must not drop new prefs).
export const mergeCloudPrefs = (defaults, localValues, cloudPrefs) => ({
  ...defaults,
  ...localValues,
  ...cloudPrefs,
  autoLoginUser: (localValues && localValues.autoLoginUser) || "",
  autoLoginPassword: (localValues && localValues.autoLoginPassword) || ""
});

// Deep equality that ignores object key order. JSON.stringify comparison
// false-positives here: Firestore returns map fields with unspecified key
// order, so a round-tripped termSize {cols,rows} can come back {rows,cols}.
export const deepEqual = (a, b) => {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(k => deepEqual(a[k], b[k]));
};

// Decide what to do with a Firestore snapshot (realtime listener in
// pref_sync.js). Pure so the offline/echo edge cases stay unit-testable:
//   skip-echo            — our own set() reflected back (latency compensation)
//   skip-offline-missing — cache says "no doc" but the server hasn't been
//                          reached; pushing local here would overwrite the
//                          real cloud prefs once the connection returns
//   push-local           — server confirmed no doc: first sign-in, upload
//   merge                — cloud doc available, apply it (cloud wins)
export const classifySnapshot = ({
  exists,
  hasPendingWrites,
  fromCache,
  hasPrefs
}) => {
  if (hasPendingWrites) return "skip-echo";
  if (!exists || !hasPrefs) {
    return fromCache ? "skip-offline-missing" : "push-local";
  }
  return "merge";
};
