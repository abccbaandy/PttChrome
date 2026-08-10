// 同步「這個 URL 是不是圖片連結」判斷，regex 與 ImagePreviewer 的 resolvers 共用
// （單一來源）：ImagePreviewer 的 resolver 鏈是 async（imgur album 還要打 API），
// 但圖文合併分組（image_caption_group.js）需要在 render 前同步判斷哪些行是圖行，
// 兩邊若各養一套 pattern 會漂移——故 pattern 全部收在這裡。
// 純模組：無 DOM / 無網路，unit test 直接跑 node env。

export const RE_IMAGE_EXT =
  /\.(?:jpe?g|png|gif|webp|apng|avif|jfif|pjpeg|pjp|svg|bmp|ico)(?:$|[?#])/i;
export const RE_VIDEO_EXT = /\.(?:mp4|webm|ogg)(?:$|[?#])/i;

export const RE_IMGUR_ALBUM =
  /^https?:\/\/(?:[mi]\.)?imgur\.com\/(?:a|gallery)\/(\w+)/i;
export const RE_IMGUR_SINGLE =
  /^https?:\/\/(?:[mi]\.)?imgur\.com\/([a-z0-9]+)(?:\.([a-z0-9]+))?/i;
export const RE_TWIMG =
  /^https?:\/\/pbs\.twimg\.com\/media\/([\w-]+)(?:\.(\w+))?(?:\?.*?format=(\w+))?/i;
export const RE_MEEE = /^https?:\/\/meee\.com\.tw\/(\w+)(?:\.(\w+))?/i;

// tenor 的**分享頁**（HTML，不是媒體檔）：短連結 tenor.com/<code>.gif 與
// tenor.com/view/<slug>-<id>。刻意不含 media*.tenor.com——那是直連檔，交給泛用的
// 圖片／影片 resolver 即可。短連結雖以 .gif 結尾卻是網頁，故這條**必須排在
// RE_IMAGE_EXT 之前**判斷，否則會被當成直連圖而載入失敗（本功能的原始 bug）。
export const RE_TENOR =
  /^https?:\/\/(?:www\.)?tenor\.com\/(?:view\/[\w-]+-\d+|[A-Za-z0-9]{1,16}\.gif)(?:$|[?#])/i;

// 會解析成「靜態圖片／相簿」的 URL 才算（youtube/twitch iframe、影片檔不算——
// 那些不是漫畫圖，右欄翻譯貼上去沒有意義）。
//
// tenor 例外說明：它最終渲染成 <video>（GIF 語意的自動循環），這裡仍算圖片列。
// 理由同 imgur 的影片型資產——同步判斷是圖、descriptor 是 video 的組合早就存在，
// 圖文合併塊也已支援（見 main.css 的 .mergedImageCol .easyReadingVideo）。
// 兩種 tenor 連結形式（短連結／view）判定要一致，否則同一則圖只因寫法不同就一個
// 進合併塊、一個不進。
export function isImageLikeUrl(src) {
  if (!src) return false;
  return (
    RE_IMGUR_ALBUM.test(src) ||
    (RE_IMGUR_SINGLE.test(src) && !/\/(?:a|gallery)\//i.test(src)) ||
    RE_TWIMG.test(src) ||
    RE_MEEE.test(src) ||
    RE_TENOR.test(src) ||
    RE_IMAGE_EXT.test(src)
  );
}

// Flickr 短網址（flic.kr/p/<id>）的 base58 解碼。注意字母表是 Flickr 自家順序
// （數字→小寫→大寫，去 0OIl），與 Bitcoin 系 bs58（數字→大寫→小寫）不同、不可混用。
// 原依賴 npm `base58`（2014 年後未維護）內聯至此；行為與該套件 decode 一致。
const FLICKR_B58_ALPHABET =
  "123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
export function flickrBase58Decode(str) {
  let num = 0;
  for (const ch of str) {
    const idx = FLICKR_B58_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error("not a valid Base58 string: " + str);
    num = num * 58 + idx;
  }
  return num;
}
