// RE_ASSET 是這個 Worker 唯一有分支的純邏輯，也是它的安全邊界：
// 決定「什麼會被代理」。破了就變成開放 proxy，或把影片代理出去（違反 Cloudflare ToS）。
import { describe, test, expect } from "vitest";
import { RE_ASSET } from "../src/index.js";

const accepts = (p) => RE_ASSET.test(p);

describe("RE_ASSET 白名單", () => {
  test.each([
    ["/L976tXr.jpg", "7 碼 id"],
    ["/L976tXr.jpeg", "jpeg"],
    ["/L976tXr.png", "png"],
    ["/L976tXr.gif", "gif 原檔（載原圖才會動，不可改要 webp）"],
    ["/L976tXr.webp", "webp 衍生"],
    ["/8vSRl.jpg", "5 碼 id"],
    ["/L976tXrl.jpg", "帶尺寸變體後綴"],
  ])("放行 %s（%s）", (path) => {
    expect(accepts(path)).toBe(true);
  });

  // 影片被擋是**刻意**的，不是疏漏，改動前先讀 README 的「契約」段：
  //   1. Cloudflare ToS 允許 Workers 服務圖片／音訊，排除影片檔。
  //   2. imgur_probe.js 靠 `.mp4` HEAD 是否 200 判斷動圖；若代理把 mp4 回成 404，
  //      探測會誤判成 static → 動圖被靜音（回報案例 imgur.com/lP0NHpE）。
  //      所以 app 端的 .mp4 探測與播放都必須直連 i.imgur.com。
  test.each([["/8MYpXhr.mp4"], ["/8MYpXhr.webm"], ["/8MYpXhr.ogg"], ["/8MYpXhr.gifv"]])(
    "拒絕影片 %s",
    (path) => {
      expect(accepts(path)).toBe(false);
    },
  );

  test.each([
    ["/../etc/passwd", "路徑穿越"],
    ["/a/b.jpg", "多層路徑"],
    ["//evil.com/x.jpg", "protocol-relative"],
    ["/L976tXr", "無副檔名"],
    ["/", "根路徑"],
    ["/L976tXr.jpg.mp4", "雙副檔名"],
    ["/foo-bar.jpg", "非 base62（連字號）"],
    ["/L976tXr_d.webp", "非 base62（底線）——imgur 的 _d 變體，app 端目前不產"],
    ["/L976tXrTooLongId.jpg", "超過 12 碼"],
    ["/L976tXr.JPG", "大寫副檔名（大小寫不同會造成快取碎片，一律不放行）"],
  ])("拒絕 %s（%s）", (path) => {
    expect(accepts(path)).toBe(false);
  });

  // RE_ASSET 帶 /g 旗標時 test() 會因 lastIndex 而在連續呼叫間跳號——這裡確認沒有。
  test("重複呼叫結果穩定（無 /g 旗標的 lastIndex 陷阱）", () => {
    expect(accepts("/L976tXr.jpg")).toBe(true);
    expect(accepts("/L976tXr.jpg")).toBe(true);
    expect(accepts("/L976tXr.jpg")).toBe(true);
  });

  test("擷取出的 id 與副檔名可直接組回源 URL", () => {
    const m = RE_ASSET.exec("/L976tXr.webp");
    expect(m[1]).toBe("L976tXr");
    expect(m[2]).toBe("webp");
  });
});
