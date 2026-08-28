// 離線重放的「圖片載入情境」純函式守護（helpers/offline_images.js）。
//
// 背景：offline e2e 原本只有一種圖片情境 —— fixture PNG 秒回（＝本地快取永遠命中）。
// 那正是 50fa35c 那個 CI 偶發紅在本機永遠測不出來的原因：好讀長頁的行內預覽是佔位盒，
// 圖回得慢，版面就會在測試量完座標之後才位移。逆境 profile 的用途是把偶發紅變成**必現紅**，
// 所以它自己絕對不可以是不確定的。這支測試鎖的就是那份確定性。
import {
  GONE_ORIGIN,
  GONE_PREFIX,
  IMAGE_PROFILES,
  MIXED_BUCKETS,
  DEFAULT_SLOW_IMAGE_MS,
  imageResponseFor,
  imageScenarioFor,
  profileFromProjectName,
  redirectTargetFor,
  resolveImageProfile,
  slowImageDelayMs,
} from "../../tests/e2e/helpers/offline_images.js";

// 現有 cassette 真的會請求到的圖床網址（imgur / urusai / twimg / meee / ibb…）。
// 用真實語料而非隨手編的字串：mixed 的分桶若在真實語料上退化成單一桶，這個 profile
// 就等於別的 profile，測試會靜默失去覆蓋。
const REAL_IMAGE_URLS = [
  "https://i.imgur.com/L976tXr.webp",
  "https://i.imgur.com/L976tXr.png",
  "https://i.imgur.com/f8Kgx9C.gif",
  "https://i.imgur.com/1T2ieQd.png",
  "https://i.imgur.com/2zgQkyt.png",
  "https://i.imgur.com/7MFq2LP.png",
  "https://i.urusai.cc/PPc8O.jpg",
  "https://i.urusai.cc/kJVR5.jpg",
  "https://pbs.twimg.com/media/HKlOUYHawAAczvg.jpg:orig",
  "https://pbs.twimg.com/media/HM2xS-CbMAA0n3p.jpg:large",
  "https://i.meee.com.tw/AEBHMw6.png",
  "https://i.ibb.co/yFKBG4g/p.gif",
];

// 產品預設 useImgurProxy:true（src/js/pref_storage.js）⇒ e2e 在瀏覽器裡看到的 imgur
// 圖片網址**已經被改寫成自架 Worker 的位址**。刻意不併進 REAL_IMAGE_URLS：那會改動
// 下面 mixed 分桶的鎖定陣列，混淆兩件不相干的事。
const PROXIED_URL =
  "https://ptt-imgur-cache.ptt-relay-8xquy.workers.dev/QBvrtq4.webp";

describe("離線重放：圖片載入情境", () => {
  test("非 mixed 的 profile 一律回同名 scenario", () => {
    for (const u of REAL_IMAGE_URLS) {
      expect(imageScenarioFor(u, "cache")).toBe("cache");
      expect(imageScenarioFor(u, "slow")).toBe("slow");
      expect(imageScenarioFor(u, "broken")).toBe("broken");
      expect(imageScenarioFor(u, "redirect")).toBe("redirect");
    }
  });

  // 'redirect' 是唯一沒有對應 project 的 profile：轉址桶在 mixed 底下會不會落到某一卷
  // 素材，取決於那一卷有哪些網址 —— 不能拿來當斷言前提，所以另給一個整輪 profile。
  test("redirect 可以整輪套用（image_load_conditions 靠它驗 301）", () => {
    expect(IMAGE_PROFILES).toContain("redirect");
    expect(resolveImageProfile({ env: { OFFLINE_IMAGE_PROFILE: "redirect" } })).toBe(
      "redirect"
    );
  });

  test("未知 profile 退回 cache（＝現行行為，不會靜默把整輪弄壞）", () => {
    expect(imageScenarioFor(REAL_IMAGE_URLS[0], "nonsense")).toBe("cache");
    expect(imageScenarioFor(REAL_IMAGE_URLS[0], undefined)).toBe("cache");
  });

  // 不變量 1：決定性。同一個 URL 問一千次必得同一個答案，不看時間、不看順序。
  test("同一個 URL 的分桶永遠相同（決定性）", () => {
    for (const u of REAL_IMAGE_URLS) {
      const first = imageScenarioFor(u, "mixed");
      for (let i = 0; i < 1000; ++i) {
        expect(imageScenarioFor(u, "mixed")).toBe(first);
      }
    }
  });

  // mixed 若在真實語料上只落到一兩個桶，它就退化成別的 profile ⇒ 覆蓋度靜默消失。
  test("mixed 在真實 cassette 語料上四個桶都會被分到", () => {
    const seen = new Set(REAL_IMAGE_URLS.map((u) => imageScenarioFor(u, "mixed")));
    for (const bucket of MIXED_BUCKETS) {
      expect(Array.from(seen)).toContain(bucket);
    }
  });

  // 鎖住實際分桶結果：換雜湊／換桶序都會改變逆境跑起來的樣子，必須是刻意的改動。
  test("實際分桶結果被鎖住（改雜湊或桶序會紅）", () => {
    expect(REAL_IMAGE_URLS.map((u) => imageScenarioFor(u, "mixed"))).toEqual([
      "slow",
      "broken",
      "redirect",
      "cache",
      "broken",
      "redirect",
      "broken",
      "broken",
      "broken",
      "cache",
      "slow",
      "broken",
    ]);
  });

  // 不變量 2：301 鏈一跳即止。轉址終點帶標記前綴，再問一次必得 broken ⇒ 不可能無窮迴圈。
  describe("301 轉址鏈", () => {
    // 終點的 origin **不可以**沿用原址。原本沿用，而產品預設會把 imgur 網址改寫成
    // 自架 Worker 位址 ⇒ 轉址終點被鑄在正式基礎設施上；Chromium 跟隨了那個 301，
    // 但那一跳不再經過 page.route ⇒ offline e2e 每輪都真的打到公網
    //（2026-08-28 由 Worker access log 的 GET /__offline-gone__/783.png 發現）。
    // 保留域（RFC 2606 .invalid）永不解析 ⇒ 攔截層哪天再破一個洞也連不出去。
    test("轉址終點固定落在保留域，絕不沿用原址 host", () => {
      for (const u of REAL_IMAGE_URLS) {
        const target = redirectTargetFor(u);
        expect(new URL(target).origin).toBe(GONE_ORIGIN);
        expect(new URL(target).origin).not.toBe(new URL(u).origin);
        expect(new URL(target).hostname.endsWith(".invalid")).toBe(true);
      }
    });

    test("終點仍是圖片副檔名（才進得了攔截層，回得了 404）", () => {
      for (const u of REAL_IMAGE_URLS) {
        const target = redirectTargetFor(u);
        expect(target.endsWith(".png")).toBe(true);
        expect(target).toContain(GONE_PREFIX);
      }
    });

    // REGRESSION：本次事故的原始輸入。網址已是 Worker 位址時，終點不得含 workers.dev。
    test("被 imgur 代理改寫過的網址，終點不得回指自架 Worker", () => {
      const target = redirectTargetFor(PROXIED_URL);
      expect(target).not.toContain("workers.dev");
      expect(target).not.toContain("ptt-imgur-cache");
      expect(new URL(target).origin).toBe(GONE_ORIGIN);
    });

    test("轉址終點在任何 profile 下都是 broken（一跳即止）", () => {
      for (const u of REAL_IMAGE_URLS) {
        const target = redirectTargetFor(u);
        for (const p of IMAGE_PROFILES) {
          expect(imageScenarioFor(target, p)).toBe("broken");
        }
      }
    });

    test("轉址終點本身是決定性的", () => {
      const u = REAL_IMAGE_URLS[0];
      expect(redirectTargetFor(u)).toBe(redirectTargetFor(u));
    });

    test("不合法 URL 不會炸，退到固定 origin", () => {
      expect(redirectTargetFor("not a url")).toContain(GONE_PREFIX);
      expect(new URL(redirectTargetFor("not a url")).origin).toBe(GONE_ORIGIN);
    });
  });

  // 不變量 3：壞圖的 body 不得是可解碼的圖片。<img> 不看 HTTP status，只要 body 能
  // decode 就 onLoad —— docs/offline-replay-testing.md 記載的 imgur 假綠正是這樣來的
  //（404 頁身也是一張 PNG ⇒ 測試其實一直在測「imgur 的錯誤圖」）。
  describe("各情境的回應", () => {
    test("broken 回 404 且 body 是空的 text/plain（不得是可解碼的圖）", () => {
      const r = imageResponseFor("broken", REAL_IMAGE_URLS[0]);
      expect(r.status).toBe(404);
      expect(r.contentType).toBe("text/plain");
      expect(r.body).toBe("");
    });

    test("redirect 回 301 並帶 Location", () => {
      const u = REAL_IMAGE_URLS[0];
      const r = imageResponseFor("redirect", u);
      expect(r.status).toBe(301);
      expect(r.headers.location).toBe(redirectTargetFor(u));
      expect(r.body).toBe("");
    });

    test("cache / slow 都回同一張 fixture PNG（slow 只差在延遲）", () => {
      const a = imageResponseFor("cache", REAL_IMAGE_URLS[0]);
      const b = imageResponseFor("slow", REAL_IMAGE_URLS[0]);
      expect(a.status).toBe(200);
      expect(a.contentType).toBe("image/png");
      expect(b.body).toBe(a.body);
      // 真的是 PNG（\x89PNG）——fixture 換掉或路徑錯了要在這裡發現。
      expect(a.body.slice(0, 4).toString("latin1")).toBe("\x89PNG");
    });
  });

  describe("profile 解析", () => {
    test("project 名 → profile", () => {
      expect(profileFromProjectName("offline-slow")).toBe("slow");
      expect(profileFromProjectName("offline-broken")).toBe("broken");
      expect(profileFromProjectName("offline-mixed")).toBe("mixed");
      // 既有的兩個 project 不受影響 ⇒ 現行行為（秒回）原封不動。
      expect(profileFromProjectName("offline")).toBe(null);
      expect(profileFromProjectName("offline-firefox")).toBe(null);
      expect(profileFromProjectName(undefined)).toBe(null);
    });

    test("優先序：env > project 名 > cache", () => {
      expect(
        resolveImageProfile({
          env: { OFFLINE_IMAGE_PROFILE: "broken" },
          projectName: "offline-slow",
        })
      ).toBe("broken");
      expect(resolveImageProfile({ env: {}, projectName: "offline-slow" })).toBe("slow");
      expect(resolveImageProfile({ env: {}, projectName: "offline" })).toBe("cache");
      expect(resolveImageProfile()).toBe("cache");
    });

    test("env 給了無效值就當沒給（不會把整輪弄成未定義行為）", () => {
      expect(
        resolveImageProfile({ env: { OFFLINE_IMAGE_PROFILE: "wat" }, projectName: "offline-mixed" })
      ).toBe("mixed");
    });
  });

  describe("慢圖延遲", () => {
    // 使用者要求的下界就是 5 秒；預設值低於它 = 這個情境沒測到「讀圖超久」。
    test("預設超過 5 秒", () => {
      expect(DEFAULT_SLOW_IMAGE_MS).toBeGreaterThan(5000);
      expect(slowImageDelayMs({})).toBe(DEFAULT_SLOW_IMAGE_MS);
    });

    test("env 可覆寫（本機除錯用）", () => {
      expect(slowImageDelayMs({ OFFLINE_SLOW_IMAGE_MS: "800" })).toBe(800);
      expect(slowImageDelayMs({ OFFLINE_SLOW_IMAGE_MS: "0" })).toBe(0);
    });

    test("無效值退回預設", () => {
      expect(slowImageDelayMs({ OFFLINE_SLOW_IMAGE_MS: "abc" })).toBe(DEFAULT_SLOW_IMAGE_MS);
      expect(slowImageDelayMs({ OFFLINE_SLOW_IMAGE_MS: "-5" })).toBe(DEFAULT_SLOW_IMAGE_MS);
    });
  });
});
