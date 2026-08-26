// live e2e 的「登入預算」守護（2026-08-25）。
//
// 為什麼要有這條：PTT 有一層站方自有的 DDoS/BOT 防護，觸發條件是**短時間內大量登入**，
// 踩到之後帳號被暫時封鎖，整輪 live e2e 每一條都卡在登入閘門，而且每次重試都在延長封鎖。
// 實錄：`easy-reading-list.spec.js` 一支就自己 `page.goto('/') + login()` 九次，整輪十幾次，
// 連跑兩輪就被鎖住（tests/e2e/README.md 有完整處置）。
//
// 修法是「整輪只登入一次」——唯一的登入點是 `helpers/fixtures.js` 的共用 session。
// 這條測試把那個約定變成會紅的規則：**任何 live spec 都不准自己呼叫 login()，
// 也不准自己開站（page.goto）**。
//
// 2026-08-26 收緊到「一輪一次」：在那之前還有兩條 spec 有豁免權（enhance 的自動登入
// 與 deep-link，被測行為本身就是開站），一輪三次登入，連跑五輪照樣被鎖。現在
//   - 共用 session 的開機**就是**產品的自動登入（fixtures.js 的 autoLoginBoot）
//     ⇒ 那條 spec 改成斷言開機留下的證據；
//   - deep link 改走 hashchange（同一個已登入分頁再貼一次連結，deep_link_entry.js
//     明列的第 2 條進入路徑）。
// ⇒ 豁免名單清空，整輪一次登入。
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

  // 自己開站（`page.goto`）＝多一條連線、多一次登入（dev build 開站即 connect）。
  // 名單現在是**空的**：連「開站自動登入」與 deep link 都改成搭共用 session 的那一次
  // 開機，沒有任何 spec 有資格自己開站。多一個進來就是多一次登入，必須先改這條測試。
  test("沒有任何 live spec 自己開站（page.goto）", () => {
    const booting = liveSpecs.filter((f) => /page\.goto\(/.test(read(f)));
    expect(booting).toEqual([]);
  });

  // 自己開 browser context 同樣等於多一條連線。preflight 不在 liveSpecs 裡（它是
  // 獨立 project，只連線不登入），所以掃得乾淨。
  test("沒有任何 live spec 自己開 browser context", () => {
    const offenders = liveSpecs.filter((f) =>
      /browser\.newContext\(/.test(read(f)),
    );
    expect(offenders).toEqual([]);
  });

  test("唯一的登入點是共用 session fixture", () => {
    const fixtures = fs.readFileSync(
      path.join(E2E_DIR, "helpers", "fixtures.js"),
      "utf8"
    );
    // 有帳密 → 產品自己的自動登入；沒有 → guest 手動登入。就這兩條路。
    expect(fixtures).toContain("await autoLoginBoot(page)");
    expect(fixtures).toContain("await login(page)");
  });

  // 「自動登入」那條 spec 現在斷言的是共用 session 開機留下的證據（shared.boot），
  // 而那份證據只有走 autoLoginBoot 時才會是 auto:true ⇒ fixture 一旦改回手動登入，
  // 那條 spec 會紅，而不是靜默失去覆蓋。
  test("自動登入 spec 斷言的是共用 session 的開機證據", () => {
    const src = read("enhance.spec.js");
    expect(src).toContain("boot.auto");
    expect(src).toContain("主功能表");
  });

  // deep link 的入口：hashchange（deep_link_entry.js 明列的第 2 條路徑）。改回自己
  // 開站會被上面的 page.goto 掃描擋下，這條再明講「該用哪一條」。
  test("deep link spec 走 hashchange 而不是自己冷啟動", () => {
    expect(read("deep-link.spec.js")).toContain("location.hash");
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
