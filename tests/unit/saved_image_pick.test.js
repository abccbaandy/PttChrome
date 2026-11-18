// P107 第一步：離線文章要抓回來存的圖（src/js/saved_image_pick.js）。
import { SAVED_IMAGE_LIMIT, pickSavedImages, savedImageUrl } from "../../src/js/saved_image_pick";

describe("savedImageUrl：只挑網址看得出是靜態圖、而且是 https 的", () => {
  test.each([
    ["https://i.imgur.com/abc123.jpg", "https://i.imgur.com/abc123.jpg"],
    ["http://i.imgur.com/abc123.png", "https://i.imgur.com/abc123.png"],
    ["https://imgur.com/abc123.JPG", "https://i.imgur.com/abc123.jpg"],
    ["https://m.imgur.com/abc123.webp", "https://i.imgur.com/abc123.webp"],
    ["https://pbs.twimg.com/media/FabcXYZ?format=jpg&name=orig", "https://pbs.twimg.com/media/FabcXYZ?format=jpg&name=orig"],
    ["http://pbs.twimg.com/media/FabcXYZ.png", "https://pbs.twimg.com/media/FabcXYZ.png"],
    ["https://i.ibb.co/xyz/photo.jpeg", "https://i.ibb.co/xyz/photo.jpeg"],
    ["https://example.com/a/b.png?x=1#y", "https://example.com/a/b.png?x=1#y"],
  ])("%s ⇒ %s", (href, url) => {
    expect(savedImageUrl(href)).toBe(url);
  });

  test.each([
    ["GIF 不存", "https://i.imgur.com/abc123.gif"],
    ["推特動圖格式", "https://pbs.twimg.com/media/FabcXYZ?format=gif"],
    ["imgur 沒寫副檔名（可能是影片，要探測）", "https://imgur.com/abc123"],
    ["imgur 相簿", "https://imgur.com/a/abc123"],
    ["imgur gallery", "https://imgur.com/gallery/abc123.jpg"],
    ["imgur 影片", "https://i.imgur.com/abc123.mp4"],
    ["其他站的 http（APK 不准明文）", "http://i.meee.com.tw/abc.jpg"],
    ["影片檔", "https://example.com/a.mp4"],
    ["網頁", "https://www.ptt.cc/bbs/C_Chat/M.1.A.B.html"],
    ["副檔名在 query 不算", "https://example.com/show?file=a.jpg"],
    ["帶帳密", "https://u:p@example.com/a.jpg"],
    ["不是 http(s)", "ftp://example.com/a.jpg"],
    ["不是網址", "not a url"],
    ["空字串", ""],
  ])("%s：%s ⇒ null", (_, href) => {
    expect(savedImageUrl(href)).toBeNull();
  });
});

describe("pickSavedImages", () => {
  test("照出現順序、去重；兩種寫法指到同一張圖時共用一個網址", () => {
    const r = pickSavedImages([
      "https://imgur.com/aaa.jpg",
      "https://www.ptt.cc/bbs/x.html",
      "https://i.imgur.com/aaa.jpg",
      "https://i.imgur.com/bbb.png",
      "https://imgur.com/aaa.jpg",
    ]);
    expect(r.urls).toEqual(["https://i.imgur.com/aaa.jpg", "https://i.imgur.com/bbb.png"]);
    expect([...r.byHref]).toEqual([
      ["https://imgur.com/aaa.jpg", "https://i.imgur.com/aaa.jpg"],
      ["https://i.imgur.com/aaa.jpg", "https://i.imgur.com/aaa.jpg"],
      ["https://i.imgur.com/bbb.png", "https://i.imgur.com/bbb.png"],
    ]);
  });

  test("最多 limit 張；之後出現的新圖不挑，但已挑的圖換個寫法還是對得到", () => {
    const r = pickSavedImages(
      ["https://i.imgur.com/a1.jpg", "https://i.imgur.com/a2.jpg", "https://i.imgur.com/a3.jpg", "https://imgur.com/a1.jpg"],
      2,
    );
    expect(r.urls).toEqual(["https://i.imgur.com/a1.jpg", "https://i.imgur.com/a2.jpg"]);
    expect(r.byHref.has("https://i.imgur.com/a3.jpg")).toBe(false);
    expect(r.byHref.get("https://imgur.com/a1.jpg")).toBe("https://i.imgur.com/a1.jpg");
  });

  test("預設上限", () => {
    const hrefs = Array.from({ length: SAVED_IMAGE_LIMIT + 5 }, (_, i) => `https://i.imgur.com/p${i}.png`);
    expect(pickSavedImages(hrefs).urls).toHaveLength(SAVED_IMAGE_LIMIT);
  });

  test("沒有連結／null ⇒ 空", () => {
    expect(pickSavedImages([]).urls).toEqual([]);
    expect(pickSavedImages(null).urls).toEqual([]);
  });
});
