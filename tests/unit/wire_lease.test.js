// 線路使用權（src/js/wire_lease.js，架構 review A2 步驟 b，docs/wire-send.md「線路使用權」）。
//
// 以前 serialized_op_gate 逐一列舉每個功能的 `xxxInFlight` 旗標與提示字，每加一個送鍵功能
// 就要回去補一行；漏了＝那個功能跑序列時使用者的鍵照送，跟序列競態（PTT typeahead 吃掉
// 中間那幀、打進 prompt）。現在功能帶著提示字向線路取得使用權，閘門只問「有沒有人拿著」。
import fs from "node:fs";
import path from "node:path";
import {
  acquireWire,
  releaseWire,
  wireLeaseHint,
  holdWireWhile,
  LEASE_FALLBACK_HINT,
} from "../../src/js/wire_lease";
import { AidNavigation } from "../../src/js/aid_navigation";
import { LongPushSession } from "../../src/js/long_push_session";
import { LogoutSession } from "../../src/js/logout_session";
import { BoardNoteSkip } from "../../src/js/board_note_skip";
import { serializedOpHint } from "../../src/js/serialized_op_gate";
import { beginInFlight, endInFlight, SEARCH_HINT } from "../../src/js/article_search";
import { UNREAD_JUMP_FLAG, UNREAD_JUMP_HINT } from "../../src/js/unread_jump";
import { HOME_FAV_FETCH_FLAG, HOME_FAV_FETCH_HINT } from "../../src/js/home_dashboard";
import { MARK_ALL_READ_FLAG, MARK_ALL_READ_HINT } from "../../src/js/mark_all_read";
import { NATIVE_READ_LATER_FLAG, NATIVE_READ_LATER_HINT } from "../../src/js/native_read_later";
import { REFRESH_FLAG, REFRESH_HINT } from "../../src/js/screen_refresh";

const SRC = path.resolve(__dirname, "../../src");

afterEach(() => {
  vi.useRealTimers();
});

describe("acquireWire／releaseWire", () => {
  test("拿著 ⇒ 閘門給它的提示字、鏡像欄位為 true；放掉 ⇒ 線路空著、鏡像 false", () => {
    const core = {};
    expect(serializedOpHint(core)).toBe(null);
    acquireWire(core, "fooInFlight", "忙著做 foo", 1000);
    expect(core.fooInFlight).toBe(true);
    expect(serializedOpHint(core)).toBe("忙著做 foo");
    releaseWire(core, "fooInFlight");
    expect(core.fooInFlight).toBe(false);
    expect(serializedOpHint(core)).toBe(null);
  });

  test("沒給提示字也不准無聲吞鍵：給保底提示", () => {
    const core = {};
    acquireWire(core, "fooInFlight", "", 1000);
    expect(wireLeaseHint(core)).toBe(LEASE_FALLBACK_HINT);
  });

  test("逾時自動放掉（防收尾漏掉造成永久吞鍵）", () => {
    vi.useFakeTimers();
    const core = {};
    acquireWire(core, "fooInFlight", "foo", 1000);
    vi.advanceTimersByTime(999);
    expect(core.fooInFlight).toBe(true);
    vi.advanceTimersByTime(1);
    expect(core.fooInFlight).toBe(false);
    expect(serializedOpHint(core)).toBe(null);
  });

  test("續約：逾時從最後一次拿起算，舊計時器不會提早放掉", () => {
    vi.useFakeTimers();
    const core = {};
    acquireWire(core, "fooInFlight", "foo", 1000);
    vi.advanceTimersByTime(800);
    acquireWire(core, "fooInFlight", "foo", 1000);
    vi.advanceTimersByTime(800);
    expect(core.fooInFlight).toBe(true);
    vi.advanceTimersByTime(200);
    expect(core.fooInFlight).toBe(false);
  });

  test("放掉後重拿（unread_jump 每頁接續的寫法）不會被前一份的計時器放掉", () => {
    vi.useFakeTimers();
    const core = {};
    acquireWire(core, "fooInFlight", "foo", 1000);
    vi.advanceTimersByTime(900);
    releaseWire(core, "fooInFlight");
    acquireWire(core, "fooInFlight", "foo", 1000);
    vi.advanceTimersByTime(200);
    expect(core.fooInFlight).toBe(true);
  });

  test("兩個人同時拿著：提示給先拿的；先拿的放掉後換另一個", () => {
    const core = {};
    acquireWire(core, "aInFlight", "A", 1000);
    acquireWire(core, "bInFlight", "B", 1000);
    expect(wireLeaseHint(core)).toBe("A");
    releaseWire(core, "aInFlight");
    expect(wireLeaseHint(core)).toBe("B");
    releaseWire(core, "bInFlight");
    expect(wireLeaseHint(core)).toBe(null);
  });

  test("沒拿著就放、core 不存在都不炸", () => {
    expect(() => releaseWire({}, "fooInFlight")).not.toThrow();
    expect(() => releaseWire(null, "fooInFlight")).not.toThrow();
    expect(wireLeaseHint(null)).toBe(null);
    expect(wireLeaseHint({})).toBe(null);
  });
});

// 提示字原本寫死在 serialized_op_gate，搬到各功能自己帶之後要一字不差（使用者看到的字不變）。
describe("各功能拿線路時的提示字與搬家前一致", () => {
  test.each([
    ["搜尋（預設 owner）", undefined, undefined, "searchInFlight", "搜尋中，請稍候…"],
    ["重新整理", REFRESH_FLAG, REFRESH_HINT, "refreshInFlight", "重新整理中，請稍候…"],
    ["跳到第一篇未讀", UNREAD_JUMP_FLAG, UNREAD_JUMP_HINT, "unreadJumpInFlight", "正在找第一篇未讀，請稍候…"],
    ["設為已讀", MARK_ALL_READ_FLAG, MARK_ALL_READ_HINT, "markAllReadInFlight", "設定已讀中，請稍候…"],
    ["稍後再讀（原生列表）", NATIVE_READ_LATER_FLAG, NATIVE_READ_LATER_HINT, "nativeReadLaterInFlight", "讀取文章代碼中，請稍候…"],
    ["首頁抓我的最愛", HOME_FAV_FETCH_FLAG, HOME_FAV_FETCH_HINT, "homeFavFetchInFlight", "正在更新我的最愛，請稍候…"],
  ])("%s", (_name, flag, hint, mirror, expected) => {
    const core = {};
    beginInFlight(core, flag, hint);
    expect(core[mirror]).toBe(true);
    expect(serializedOpHint(core)).toBe(expected);
    endInFlight(core, flag);
    expect(core[mirror]).toBe(false);
    expect(serializedOpHint(core)).toBe(null);
  });

  test("搜尋的預設提示字", () => {
    expect(SEARCH_HINT).toBe("搜尋中，請稍候…");
  });

  test("AID 跳文、長推文這些自己有 session 的仍排在使用權前面", () => {
    const core = {};
    beginInFlight(core, UNREAD_JUMP_FLAG, UNREAD_JUMP_HINT);
    const nav = new AidNavigation(core, null, null, null);
    nav.active = true;
    expect(serializedOpHint(core)).toBe("AID 跳文中，請稍候…");
    nav.active = false;
    expect(serializedOpHint(core)).toBe(UNREAD_JUMP_HINT);
  });
});

// A2 步驟 c：自己有 session 的序列建構時登記，閘門不再認識它們（docs/wire-send.md）。
describe("session 型持有者（holdWireWhile）", () => {
  // 真的 session 建構子（不是假物件）：App 建構時就是這樣登記的。
  function realSessions(order) {
    const core = {};
    const make = {
      aidNavigation: () => (core.aidNavigation = new AidNavigation(core, null, null, null)),
      longPush: () => (core.longPush = new LongPushSession(core, null, null, null)),
      logout: () => (core.logout = new LogoutSession(core, null, null, null)),
      boardNoteSkip: () => (core.boardNoteSkip = new BoardNoteSkip(core, null, null, null)),
    };
    for (const k of order) make[k]();
    return core;
  }

  test("各 session 的提示字與搬家前一字不差", () => {
    const core = realSessions(["aidNavigation", "longPush", "logout", "boardNoteSkip"]);
    expect(serializedOpHint(core)).toBe(null);
    core.aidNavigation.active = true;
    expect(serializedOpHint(core)).toBe("AID 跳文中，請稍候…");
    core.aidNavigation.opHint = "重新整理中，請稍候…";
    expect(serializedOpHint(core)).toBe("重新整理中，請稍候…");
    core.aidNavigation.active = false;
    core.longPush.active = true;
    core.longPush._phase = "preflight";
    expect(serializedOpHint(core)).toBe("正在確認能不能推文，請稍候…");
    core.longPush._phase = "sending";
    expect(serializedOpHint(core)).toBe("長推文送出中，請稍候…");
    core.longPush.active = false;
    core.logout.active = true;
    expect(serializedOpHint(core)).toBe("登出中，請稍候…");
    core.logout.active = false;
    core.boardNoteSkip.busy = true;
    expect(serializedOpHint(core)).toBe("略過進板畫面中，請稍候…");
    core.boardNoteSkip.busy = false;
    expect(serializedOpHint(core)).toBe(null);
  });

  test("長推文探完路等使用者打字（armed：busy 但不 active）⇒ 線路空著", () => {
    const core = realSessions(["longPush"]);
    core.longPush._armed = { any: 1 };
    expect(core.longPush.busy).toBe(true);
    expect(serializedOpHint(core)).toBe(null);
  });

  test("略過進板畫面 arm 等待期（active 但不 busy）⇒ 線路空著", () => {
    const core = realSessions(["boardNoteSkip"]);
    core.boardNoteSkip.armed = true;
    core.boardNoteSkip._armedAt = Date.now();
    expect(serializedOpHint(core)).toBe(null);
  });

  test("名次固定：不管建構順序，同時佔著時 AID → 長推文 → 登出 → 略過進板", () => {
    const core = realSessions(["boardNoteSkip", "logout", "longPush", "aidNavigation"]);
    core.boardNoteSkip.busy = true;
    core.logout.active = true;
    core.longPush.active = true;
    core.aidNavigation.active = true;
    expect(serializedOpHint(core)).toBe("AID 跳文中，請稍候…");
    core.aidNavigation.active = false;
    expect(serializedOpHint(core)).toBe("長推文送出中，請稍候…");
    core.longPush.active = false;
    expect(serializedOpHint(core)).toBe("登出中，請稍候…");
    core.logout.active = false;
    expect(serializedOpHint(core)).toBe("略過進板畫面中，請稍候…");
  });

  test("同一個 owner 再登記＝換成新的（session 重建時舊的不殘留）", () => {
    const core = {};
    const old = new AidNavigation(core, null, null, null);
    const fresh = new AidNavigation(core, null, null, null);
    old.active = true;
    expect(serializedOpHint(core)).toBe(null);
    fresh.active = true;
    expect(serializedOpHint(core)).toBe("AID 跳文中，請稍候…");
    expect(core._wireHolders.length).toBe(1);
  });

  test("沒有名次的 owner 直接丟（新 session 型功能要在 SESSION_WIRE_RANK 排好位置）", () => {
    expect(() => holdWireWhile({}, "somethingNew", () => null)).toThrow();
  });

  test("core 不存在不炸", () => {
    expect(() => holdWireWhile(null, "aidNavigation", () => "x")).not.toThrow();
    expect(() => new AidNavigation(null, null, null, null)).not.toThrow();
  });
});

// --- 靜態守護 ----------------------------------------------------------------
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.(js|jsx|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}
const FILES = walk(SRC).map((p) => ({
  rel: path.relative(SRC, p).split(path.sep).join("/"),
  text: fs.readFileSync(p, "utf8"),
}));
const stripComments = (s) =>
  s
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");

describe("靜態守護", () => {
  test("serialized_op_gate 不再逐一列舉 xxxInFlight 旗標（新功能不必回來改閘門）", () => {
    const gate = FILES.find((f) => f.rel === "js/serialized_op_gate.js");
    expect(stripComments(gate.text)).not.toMatch(/InFlight/);
  });

  test("serialized_op_gate 也不再認識自己有 session 的序列（AID、長推文、登出、略過進板）", () => {
    const gate = FILES.find((f) => f.rel === "js/serialized_op_gate.js");
    expect(stripComments(gate.text)).not.toMatch(/aidNavigation|longPush|logout|boardNoteSkip/);
  });

  // 閘門只問 core 上登記過的持有者：拿臨時物件字面值去問一定回 null ⇒ 吞鍵沒提示。
  test("不准拿物件字面值問閘門（serializedOpHint({…}) / wireLeaseHint({…})）", () => {
    const offenders = [];
    for (const f of FILES) {
      stripComments(f.text)
        .split("\n")
        .forEach((line, i) => {
          if (/\b(serializedOpHint|wireLeaseHint)\(\s*\{/.test(line)) offenders.push(`${f.rel}:${i + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  // 使用權的 owner：預設 'searchInFlight'＋各功能 `XXX_FLAG = '...'` 與 `flag: '...'` 宣告的名字。
  const OWNERS = new Set(["searchInFlight"]);
  for (const f of FILES) {
    for (const m of f.text.matchAll(/_FLAG\s*=\s*'(\w+)'|\bflag:\s*'(\w+)'/g)) OWNERS.add(m[1] || m[2]);
  }

  test("找得到所有 owner（守護本身沒失效）", () => {
    expect([...OWNERS].sort()).toEqual(
      expect.arrayContaining([
        "homeFavFetchInFlight",
        "markAllReadInFlight",
        "nativeReadLaterInFlight",
        "refreshInFlight",
        "searchInFlight",
        "unreadJumpInFlight",
      ]),
    );
  });

  test("使用權的鏡像欄位只准經 wire_lease 寫（App 建構子的初值除外）", () => {
    const names = [...OWNERS].join("|");
    const write = new RegExp(
      [
        // core.searchInFlight = …／||= …
        `\\b(${names})\\s*(\\|\\||&&|\\?\\?)?=[^=]`,
        // core[flag] = …／core[UNREAD_JUMP_FLAG] = …／core[f] = …／core['searchInFlight'] = …
        `\\[\\s*(\\w*(flag|FLAG|Flag)\\w*|f|'\\w*InFlight'|"\\w*InFlight")\\s*\\]\\s*(\\|\\||&&|\\?\\?)?=[^=]`,
        // Object.assign(core, { searchInFlight: true })
        `\\b(${names})\\s*:\\s*true\\b`,
      ].join("|"),
    );
    const offenders = [];
    for (const f of FILES) {
      if (f.rel === "js/wire_lease.js") continue;
      stripComments(f.text)
        .split("\n")
        .forEach((line, i) => {
          if (!write.test(line)) return;
          if (f.rel === "js/pttchrome.jsx" && /this\.searchInFlight = false;/.test(line)) return;
          offenders.push(`${f.rel}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  test("自訂 owner 一定帶提示字：beginInFlight 第二參數有給就要有第三個；submitSerializedSteps 有 flag 就要有 hint", () => {
    const offenders = [];
    for (const f of FILES) {
      if (f.rel === "js/article_search.js") continue; // 定義處（轉手 opts 的 flag／hint）
      const t = stripComments(f.text);
      for (const m of t.matchAll(/beginInFlight\(([^)]*)\)/g)) {
        const args = m[1].split(",").map((a) => a.trim()).filter(Boolean);
        if (args.length === 2) offenders.push(`${f.rel}: beginInFlight(${m[1]})`);
      }
      for (const m of t.matchAll(/submitSerializedSteps\([^;]*?\{([^}]*)\}/g)) {
        if (/\bflag\s*:/.test(m[1]) && !/\bhint\s*:/.test(m[1]))
          offenders.push(`${f.rel}: submitSerializedSteps({${m[1].replace(/\s+/g, " ")}})`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
