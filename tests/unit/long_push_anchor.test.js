// 長推文的游標錨定（src/js/long_push_anchor.js）——純函式層。
//
// 這些判斷擋的是「推到別篇文章」：pttbbs 的列表游標 crs_ln 只是 .DIR 行號，
// 板上一有增刪就同編號≠同一篇（read.c:1198-1221，詳見模組檔頭）。所以每一條
// case 都要問「讀不出來時會不會誤判成 ok」——保守方向永遠是 unknown/moved。

import {
  subjectKey,
  listRowIdentity,
  articleAnchor,
  captureCursorAnchor,
  subjectMatches,
  checkCursorAnchor,
  findAnchorRowNum,
} from "../../src/js/long_push_anchor";

// 依 bbs.c#readdoent 的 printf 序列排版（欄位表見 comment_parse.js）：
//   0-6 %7d 序號 | 7 空格 | 8 型別 | 9-10 推文數 | 11-16 %-6.5s 日期
//   17-29 %-13.12s 作者 | 30- mark + 標題
function listRow(num, author, title, opts) {
  const o = opts || {};
  const seq =
    o.cursor === "old"
      ? "●" + String(num).slice(-5) // 全形 ● 蓋掉 cell 0-1（前導空格＋最高位）
      : o.cursor
        ? ">" + String(num).padStart(6)
        : String(num).padStart(7);
  return (
    seq +
    " " +
    (o.type || " ") +
    (o.push || "  ") +
    " 9/01 " +
    author.padEnd(13).slice(0, 13) +
    (o.mark || "□") +
    title
  );
}

// 置底列：readdoent 在序號欄印 "  " + "  ★ " 而不是 %7d（★ 是全形，rowToText
// 收合成 1 個字元 ⇒ 這 7 個 cell 在文字裡是 6 個字，realignListColumns 會補回來）。
const PINNED_ROW =
  "    ★ " + " " + " " + "  " + " 9/01 " + "sysop".padEnd(13) + "□公告";
// 已刪除列：pttbbs 在作者欄印 "-"，parseListAuthor 的 USERID_RE 會擋掉。
const DELETED_ROW = listRow(100, "-", "(本文已被刪除) [someone]");

const ANCHOR = { author: "abcuser", subject: "[閒聊] 原本那篇" };

// facts 的形狀同 list_session._collectFacts（rowTexts / curY / rows），nums 與
// cursorRowNum 刻意不給，讓 long_push_anchor 自己用 pageArticleNums 補。
function facts(rows, curY) {
  const rowTexts = new Array(24).fill("");
  rowTexts[0] = "【看板 Test】";
  rowTexts[2] = "  編號    日 期 作  者       文  章  標  題";
  rows.forEach((t, i) => (rowTexts[3 + i] = t));
  rowTexts[23] = " 文章選讀 ";
  return { rowTexts, rows: 24, curY };
}

describe("subjectKey", () => {
  test("剝掉 Re:/Fw: 前綴（大小寫不敏感、可疊）", () => {
    expect(subjectKey("Re: [問卦] 安安")).toBe("[問卦] 安安");
    expect(subjectKey("re: Fw: 疊起來")).toBe("疊起來");
    expect(subjectKey("  [心得] 前後空白  ")).toBe("[心得] 前後空白");
  });

  test("空的回 null（沒有基準就不能宣稱 ok）", () => {
    expect(subjectKey("")).toBe(null);
    expect(subjectKey(null)).toBe(null);
    expect(subjectKey("Re: ")).toBe(null);
  });
});

describe("listRowIdentity", () => {
  test("一般列讀得出作者與主題", () => {
    expect(listRowIdentity(listRow(1234, "abcUser", "[閒聊] 原本那篇"))).toEqual({
      author: "abcuser",
      subject: "[閒聊] 原本那篇",
    });
  });

  test("游標列兩代都讀得出來（> 不位移欄位、● 位移一格由 realign 補回）", () => {
    const neu = listRowIdentity(
      listRow(349886, "abcUser", "[閒聊] 原本那篇", { cursor: true }),
    );
    const old = listRowIdentity(
      listRow(349886, "abcUser", "[閒聊] 原本那篇", { cursor: "old" }),
    );
    expect(neu).toEqual({ author: "abcuser", subject: "[閒聊] 原本那篇" });
    expect(old).toEqual(neu);
  });

  test("R: 型別符與置底/刪除/空列", () => {
    expect(
      listRowIdentity(listRow(7, "abcUser", "[閒聊] 原本那篇", { mark: "R:" }))
        .subject,
    ).toBe("[閒聊] 原本那篇");
    // 置底列沒有編號、已刪除列作者欄是 "-"、空列什麼都沒有 ⇒ 一律 null，
    // 呼叫端會當成 unknown 而不是 ok。
    expect(listRowIdentity(PINNED_ROW)).not.toBeNull(); // ★ 列仍有作者，靠編號排除
    expect(listRowIdentity(DELETED_ROW)).toBe(null);
    expect(listRowIdentity("")).toBe(null);
    expect(listRowIdentity("   短列   ")).toBe(null);
  });
});

describe("articleAnchor", () => {
  test("從文章標頭取作者＋主題（Re: 被正規化掉）", () => {
    expect(
      articleAnchor([
        "作者  abcUser (安安) 看板 Test",
        "標題  Re: [閒聊] 原本那篇",
        "時間  Mon Sep  1 12:00:00 2026",
      ]),
    ).toEqual({ author: "abcuser", subject: "[閒聊] 原本那篇" });
  });

  test("只有一半（沒標題／不是標頭）回 null", () => {
    expect(articleAnchor(["作者  abcUser (安安) 看板 Test"])).toBe(null);
    expect(articleAnchor(["這是內文", "還是內文"])).toBe(null);
    expect(articleAnchor(null)).toBe(null);
  });
});

describe("subjectMatches：容忍 readdoent 的截斷", () => {
  // bbs.c#readdoent: strlen(title) > w ⇒ outns(title, w-2) + "…"
  test("列表側被截斷時只比前綴", () => {
    expect(subjectMatches("[閒聊] 超級無敵長的標題會被截…", "[閒聊] 超級無敵長的標題會被截掉一段")).toBe(true);
  });

  test("錨點側被截斷時也比得上（錨點取自落地幀的情況）", () => {
    expect(subjectMatches("[閒聊] 超級無敵長的標題會被截掉一段", "[閒聊] 超級無敵長的標題會被截…")).toBe(true);
  });

  test("前綴不同就是不同", () => {
    expect(subjectMatches("[公告] 別篇…", "[閒聊] 原本那篇")).toBe(false);
    expect(subjectMatches("[閒聊] 原本那篇", "[閒聊] 原本那篇 2")).toBe(false);
    expect(subjectMatches("", "[閒聊] 原本那篇")).toBe(false);
  });
});

describe("checkCursorAnchor", () => {
  test("游標還在原篇 → ok", () => {
    const f = facts(
      [
        listRow(1233, "someone", "[公告] 別篇"),
        listRow(1234, "abcUser", "[閒聊] 原本那篇", { cursor: true }),
      ],
      4,
    );
    expect(checkCursorAnchor(f, ANCHOR)).toBe("ok");
  });

  test("游標飄到別篇 → moved（就是使用者踩到的那個 bug）", () => {
    const f = facts(
      [
        listRow(1233, "abcUser", "[閒聊] 原本那篇"),
        listRow(1234, "otherGuy", "[公告] 剛剛才貼的新文", { cursor: true }),
      ],
      4,
    );
    expect(checkCursorAnchor(f, ANCHOR)).toBe("moved");
  });

  test("同作者不同標題／同標題不同作者都算 moved", () => {
    const sameAuthor = facts(
      [listRow(1234, "abcUser", "[閒聊] 另一篇", { cursor: true })],
      3,
    );
    const sameTitle = facts(
      [listRow(1234, "otherGuy", "[閒聊] 原本那篇", { cursor: true })],
      3,
    );
    expect(checkCursorAnchor(sameAuthor, ANCHOR)).toBe("moved");
    expect(checkCursorAnchor(sameTitle, ANCHOR)).toBe("moved");
  });

  test("讀不出身分／沒有錨點 → unknown（絕不回 ok）", () => {
    expect(checkCursorAnchor(facts([""], 3), ANCHOR)).toBe("unknown");
    expect(checkCursorAnchor(facts([DELETED_ROW], 3), ANCHOR)).toBe("unknown");
    expect(
      checkCursorAnchor(facts([listRow(1, "abcUser", "x", { cursor: true })], 3), null),
    ).toBe("unknown");
    expect(checkCursorAnchor(null, ANCHOR)).toBe("unknown");
  });
});

describe("findAnchorRowNum", () => {
  test("原篇還在同一頁 → 回它的編號", () => {
    const f = facts(
      [
        listRow(1233, "abcUser", "[閒聊] 原本那篇"),
        listRow(1234, "otherGuy", "[公告] 新文", { cursor: true }),
        listRow(1235, "third", "[問卦] 又一篇"),
      ],
      4,
    );
    expect(findAnchorRowNum(f, ANCHOR)).toBe(1233);
  });

  test("原篇不在這一頁 → null（呼叫端改走 #AID 或停手）", () => {
    const f = facts(
      [
        listRow(1233, "otherGuy", "[公告] 新文"),
        listRow(1234, "third", "[問卦] 又一篇", { cursor: true }),
      ],
      4,
    );
    expect(findAnchorRowNum(f, ANCHOR)).toBe(null);
  });

  test("置底列不會被選中（沒有編號，跳不過去）", () => {
    const f = facts([PINNED_ROW, listRow(1234, "x", "y", { cursor: true })], 4);
    expect(findAnchorRowNum(f, { author: "sysop", subject: "公告" })).toBe(null);
  });

  test("沒有錨點時不亂指", () => {
    const f = facts([listRow(1233, "abcUser", "[閒聊] 原本那篇")], 3);
    expect(findAnchorRowNum(f, null)).toBe(null);
  });
});

describe("captureCursorAnchor", () => {
  test("採到游標列的身分與編號", () => {
    const f = facts(
      [
        listRow(1233, "someone", "[公告] 別篇"),
        listRow(1234, "abcUser", "[閒聊] 原本那篇", { cursor: true }),
      ],
      4,
    );
    expect(captureCursorAnchor(f)).toEqual({
      author: "abcuser",
      subject: "[閒聊] 原本那篇",
      num: 1234,
    });
  });

  test("讀不出身分就不採（留到下一幀再試）", () => {
    expect(captureCursorAnchor(facts([""], 3))).toBe(null);
  });
});
