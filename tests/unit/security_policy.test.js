// GitHub 的 security policy 頁（「New issue」清單裡的「Report a security vulnerability」連過去）
// 會到 .github/、根目錄、docs/ 找檔名為 SECURITY.md（不分大小寫）的檔案顯示。
// 內部開發文件取名 docs/security.md 就會被誤當成安全政策 ⇒ 回報者看到的是 CSP 建置細節。
// 鎖住：三個位置只有 .github/SECURITY.md 一份，且內容是回報流程。
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");

const policyFiles = () =>
  [".github", ".", "docs"].flatMap((dir) =>
    fs
      .readdirSync(path.join(ROOT, dir))
      .filter((f) => f.toLowerCase() === "security.md")
      .map((f) => path.posix.join(dir, f)),
  );

describe("security policy", () => {
  test("GitHub 會抓的位置只有 .github/SECURITY.md", () => {
    expect(policyFiles()).toEqual([".github/SECURITY.md"]);
  });

  test("內容是私下回報流程，並導向 bug 範本", () => {
    const text = fs.readFileSync(path.join(ROOT, ".github", "SECURITY.md"), "utf8");
    expect(text).toContain("Report a vulnerability");
    expect(text).toContain("不要開公開 issue");
    expect(text).toContain("template=bug_report.yml");
    expect(fs.existsSync(path.join(ROOT, ".github", "ISSUE_TEMPLATE", "bug_report.yml"))).toBe(true);
  });
});
