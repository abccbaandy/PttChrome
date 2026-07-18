// Preference cloud sync: Google sign-in (Firebase Auth) + per-user Firestore
// doc (users/{uid}). localStorage stays the source applied at startup; a
// realtime listener (onSnapshot) then keeps re-applying the cloud copy on
// top (cloud wins), so edits made on another device/tab land here live.
//
// SDK loading: npm modular SDK behind dynamic import() — Vite/Rolldown splits it
// into a lazy chunk, so nothing is downloaded until the user signs in (or
// has signed in before — see SYNC_FLAG_KEY). Tests run the real SDK against
// the local Firebase Emulator Suite (yarn test:integration), not a fake.

import { FIREBASE_CONFIG, RECAPTCHA_SITE_KEY } from "./firebase_config";
import {
  DEFAULT_PREFS,
  readValuesWithDefault,
  writeValues
} from "./pref_storage";
import {
  sanitizeForCloud,
  mergeCloudPrefs,
  classifySnapshot,
  deepEqual
} from "./pref_sync_logic";

// Set after the first successful sign-in so the next startup knows to load
// the SDK and restore the session; cleared on sign-out. Keeping it separate
// from the prefs blob means signed-out users never pay the SDK download.
const SYNC_FLAG_KEY = "pttchrome.prefsync.enabled";

let loadPromise = null;
// { app, auth, db, authM, fsM } once loadPromise resolves; savePrefs reads it
// synchronously (currentUser != null implies the SDK finished loading).
let fb = null;
let currentUser = null;
// False until Firebase answers the first onAuthStateChanged — before that,
// currentUser === null only means "don't know yet", not "signed out".
let authStateKnown = false;
const authStateWaiters = [];
const authStateListeners = [];
// App-level "cloud prefs arrived" callback (main.js registers
// app.onValuesPrefChange). Registration is plain JS — it never triggers the
// SDK download. Kept module-level so listeners attached from any entry point
// (startup restore or PrefModal sign-in) reach the running app.
let cloudValuesCallback = null;
// Active onSnapshot unsubscribe; null when not listening.
let snapshotUnsub = null;

// Load the modular SDK + initializeApp, once. The dynamic import()s are
// code-split into lazy chunks by Vite/Rolldown, kept out of the entry bundle.
const init = () => {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const [appM, authM, fsM, acM] = await Promise.all([
      import("firebase/app"),
      import("firebase/auth"),
      import("firebase/firestore"),
      import("firebase/app-check")
    ]);
    // Test-only: route to the local emulator suite when run under the
    // integration runner (it sets these env vars, incl. the demo project
    // id). vite.config.js `define` pins all three to undefined in app
    // builds, so this block is dead-code-eliminated there.
    const emuProject = process.env.GCLOUD_PROJECT;
    const app = appM.initializeApp(
      emuProject
        ? { ...FIREBASE_CONFIG, projectId: emuProject }
        : FIREBASE_CONFIG
    );
    // App Check (reCAPTCHA Enterprise): once enforcement is on, Firestore
    // only accepts requests carrying a token minted for our deployed domain,
    // so the public web config can't be used to burn quota from scripts.
    // Skipped under the emulator suite (node env has no DOM, and the
    // emulator doesn't verify tokens anyway).
    if (!emuProject) {
      if (process.env.DEVELOPER_MODE) {
        // localhost isn't on the reCAPTCHA key's domain allow-list; dev
        // builds exchange a debug token instead. APPCHECK_DEBUG_TOKEN is a
        // registered token injected from the developer's machine env (see
        // vite.config.js — never committed); without it the SDK
        // auto-generates one per browser profile and prints it to the
        // console for manual registration. Dead-code eliminated in
        // production builds.
        self.FIREBASE_APPCHECK_DEBUG_TOKEN =
          process.env.APPCHECK_DEBUG_TOKEN || true;
      }
      try {
        acM.initializeAppCheck(app, {
          provider: new acM.ReCaptchaEnterpriseProvider(RECAPTCHA_SITE_KEY),
          isTokenAutoRefreshEnabled: true
        });
      } catch (e) {
        // e.g. the recaptcha script is blocked by an ad-blocker. Sync calls
        // get rejected once enforcement is on; the rest of the app works.
        console.warn("pref_sync: App Check init failed", e);
      }
    }
    const auth = authM.getAuth(app);
    const db = fsM.getFirestore(app);
    if (process.env.FIREBASE_AUTH_EMULATOR_HOST) {
      authM.connectAuthEmulator(
        auth,
        "http://" + process.env.FIREBASE_AUTH_EMULATOR_HOST,
        { disableWarnings: true }
      );
    }
    if (process.env.FIRESTORE_EMULATOR_HOST) {
      const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(":");
      fsM.connectFirestoreEmulator(db, host, +port);
    }
    authM.onAuthStateChanged(auth, user => {
      currentUser = user;
      authStateKnown = true;
      // Session gone (sign-out, token expired/revoked) → stop listening
      // before Firestore starts rejecting the stream with permission-denied.
      if (!user) detachSnapshotListener();
      authStateListeners.forEach(cb => cb(user));
      authStateWaiters.splice(0).forEach(resolve => resolve(user));
    });
    fb = { app, auth, db, authM, fsM };
    return fb;
  })();
  return loadPromise;
};

// Idempotent SDK handle for tests (emulator suite needs the db/auth instances
// for disableNetwork and teardown). Same promise PrefModal's signIn awaits.
export const ensureFirebase = init;

const userDocRef = uid => fb.fsM.doc(fb.db, "users", uid);

const detachSnapshotListener = () => {
  if (snapshotUnsub) {
    snapshotUnsub();
    snapshotUnsub = null;
    console.info("pref_sync: snapshot listener detached");
  }
};

// Key names whose values changed between two pref objects — log-friendly
// (names only; never the values, credentials included). deepEqual, not
// JSON.stringify: Firestore map key order would false-positive (termSize).
const changedKeys = (a, b) =>
  Object.keys(b).filter(k => !deepEqual(a && a[k], b[k]));

// Attach the realtime listener on users/{uid} and reconcile every snapshot
// (see classifySnapshot for the case split). This is what propagates changes
// made on another device/tab into this one — without it, a stale tab would
// keep old prefs and overwrite the cloud on its next save.
// Resolves once with the first applied values (merged prefs, or the local
// ones on a first-sign-in push) so signIn can refresh the modal form.
const attachSnapshotListener = () => {
  detachSnapshotListener();
  console.info("pref_sync: attaching snapshot listener (users/" +
    currentUser.uid + ")");
  return new Promise(resolve => {
    let resolved = false;
    const resolveOnce = values => {
      if (!resolved) {
        resolved = true;
        resolve(values);
      }
    };
    snapshotUnsub = fb.fsM.onSnapshot(
      userDocRef(currentUser.uid),
      snap => {
        if (!currentUser) return;
        // exists is a method in the modular SDK (was a property in compat).
        const exists = snap.exists();
        const data = exists && snap.data();
        // Re-read on every snapshot: the local copy moves underneath us
        // (PrefModal saves, credential cleanup).
        const local = readValuesWithDefault();
        const action = classifySnapshot({
          exists,
          hasPendingWrites: snap.metadata.hasPendingWrites,
          fromCache: snap.metadata.fromCache,
          hasPrefs: !!(data && data.prefs)
        });
        console.info(
          "pref_sync: snapshot action=" + action +
            " exists=" + exists +
            " fromCache=" + snap.metadata.fromCache +
            " pendingWrites=" + snap.metadata.hasPendingWrites
        );
        switch (action) {
          case "push-local":
            savePrefs(local).then(resolveOnce);
            break;
          case "merge": {
            const merged = mergeCloudPrefs(DEFAULT_PREFS, local, data.prefs);
            const changed = changedKeys(local, merged);
            if (changed.length) {
              console.info(
                "pref_sync: cloud merge applied, changed keys: " +
                  changed.join(", ")
              );
              writeValues(merged);
              if (cloudValuesCallback) cloudValuesCallback(merged);
            } else {
              // Nothing actually changed (e.g. the ack of our own upload) —
              // skip the re-apply, onValuesPrefChange does real work (resize).
              console.info("pref_sync: cloud merge: no effective change");
            }
            resolveOnce(merged);
            break;
          }
          // skip-echo / skip-offline-missing: wait for the next snapshot.
        }
      },
      e => {
        // The listener auto-stops after an error; drop the handle so a later
        // attach doesn't assume it's still alive.
        console.warn("pref_sync: snapshot listener error", e);
        snapshotUnsub = null;
      }
    );
  });
};

export const getUser = () => currentUser;

// main.js registers the app-level apply callback here once at startup.
// Plain assignment — safe to call before (or without) any Firebase load.
export const registerOnCloudValues = cb => {
  cloudValuesCallback = cb;
};

// Resolves with the user from Firebase's first auth answer (immediately if
// it already arrived). Unlike onAuthState below, this never fires early with
// the pre-answer null.
const waitForFirstAuthState = () =>
  authStateKnown
    ? Promise.resolve(currentUser)
    : new Promise(resolve => {
        authStateWaiters.push(resolve);
      });

// Resolves once the module-level auth state catches up with a completed
// sign-in: onAuthStateChanged listeners fire on a later microtask than the
// sign-in promise, and attachSnapshotListener needs currentUser.uid.
const waitForUser = () =>
  currentUser
    ? Promise.resolve(currentUser)
    : new Promise(resolve => {
        const unsub = onAuthState(u => {
          // Only async invocations reach unsub (the synchronous first call
          // sees the null we just checked), so unsub is assigned by then.
          if (u) {
            unsub();
            resolve(u);
          }
        });
      });

// cb fires immediately with the current state, then on every change.
// Returns an unsubscribe function.
export const onAuthState = cb => {
  authStateListeners.push(cb);
  cb(currentUser);
  return () => {
    const i = authStateListeners.indexOf(cb);
    if (i >= 0) authStateListeners.splice(i, 1);
  };
};

// Startup hook (main.js). No-op unless the user signed in previously, so the
// e2e/guest path stays free of any Firebase network traffic. Cloud values are
// delivered through the callback registered via registerOnCloudValues.
export const startIfPreviouslySignedIn = () => {
  try {
    if (window.localStorage.getItem(SYNC_FLAG_KEY) !== "1") return;
  } catch (e) {
    return;
  }
  (async () => {
    try {
      await init();
      // Wait for Firebase's first onAuthStateChanged before deciding: null
      // there means the session expired/was revoked.
      const user = await waitForFirstAuthState();
      console.info(
        "pref_sync: startup auth " + (user ? "restored" : "expired/revoked")
      );
      if (user) await attachSnapshotListener();
    } catch (e) {
      console.warn("pref_sync: startup sync failed", e);
    }
  })();
};

// Interactive sign-in from PrefModal. onCloudValues fires once with the
// values from the first sync so the modal can refresh its form state;
// subsequent snapshots go to the registered app-level callback.
// authenticate is an injection seam for the emulator tests (signInWithPopup
// needs a browser UI; tests pass a signInWithCredential step instead) —
// production callers omit it.
export const signIn = async (onCloudValues, authenticate) => {
  const f = await init();
  await (authenticate
    ? authenticate(f)
    : f.authM.signInWithPopup(f.auth, new f.authM.GoogleAuthProvider()));
  try {
    window.localStorage.setItem(SYNC_FLAG_KEY, "1");
  } catch (e) {}
  await waitForUser();
  const values = await attachSnapshotListener();
  if (onCloudValues) onCloudValues(values);
  return values;
};

// Sign out and stop syncing. localStorage prefs are kept: the app keeps
// working offline with the last-known values. Listener must go down before
// auth does, or the open stream errors with permission-denied.
export const signOut = async () => {
  detachSnapshotListener();
  try {
    window.localStorage.removeItem(SYNC_FLAG_KEY);
  } catch (e) {}
  if (!loadPromise) return;
  const f = await init();
  return f.authM.signOut(f.auth);
};

// Upload prefs (credentials stripped). No-op when signed out. Errors are
// swallowed: the local copy is already saved, next save retries.
// autoLoginUser is actively deleted (not just omitted): docs written before
// it became local-only still carry the PTT username, and set(merge:true)
// never drops a field on its own — each save self-heals the leftover.
export const savePrefs = async values => {
  if (!currentUser) return values;
  console.info("pref_sync: uploading prefs");
  try {
    await fb.fsM.setDoc(
      userDocRef(currentUser.uid),
      {
        prefs: {
          ...sanitizeForCloud(values),
          autoLoginUser: fb.fsM.deleteField()
        },
        updatedAt: fb.fsM.serverTimestamp(),
        schemaVersion: 1
      },
      { merge: true }
    );
    console.info("pref_sync: upload acknowledged by server");
    return values;
  } catch (e) {
    console.warn("pref_sync: save failed", e);
    return values;
  }
};
