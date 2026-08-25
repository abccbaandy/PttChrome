// live e2e 的「登入預算」守護（2026-08-25）。
//
// 為什麼要有這條：PTT 有一層站方自有的 DDoS/BOT 防護，觸發條件是**短時間內大量登入**，
// 踩到之後帳號被暫時封鎖，整輪 live e2e 每一條都卡在登入閘門，而且每次重試都在延長封鎖。
// 實錄：`easy-reading-list.spec.js` 一支就自己 `page.goto('/') + login()` 九次，整輪十幾次，
// 連跑兩輪就被鎖住（tests/e2e/README.md 有完整處置）。
//
// 修法是「整輪只登入一次」——唯一的登入點是 `helpers/fixtures.js` 的共用 session。
// 這條測試把那個約定變成會紅的規則：**任何 live spec 都不准自己呼叫 login()**。
// 純靜態掃描，不連網、不開瀏覽器，所以放 unit（e2e 素材不穩，見 CLAUDE.md 測試段）。
import fs from "fs";
import path from "path";

const E2E_DIR = path.join(__dirname, "..", "e2e");

const liveSpecs = fs
  .readdirSync(E2E_DIR)
  .filter((f) => f.endsWith(".spec.js"))
  .sort();

// 只掃**程式碼**：這些檔案的註解本來就在談 login() 與 page.goto('/')（那正是規範的
// 內容），連註解一起掃會被自己的說明文字誤判。
// 刻意只砍「整行的行註解」而不是任何 '//'：後者會把 'http://localhost:8080' 這種
// 字串攔腰切斷。區塊註解一併移除。
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

const read = (f) =>
  stripComments(fs.readFileSync(path.join(E2E_DIR, f), "utf8"));

describe("live e2e 登入預算", () => {
  test("掃描範圍不是空的（檔名規則改了要在這裡發現，不能靜默通過）", () => {
    expect(liveSpecs.length).toBeGreaterThanOrEqual(7);
  });

  test("沒有任何 live spec 自己呼叫 login()", () => {
    const offenders = liveSpecs.filter((f) => /\blogin\s*\(/.test(read(f)));
    expect(offenders).toEqual([]);
  });

  // 自己開站（`page.goto`）＝多一條連線、多一次登入（dev build 開站即 connect，且這兩條
  // 都注入 autoLogin prefs）。只有「被測行為本身就是開站自動登入」的 spec 才有資格，
  // 而那是一份**明確的**清單：多一個檔案進來就必須是有意識的決定，所以這裡鎖死名單而不是
  // 只算數量。
  test("自己開站的 live spec 就是那兩條測開站自動登入的（名單鎖死）", () => {
    const booting = liveSpecs.filter((f) => /page\.goto\(/.test(read(f)));
    expect(booting).toEqual(["deep-link.spec.js", "enhance.spec.js"]);
  });

  test("那兩條開站 spec 測的確實是自動登入（沒有偷偷手動送帳密）", () => {
    for (const f of ["deep-link.spec.js", "enhance.spec.js"]) {
      expect(read(f)).toContain("autoLogin");
    }
  });

  test("唯一的登入點是共用 session fixture", () => {
    const fixtures = fs.readFileSync(
      path.join(E2E_DIR, "helpers", "fixtures.js"),
      "utf8"
    );
    expect(fixtures).toContain("await login(page)");
  });

  test("共用 session 在被封鎖時不會再開連線（閂鎖擋在 newContext 之前）", () => {
    const fixtures = fs.readFileSync(
      path.join(E2E_DIR, "helpers", "fixtures.js"),
      "utf8"
    );
    const guard = fixtures.indexOf("assertNotBotBlocked()");
    const context = fixtures.indexOf("browser.newContext");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(context);
  });

  test("每輪開跑會清掉閂鎖（否則被鎖一次之後就永遠略過）", () => {
    const cfg = fs.readFileSync(
      path.join(__dirname, "..", "..", "playwright.config.js"),
      "utf8"
    );
    expect(cfg).toContain("globalSetup");
    const setup = fs.readFileSync(path.join(E2E_DIR, "global-setup.js"), "utf8");
    expect(setup).toContain("clearBotBlock()");
  });
});
