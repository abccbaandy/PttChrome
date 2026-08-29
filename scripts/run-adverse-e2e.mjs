// 逆境 offline e2e（`yarn test:e2e:offline:adverse`）的分批執行器。
//
// 為什麼不是一句 `playwright test --project=a --project=b --project=c`：
// 那是**單一 playwright 進程**跑完三個 project、189 條，每條開一個 page ⇒ 一輪連續
// 開關上百個 Chromium renderer。Windows 同一桌面 session 的 desktop heap／handle 被
// 吃乾之後，**任何**新進程都起不來，worker 一啟動就死：
//   Error: worker process exited unexpectedly (code=3221225794, signal=null)
// 3221225794 = 0xC0000142 = STATUS_DLL_INIT_FAILED（進程根本沒跑起來 ⇒ 失敗案例
// 耗時 0ms、零 AssertionError）。手動分 `--project` 跑就過得了，這支把那件事自動化：
//   每桶各一個獨立 playwright 進程（結束＝所有 Chromium 完全退出，OS 才真回收）
//   ＋桶間冷卻 ＋ 只有命中崩潰指紋時才補跑。
// 背景與判準見 docs/offline-replay-testing.md。
//
// exit code（刻意分三種，比照 scripts/ci-status.mjs）：
//   0 全綠｜1 有真失敗（測試紅）｜2 環境崩潰、未取得有效結論
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8080;
const BASE_URL = `http://localhost:${PORT}/`;

// 桶名必須與 playwright.config.js 的逆境 project 對齊；漂移由
// tests/unit/adverse_runner_parse.test.js 擋下。
export const ADVERSE_PROJECTS = ["offline-slow", "offline-broken", "offline-mixed"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 純函式（unit 守護：tests/unit/adverse_runner_parse.test.js）----

// 從 playwright.config.js 原始碼取出兩份逆境 spec 清單。`--batch=spec` 用它切更細的批。
// 直接 require config 會把 @playwright/test 拉進 vitest 的 jsdom 環境，故改為讀原始碼。
export function parseAdverseSpecs(source) {
  const grab = (name) => {
    const m = new RegExp(`const\\s+${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(source);
    if (!m) return [];
    return [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
  };
  return { layout: grab("ADVERSE_LAYOUT_SPECS"), image: grab("ADVERSE_IMAGE_SPECS") };
}

// 一次 playwright 執行的結論。**真斷言失敗永遠不重試**——offline e2e 不接受 flaky，
// 重試會把「斷言不夠嚴謹」偽裝成偶發（見 docs/offline-replay-testing.md）。
// env-crash 三個條件缺一即 fail：worker 崩潰訊息、0xC0000142 的碼、且零真失敗訊號。
export function classifyRun({ code, output }) {
  const text = String(output || "");
  if (code === 0) return "pass";
  const workerCrash = /worker process exited unexpectedly/i.test(text);
  const dllInitFailed = /\b3221225794\b|0xC0000142/i.test(text);
  const realFailure = /AssertionError|Test timeout of|Error: expect\(/i.test(text);
  return workerCrash && dllInitFailed && !realFailure ? "env-crash" : "fail";
}

// argv → 設定。`--only` 吃逗號分隔的桶名；未知旗標原封不動透傳給 playwright
// （例如 --workers=2、--grep、位置參數當檔名 filter）。
export function parseArgs(argv) {
  const opts = { batch: "project", only: null, retry: true, passthrough: [] };
  for (const arg of argv) {
    const only = /^--only=(.+)$/.exec(arg);
    const batch = /^--batch=(project|spec)$/.exec(arg);
    if (only) opts.only = only[1].split(",").map((s) => s.trim()).filter(Boolean);
    else if (batch) opts.batch = batch[1];
    else if (arg === "--no-retry") opts.retry = false;
    else opts.passthrough.push(arg);
  }
  return opts;
}

// 批次清單（純函式）。project 模式一桶一批；spec 模式再依 spec 檔切開（共用同一個
// dev server，所以多切不會多付 vite 啟動成本），留給「分 project 仍然崩」時用。
//
// filters ＝ 使用者給的位置參數（playwright 的檔名 filter）。spec 模式下**不能**原封
// 不動往下傳：每批自己已經帶一個檔名 filter，playwright 的多個位置參數是 OR ⇒ 每一批
// 都會順便再跑一次那些檔案。所以這裡改成拿它來篩批次清單本身。
export function buildBatches({ batch, only }, specs = { layout: [], image: [] }, filters = []) {
  const projects = only || ADVERSE_PROJECTS;
  if (batch === "project") {
    return projects.map((p) => ({ label: p, project: p, args: [...filters] }));
  }
  const batches = [];
  for (const project of projects) {
    // Tier B（圖片本身當主題）只在 slow 跑，與 config 的 testMatch 一致。
    const list = project === "offline-slow" ? [...specs.layout, ...specs.image] : specs.layout;
    for (const spec of list) {
      const file = spec.split("/").pop();
      if (filters.length && !filters.some((f) => file.includes(f) || f.includes(file))) continue;
      batches.push({ label: `${project}__${file}`, project, args: [file] });
    }
  }
  return batches;
}

// argv 尾巴切成「旗標（含其值）」與「檔名 filter」。純函式，unit 守護。
export function splitPassthrough(passthrough) {
  const flags = [];
  const filters = [];
  for (let i = 0; i < passthrough.length; i++) {
    const arg = passthrough[i];
    const prev = passthrough[i - 1] || "";
    const isFlagValue = prev.startsWith("--") && !prev.includes("=") && !arg.startsWith("-");
    if (arg.startsWith("-") || isFlagValue) flags.push(arg);
    else filters.push(arg);
  }
  return { flags, filters };
}

// ---- 以下有副作用 ----

function readConfigSource() {
  return fs.readFileSync(path.join(ROOT, "playwright.config.js"), "utf8");
}

// 探測 dev server 是否已經在跑（手動 yarn start，或上一批留下的）。
async function serverUp(timeoutMs = 1500) {
  try {
    const res = await fetch(BASE_URL, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

// 起一次 vite 給所有批次共用。playwright.config.js 的 reuseExistingServer:true 會讓
// 每個批次直接附上去，不會反覆啟停。
async function startDevServer() {
  const child = spawn(process.execPath, [path.join("node_modules", "vite", "bin", "vite.js")], {
    cwd: ROOT,
    stdio: "ignore",
  });
  const deadline = Date.now() + 180000;
  for (;;) {
    if (await serverUp()) return child;
    if (child.exitCode !== null) throw new Error(`dev server 提前結束（code=${child.exitCode}）`);
    if (Date.now() > deadline) throw new Error("dev server 180s 內沒起來");
    await sleep(500);
  }
}

// 收 dev server：kill-dev-server.js 已處理「Vite 在 Windows 只綁 IPv6」與進程樹強殺。
function stopDevServer(child) {
  if (child) {
    try {
      child.kill();
    } catch {
      /* 已經死了 */
    }
  }
  spawnSync(process.execPath, [path.join("scripts", "kill-dev-server.js")], {
    cwd: ROOT,
    stdio: "inherit",
  });
}

// 診斷用：當下的瀏覽器／node 進程數。**只讀不殺**（使用者自己的 Chrome 也在裡面）。
// 三批下來就看得出崩潰前是「孤兒 Chromium 單調成長」還是別的東西在漏。
function processCounts() {
  const count = (image) => {
    if (process.platform === "win32") {
      const out = spawnSync("tasklist", ["/FI", `IMAGENAME eq ${image}`, "/NH"], {
        encoding: "utf8",
      });
      const text = String(out.stdout || "");
      return text.split(/\r?\n/).filter((l) => l.toLowerCase().includes(image.toLowerCase())).length;
    }
    const name = image.replace(/\.exe$/, "");
    const out = spawnSync("sh", ["-c", `ps -e -o comm= | grep -c ${name}`], { encoding: "utf8" });
    return Number(String(out.stdout || "").trim()) || 0;
  };
  return { chrome: count("chrome.exe"), node: count("node.exe") };
}

const PLAYWRIGHT_CLI = path.join(ROOT, "node_modules", "playwright", "cli.js");

// 跑一次 playwright，輸出即時透傳（保住 list reporter 的即時感）同時留一份供指紋判斷。
function runPlaywright({ label, project, args, extra = [] }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(
      process.execPath,
      [PLAYWRIGHT_CLI, "test", `--project=${project}`, ...args, ...extra],
      {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          // 不分目錄的話後一批會蓋掉前一批的 HTML 報告（playwright-report/ 已在 .gitignore）。
          PLAYWRIGHT_HTML_OUTPUT_DIR: path.join("playwright-report", label),
        },
      }
    );
    let output = "";
    const tee = (stream, sink) =>
      stream.on("data", (d) => {
        output += d;
        sink.write(d);
      });
    tee(child.stdout, process.stdout);
    tee(child.stderr, process.stderr);
    child.on("close", (code) => resolve({ code, output, ms: Date.now() - started }));
  });
}

// worker 崩潰時 playwright 會把排隊中的案例一起標紅，補跑只需那幾條。
function lastRunHasFailures() {
  try {
    const raw = fs.readFileSync(path.join(ROOT, "test-results", ".last-run.json"), "utf8");
    return (JSON.parse(raw).failedTests || []).length > 0;
  } catch {
    return false;
  }
}

const fmt = (ms) => `${(ms / 1000 / 60).toFixed(1)}m`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const unknown = (opts.only || []).filter((p) => !ADVERSE_PROJECTS.includes(p));
  if (unknown.length) {
    console.error(`--only 有不存在的桶：${unknown.join(", ")}（可用：${ADVERSE_PROJECTS.join(" / ")}）`);
    return 2;
  }
  // 位置參數（檔名 filter）與旗標分開處理，理由見 buildBatches。「不帶 = 的 --flag」
  // 後面那一項當成它的值（`--grep 樓層`）；有歧義時請用 `--flag=value` 形式。
  const { flags, filters } = splitPassthrough(opts.passthrough);
  const batches = buildBatches(opts, parseAdverseSpecs(readConfigSource()), filters).map((b) => ({
    ...b,
    args: [...b.args, ...flags],
  }));
  if (!batches.length) {
    console.error("沒有任何批次符合條件（檢查 --only 與檔名 filter）。");
    return 2;
  }
  const cooldownMs = Number(process.env.ADVERSE_COOLDOWN_MS) || 5000;

  let devServer = null;
  if (await serverUp()) {
    console.log(`dev server 已在 :${PORT}，直接沿用。`);
  } else {
    console.log(`啟動 dev server（:${PORT}，${batches.length} 個批次共用）…`);
    devServer = await startDevServer();
  }

  const results = [];
  try {
    for (const [i, batch] of batches.entries()) {
      if (i > 0) await sleep(cooldownMs); // 讓 OS 把上一批的 handle 收乾淨
      console.log(`\n=== [${i + 1}/${batches.length}] ${batch.label} ===`);
      let run = await runPlaywright(batch);
      let verdict = classifyRun(run);

      if (verdict === "env-crash" && opts.retry) {
        console.log(
          `\n[${batch.label}] 判定為**環境崩潰**（STATUS_DLL_INIT_FAILED，零斷言錯）——` +
            `冷卻 ${(cooldownMs * 2) / 1000}s 後補跑。`
        );
        await sleep(cooldownMs * 2);
        const extra = lastRunHasFailures() ? ["--last-failed"] : [];
        console.log(
          extra.length ? "只補跑失敗案例（--last-failed）。" : "取不到失敗清單，整批重跑。"
        );
        const retryRun = await runPlaywright({ ...batch, extra });
        run = { ...retryRun, ms: run.ms + retryRun.ms };
        verdict = classifyRun(retryRun);
      }

      const counts = processCounts();
      console.log(
        `[${batch.label}] ${verdict}，耗時 ${fmt(run.ms)}` +
          `（此刻 chrome=${counts.chrome} node=${counts.node}）`
      );
      results.push({ label: batch.label, verdict, ms: run.ms });
      if (verdict === "fail") break; // 真失敗就停手，別再燒十分鐘
    }
  } finally {
    stopDevServer(devServer);
  }

  const total = results.reduce((a, r) => a + r.ms, 0);
  console.log("\n---- 逆境批次總結 ----");
  for (const r of results) console.log(`  ${r.verdict.padEnd(9)} ${r.label}（${fmt(r.ms)}）`);
  console.log(`  合計 ${fmt(total)}，跑完 ${results.length}/${batches.length} 批`);

  if (results.some((r) => r.verdict === "fail")) {
    console.log("結論：有真失敗，往被測 code 查。");
    return 1;
  }
  if (results.some((r) => r.verdict === "env-crash")) {
    console.log(
      "結論：**環境問題**（Windows 資源耗盡，非被測 code）。補跑後仍崩 ⇒ 改用 `--batch=spec`，" +
        "或交給 CI 的 test-e2e-offline-adverse job。見 docs/offline-replay-testing.md。"
    );
    return 2;
  }
  if (results.length < batches.length) return 2;
  console.log("結論：全綠。");
  return 0;
}

// 只有「直接執行」才跑 main——unit test import 純函式時不可起 dev server 或 exit。
// 收尾用 process.exitCode 而非 process.exit()（見 scripts/ci-status.mjs 的 libuv 註解）。
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.on("SIGINT", () => {
    stopDevServer(null); // 保險：把佔著 8080 的 vite 收掉
    process.exitCode = 130;
  });
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error(e.message);
      process.exitCode = 2;
    }
  );
}
