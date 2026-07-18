// Runs the cloud-sync integration suite against the Firebase Emulator Suite
// started inside a Docker container. firebase-tools is intentionally NOT a repo
// dependency (it kept dragging transitive Dependabot alerts into the committed
// lockfile — node-fetch/uuid/tough-cookie); the emulator binary lives only in
// the pinned image below. See docs/pref-sync-firestore.md.
//
// Layout: the emulator runs in the container, exposing auth:9099 / firestore:8089;
// vitest runs on the host and connects via the *_EMULATOR_HOST env that
// tests/integration/setup.js keys off. Only the three Firebase config files are
// mounted (read-only) into the image's home dir, so the emulator's debug logs
// write inside the container (no repo pollution, no mount-permission issues).
import { spawnSync } from "node:child_process";

const IMAGE = "andreysenov/firebase-tools:15.22.3-node-22"; // bundles OpenJDK
const CONTAINER = "ptt-fb-emu";
const PROJECT = "demo-pttchrome"; // demo- prefix => guaranteed offline, no real project
const AUTH_PORT = 9099;
const FIRESTORE_PORT = 8089;
const cwd = process.cwd().replace(/\\/g, "/"); // Docker wants forward slashes

function rmContainer() {
  spawnSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Poll an HTTP endpoint until it answers 200. A bare TCP check is unreliable
// here: Docker's port proxy accepts connections on the published host port
// *before* the emulator inside the container starts listening, so a connect
// check passes instantly and vitest then races a not-yet-ready emulator. The
// emulators answer real HTTP only once booted (auth root -> {"authEmulator":
// {"ready":true}}, firestore root -> "Ok").
async function waitHttp(label, url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`${label} not ready in ${timeoutMs}ms (${url})`);
    await sleep(500);
  }
}

async function main() {
  if (spawnSync("docker", ["--version"], { stdio: "ignore" }).status !== 0) {
    console.error(
      "Docker is required for integration tests (the Firebase emulator runs in a container).\n" +
        "Install Docker, or rely on CI (.github/workflows/test.yml). See docs/pref-sync-firestore.md."
    );
    process.exit(1);
  }

  rmContainer(); // clear any stale container from a crashed previous run

  const run = spawnSync(
    "docker",
    [
      "run", "-d", "--name", CONTAINER,
      "-p", `${AUTH_PORT}:${AUTH_PORT}`,
      "-p", `${FIRESTORE_PORT}:${FIRESTORE_PORT}`,
      "-v", `${cwd}/firebase.json:/home/node/firebase.json:ro`,
      "-v", `${cwd}/firestore.rules:/home/node/firestore.rules:ro`,
      "-v", `${cwd}/firestore.indexes.json:/home/node/firestore.indexes.json:ro`,
      IMAGE,
      "firebase", "emulators:start", "--only", "auth,firestore", "--project", PROJECT
    ],
    { stdio: "inherit" }
  );
  if (run.status !== 0) {
    rmContainer();
    process.exit(run.status || 1);
  }

  try {
    await waitHttp("auth emulator", `http://127.0.0.1:${AUTH_PORT}/`, 120000);
    await waitHttp("firestore emulator", `http://127.0.0.1:${FIRESTORE_PORT}/`, 120000);
  } catch (e) {
    console.error("Emulator failed to become ready:", e.message);
    spawnSync("docker", ["logs", CONTAINER], { stdio: "inherit" });
    rmContainer();
    process.exit(1);
  }

  const vitest = spawnSync("npx vitest run --project integration", {
    stdio: "inherit",
    shell: true, // npx -> npx.cmd resolution on Windows
    env: {
      ...process.env,
      GCLOUD_PROJECT: PROJECT,
      FIREBASE_AUTH_EMULATOR_HOST: `127.0.0.1:${AUTH_PORT}`,
      FIRESTORE_EMULATOR_HOST: `127.0.0.1:${FIRESTORE_PORT}`
    }
  });

  rmContainer();
  process.exit(vitest.status || 0);
}

main().catch(e => {
  console.error(e);
  rmContainer();
  process.exit(1);
});
