// offline e2e 的「版面穩定契約」靜態守護（2026-08-27）。
//
// 為什麼要有這條：50fa35c 修掉了 mouse.offline 的「捲完立刻量 getBoundingClientRect」，
// 但那個 settle 是寫在某個 page.evaluate 裡的內層閉包 —— 不匯出、不可重用。結果
// pusher_highlight.offline 那份逐字拷貝（同一套判準，跑的還是預覽最密的設定）原封不動
// 地留著同一個 bug，而且沒有任何東西會發現。
//
// 修法是把判準收斂到 tests/e2e/helpers/layout.js，然後用這支測試把約定變成會紅的規則：
// **任何會量座標又會真的動滑鼠的 offline spec，都必須用那個模組。**
//
// 純靜態掃描，不連網、不開瀏覽器 ⇒ 放 unit（比照 tests/unit/e2e_login_budget.test.js）。
import fs from "fs";
import path from "path";

const ROOT = path.join(__dirname, "..", "..");
const OFFLINE_DIR = path.join(ROOT, "tests", "e2e", "offline");
const HELPERS_DIR = path.join(ROOT, "tests", "e2e", "helpers");

const offlineSpecs = fs
  .readdirSync(OFFLINE_DIR)
  .filter((f) => f.endsWith(".spec.js"))
  .sort();

// 只掃**程式碼**：這些檔案的註解本來就在談 getBoundingClientRect 與 scrollIntoView
//（那正是規範的內容），連註解一起掃會被自己的說明文字誤判。
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

const read = (f) => stripComments(fs.readFileSync(path.join(OFFLINE_DIR, f), "utf8"));

// 量座標：從元素的實際位置推出一個點。格子數學（firstGridOffset + chw/chh）不算
// —— 那是常數，不會被延遲載入推走。
const MEASURES_GEOMETRY = /getBoundingClientRect\(|elementFromPoint\(|\.boundingBox\(\)/;
// 真的把指標放到那個點上。
const DRIVES_POINTER = /page\.mouse\./;

// 具名豁免：**必須寫理由**，而且理由要是「結構上不可能受延遲載入影響」，
// 不是「目前看起來還好」。
const EXEMPT = {
  // 內容是單行 feedLine（先清屏、不進好讀、整頁一個佔位盒都沒有）⇒ 沒有任何東西
  // 會在量測之後撐高版面。這支同時是唯一跑 Firefox 的 offline spec。
  "selection.offline.spec.js": "單行 feedLine，無好讀、無行內預覽",
};

describe("offline e2e 版面穩定契約", () => {
  test("掃描範圍不是空的（檔名規則改了要在這裡發現，不能靜默通過）", () => {
    expect(offlineSpecs.length).toBeGreaterThanOrEqual(25);
  });

  test("helpers/layout.js 存在且匯出三個層次的工具", () => {
    const src = fs.readFileSync(path.join(HELPERS_DIR, "layout.js"), "utf8");
    for (const name of [
      "waitPreviewsSettled",
      "waitRectStable",
      "scrollIntoViewStable",
      "assertElementUnder",
      "stableCommentRow",
      "plainLeftEdge",
    ]) {
      expect(src).toContain(name);
    }
  });

  // 這就是規則本身。違反 ⇒ 有人又寫了「捲完立刻量、然後點下去」。
  test("會量座標又會動滑鼠的 spec 一律要 require helpers/layout", () => {
    const offenders = offlineSpecs.filter((f) => {
      if (EXEMPT[f]) return false;
      const src = read(f);
      if (!MEASURES_GEOMETRY.test(src) || !DRIVES_POINTER.test(src)) return false;
      return !/require\(['"]\.\.\/helpers\/layout['"]\)/.test(src);
    });
    expect(offenders).toEqual([]);
  });

  // 豁免名單只准留「結構上免疫」的檔案。哪天它開始進好讀／掛預覽了，這條會紅。
  test("豁免名單裡的 spec 確實沒有進好讀（不會有行內預覽佔位盒）", () => {
    for (const f of Object.keys(EXEMPT)) {
      const src = read(f);
      expect(offlineSpecs, `豁免名單有不存在的檔案：${f}`).toContain(f);
      expect(src, `${f} 已經會進好讀了，豁免理由（${EXEMPT[f]}）失效`).not.toMatch(
        /enableEasyReading:\s*true/
      );
      expect(src).not.toContain("replayCassette(");
    }
  });

  // 50fa35c 的 settle 只要求「連續兩次、間隔 50ms 相同」，在 observer 鏈還沒 fire 時
  // （t=0 與 t=50ms 都還是初始值）會提前放行。收斂到 helper 之後把門檻收緊，這裡鎖住
  // 它不被改鬆回去。
  test("waitRectStable 的預設門檻不得鬆於「連續 3 次、間隔 100ms」", () => {
    const src = fs.readFileSync(path.join(HELPERS_DIR, "layout.js"), "utf8");
    const m = /samples = (\d+), interval = (\d+)/.exec(src);
    expect(m, "waitRectStable 的預設值格式變了，這條守護要跟著更新").not.toBeNull();
    expect(Number(m[1])).toBeGreaterThanOrEqual(3);
    expect(Number(m[2])).toBeGreaterThanOrEqual(100);
  });

  // waitPreviewsSettled 的終局判定必須含**Node 端在途圖片請求**：圖回得慢時瀏覽器
  // 連 onLoad 都還沒發生，頁面上除了讀取動畫沒有任何痕跡 —— 少了這個訊號就會提前收工。
  test("waitPreviewsSettled 同時看在途請求與 .previewLoading", () => {
    const src = fs.readFileSync(path.join(HELPERS_DIR, "layout.js"), "utf8");
    expect(src).toContain("imageInflight");
    expect(src).toContain("previewLoading");
    // 逾時要丟錯而不是靜默放行（靜默放行＝把 flaky 藏回去）。
    expect(src).toMatch(/waitPreviewsSettled 逾時/);
  });
});

describe("逆境 project 設定", () => {
  const cfg = fs.readFileSync(path.join(ROOT, "playwright.config.js"), "utf8");

  test("三個逆境 project 都在（profile 由 project 名推導）", () => {
    for (const name of ["offline-slow", "offline-broken", "offline-mixed"]) {
      expect(cfg).toContain(`name: '${name}'`);
    }
  });

  // 現行的兩個 project 名不得落進 profileFromProjectName 的比對 ⇒ 既有 offline 一定
  // 跑在 'cache'（＝這次改動前的行為）。這條在 offline_image_profile.test.js 也鎖了一次。
  test("既有 offline / offline-firefox 不受影響", () => {
    expect(cfg).toContain("name: 'offline'");
    expect(cfg).toContain("name: 'offline-firefox'");
  });

  test("逆境清單裡的每一支 spec 都真的存在", () => {
    // 排除 glob（offline project 的 testMatch 是 'offline/**/*.spec.js'）。
    const listed = Array.from(cfg.matchAll(/'offline\/([^'*]+\.spec\.js)'/g)).map((m) => m[1]);
    expect(listed.length).toBeGreaterThan(0);
    for (const f of listed) {
      expect(offlineSpecs, `逆境清單指到不存在的 spec：${f}`).toContain(f);
    }
  });

  // 2026-08-29 起這個 script 不再直接呼叫 playwright，而是委派給分批執行器
  // （本機 Windows 一次跑完三桶會撞 STATUS_DLL_INIT_FAILED，見
  // scripts/run-adverse-e2e.mjs 開頭）。涵蓋性改由該腳本的 ADVERSE_PROJECTS 保證，
  // 它與 config 的一致性鎖在 tests/unit/adverse_runner_parse.test.js。
  test("yarn test:e2e:offline:adverse 涵蓋三個逆境 project", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const script = pkg.scripts["test:e2e:offline:adverse"];
    expect(script).toContain("scripts/run-adverse-e2e.mjs");
    const runner = fs.readFileSync(path.join(ROOT, "scripts", "run-adverse-e2e.mjs"), "utf8");
    const listed = /ADVERSE_PROJECTS = \[([^\]]*)\]/.exec(runner)?.[1] || "";
    for (const name of ["offline-slow", "offline-broken", "offline-mixed"]) {
      expect(listed).toContain(name);
    }
  });

  test("CI 有一個獨立的逆境 job（與現有三個平行）", () => {
    const wf = fs.readFileSync(path.join(ROOT, ".github", "workflows", "test.yml"), "utf8");
    expect(wf).toContain("test-e2e-offline-adverse:");
    expect(wf).toContain("yarn test:e2e:offline:adverse");
  });
});
