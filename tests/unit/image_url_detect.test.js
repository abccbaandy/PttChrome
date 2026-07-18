// isImageLikeUrl 的同步判斷必須與 ImagePreviewer 的 async resolver 鏈行為一致
// （regex 單一來源，見 src/js/image_url_detect.js）——此表逐項對照 resolver 的
// 分類：會解析成靜態圖/相簿 → true；iframe（youtube/twitch）/影片/不可預覽 → false。
import { isImageLikeUrl, flickrBase58Decode } from "../../src/js/image_url_detect";

describe("isImageLikeUrl（與 ImagePreviewer resolvers 對照）", () => {
  test.each([
    // imgur
    ["https://i.imgur.com/Ab3dE9.jpg", true],
    ["https://imgur.com/Ab3dE9", true],
    ["http://m.imgur.com/Ab3dE9.png", true],
    ["https://imgur.com/a/hash12", true], // album
    ["https://imgur.com/gallery/hash12", true],
    // twitter / X
    ["https://pbs.twimg.com/media/AbC-123?format=jpg&name=orig", true],
    ["https://pbs.twimg.com/media/AbC-123.jpg", true],
    // meee
    ["https://meee.com.tw/AbCdE.jpg", true],
    ["https://meee.com.tw/AbCdE", true],
    // 任意圖床直連（generic 副檔名）
    ["https://example.com/pic.webp", true],
    ["https://example.com/pic.png?x=1", true],
    // 非圖：iframe 型（youtube/twitch）、影片、一般連結
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", false],
    ["https://youtu.be/dQw4w9WgXcQ", false],
    ["https://clips.twitch.tv/SomeClip-abc", false],
    ["https://example.com/movie.mp4", false],
    ["https://www.ptt.cc/bbs/C_Chat/M.123.A.html", false],
    ["", false],
    [undefined, false],
  ])("%s → %s", (src, expected) => {
    expect(isImageLikeUrl(src)).toBe(expected);
  });
});

// flickrBase58Decode：原 npm `base58`（2014 無維護）內聯後的回歸守護。
// 重點鎖「Flickr 字母表順序」（數字→小寫→大寫）：若未來誤換成 Bitcoin 系 bs58
//（數字→大寫→小寫），'a' 會從 9 變成 33，flic.kr 短網址會解出錯的 photo id。
describe("flickrBase58Decode", () => {
  it.each([
    ["1", 0], // 字母表第 0 位
    ["2", 1],
    ["a", 9], // Flickr 字母表：小寫緊接數字（Bitcoin 系此處是大寫，會解出 33）
    ["A", 34],
    ["21", 58], // 進位
    ["ba", 589], // 'b'=10, 'a'=9 → 10*58+9
  ])("decode(%s) → %i", (str, expected) => {
    expect(flickrBase58Decode(str)).toBe(expected);
  });

  it("拒絕字母表外字元（0/O/I/l 不在 base58 內）", () => {
    expect(() => flickrBase58Decode("0")).toThrow();
    expect(() => flickrBase58Decode("abcO")).toThrow();
  });
});
