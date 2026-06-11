/**
 * @jest-environment jsdom
 *
 * pref_sync.js against a simulated Firebase (no network, no real SDK).
 * The fake implements exactly the compat surface pref_sync touches:
 *   - script loading (document.head.appendChild → fire onload)
 *   - firebase.auth().onAuthStateChanged / signInWithPopup / signOut
 *   - firebase.firestore().collection().doc(): onSnapshot / set
 *   - firebase.firestore.FieldValue.{delete,serverTimestamp}
 * This lets us replay the full startup-restore → snapshot → apply flow and
 * the multi-device propagation that e2e can't cover (no Firebase in e2e).
 * Regression guard: the old `const unsub = onAuthState(cb)` startup waiter
 * crashed with "unsub is not a function" (cb fires synchronously, before
 * unsub is assigned), so startup restore never attached the listener.
 *
 * Promise-style (no async/await): the babel test preset has no
 * regenerator-runtime, same constraint as src/.
 */

const SYNC_FLAG_KEY = "pttchrome.prefsync.enabled";
const PREF_KEY = "pttchrome.pref.v1";
const UID = "test-uid";

const DELETE_SENTINEL = { __op: "delete" };
const TIMESTAMP_SENTINEL = { __op: "serverTimestamp" };

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

// ---- fake firebase ---------------------------------------------------------

const makeFakeFirebase = () => {
  let authCb = null;
  let docData; // undefined = doc does not exist
  let listeners = [];
  const setCalls = [];

  const snapFor = ({ hasPendingWrites = false, fromCache = false } = {}) => ({
    exists: docData !== undefined,
    data: () => docData,
    metadata: { hasPendingWrites, fromCache }
  });

  const fireSnapshot = meta =>
    listeners.slice().forEach(l => l.onNext(snapFor(meta)));

  const applySet = payload => {
    const prefs = { ...((docData && docData.prefs) || {}) };
    Object.keys(payload.prefs || {}).forEach(k => {
      if (payload.prefs[k] === DELETE_SENTINEL) delete prefs[k];
      else prefs[k] = payload.prefs[k];
    });
    docData = { ...docData, ...payload, prefs };
  };

  const docRef = {
    onSnapshot: (onNext, onError) => {
      const l = { onNext, onError };
      listeners.push(l);
      // Initial delivery is async, like the real SDK.
      Promise.resolve().then(() => {
        if (listeners.indexOf(l) >= 0) l.onNext(snapFor());
      });
      return () => {
        listeners = listeners.filter(x => x !== l);
      };
    },
    set: (payload, opts) => {
      setCalls.push({ payload, opts });
      applySet(payload);
      return Promise.resolve();
    }
  };

  const authObj = {
    onAuthStateChanged: cb => {
      authCb = cb;
    },
    signInWithPopup: () => {
      authCb({ uid: UID });
      return Promise.resolve();
    },
    signOut: () => {
      authCb(null);
      return Promise.resolve();
    }
  };

  const firestoreFn = () => ({
    collection: () => ({ doc: () => docRef })
  });
  firestoreFn.FieldValue = {
    delete: () => DELETE_SENTINEL,
    serverTimestamp: () => TIMESTAMP_SENTINEL
  };

  const authFn = () => authObj;
  authFn.GoogleAuthProvider = function() {};

  return {
    firebase: { initializeApp: () => {}, auth: authFn, firestore: firestoreFn },
    fireAuth: user => authCb(user),
    fireSnapshot,
    setCloudDoc: data => {
      docData = data;
    },
    getCloudDoc: () => docData,
    setCalls,
    listenerCount: () => listeners.length
  };
};

// ---- harness ---------------------------------------------------------------

let fake;
let prefSync;

const readStoredPrefs = () =>
  JSON.parse(window.localStorage.getItem(PREF_KEY)).values;

const writeStoredPrefs = values =>
  window.localStorage.setItem(PREF_KEY, JSON.stringify({ values }));

beforeEach(() => {
  jest.resetModules();
  window.localStorage.clear();
  jest.spyOn(console, "info").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});

  fake = makeFakeFirebase();
  // loadScript appends <script> tags; jsdom never fetches them, so complete
  // each one by installing the fake global and firing onload.
  jest.spyOn(document.head, "appendChild").mockImplementation(el => {
    window.firebase = fake.firebase;
    Promise.resolve().then(() => el.onload());
    return el;
  });

  prefSync = require("../../src/js/pref_sync");
});

afterEach(() => {
  jest.restoreAllMocks();
  delete window.firebase;
});

// Boot the sync as main.js does, with a previous session that restores.
const startupWithUser = onCloudValues => {
  window.localStorage.setItem(SYNC_FLAG_KEY, "1");
  prefSync.registerOnCloudValues(onCloudValues);
  prefSync.startIfPreviouslySignedIn();
  return flush() // SDK "loaded", onAuthStateChanged registered
    .then(() => {
      fake.fireAuth({ uid: UID });
      return flush(); // listener attached + initial snapshot delivered
    });
};

// ---- tests -----------------------------------------------------------------

describe("startup restore (previously signed in)", () => {
  it("applies cloud prefs to localStorage and the app callback", () => {
    writeStoredPrefs({
      fontSize: 16,
      autoLoginUser: "me",
      autoLoginPassword: "pw"
    });
    fake.setCloudDoc({ prefs: { fontSize: 18 } });
    const onCloudValues = jest.fn();

    return startupWithUser(onCloudValues).then(() => {
      expect(onCloudValues).toHaveBeenCalledTimes(1);
      const applied = onCloudValues.mock.calls[0][0];
      expect(applied.fontSize).toBe(18); // cloud wins
      expect(applied.autoLoginUser).toBe("me"); // local-only, kept
      expect(applied.autoLoginPassword).toBe("pw");
      expect(readStoredPrefs().fontSize).toBe(18);
    });
  });

  it("first sign-in (no cloud doc) pushes local prefs up, credentials stripped", () => {
    writeStoredPrefs({
      fontSize: 24,
      autoLoginUser: "me",
      autoLoginPassword: "pw"
    });

    return startupWithUser(jest.fn()).then(() => {
      expect(fake.setCalls.length).toBe(1);
      const uploaded = fake.setCalls[0].payload.prefs;
      expect(uploaded.fontSize).toBe(24);
      expect(uploaded).not.toHaveProperty("autoLoginPassword");
      expect(uploaded.autoLoginUser).toBe(DELETE_SENTINEL); // active cleanup
    });
  });
});

describe("realtime propagation", () => {
  it("applies a change made on another device while this page is open", () => {
    writeStoredPrefs({ fontSize: 16 });
    fake.setCloudDoc({ prefs: { fontSize: 16 } });
    const onCloudValues = jest.fn();

    return startupWithUser(onCloudValues)
      .then(() => {
        onCloudValues.mockClear();
        // Device A saves fontSize 20 → server pushes a snapshot to us (B).
        fake.setCloudDoc({ prefs: { fontSize: 20 } });
        fake.fireSnapshot();
        return flush();
      })
      .then(() => {
        expect(onCloudValues).toHaveBeenCalledTimes(1);
        expect(onCloudValues.mock.calls[0][0].fontSize).toBe(20);
        expect(readStoredPrefs().fontSize).toBe(20);
        // A later save from this tab uploads the NEW value, not a stale one.
        return prefSync.savePrefs(readStoredPrefs());
      })
      .then(() => {
        expect(fake.getCloudDoc().prefs.fontSize).toBe(20);
      });
  });

  it("skips the echo of its own pending write", () => {
    writeStoredPrefs({ fontSize: 16 });
    fake.setCloudDoc({ prefs: { fontSize: 16 } });
    const onCloudValues = jest.fn();

    return startupWithUser(onCloudValues)
      .then(() => {
        onCloudValues.mockClear();
        fake.fireSnapshot({ hasPendingWrites: true });
        return flush();
      })
      .then(() => {
        expect(onCloudValues).not.toHaveBeenCalled();
      });
  });

  it("does not re-apply when cloud equals local (Firestore key-order noise)", () => {
    writeStoredPrefs({ fontSize: 16, termSize: { cols: 80, rows: 24 } });
    // Same values, different map key order — as Firestore returns them.
    fake.setCloudDoc({ prefs: { termSize: { rows: 24, cols: 80 }, fontSize: 16 } });
    const onCloudValues = jest.fn();

    return startupWithUser(onCloudValues).then(() => {
      expect(onCloudValues).not.toHaveBeenCalled();
      expect(readStoredPrefs().termSize).toEqual({ cols: 80, rows: 24 });
    });
  });

  it("does NOT mistake an offline cache miss for a first sign-in", () => {
    writeStoredPrefs({ fontSize: 16 });
    fake.setCloudDoc({ prefs: { fontSize: 18 } });

    return startupWithUser(jest.fn())
      .then(() => {
        fake.setCalls.length = 0;
        // Offline restart scenario: cache has no doc, server unreachable.
        fake.setCloudDoc(undefined);
        fake.fireSnapshot({ fromCache: true });
        return flush();
      })
      .then(() => {
        expect(fake.setCalls.length).toBe(0); // no destructive push queued
      });
  });
});

describe("lifecycle", () => {
  it("signOut detaches the listener before auth teardown", () => {
    writeStoredPrefs({ fontSize: 16 });
    fake.setCloudDoc({ prefs: { fontSize: 16 } });
    const onCloudValues = jest.fn();

    return startupWithUser(onCloudValues)
      .then(() => {
        onCloudValues.mockClear();
        return prefSync.signOut();
      })
      .then(() => {
        expect(fake.listenerCount()).toBe(0);
        expect(window.localStorage.getItem(SYNC_FLAG_KEY)).toBe(null);
        fake.setCloudDoc({ prefs: { fontSize: 99 } });
        fake.fireSnapshot();
        return flush();
      })
      .then(() => {
        expect(onCloudValues).not.toHaveBeenCalled();
      });
  });

  it("interactive signIn attaches the listener and resolves with merged values", () => {
    writeStoredPrefs({ fontSize: 16 });
    fake.setCloudDoc({ prefs: { fontSize: 18 } });
    const modalCb = jest.fn();
    const appCb = jest.fn();
    prefSync.registerOnCloudValues(appCb);

    return prefSync.signIn(modalCb).then(values => {
      expect(values.fontSize).toBe(18);
      expect(modalCb).toHaveBeenCalledTimes(1); // one-shot for the modal form
      expect(appCb).toHaveBeenCalled(); // app applied it too
      expect(window.localStorage.getItem(SYNC_FLAG_KEY)).toBe("1");
      expect(fake.listenerCount()).toBe(1);
    });
  });

  it("savePrefs is a no-op before sign-in", () => {
    const values = { fontSize: 12 };
    return prefSync.savePrefs(values).then(out => {
      expect(out).toBe(values);
      expect(fake.setCalls.length).toBe(0);
    });
  });
});
