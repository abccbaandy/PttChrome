// offline e2e 的「零外網」靜態守護（2026-08-28）。
//
// 為什麼要有這條：offline e2e 的整個前提是「不連外網」，但 2026-08-28 從自架 imgur
// 快取 Worker 的 access log 發現，每一輪 offline e2e 都真的去打了它
//（`GET /__offline-gone__/783.png`）。成因是 `route.fulfill` 吐出的 301 會被 Chromium
// 跟隨，而那一跳**不再經過 page.route** —— 從測試這一端完全看不出來。
//
// 根因已修（轉址終點改鑄在保留域，見 helpers/offline_images.js#GONE_ORIGIN），但述詞
// route 還有多少種繞法無法窮舉，所以另外把瀏覽器的出口封死。這支測試守的就是那道
// 出口：**任何 offline project 都必須設死路 proxy**，少一個就紅。
//
// 純靜態，不連網、不開瀏覽器 ⇒ 放 unit（比照 tests/unit/e2e_layout_settle.test.js）。
import config from "../../playwright.config.js";

const offlineProjects = config.projects.filter((p) => p.name.startsWith("offline"));

describe("offline e2e：瀏覽器層硬斷網", () => {
  test("offline project 存在（清單改名不得靜默讓這支變空轉）", () => {
    expect(offlineProjects.map((p) => p.name).sort()).toEqual([
      "offline",
      "offline-broken",
      "offline-firefox",
      "offline-mixed",
      "offline-slow",
    ]);
  });

  test.each(["offline", "offline-broken", "offline-firefox", "offline-mixed", "offline-slow"])(
    "%s 必須把出口指向連不上的 proxy",
    (name) => {
      const proxy = offlineProjects.find((p) => p.name === name).use.proxy;
      expect(proxy, `${name} 沒設 proxy ⇒ 逃出 page.route 的請求會真的上公網`).toBeTruthy();
      expect(proxy.server).toBe("http://127.0.0.1:1");
    }
  );

  test("localhost 必須 bypass（dev server 與 stub WS 要照常）", () => {
    for (const p of offlineProjects) {
      const bypass = p.use.proxy.bypass || "";
      expect(bypass).toContain("localhost");
      expect(bypass).toContain("127.0.0.1");
    }
  });

  // live／record 連的是真 PTT，斷網會把它們整包弄死。
  test("非 offline 的 project 不得被斷網", () => {
    for (const p of config.projects.filter((x) => !x.name.startsWith("offline"))) {
      expect((p.use || {}).proxy, `${p.name} 不該設 proxy`).toBeUndefined();
    }
  });
});
