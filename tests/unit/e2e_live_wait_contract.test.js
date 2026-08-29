// live e2e 的「等待條件」契約守護（2026-08-29）。
//
// 起因：`easy-reading.spec.js` 的「好讀模式自動行內開圖」整輪 live 間歇性紅
// （同一天三輪：紅／紅／綠），乾淨樹對照過 ⇒ 不是被測 code 壞掉，是**測試的等待
// 條件**本身在賭：
//   1. `sendKey('Enter')` 之後睡 4.5 秒就當「整篇累積完了」。好讀是自動翻頁，累積
//      時間隨文長與連線變動；長文那時還在翻，`easy_reading` 同時在控 `.main` 的
//      scrollTop ⇒ 測試自己寫的 `scrollTop = y` 會被拉走，佔位盒從沒進過視野。
//   2. 手寫的單趟 seek：每格固定 sleep(250) 就往下捲。mount 鏈是
//      IntersectionObserver → renderInto（React root）→ requestPreview 的 promise
//      → commit，250ms 只夠快的情況；掃過去的那格接著被 far observer 卸掉 ⇒
//      掃完整篇 0 個預覽節點（現場：7 個可預覽連結、found=0、scrollTop=1752）。
//
// 修法是「等待一律綁內容條件」：累積走 helpers/ptt.js#waitEasyReadingComplete，
// 行內預覽的 seek 走 helpers/layout.js#seekMountedPreview。這支測試把它變成會紅的
// 規則 —— bug 在測試自己身上時，靜態規則是唯一擋得下再犯的東西。
//
// 純靜態掃描，不連網、不開瀏覽器（比照 e2e_login_budget / e2e_layout_settle）。
import fs from "fs";
import path from "path";

const ROOT = path.join(__dirname, "..", "..");
const E2E_DIR = path.join(ROOT, "tests", "e2e");
const HELPERS_DIR = path.join(E2E_DIR, "helpers");

const liveSpecs = fs
  .readdirSync(E2E_DIR)
  .filter((f) => f.endsWith(".spec.js"))
  .sort();

// 只掃**程式碼**：這些檔案的註解本來就在談 waitForTimeout / scrollTop（那正是規範
// 的內容），連註解一起掃會被自己的說明文字誤判。
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

const read = (f) => stripComments(fs.readFileSync(path.join(E2E_DIR, f), "utf8"));

// 「這支 spec 會對好讀**累積出來的長頁**做內容斷言」的代理判準：開了文章好讀，
// 而且真的去讀累積頁的 DOM。
const ENABLES_EASY_READING = /enableEasyReading:\s*true/;
const READS_ACCUMULATED_DOM = /data-type="bbsline"|inlinePreviewSlot|hyperLinkPreview/;

// 具名豁免：**必須寫理由**，而且理由要是「結構上不需要文章累積的終點」。
const EXEMPT = {
  // 列表好讀（ListSession）不是文章累積長頁：它讀的 bbsline 是列表列，終點判定走
  // 這支自己的 settledActive（交易 settle + 狀態旗標），不是 easyReadingReachedPageEnd。
  "easy-reading-list.spec.js": "列表好讀，非文章累積頁；等待走 list session 的 settle",
};

describe("live e2e 等待條件契約", () => {
  test("掃描範圍不是空的（檔名規則改了要在這裡發現）", () => {
    expect(liveSpecs.length).toBeGreaterThanOrEqual(5);
  });

  // 規則一：累積等待一律用 helper，不准用固定睡眠賭。
  test("會讀好讀累積頁的 live spec 一律要用 waitEasyReadingComplete", () => {
    const offenders = liveSpecs.filter((f) => {
      if (EXEMPT[f]) return false;
      const src = read(f);
      if (!ENABLES_EASY_READING.test(src) || !READS_ACCUMULATED_DOM.test(src)) return false;
      return !/waitEasyReadingComplete/.test(src);
    });
    expect(offenders).toEqual([]);
  });

  // 規則二：行內預覽的 seek 不准自己手寫（直接寫 scrollTop 會和 easy_reading 的
  // 捲動控制打架，固定 sleep 又賭 mount 鏈的速度）。
  test("碰行內預覽的 live spec 不得自己寫 scrollTop seek", () => {
    const offenders = liveSpecs.filter((f) => {
      const src = read(f);
      if (!/inlinePreviewSlot|hyperLinkPreview/.test(src)) return false;
      return /scrollTop\s*=/.test(src);
    });
    expect(offenders).toEqual([]);
  });

  test("碰行內預覽的 live spec 要用 seekMountedPreview", () => {
    const offenders = liveSpecs.filter((f) => {
      const src = read(f);
      if (!/inlinePreviewSlot|hyperLinkPreview/.test(src)) return false;
      return !/seekMountedPreview/.test(src);
    });
    expect(offenders).toEqual([]);
  });

  test("豁免名單裡的檔案確實存在，且理由沒有過期（沒去讀行內預覽）", () => {
    for (const f of Object.keys(EXEMPT)) {
      expect(liveSpecs, `豁免名單有不存在的檔案：${f}`).toContain(f);
      expect(read(f), `${f} 已經在讀行內預覽了，豁免理由（${EXEMPT[f]}）失效`).not.toMatch(
        /inlinePreviewSlot|hyperLinkPreview/
      );
    }
  });
});

describe("seekMountedPreview（live/offline 共用的行內預覽 seek）", () => {
  const src = fs.readFileSync(path.join(HELPERS_DIR, "layout.js"), "utf8");

  test("helpers/layout.js 有匯出它", () => {
    expect(src).toContain("seekMountedPreview");
    expect(src).toMatch(/module\.exports\s*=\s*\{[\s\S]*seekMountedPreview/);
  });

  // live 不可以用 waitPreviewsSettled：它要求 .previewLoading 歸零，而真圖床
  // （imgur stall，docs/imgur-latency-research.md）加上「產品端沒有圖片載入 timeout」
  // ⇒ 讀取指示器可以永遠留著 ⇒ settle 必逾時，只是換一種假紅。
  test("它不呼叫 waitPreviewsSettled（那是 offline 專用的終局判定）", () => {
    const body = src.slice(src.indexOf("async function seekMountedPreview"));
    const end = body.indexOf("\nmodule.exports");
    expect(body.slice(0, end > 0 ? end : undefined)).not.toContain("waitPreviewsSettled");
  });

  // 判定分兩級，相依對象不同：mounted 與圖床可達性無關（可當必驗），
  // media/loaded 依賴外網（只能當機會性斷言）。混成一級就是把圖床綁進 CI 顏色。
  test("回傳分成 mounted 與 media/loaded 兩級", () => {
    for (const key of ["mounted", "mediaFound", "loadedImage"]) {
      expect(src).toContain(key);
    }
  });
});
