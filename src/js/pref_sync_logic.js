// Pure merge/sanitize logic for preference cloud sync (no DOM, no network) —
// unit-tested in tests/unit/pref_sync_logic.test.js. Side effects (Firebase
// SDK loading, auth, Firestore I/O) live in pref_sync.js.

// Strip fields that must never leave this machine before uploading.
// autoLoginPassword lives in the browser credential manager (see
// auto_login.js); even the legacy plaintext copy must not reach Firestore.
export const sanitizeForCloud = values => {
  const { autoLoginPassword, ...rest } = values;
  return rest;
};

// Merge cloud prefs over local ones: cloud wins for every synced key, the
// password always keeps the local value, and defaults backfill keys missing
// from both (schema evolution: an old cloud doc must not drop new prefs).
export const mergeCloudPrefs = (defaults, localValues, cloudPrefs) => ({
  ...defaults,
  ...localValues,
  ...cloudPrefs,
  autoLoginPassword: (localValues && localValues.autoLoginPassword) || ""
});
