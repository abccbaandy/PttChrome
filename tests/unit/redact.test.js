import fs from "fs";
import path from "path";
import { redactUser, redactIPs, redactSecret, scrub } from "../../src/js/redact";

describe("redactUser", () => {
  it("等長遮蔽獨立 token（大小寫不敏感）", () => {
    expect(redactUser("hi MyUser :)", "myuser")).toBe("hi xxxxxx :)");
    expect(redactUser("myuser", "myuser")).toBe("xxxxxx"); // 頭尾邊界
  });

  it("不誤傷別人 id 的子串", () => {
    expect(redactUser("notmyuser2", "myuser")).toBe("notmyuser2");
  });

  it("Big5 尾位元組左邊界：「我是<id>」緊貼中文也能遮", () => {
    // 「是」Big5 = 0xAC 0x4F；0x4F='O' 是英數，靠 Big5 尾位元組規則放行。
    const s = "\xac\x4f" + "myuser" + " ";
    expect(redactUser(s, "myuser")).toBe("\xac\x4fxxxxxx ");
  });

  // REGRESSION（2026-10，live scenario 錄製的隱私把關抓到）：主功能表狀態列把帳號包在
  // 顏色碼裡「[ \x1b[1;31m<id>\x1b[0;30;47m ]」。左邊緊貼的是 SGR 結尾的 'm'（英數）⇒
  // 舊判準認定「不是邊界」整個沒遮，debug 錄製檔與 cassette 都帶著帳號。
  it("ANSI 控制序列左邊界：「\\x1b[1;31m<id>」也要遮", () => {
    expect(redactUser("| \x1b[1;31mMyUser\x1b[0;30;47m |", "myuser")).toBe(
      "| \x1b[1;31mxxxxxx\x1b[0;30;47m |"
    );
    expect(redactUser("\x1b[mmyuser", "myuser")).toBe("\x1b[mxxxxxx");
    // 但一般單字裡的 m 不是邊界：「summyuser」照舊不遮。
    expect(redactUser("summyuser", "myuser")).toBe("summyuser");
  });

  it("guest / 空 id 不動作", () => {
    expect(redactUser("guest here", "guest")).toBe("guest here");
    expect(redactUser("abc", "")).toBe("abc");
  });
});

describe("redactIPs", () => {
  it("等長遮 IPv4", () => {
    expect(redactIPs("來自: 1.22.333.4 ok")).toBe("來自: xxxxxxxxxx ok");
  });
});

describe("redactSecret", () => {
  it("無邊界判斷、全部出現處等長遮蔽", () => {
    expect(redactSecret("xp@ss1p@ss1y", "p@ss1")).toBe("xxxxxxxxxxxy");
  });
  it("空 secret 不動作", () => {
    expect(redactSecret("abc", "")).toBe("abc");
  });
});

describe("scrub", () => {
  it("ids + secrets + IP 全套", () => {
    const out = scrub("myuser pw123 1.2.3.4", ["myuser"], ["pw123"]);
    expect(out).toBe("xxxxxx xxxxx xxxxxxx");
  });
});

// 單一真相源守護：錄製器（tests/e2e/tools/record-cassette.spec.js）曾經自己複製一份
// 逐字相同的 redactUser/redactIPs。隱私把關的邏輯拆成兩半 = 只修其中一半時另一半
// 靜默失效，而它把關的是「公開 fork 的素材裡不可以有 PTT 帳號／IP」。
// ⇒ 錄製器一律 require 這個模組，不准自帶實作。
describe("錄製器共用 src/js/redact（不得自帶實作）", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "e2e", "tools", "record-cassette.spec.js"),
    "utf8"
  );

  it("record-cassette.spec.js require 得到 src/js/redact", () => {
    expect(src).toMatch(/require\(['"][^'"]*src\/js\/redact['"]\)/);
  });

  it("record-cassette.spec.js 不再自行定義 redactUser / redactIPs", () => {
    expect(src).not.toMatch(/function\s+redactUser\s*\(/);
    expect(src).not.toMatch(/function\s+redactIPs\s*\(/);
  });
});
