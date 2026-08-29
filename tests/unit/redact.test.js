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
