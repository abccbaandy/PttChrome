// Preference cloud sync: Google sign-in (Firebase Auth) + per-user Firestore
// doc (users/{uid}). localStorage stays the source applied at startup; the
// cloud copy is fetched in the background and re-applied on top (cloud wins).
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
import { sanitizeForCloud, mergeCloudPrefs } from "./pref_sync_logic";

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

// Fetch the cloud doc and reconcile: no doc yet → first sign-in on this
// account, push local prefs up; doc exists → cloud wins, write the merged
// result back to localStorage and hand it to the caller to apply.
const fetchAndApply = onCloudValues => {
  const local = readValuesWithDefault();
  return userDocRef(currentUser.uid)
    .get()
    .then(snap => {
      const data = snap.exists && snap.data();
      if (!data || !data.prefs) {
        return savePrefs(local);
      }
      const merged = mergeCloudPrefs(DEFAULT_PREFS, local, data.prefs);
      writeValues(merged);
      if (onCloudValues) onCloudValues(merged);
      return merged;
    });
};

export const getUser = () => currentUser;

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
// e2e/guest path stays free of any Firebase network traffic.
export const startIfPreviouslySignedIn = ({ onCloudValues }) => {
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
    .then(user => user && fetchAndApply(onCloudValues))
    .catch(e => console.warn("pref_sync: startup sync failed", e));
};

// Interactive sign-in from PrefModal. Resolves with the merged values after
// the first sync so the modal can refresh its form state.
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
      return fetchAndApply(onCloudValues);
    });

// Sign out and stop syncing. localStorage prefs are kept: the app keeps
// working offline with the last-known values.
export const signOut = () => {
  try {
    window.localStorage.removeItem(SYNC_FLAG_KEY);
  } catch (e) {}
  if (!loadPromise) return Promise.resolve();
  return init().then(firebase => firebase.auth().signOut());
};

// Upload prefs (password stripped). No-op when signed out. Errors are
// swallowed: the local copy is already saved, next save retries.
export const savePrefs = values => {
  if (!currentUser) return Promise.resolve(values);
  return userDocRef(currentUser.uid)
    .set(
      {
        prefs: sanitizeForCloud(values),
        updatedAt: window.firebase.firestore.FieldValue.serverTimestamp(),
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
