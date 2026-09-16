// DEFAULT_PREFS 的「預設值契約」（2026-09-16：把維護者長期實際在用的組態升格為預設）。
//
// 兩件事：
//   1. 這一輪翻動的 8 個 key 鎖住新值 —— 它們每一個都改變了「開箱即得」的行為，
//      被順手改回去不會有任何其他測試發現。
//   2. **鏡射初值守護**：term_view.js / pttchrome.jsx 的 constructor 為部分 pref 留了
//      佔位初值（boot 走 main.jsx → App.onValuesPrefChange 逐 key 重套，所以功能上
//      不影響），原本只有一句「值須與 pref_storage.js DEFAULT_PREFS 一致」的註解在
//      保證。註解擋不住任何人 —— 這裡用靜態掃描把它變成會紅的規則。
import fs from "fs";
import path from "path";
import { DEFAULT_PREFS } from "../../src/js/pref_storage";

const ROOT = path.join(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("2026-09 翻動的預設值", () => {
  test("好讀三兄弟預設開（功能已成熟，不再是 opt-in）", () => {
    // 文章好讀／文章列表好讀／看板列表平滑捲動。三者原本都寫著「功能成熟前預設關」，
    // 2026-09 一起翻開；關掉＝逐位元回到原生的一次一頁（逃生門仍在設定頁）。
    expect(DEFAULT_PREFS.enableEasyReading).toBe(true);
    expect(DEFAULT_PREFS.enableEasyReadingList).toBe(true);
    expect(DEFAULT_PREFS.enableBoardListSmoothScroll).toBe(true);
    // 它是上面兩個的子功能，母開關翻開之後更沒有理由關。
    expect(DEFAULT_PREFS.enableListNativeAutoResume).toBe(true);
  });

  test("終端機慣例的兩顆：選取即複製、Live 文自動跳末頁", () => {
    expect(DEFAULT_PREFS.copyOnSelect).toBe(true);
    expect(DEFAULT_PREFS.endTurnsOnLiveUpdate).toBe(true);
  });

  test("中鍵＝左方向鍵（回上一層）", () => {
    // 0=關閉 1=貼上 2=左方向鍵。值域與舊 mouseMiddleFunction 不同，見 docs/mouse.md。
    expect(DEFAULT_PREFS.mouseMiddleClick).toBe(2);
  });

  test("自動登入預設開，重複登入預設踢掉舊連線", () => {
    // 無憑證時 auto_login.js#_resolveCredential 只會 console.info 後 return
    // （navigator.credentials.get 用 mediation:'optional'，沒存過密碼的人不會看到
    // 任何 UI）⇒ 對新使用者零影響。
    expect(DEFAULT_PREFS.autoLogin).toBe(true);
    expect(DEFAULT_PREFS.autoLoginDupConn).toBe("Y");
    // 憑證三欄永遠是空的（local-only，絕不寫死在預設裡）。
    expect(DEFAULT_PREFS.autoLoginUser).toBe("");
    expect(DEFAULT_PREFS.autoLoginPassword).toBe("");
    expect(DEFAULT_PREFS.autoLoginOtpSecret).toBe("");
  });
});

// constructor 佔位初值與 DEFAULT_PREFS 必須逐值相同。掃描的是「pref 同名欄位」，
// 所以新增鏡射不需要改這支測試；漏同步才會紅。
describe("鏡射初值（constructor）與 DEFAULT_PREFS 一致", () => {
  const MIRROR_FILES = ["src/js/term_view.js", "src/js/pttchrome.jsx"];

  // 純量 pref（物件／陣列／字串不走鏡射，term_size 之類另有路徑）。
  const scalarKeys = Object.keys(DEFAULT_PREFS).filter((k) => {
    const v = DEFAULT_PREFS[k];
    return typeof v === "boolean" || typeof v === "number";
  });

  const literal = (raw) => (raw === "true" ? true : raw === "false" ? false : Number(raw));

  const mirrorsIn = (src) => {
    const found = {};
    for (const key of scalarKeys) {
      const re = new RegExp("^\\s*this\\." + key + "\\s*=\\s*(true|false|-?\\d+)\\s*;", "gm");
      const hits = [...src.matchAll(re)].map((m) => literal(m[1]));
      if (hits.length) found[key] = hits;
    }
    return found;
  };

  test.each(MIRROR_FILES)("%s 的鏡射初值全部對得上", (rel) => {
    const found = mirrorsIn(read(rel));
    for (const [key, hits] of Object.entries(found)) {
      // 同一個欄位在 constructor 裡只該被指定一次；出現兩次代表有人在別處重設，
      // 那才是真正決定初值的那一行（讀 code 的人會看錯）。
      expect(`${rel} ${key} 指定次數 ${hits.length}`).toBe(`${rel} ${key} 指定次數 1`);
      expect(`${rel} ${key}=${hits[0]}`).toBe(`${rel} ${key}=${DEFAULT_PREFS[key]}`);
    }
  });

  // 掃描是動態的 ⇒ 正則若被改壞（或欄位被改名）會靜默掃不到任何東西、測試照樣綠。
  // 這幾個是實際存在的鏡射，當成掃描器自身的 canary。
  test("掃描器自己有效（canary 欄位掃得到）", () => {
    const view = mirrorsIn(read("src/js/term_view.js"));
    const app = mirrorsIn(read("src/js/pttchrome.jsx"));
    expect(Object.keys(view).length).toBeGreaterThan(10);
    for (const key of ["mouseMiddleClick", "mouseWheel", "mouseBackNav", "showFloorNumbers"]) {
      expect(`term_view ${key} 掃到`).toBe(
        `term_view ${key} ${key in view ? "掃到" : "沒掃到"}`,
      );
    }
    for (const key of ["copyOnSelect", "endTurnsOnLiveUpdate"]) {
      expect(`pttchrome ${key} 掃到`).toBe(
        `pttchrome ${key} ${key in app ? "掃到" : "沒掃到"}`,
      );
    }
  });
});
