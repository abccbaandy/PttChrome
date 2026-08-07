// 離線重放的「外部請求分類」純函式守護（helpers/replay.js#classifyOfflineRequest）。
//
// 背景：offline e2e 的 stub WebSocket 只擋掉 PTT 連線，行內預覽（ImagePreviewer）
// 拿到的是 cassette 裡真實文章的真實圖床網址 → 瀏覽器照樣連公網。症狀是順序相依的
// flake：整檔跑時同一圖床被打好幾輪 → 變慢/限流 → `waitForSelector`（預設
// state:'visible'，而 FallbackImage 在 onLoad 前是 display:none）等不到 → 紅。
// 修法是把外部請求全部改由本地 fixture 回應；這裡鎖分類規則不被改歪。
import { classifyOfflineRequest } from "../../tests/e2e/helpers/replay.js";

describe("離線重放：外部請求分類", () => {
  test("本機 dev server 一律放行（app 自己的 bundle / conv 轉碼表）", () => {
    for (const u of [
      "http://localhost:8080/src/entry.js",
      "http://127.0.0.1:8080/conv/b2u.bin",
      "http://[::1]:8080/index.html",
    ]) {
      expect(classifyOfflineRequest(u)).toBe("passthrough");
    }
  });

  test("非 http(s)（data:/blob:）與不合法 URL 放行", () => {
    expect(classifyOfflineRequest("data:image/png;base64,AAAA")).toBe("passthrough");
    expect(classifyOfflineRequest("blob:http://localhost:8080/x")).toBe("passthrough");
    expect(classifyOfflineRequest("not a url")).toBe("passthrough");
  });

  // 現有 cassette 實際會請求的網址（stock-huang / stock-end / test-xmen）——
  // 這些若被分類成 passthrough 就是又連出去了。
  test("cassette 內的真實圖床網址一律歸 image（回本地 fixture PNG）", () => {
    for (const u of [
      "https://i.imgur.com/L976tXr.webp",
      "https://i.imgur.com/L976tXr.png",
      "https://i.imgur.com/f8Kgx9C.gif",
      "https://i.urusai.cc/PPc8O.jpg",
      "https://pbs.twimg.com/media/HKlOUYHawAAczvg.jpg",
    ]) {
      expect(classifyOfflineRequest(u)).toBe("image");
    }
  });

  test("twitter 的 :orig / :large 尾綴不影響副檔名判定", () => {
    expect(classifyOfflineRequest("https://pbs.twimg.com/media/AB.jpg:orig")).toBe("image");
    expect(classifyOfflineRequest("https://pbs.twimg.com/media/AB.png:large")).toBe("image");
  });

  test("查詢字串在副檔名之後仍算圖片", () => {
    expect(classifyOfflineRequest("https://ex.com/a.jpg?w=100")).toBe("image");
    expect(classifyOfflineRequest("https://ex.com/a.png#frag")).toBe("image");
  });

  test("imgur 相簿 / flickr API 各走自己的假 JSON", () => {
    expect(classifyOfflineRequest("https://api.imgur.com/3/album/abc?client_id=x")).toBe(
      "imgur-album"
    );
    expect(classifyOfflineRequest("https://api.flickr.com/services/rest/?method=y")).toBe(
      "flickr"
    );
  });

  // imgur 型別探測（src/js/imgur_probe.js）會對同一 hash 各發一發 HEAD。離線下
  // `.jpg` 走 fixture PNG（content-type image/png）、`.mp4` 落 blocked → 404，
  // 兩者合起來判定為「靜態圖」——確定性結果，且不會有請求逃到公網。
  test("imgur 型別探測的兩發 HEAD 都被離線規則接住", () => {
    expect(classifyOfflineRequest("https://i.imgur.com/L976tXr.jpg")).toBe("image");
    expect(classifyOfflineRequest("https://i.imgur.com/L976tXr.mp4")).toBe("blocked");
  });

  test("iframe embed 與未知 host → blocked（404 空身，不留 hang）", () => {
    for (const u of [
      "https://www.youtube.com/embed/1m2KVNX4DhI",
      "https://clips.twitch.tv/embed?clip=x&parent=localhost",
      "https://reurl.cc/539ZDv",
    ]) {
      expect(classifyOfflineRequest(u)).toBe("blocked");
    }
  });
});
