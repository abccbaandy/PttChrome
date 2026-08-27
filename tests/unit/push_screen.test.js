// 「server 這一幀在等我們做什麼」的畫面分類（src/js/push_screen.js）。
// 長推文送出序列（long_push_session.js）與圖片上傳（image_upload.js 決定網址
// 要送進推文列還是只複製）共用這一支，所以這裡紅了是兩個功能一起壞。
//
// 每一條字串都照 3rd_script/pttbbs 的 printf 格式建構（函式名為準，行號會漂）：
//   bbs.c#recommend      型別選單 / 作者本人 / 時間太近 / 內容輸入 / 確定[y/N]
//                        ＋ 全部的擋人與冷卻 vmsg
//   bbs.c#check_cooldown 冷靜一下吧 / 您被設退文 / 間隔太近囉
//   vtuikit.c#vshowmsg   " ◆ " 前綴與右靠的 " [按任意鍵繼續]"
// 認錯的後果是狀態機把鍵送到錯的地方——在「時間太近」那一幀送型別鍵 "1"，那個 1
// 會直接變成推文內容。

import {
  classifyPushScreen,
  parseVmsgText,
  parseCooldownSeconds,
} from "../../src/js/push_screen";

const ROWS = 24;
// 一幀畫面：只有底列（b_lines）有意義，其餘留白。
const screen = (lastRow, extra) => {
  const rows = new Array(ROWS).fill("");
  rows[ROWS - 1] = lastRow;
  if (extra) for (const k of Object.keys(extra)) rows[k] = extra[k];
  return rows;
};
// vtuikit.c#vshowmsg：" ◆ 訊息" 左靠，" [按任意鍵繼續]" 右靠。
const vmsg = (msg) => {
  const head = " ◆ " + msg;
  const tail = " [按任意鍵繼續]";
  return head + " ".repeat(Math.max(1, 78 - head.length - tail.length)) + tail;
};
const kindOf = (lastRow) => classifyPushScreen(screen(lastRow), ROWS).kind;

describe("型別選單（bbs.c#recommend 的 else 分支）", () => {
  test("一般看板", () => {
    const r = classifyPushScreen(
      screen("您覺得這篇文章 1.值得推薦 2.給它噓聲 3.只加→註解 [1]? "),
      ROWS,
    );
    expect(r.kind).toBe("typeMenu");
    expect(r.booAllowed).toBe(true);
  });

  // BRD_NOBOO 的板子直接不印 "2."，但 "3." 仍然是 3（迴圈跳過的是 i，不是編號）。
  test("禁噓板少印 2.，仍認得是型別選單", () => {
    const r = classifyPushScreen(
      screen("您覺得這篇文章 1.值得推薦 3.只加→註解 [1]? "),
      ROWS,
    );
    expect(r.kind).toBe("typeMenu");
    expect(r.booAllowed).toBe(false);
  });
});

describe("沒有型別選單的兩個變體（互斥的 if / else if）", () => {
  // 提示畫在 b_lines-1，底列直接就是內容輸入列 ⇒ 這時**不可以**送型別鍵。
  test("時間太近（90 秒內連推）→ 直接是輸入列", () => {
    const rows = screen("→ testuser: ", {
      [ROWS - 2]: "時間太近, 使用 → 加註方式",
    });
    const r = classifyPushScreen(rows, ROWS);
    expect(r.kind).toBe("inputPrompt");
    expect(r.userId).toBe("testuser");
    expect(r.type).toBe("→");
  });

  test("作者本人 → 直接是輸入列", () => {
    const rows = screen("→ myself: ", {
      [ROWS - 2]: "作者本人, 使用 → 加註方式",
    });
    expect(classifyPushScreen(rows, ROWS).kind).toBe("inputPrompt");
  });
});

describe("輸入列 / 確認列", () => {
  test("推 / 噓 / → 三種型別符都認得", () => {
    expect(kindOf("推 testuser: ")).toBe("inputPrompt");
    expect(kindOf("噓 testuser: ")).toBe("inputPrompt");
    expect(kindOf("→ testuser: ")).toBe("inputPrompt");
  });

  test("BRD_ALIGNEDCMT 的 id 補空白版本也認得", () => {
    const r = classifyPushScreen(screen("推 abc         : "), ROWS);
    expect(r.kind).toBe("inputPrompt");
    expect(r.userId).toBe("abc");
  });

  // 有行尾時間戳的是**已完成**的推文列，不是可以打字的地方。
  test("已完成的推文列不可被誤判成輸入列", () => {
    expect(kindOf("→ testuser: 這是已經推出去的內容        08/26 12:00")).toBe(
      "other",
    );
  });

  test("確定[y/N]（前面那個空白是格式的一部分）", () => {
    expect(kindOf("推 testuser: 內容                       確定[y/N]:")).toBe(
      "confirm",
    );
  });

  test("小天使匿名詢問（vans，要 Enter；空 Enter 等於答 YES）", () => {
    expect(kindOf("要使用小天使匿名推文嗎？ [Y/n]: ")).toBe("angel");
  });
});

describe("冷卻（等得到的）", () => {
  const cool = (msg) => classifyPushScreen(screen(vmsg(msg)), ROWS);

  test("本板禁止快速連續推文（板主可設 5-240 秒）", () => {
    const r = cool("本板禁止快速連續推文，請再等 37 秒");
    expect(r.kind).toBe("cooldown");
    expect(r.waitSec).toBe(37);
  });

  test("本文已過長（>100KiB，固定 10 秒）", () => {
    const r = cool("本文已過長, 禁止快速連續推文, 請再等 6 秒");
    expect(r.kind).toBe("cooldown");
    expect(r.waitSec).toBe(6);
  });

  test("冷靜一下吧（分＋秒）", () => {
    const r = cool("冷靜一下吧！ (限制 2 分 5 秒)");
    expect(r.kind).toBe("cooldown");
    expect(r.waitSec).toBe(125);
  });

  test("間隔太近囉（REJECT_FLOOD_POST）", () => {
    const r = cool("對不起，您的文章或推文間隔太近囉！ (限制 0 分 42 秒)");
    expect(r.kind).toBe("cooldown");
    expect(r.waitSec).toBe(42);
  });
});

describe("致命（等了也沒用 → 中止）", () => {
  const fatal = (msg) => classifyPushScreen(screen(vmsg(msg)), ROWS);

  test.each([
    ["抱歉, 禁止推薦"],
    ["無法推文: 使用者不可發言(尚有3天)"],
    ["本板推文限定管理人員使用。"],
    ["本文已刪除"],
    ["未達看板發文限制: 登入次數未滿 100 登入次數(目前37次) "],
    ["檔案太大, 無法繼續推文, 請另撰文發表"],
    ["錯誤: 資料庫連線異常，無法寫入。請稍候再試。"],
    ["系統禁止短時間內大量推文"],
  ])("%s", (msg) => {
    const r = fatal(msg);
    expect(r.kind).toBe("fatal");
    // 底列補滿空白是畫面格式，訊息本文取 trim 後的（遮罩要拿去顯示）。
    expect(r.message).toBe(msg.trim());
  });

  // 有秒數但等完照樣被擋（posttimesof == 0xf 是懲罰狀態），不可當成冷卻空等。
  test("您被設退文：帶秒數也算致命", () => {
    expect(fatal("對不起，您被設退文！ (限制 8 分 0 秒)").kind).toBe("fatal");
  });

  // 認不得的 ◆ 訊息一律停手：亂猜著繼續送鍵比停下來危險得多。
  test("未知的 ◆ 訊息一律當致命", () => {
    expect(fatal("某個沒見過的錯誤").kind).toBe("fatal");
  });
});

describe("其他畫面", () => {
  test("文章底部的 pmore 狀態列不是推文畫面", () => {
    expect(
      kindOf(
        "  瀏覽 第 1/2 頁 ( 50%)  目前顯示: 第 01~23 行  (y)回應(X%)推文(h)說明(←)離開 ",
      ),
    ).toBe("other");
  });

  test("空畫面", () => {
    expect(kindOf("")).toBe("other");
  });
});

describe("parseVmsgText / parseCooldownSeconds", () => {
  test("剝掉 ◆ 前綴與右靠的 [按任意鍵繼續]", () => {
    expect(parseVmsgText(vmsg("本文已刪除"))).toBe("本文已刪除");
  });

  test("底列不是橫幅時回 null", () => {
    expect(parseVmsgText("推 testuser: ")).toBe(null);
  });

  // 內文可能出現 ◆，但那是在文章區不是底列；底列左邊有東西就不是橫幅。
  test("◆ 前面有字就不是 vmsg 橫幅", () => {
    expect(parseVmsgText("推 abc: ◆ 看這個")).toBe(null);
  });

  test("認不出秒數回 null", () => {
    expect(parseCooldownSeconds("系統禁止短時間內大量推文")).toBe(null);
  });
});
