/**
 * pref_sync.js against the official Firebase Emulator Suite — the real
 * modular SDK signed in through the Auth emulator (fake unsigned Google ID
 * tokens, an officially supported emulator feature) and syncing through the
 * Firestore emulator with the repo's firestore.rules enforced. No fake
 * firebase anywhere; latency compensation (hasPendingWrites), offline cache
 * behaviour (fromCache) and permission-denied are produced by the real SDK.
 *
 * Isolation model: one long-lived module instance (like a long-lived page).
 * Every test gets a FRESH uid (new `sub` in the fake token), so its
 * users/{uid} doc is untouched by earlier tests and by the main client's
 * in-memory Firestore cache — no cross-test wipes needed. A second SDK app
 * ("seeder") signs in with the same token and plays the other device.
 *
 * signInWithPopup needs a browser UI, so tests drive prefSync.signIn through
 * its injectable authenticate seam with signInWithCredential instead; the
 * rest of the flow (flag, listener attach, merge, callbacks) is the real one.
 *
 * Startup-restore caveat: the auth node build has in-memory persistence only,
 * so a "previous session" can't survive a module reload. Tests sign in first,
 * then run startIfPreviouslySignedIn() — init() is memoized, so from
 * pref_sync's view this equals a restored session (flag → init → first auth
 * state → attach), minus the async restore wait.
 *
 * Promise-style (no async/await): the babel test preset has no
 * regenerator-runtime, same constraint as src/.
 */

const prefSync = require("../../src/js/pref_sync");
const { FIREBASE_CONFIG } = require("../../src/js/firebase_config");
const { initializeApp, deleteApp } = require("firebase/app");
const {
  getAuth,
  connectAuthEmulator,
  signInWithCredential,
  GoogleAuthProvider
} = require("firebase/auth");
const {
  getFirestore,
  connectFirestoreEmulator,
  doc,
  getDoc,
  setDoc,
  disableNetwork,
  enableNetwork,
  terminate
} = require("firebase/firestore");

const SYNC_FLAG_KEY = "pttchrome.prefsync.enabled";
const PREF_KEY = "pttchrome.pref.v1";
const PROJECT_ID = process.env.GCLOUD_PROJECT;

// CI cold-starts the emulator (jar download + JVM warmup), so the first Firestore
// round-trip can be slow. Give the polls more headroom on CI and auto-retry a flaky
// test there. A successful poll resolves as soon as its condition holds (~200ms
// locally), so a bigger ceiling NEVER slows the happy path — it only absorbs the
// cold-start tail. Locally the deadline stays tight so a real hang fails fast.
// (jest.integration.config.js#testTimeout derives its outer guard from the same env.)
const POLL_DEADLINE_MS =
  Number(process.env.INTEGRATION_TIMEOUT_MS) ||
  (process.env.CI ? 30000 : 10000);
if (process.env.CI) jest.retryTimes(2, { logErrorsBeforeRetry: true });

// ---- helpers ---------------------------------------------------------------

let seq = 0;
let testSub; // per-test unique subject => per-test uid (see isolation model)
let uid; // actual uid the Auth emulator assigned for testSub

const tokenFor = sub =>
  JSON.stringify({ sub, email: sub + "@example.com", email_verified: true });

const flush = ms => new Promise(resolve => setTimeout(resolve, ms || 0));

const waitFor = (cond, what) => {
  const deadline = Date.now() + POLL_DEADLINE_MS;
  const tick = () => {
    if (cond()) return Promise.resolve();
    if (Date.now() > deadline)
      return Promise.reject(new Error("waitFor timeout: " + what));
    return flush(50).then(tick);
  };
  return tick();
};

// authenticate seam for prefSync.signIn / direct sign-in of the main client.
const credAuth = f =>
  f.authM
    .signInWithCredential(
      f.auth,
      f.authM.GoogleAuthProvider.credential(tokenFor(testSub))
    )
    .then(cred => {
      uid = cred.user.uid;
      return cred;
    });

// Second SDK app instance = "the other device". Signs in with the same fake
// token (same sub => same uid), so the real firestore.rules let it at
// users/{uid}. Created once; re-signs in whenever the test sub changed.
let seederHandle = null;
const seeder = () => {
  if (!seederHandle) {
    const app = initializeApp(
      { ...FIREBASE_CONFIG, projectId: PROJECT_ID },
      "seeder"
    );
    const auth = getAuth(app);
    connectAuthEmulator(
      auth,
      "http://" + process.env.FIREBASE_AUTH_EMULATOR_HOST,
      { disableWarnings: true }
    );
    const db = getFirestore(app);
    const hostPort = process.env.FIRESTORE_EMULATOR_HOST.split(":");
    connectFirestoreEmulator(db, hostPort[0], +hostPort[1]);
    seederHandle = { app, auth, db, sub: null, uid: null };
  }
  const s = seederHandle;
  if (s.sub === testSub) return Promise.resolve(s);
  return signInWithCredential(
    s.auth,
    GoogleAuthProvider.credential(tokenFor(testSub))
  ).then(cred => {
    s.sub = testSub;
    s.uid = cred.user.uid;
    uid = uid || cred.user.uid;
    return s;
  });
};

const seedDoc = data => seeder().then(s => setDoc(doc(s.db, "users", s.uid), data));

const readCloudDoc = () =>
  seeder()
    .then(s => getDoc(doc(s.db, "users", s.uid)))
    .then(snap => (snap.exists() ? snap.data() : undefined));

// Poll the cloud doc through the seeder until cond(doc) holds; resolves with
// the doc.
const waitForCloud = (cond, what) => {
  const deadline = Date.now() + POLL_DEADLINE_MS;
  const tick = () =>
    readCloudDoc().then(d => {
      if (cond(d)) return d;
      if (Date.now() > deadline)
        return Promise.reject(
          new Error("waitForCloud timeout: " + (what || ""))
        );
      return flush(100).then(tick);
    });
  return tick();
};

const readStoredPrefs = () =>
  JSON.parse(window.localStorage.getItem(PREF_KEY)).values;

const writeStoredPrefs = values =>
  window.localStorage.setItem(PREF_KEY, JSON.stringify({ values }));

let infoSpy;
let warnSpy;

// The snapshot handler logs "snapshot action=<x>" for every snapshot it
// classifies — the only deterministic signal for "listener attached and the
// first snapshot was processed" / "the echo was seen and skipped".
const actionLogged = action => () =>
  infoSpy.mock.calls.some(
    c => String(c[0]).indexOf("snapshot action=" + action) >= 0
  );
const anySnapshotProcessed = () =>
  infoSpy.mock.calls.some(
    c => String(c[0]).indexOf("snapshot action=") >= 0
  );

// Boot the sync as main.js does for a previously-signed-in user (see the
// startup-restore caveat in the header). Resolves once the first snapshot
// has been classified.
const startupWithUser = onCloudValues => {
  prefSync.registerOnCloudValues(onCloudValues);
  return prefSync
    .ensureFirebase()
    .then(credAuth)
    .then(() => waitFor(() => prefSync.getUser(), "auth state"))
    .then(() => {
      window.localStorage.setItem(SYNC_FLAG_KEY, "1");
      prefSync.startIfPreviouslySignedIn();
      return waitFor(anySnapshotProcessed, "first snapshot");
    });
};

// ---- lifecycle ---------------------------------------------------------------

beforeEach(() => {
  infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  seq += 1;
  testSub = "it-" + Date.now().toString(36) + "-" + seq;
  uid = null;
  return prefSync
    .signOut()
    .then(() => waitFor(() => !prefSync.getUser(), "signed out"))
    .then(() => {
      window.localStorage.clear();
      prefSync.registerOnCloudValues(null);
      infoSpy.mockClear();
      warnSpy.mockClear();
    });
});

afterEach(() => {
  jest.restoreAllMocks();
});

// Close gRPC channels and auth token timers, or jest never exits.
afterAll(() => {
  return prefSync
    .signOut()
    .then(() => prefSync.ensureFirebase())
    .then(fb => terminate(fb.db).then(() => deleteApp(fb.app)))
    .then(() =>
      seederHandle
        ? terminate(seederHandle.db).then(() => deleteApp(seederHandle.app))
        : null
    );
});

// ---- tests -----------------------------------------------------------------

describe("startup restore (previously signed in)", () => {
  it("applies cloud prefs to localStorage and the app callback", () => {
    writeStoredPrefs({
      fontSize: 16,
      autoLoginUser: "me",
      autoLoginPassword: "pw"
    });
    const onCloudValues = jest.fn();

    return seedDoc({ prefs: { fontSize: 18 } })
      .then(() => startupWithUser(onCloudValues))
      .then(() =>
        waitFor(() => onCloudValues.mock.calls.length >= 1, "cloud values")
      )
      .then(() => {
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

    return startupWithUser(jest.fn())
      .then(() => waitFor(actionLogged("push-local"), "push-local"))
      .then(() =>
        // Poll until the upload landed server-side.
        waitForCloud(d => d && d.prefs && d.prefs.fontSize === 24, "upload")
      )
      .then(cloudDoc => {
        expect(cloudDoc.prefs.fontSize).toBe(24);
        expect(cloudDoc.prefs).not.toHaveProperty("autoLoginPassword");
        expect(cloudDoc.prefs).not.toHaveProperty("autoLoginUser");
        expect(cloudDoc.schemaVersion).toBe(1);
      });
  });
});

describe("realtime propagation", () => {
  it("applies a change made on another device while this page is open", () => {
    writeStoredPrefs({ fontSize: 16 });
    const onCloudValues = jest.fn();

    return seedDoc({ prefs: { fontSize: 16 } })
      .then(() => startupWithUser(onCloudValues))
      .then(() => {
        onCloudValues.mockClear();
        // Device A saves fontSize 20 → server pushes a snapshot to us (B).
        return seedDoc({ prefs: { fontSize: 20 } });
      })
      .then(() =>
        waitFor(() => onCloudValues.mock.calls.length >= 1, "propagated")
      )
      .then(() => {
        expect(onCloudValues.mock.calls[0][0].fontSize).toBe(20);
        expect(readStoredPrefs().fontSize).toBe(20);
        // A later save from this tab uploads the NEW value, not a stale one;
        // schemaVersion proves this write (the seed had none).
        return prefSync.savePrefs(readStoredPrefs());
      })
      .then(() => waitForCloud(d => d && d.schemaVersion === 1, "upload"))
      .then(cloudDoc => {
        expect(cloudDoc.prefs.fontSize).toBe(20);
      });
  });

  it("skips the echo of its own pending write (latency compensation)", () => {
    writeStoredPrefs({ fontSize: 16 });
    const onCloudValues = jest.fn();

    return seedDoc({ prefs: { fontSize: 16 } })
      .then(() => startupWithUser(onCloudValues))
      .then(() => {
        onCloudValues.mockClear();
        // PrefModal flow: localStorage first, then upload. The local echo
        // arrives with hasPendingWrites=true, the server ack merges to
        // no-change — neither may re-trigger the app callback.
        writeStoredPrefs({ ...readStoredPrefs(), fontSize: 21 });
        return prefSync.savePrefs(readStoredPrefs());
      })
      .then(() => waitFor(actionLogged("skip-echo"), "echo observed"))
      .then(() => waitForCloud(d => d.prefs.fontSize === 21, "ack"))
      .then(() => flush(300)) // let any late snapshot land
      .then(() => {
        expect(onCloudValues).not.toHaveBeenCalled();
      });
  });

  it("does not re-apply when cloud equals local (Firestore key-order noise)", () => {
    writeStoredPrefs({ fontSize: 16, termSize: { cols: 80, rows: 24 } });
    const onCloudValues = jest.fn();

    // Same values; the emulator returns map fields in its own key order,
    // which is exactly the noise deepEqual (not JSON.stringify) absorbs.
    return seedDoc({ prefs: { termSize: { rows: 24, cols: 80 }, fontSize: 16 } })
      .then(() => startupWithUser(onCloudValues))
      .then(() => flush(300))
      .then(() => {
        expect(onCloudValues).not.toHaveBeenCalled();
        expect(readStoredPrefs().termSize).toEqual({ cols: 80, rows: 24 });
      });
  });

  it("does NOT mistake an offline cache miss for a first sign-in", () => {
    writeStoredPrefs({ fontSize: 16 });
    const onCloudValues = jest.fn();
    let fb;

    // The other device already has prefs in the cloud. This device starts
    // with an empty Firestore cache and no network: the missing-doc snapshot
    // (fromCache) must NOT trigger a push of local prefs over the cloud copy.
    return seedDoc({ prefs: { fontSize: 18 } })
      .then(() => prefSync.ensureFirebase())
      .then(f => {
        fb = f;
        return credAuth(fb);
      })
      .then(() => waitFor(() => prefSync.getUser(), "auth state"))
      .then(() => disableNetwork(fb.db))
      .then(() => {
        prefSync.registerOnCloudValues(onCloudValues);
        window.localStorage.setItem(SYNC_FLAG_KEY, "1");
        prefSync.startIfPreviouslySignedIn();
        return waitFor(actionLogged("skip-offline-missing"), "offline skip");
      })
      .then(() => enableNetwork(fb.db))
      .then(() => waitFor(() => onCloudValues.mock.calls.length >= 1, "merge"))
      .then(() => {
        // Back online: the server copy won — and was not clobbered by 16.
        expect(onCloudValues.mock.calls[0][0].fontSize).toBe(18);
        expect(readStoredPrefs().fontSize).toBe(18);
        return readCloudDoc();
      })
      .then(cloudDoc => {
        expect(cloudDoc.prefs.fontSize).toBe(18);
      });
  });
});

describe("lifecycle", () => {
  it("signOut detaches the listener before auth teardown", () => {
    writeStoredPrefs({ fontSize: 16 });
    const onCloudValues = jest.fn();

    return seedDoc({ prefs: { fontSize: 16 } })
      .then(() => startupWithUser(onCloudValues))
      .then(() => {
        onCloudValues.mockClear();
        return prefSync.signOut();
      })
      .then(() => {
        expect(window.localStorage.getItem(SYNC_FLAG_KEY)).toBe(null);
        return seedDoc({ prefs: { fontSize: 99 } });
      })
      .then(() => flush(300))
      .then(() => {
        expect(onCloudValues).not.toHaveBeenCalled();
        // Listener went down before auth — the real rules would otherwise
        // have rejected the open stream with permission-denied.
        const streamErrors = warnSpy.mock.calls.filter(
          c => String(c[0]).indexOf("snapshot listener error") >= 0
        );
        expect(streamErrors).toEqual([]);
      });
  });

  it("interactive signIn attaches the listener and resolves with merged values", () => {
    writeStoredPrefs({ fontSize: 16 });
    const modalCb = jest.fn();
    const appCb = jest.fn();
    prefSync.registerOnCloudValues(appCb);

    return seedDoc({ prefs: { fontSize: 18 } })
      .then(() => prefSync.signIn(modalCb, credAuth))
      .then(values => {
        expect(values.fontSize).toBe(18);
        expect(modalCb).toHaveBeenCalledTimes(1); // one-shot for the modal form
        expect(appCb).toHaveBeenCalled(); // app applied it too
        expect(window.localStorage.getItem(SYNC_FLAG_KEY)).toBe("1");
        expect(readStoredPrefs().fontSize).toBe(18);
      });
  });

  it("savePrefs is a no-op before sign-in", () => {
    const values = { fontSize: 12 };
    return prefSync
      .savePrefs(values)
      .then(out => {
        expect(out).toBe(values);
        return readCloudDoc();
      })
      .then(cloudDoc => {
        expect(cloudDoc).toBeUndefined();
      });
  });

  it("savePrefs self-heals a legacy autoLoginUser left in old cloud docs", () => {
    writeStoredPrefs({ fontSize: 16, autoLoginUser: "me" });
    const onCloudValues = jest.fn();

    // Docs written before autoLoginUser became local-only still carry the
    // PTT username; set(merge:true) alone would keep it forever.
    return seedDoc({ prefs: { fontSize: 16, autoLoginUser: "leaked" } })
      .then(() => startupWithUser(onCloudValues))
      .then(() => prefSync.savePrefs(readStoredPrefs()))
      .then(() => waitForCloud(d => d && d.schemaVersion === 1, "upload"))
      .then(cloudDoc => {
        expect(cloudDoc.prefs).not.toHaveProperty("autoLoginUser");
        expect(cloudDoc.prefs.fontSize).toBe(16);
      });
  });
});
