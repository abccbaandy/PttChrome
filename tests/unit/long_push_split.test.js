// 長推文分段的純邏輯（src/js/long_push.js）。
//
// 這批數字全部來自 3rd_script/pttbbs 的 mbbsd/bbs.c#recommend 與
// mbbsd/vtuikit.c#vgetstring（見 long_push.js 檔頭的推導），一旦算錯的後果不是
// 畫面難看而是**整條送出序列卡死**：超過 vgetstring 的 DBCS 保護門檻時
// vkey_purge() 會把後面那個 \r 一起清掉，推文就停在輸入列。

import { loadBig5Tables } from "./helpers/load_big5_tables";
import {
  stripNonBig5,
  big5ByteLength,
  pushMaxBytes,
  splitPushSegments,
  findUrlSpans,
} from "../../src/js/long_push";
import { detectIpLogged } from "../../src/js/push_screen";

beforeAll(() => loadBig5Tables());

describe("stripNonBig5", () => {
  test("Big5 表內的中英文原樣保留", () => {
    const r = stripNonBig5("測試 abc 123");
    expect(r.text).toBe("測試 abc 123");
    expect(r.dropped).toEqual([]);
  });

  test("emoji（surrogate pair）整個字被移除並回報一次", () => {
    const r = stripNonBig5("好耶🎉收工");
    expect(r.text).toBe("好耶收工");
    expect(r.dropped).toEqual(["🎉"]);
  });

  // u2b 對轉不出 Big5 的字回 '\xFF\xFD'，0xFF 就是 telnet IAC，而 telnet.js 不做
  // IAC 跳脫 ⇒ 沒濾掉就會被 server 當成 telnet 命令而不是文字。
  test("BMP 內但不在 Big5 的字（諺文）也被移除", () => {
    // Big5 收了日文假名（あ 會留下），所以這裡要挑真的不在表內的字。
    const r = stripNonBig5("한測試");
    expect(r.text).toBe("測試");
    expect(r.dropped).toEqual(["한"]);
  });

  test("換行統一成 \\n（留給分段當強制斷點），其餘控制字元丟掉", () => {
    const r = stripNonBig5("a\r\nb\tc\x1bd");
    expect(r.text).toBe("a\n\nb" + "c" + "d");
    expect(r.dropped).toEqual(["\t", "\x1b"]);
  });
});

describe("big5ByteLength", () => {
  test("ASCII 1 byte、全形 2 bytes", () => {
    expect(big5ByteLength("abc")).toBe(3);
    expect(big5ByteLength("中文")).toBe(4);
    expect(big5ByteLength("a中b")).toBe(4);
  });
});

describe("pushMaxBytes", () => {
  // bbs.c#recommend: maxlength = 62 [- 15 if BRD_IPLOGRECMD/guest] - strlen(myid)
  // term.ptt.cc 實測少一格（§11.1/§12）⇒ 61 / 46；vgetstring 可打 maxlength - 1。
  test("一般看板 = 60 - len(id)", () => {
    expect(pushMaxBytes({ userId: "testuser", ipLogged: false })).toBe(52);
    expect(pushMaxBytes({ userId: "ab", ipLogged: false })).toBe(58);
  });

  test("IP 記錄板 = 45 - len(id)", () => {
    expect(pushMaxBytes({ userId: "testuser", ipLogged: true })).toBe(37);
  });

  test("判不出 IP 板時取較短的（安全方向），沒有 id 時用 IDLEN=12 保守估", () => {
    expect(pushMaxBytes({ userId: "testuser" })).toBe(37);
    expect(pushMaxBytes({})).toBe(33);
  });
});

describe("detectIpLogged", () => {
  const done = (body, ip) =>
    "推 someone: " + body + (ip ? " " + ip : "") + " 08/26 12:00";

  test("推文列時間戳前有 IPv4 → IP 記錄板", () => {
    expect(detectIpLogged([done("hi", "1.2.3.4")])).toBe(true);
  });

  test("推文列沒有 IP → 非 IP 記錄板", () => {
    expect(detectIpLogged([done("hi")])).toBe(false);
  });

  test("畫面上一則推文都沒有 → null（呼叫端保守當 IP 板）", () => {
    expect(detectIpLogged(["  瀏覽 第 1/2 頁", "內文"])).toBe(null);
  });
});

describe("splitPushSegments", () => {
  test("短文不分段", () => {
    expect(splitPushSegments("短短一句", 52)).toEqual(["短短一句"]);
  });

  test("每段的 Big5 byte 數都不超過上限", () => {
    const text = "測試".repeat(60);
    const segs = splitPushSegments(text, 20);
    expect(segs.length).toBeGreaterThan(1);
    for (const s of segs) expect(big5ByteLength(s)).toBeLessThanOrEqual(20);
    expect(segs.join("")).toBe(text);
  });

  test("永遠不切在雙 byte 字中間（合回去等於原文）", () => {
    const text = "一二三四五六七八九十";
    const segs = splitPushSegments(text, 7);
    for (const s of segs) expect(big5ByteLength(s) % 2).toBe(0);
    expect(segs.join("")).toBe(text);
  });

  // vtuikit.c:1404-1411 的 DBCS 保護：`len - iend < 3` 就 vkey_purge()。Big5 的第二
  // 個 byte 常常也 > 0x80，段末剛好塞滿時會踩到 → 後面的 \r 被一起清掉 → 卡死。
  test("段末是全形字時多留 1 byte 餘裕（奇數上限才用得滿）", () => {
    const segs = splitPushSegments("一二三四五六", 5);
    // 上限 5 但段末是全形 ⇒ 只收 4 bytes（兩個字），不會剛好貼到 5。
    expect(big5ByteLength(segs[0])).toBe(4);
  });

  test("段末是 ASCII 時可以用滿上限", () => {
    const segs = splitPushSegments("abcdefghij", 5);
    expect(segs[0]).toBe("abcde");
  });

  test("優先在空白處斷，不切斷英文單字", () => {
    const segs = splitPushSegments("hello world foobar", 12);
    expect(segs[0]).toBe("hello world");
  });

  test("優先在全形標點後斷", () => {
    const segs = splitPushSegments("今天天氣真好，我們出去走走吧", 20);
    expect(segs[0]).toBe("今天天氣真好，");
  });

  test("回頭找不到標點時硬切（不會為了找斷點把段落切得太碎）", () => {
    const text = "一二三四五六七八九十";
    const segs = splitPushSegments(text, 8);
    // 8 bytes 放得下 4 個字，但段末全形要留 1 byte 餘裕 ⇒ 只收 3 個。
    expect(segs[0]).toBe("一二三");
  });

  test("換行是強制斷點", () => {
    expect(splitPushSegments("第一行\n第二行", 52)).toEqual([
      "第一行",
      "第二行",
    ]);
  });

  test("空行與純空白行不產生空推文", () => {
    expect(splitPushSegments("a\n\n   \nb", 52)).toEqual(["a", "b"]);
    expect(splitPushSegments("", 52)).toEqual([]);
  });

  test("斷點後的空白不帶進下一段", () => {
    const segs = splitPushSegments("aaaa bbbb", 5);
    expect(segs).toEqual(["aaaa", "bbbb"]);
  });
});

// 圖片上傳會把圖床網址插進長推文輸入框（docs/image-upload.md 的 target 模式）。
// 網址被切成兩則＝PTT 上兩則各一半，圖**永遠開不起來**——這是使用者看得到的
// 正確性，不是美觀問題。零件與 url_join.js 共用，不另寫 regex。
describe("findUrlSpans", () => {
  test("抓得到 scheme 開頭的整段網址", () => {
    expect(findUrlSpans("看這個 https://i.urusai.cc/ab.png 收工")).toEqual([
      { start: 4, end: 30 },
    ]);
  });

  test("沒有 scheme 的字串不算網址（避免把一般文字當成不可切）", () => {
    expect(findUrlSpans("i.urusai.cc/ab.png")).toEqual([]);
  });

  test("多條網址各自成段", () => {
    expect(findUrlSpans("a https://x.tw/1.png b http://y.tw/2.png").length).toBe(
      2,
    );
  });
});

describe("splitPushSegments：URL 保護", () => {
  // 沒有保護時：硬切落在 .png 的 '.' 之前，回退又把那個 '.' 當成合法斷點
  // ⇒ 切出 "…/ab." + "png"。
  test("塞得下就整條留在同一則（回退不把 URL 內部的 . 當斷點）", () => {
    expect(splitPushSegments("看這個 https://i.urusai.cc/ab.png", 30)).toEqual([
      "看這個",
      "https://i.urusai.cc/ab.png",
    ]);
  });

  test("網址前有一大段中文時也不切斷它", () => {
    const url = "https://i.urusai.cc/ab.png";
    const segs = splitPushSegments("今天天氣真好我們出去走走吧 " + url, 30);
    expect(segs.some((s) => s.indexOf(url) >= 0)).toBe(true);
    for (const s of segs) expect(big5ByteLength(s)).toBeLessThanOrEqual(30);
  });

  test("網址剛好塞得下整則時不會被前面的標點擠掉", () => {
    const segs = splitPushSegments("好，https://i.urusai.cc/ab.png", 26);
    expect(segs).toContain("https://i.urusai.cc/ab.png");
  });

  // 例外只有一種：URL 本身就比單則上限長 ⇒ 只能硬切（PTT 沒有「不切」這個選項），
  // modal 會事先警告。保護必須是「盡量」，不能因為退不動就原地卡住。
  test("URL 比上限還長 → 硬切、照樣前進（不得無限迴圈／不得回空陣列）", () => {
    const url = "https://i.urusai.cc/abcdefgh.png";
    const segs = splitPushSegments(url, 10);
    expect(segs.length).toBeGreaterThan(1);
    for (const s of segs) expect(big5ByteLength(s)).toBeLessThanOrEqual(10);
    expect(segs.join("")).toBe(url);
  });

  test("前面有文字、URL 又比上限長時仍切得出完整段落", () => {
    const segs = splitPushSegments("看這個 https://i.urusai.cc/abcdefgh.png", 10);
    expect(segs.length).toBeGreaterThan(1);
    expect(segs[0]).toBe("看這個");
    expect(segs.join("").indexOf("https://")).toBeGreaterThanOrEqual(0);
  });
});
