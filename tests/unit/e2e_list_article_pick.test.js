// live e2e 選文的欄位解析（2026-08-29）。
//
// 為什麼要有這條：「開哪一篇」以前靠 End → Enter，而 End ＝ read.c 的 last_line，
// **含置底公告**（C_Chat 的置底是十幾頁）⇒ 好讀累積跑不完、常常一張圖／一則推文都
// 沒有 ⇒ 內容相依的斷言必紅。改成從列表畫面挑序號之後，「哪些列可以開」變成純字串
// 判斷 —— 那就該在 unit 鎖住，不必每次靠 live 才發現挑錯。
//
// 欄位依據 docs/pttbbs-screen-protocol.md §（readdoent 欄位表，0-indexed）：
//   cols 0-6 序號 %7d（置底文改印同寬的 ★，**沒有數字**）
//   col 7 空白 / col 8 type / cols 9-10 推文數（爆・XX・數字）
//   cols 11-16 日期 / 17-29 作者 / 30-31 mark / 32 空白 / 33- 標題
import { listArticleNumbers } from "../e2e/helpers/ptt";

// 依欄位表組一列，長度與欄位起點都與真畫面一致。
const row = ({ num = "   1234", type = " ", push = "  ", author = "someuser" }) =>
  num + " " + type + push + "8/29  " + author.padEnd(13, " ").slice(0, 13) + "□ " + " [問題] 標題";

describe("listArticleNumbers（列表選文的欄位解析）", () => {
  test("序號在 cols 0-6，推文數在 cols 9-10", () => {
    const rows = [row({ num: "   1234", push: "12" }), row({ num: "   1235", push: " 3" })];
    expect(listArticleNumbers(rows)).toEqual([
      { num: 1234, push: 12 },
      { num: 1235, push: 3 },
    ]);
  });

  test("維持畫面由上而下的順序（＝由舊到新），不自行排序", () => {
    const rows = [row({ num: "   1240", push: " 1" }), row({ num: "   1241", push: "50" })];
    expect(listArticleNumbers(rows).map((c) => c.num)).toEqual([1240, 1241]);
  });

  test("置底文沒有序號 ⇒ 不會成為候選（這就是不用 End 的理由）", () => {
    // 置底列的 cols 0-6 是同寬的 ★，rowToText 後沒有數字。
    const pinned = "    ★  " + " " + "  " + "8/29  " + "SYSOP        " + "□ " + " [公告] 板規";
    expect(listArticleNumbers([pinned])).toEqual([]);
  });

  test("游標列（'>' 只蓋掉行首空格，欄位不位移）照樣挑得到", () => {
    const cursor = ">  1234" + " " + " " + "12" + "8/29  " + "someuser     " + "□ " + " [問題] 標題";
    expect(listArticleNumbers([cursor])).toEqual([{ num: 1234, push: 12 }]);
  });

  test("爆文與負推（X/XX）一律排除：推文數以百計，好讀累積跑很久", () => {
    const boom = row({ num: "   1300", push: "爆" });
    const minus = row({ num: "   1301", push: "XX" });
    expect(listArticleNumbers([boom, minus])).toEqual([]);
    expect(listArticleNumbers([boom, minus], { min: 0 })).toEqual([]);
  });

  test("min=0 ＝ 不挑推文數（沒有推文的文章也收，push 記 0）", () => {
    const none = row({ num: "   1310", push: "  " });
    expect(listArticleNumbers([none], { min: 0 })).toEqual([{ num: 1310, push: 0 }]);
    // min>0 ＝ 一定要有推文數且 >= min
    expect(listArticleNumbers([none], { min: 8 })).toEqual([]);
  });

  test("min/max 是閉區間", () => {
    const rows = [
      row({ num: "   1320", push: " 7" }),
      row({ num: "   1321", push: " 8" }),
      row({ num: "   1322", push: "99" }),
    ];
    expect(listArticleNumbers(rows, { min: 8, max: 99 }).map((c) => c.num)).toEqual([1321, 1322]);
    expect(listArticleNumbers(rows, { min: 8, max: 20 }).map((c) => c.num)).toEqual([1321]);
  });

  test("空輸入／空列不炸", () => {
    expect(listArticleNumbers(undefined)).toEqual([]);
    expect(listArticleNumbers(["", "   ", null])).toEqual([]);
  });
});
