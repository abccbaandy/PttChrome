// Runs the cloud-sync integration suite against the Firebase Emulator Suite
// started inside a Docker container. firebase-tools is intentionally NOT a repo
// dependency (it kept dragging transitive Dependabot alerts into the committed
// lockfile — node-fetch/uuid/tough-cookie); the emulator binary lives only in
// the pinned image below. See docs/pref-sync-firestore.md.
//
// Layout: the emulator runs in the container, exposing auth:9099 / firestore:8089;
// jest runs on the host and connects via the *_EMULATOR_HOST env that
// tests/integration/setup.js keys off. Only the three Firebase config files are
// mounted (read-only) into the image's home dir, so the emulator's debug logs
// write inside the container (no repo pollution, no mount-permission issues).
import { spawnSync } from "node:child_process";
import net from "node:net";

const IMAGE = "andreysenov/firebase-tools:15.22.3-node-22"; // bundles OpenJDK
const CONTAINER = "ptt-fb-emu";
const PROJECT = "demo-pttchrome"; // demo- prefix => guaranteed offline, no real project
const AUTH_PORT = 9099;
const FIRESTORE_PORT = 8089;
const cwd = process.cwd().replace(/\\/g, "/"); // Docker wants forward slashes

function rmContainer() {
  spawnSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
}

function waitPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const sock = net.connect(port, "127.0.0.1");
      sock.once("connect", () => {
        sock.destroy();
        resolve();
      });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() > deadline) reject(new Error(`port ${port} not ready in ${timeoutMs}ms`));
        else setTimeout(tryOnce, 500);
      });
    };
    tryOnce();
  });
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
    await waitPort(AUTH_PORT, 120000);
    await waitPort(FIRESTORE_PORT, 120000);
  } catch (e) {
    console.error("Emulator failed to become ready:", e.message);
    spawnSync("docker", ["logs", CONTAINER], { stdio: "inherit" });
    rmContainer();
    process.exit(1);
  }

  const jest = spawnSync("npx jest -c jest.integration.config.js", {
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
  process.exit(jest.status || 0);
}

main().catch(e => {
  console.error(e);
  rmContainer();
  process.exit(1);
});
