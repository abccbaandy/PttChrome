// Preference cloud sync: Google sign-in (Firebase Auth) + per-user Firestore
// doc (users/{uid}). localStorage stays the source applied at startup; a
// realtime listener (onSnapshot) then keeps re-applying the cloud copy on
// top (cloud wins), so edits made on another device/tab land here live.
//
// SDK loading: the Firebase *compat* builds are injected from gstatic at
// runtime instead of npm. webpack 4's parser (acorn) cannot parse the ES2020
// syntax shipped in firebase v9+ npm dists, and babel-loader only transpiles
// src/ — `yarn add firebase` breaks the build. The compat scripts also match
// this project's CDN convention (React/jQuery). Lazy: nothing is downloaded
// until the user signs in (or has signed in before — see SYNC_FLAG_KEY).
// Migration path once webpack ≥5: swap this loader for modular imports; see
// docs/handoff/upgrade-webpack5-build-toolchain.md.

import { FIREBASE_CONFIG } from "./firebase_config";
import {
  DEFAULT_PREFS,
  readValuesWithDefault,
  writeValues
} from "./pref_storage";
import {
  sanitizeForCloud,
  mergeCloudPrefs,
  classifySnapshot
} from "./pref_sync_logic";

const FIREBASE_VERSION = "10.14.1"; // pinned: compat API surface is frozen
const COMPAT_SCRIPTS = [
  "firebase-app-compat",
  "firebase-auth-compat",
  "firebase-firestore-compat"
];

// Set after the first successful sign-in so the next startup knows to load
// the SDK and restore the session; cleared on sign-out. Keeping it separate
// from the prefs blob means signed-out users never pay the SDK download.
const SYNC_FLAG_KEY = "pttchrome.prefsync.enabled";

let loadPromise = null;
let currentUser = null;
const authStateListeners = [];
// App-level "cloud prefs arrived" callback (main.js registers
// app.onValuesPrefChange). Registration is plain JS — it never triggers the
// SDK download. Kept module-level so listeners attached from any entry point
// (startup restore or PrefModal sign-in) reach the running app.
let cloudValuesCallback = null;
// Active onSnapshot unsubscribe; null when not listening.
let snapshotUnsub = null;

const loadScript = src =>
  new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error("failed to load " + src));
    document.head.appendChild(el);
  });

// Load compat SDK + initializeApp, once. Scripts must load in order
// (auth/firestore attach onto firebase-app's global namespace).
const init = () => {
  if (loadPromise) return loadPromise;
  loadPromise = COMPAT_SCRIPTS.reduce(
    (p, name) =>
      p.then(() =>
        loadScript(
          "https://www.gstatic.com/firebasejs/" +
            FIREBASE_VERSION +
            "/" +
            name +
            ".js"
        )
      ),
    Promise.resolve()
  ).then(() => {
    window.firebase.initializeApp(FIREBASE_CONFIG);
    window.firebase.auth().onAuthStateChanged(user => {
      currentUser = user;
      // Session gone (sign-out, token expired/revoked) → stop listening
      // before Firestore starts rejecting the stream with permission-denied.
      if (!user) detachSnapshotListener();
      authStateListeners.forEach(cb => cb(user));
    });
    return window.firebase;
  });
  return loadPromise;
};

const userDocRef = uid =>
  window.firebase
    .firestore()
    .collection("users")
    .doc(uid);

const detachSnapshotListener = () => {
  if (snapshotUnsub) {
    snapshotUnsub();
    snapshotUnsub = null;
  }
};

// Attach the realtime listener on users/{uid} and reconcile every snapshot
// (see classifySnapshot for the case split). This is what propagates changes
// made on another device/tab into this one — without it, a stale tab would
// keep old prefs and overwrite the cloud on its next save.
// Resolves once with the first applied values (merged prefs, or the local
// ones on a first-sign-in push) so signIn can refresh the modal form.
const attachSnapshotListener = () => {
  detachSnapshotListener();
  return new Promise(resolve => {
    let resolved = false;
    const resolveOnce = values => {
      if (!resolved) {
        resolved = true;
        resolve(values);
      }
    };
    snapshotUnsub = userDocRef(currentUser.uid).onSnapshot(
      snap => {
        if (!currentUser) return;
        const data = snap.exists && snap.data();
        // Re-read on every snapshot: the local copy moves underneath us
        // (PrefModal saves, credential cleanup).
        const local = readValuesWithDefault();
        switch (
          classifySnapshot({
            exists: snap.exists,
            hasPendingWrites: snap.metadata.hasPendingWrites,
            fromCache: snap.metadata.fromCache,
            hasPrefs: !!(data && data.prefs)
          })
        ) {
          case "push-local":
            savePrefs(local).then(resolveOnce);
            break;
          case "merge": {
            const merged = mergeCloudPrefs(DEFAULT_PREFS, local, data.prefs);
            writeValues(merged);
            if (cloudValuesCallback) cloudValuesCallback(merged);
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
  init()
    .then(
      () =>
        new Promise(resolve => {
          // First onAuthStateChanged fire tells us whether the session
          // survived; null here means it expired or was revoked.
          const unsub = onAuthState(user => {
            unsub();
            resolve(user);
          });
        })
    )
    .then(user => user && attachSnapshotListener())
    .catch(e => console.warn("pref_sync: startup sync failed", e));
};

// Interactive sign-in from PrefModal. onCloudValues fires once with the
// values from the first sync so the modal can refresh its form state;
// subsequent snapshots go to the registered app-level callback.
export const signIn = onCloudValues =>
  init()
    .then(firebase => {
      const provider = new firebase.auth.GoogleAuthProvider();
      return firebase.auth().signInWithPopup(provider);
    })
    .then(() => {
      try {
        window.localStorage.setItem(SYNC_FLAG_KEY, "1");
      } catch (e) {}
      return attachSnapshotListener().then(values => {
        if (onCloudValues) onCloudValues(values);
        return values;
      });
    });

// Sign out and stop syncing. localStorage prefs are kept: the app keeps
// working offline with the last-known values. Listener must go down before
// auth does, or the open stream errors with permission-denied.
export const signOut = () => {
  detachSnapshotListener();
  try {
    window.localStorage.removeItem(SYNC_FLAG_KEY);
  } catch (e) {}
  if (!loadPromise) return Promise.resolve();
  return init().then(firebase => firebase.auth().signOut());
};

// Upload prefs (credentials stripped). No-op when signed out. Errors are
// swallowed: the local copy is already saved, next save retries.
// autoLoginUser is actively deleted (not just omitted): docs written before
// it became local-only still carry the PTT username, and set(merge:true)
// never drops a field on its own — each save self-heals the leftover.
export const savePrefs = values => {
  if (!currentUser) return Promise.resolve(values);
  const FieldValue = window.firebase.firestore.FieldValue;
  return userDocRef(currentUser.uid)
    .set(
      {
        prefs: {
          ...sanitizeForCloud(values),
          autoLoginUser: FieldValue.delete()
        },
        updatedAt: FieldValue.serverTimestamp(),
        schemaVersion: 1
      },
      { merge: true }
    )
    .then(() => values)
    .catch(e => {
      console.warn("pref_sync: save failed", e);
      return values;
    });
};
