// 右鍵／長按選單的項目清單（components/ContextMenu/context_menu_entries.js）。
// 鎖：桌機右鍵選單全放；手機長按選單只放跟長按位置有關的項目（按到的列／推文／連結／選到的字），
// 跟位置無關的改在工具列「更多」（tests/unit/mobile_toolbar.test.jsx）；不留頭尾或連續的分隔線。
import {
  buildContextMenuEntries,
  hasMenuItems,
} from "../../src/components/ContextMenu/context_menu_entries";
import { setupI18n } from "../../src/js/i18n";

beforeAll(() => setupI18n());

const BASE = {
  normalEnabled: true,
  selEnabled: false,
  urlEnabled: false,
  imageUploadEnabled: true,
  markAllReadEnabled: true,
  onMenuSelect: () => {},
};
const keys = (p) => buildContextMenuEntries(p).map((e) => e.key);
// 跟長按位置無關 ⇒ 手機在「更多」，長按選單不放。
const MOVED = [
  "selectAll",
  "uploadImage",
  "uploadHistory",
  "markAllRead",
  "paste",
  "saveLocal",
  "copyArticleLinkRow",
  "copyArticleLink",
  "longPush",
  "inputHelper",
  "liveArticleHelper",
  "commandPalette",
  "settings",
];
// 每一項都打開的桌機／手機共用 props。
const EVERYTHING = {
  ...BASE,
  saveLocalEnabled: true,
  articleLinkEnabled: true,
  articleLinkRow: true,
  longPushEnabled: true,
  inputHelperEnabled: true,
  liveArticleHelperEnabled: true,
  commandPaletteEnabled: true,
};

test("桌機：文章列表有「設為全部已讀」，點下去走 onMenuSelect('markAllRead')", () => {
  const calls = [];
  const entries = buildContextMenuEntries({
    ...BASE,
    onMenuSelect: (k) => calls.push(k),
  });
  const item = entries.find((e) => e.key === "markAllRead");
  expect(item).toBeDefined();
  item.onClick({});
  expect(calls).toEqual(["markAllRead"]);
  const all = keys(EVERYTHING);
  for (const k of MOVED.filter((k) => k !== "copyArticleLink"))
    expect(all).toContain(k);
});

test("桌機：不在文章列表（markAllReadEnabled 假）就沒有", () => {
  expect(keys({ ...BASE, markAllReadEnabled: false })).not.toContain(
    "markAllRead",
  );
});

test("手機：跟長按位置無關的項目都不在長按選單（在「更多」）", () => {
  for (const articleLinkRow of [true, false]) {
    const k = keys({ ...EVERYTHING, articleLinkRow, mobile: true });
    for (const m of MOVED) expect(k).not.toContain(m);
  }
});

test("手機：長按一段沒有任何位置相關目標的文字 ⇒ 清單是空的（不開選單）", () => {
  const entries = buildContextMenuEntries({ ...EVERYTHING, mobile: true });
  expect(entries).toEqual([]);
  expect(hasMenuItems(entries)).toBe(false);
  expect(hasMenuItems(buildContextMenuEntries(EVERYTHING))).toBe(true);
});

test("稍後閱讀：連結／列表那一列（位置相關）手機長按照給；「本篇」（current）手機不給、桌機給", () => {
  const link = { board: "movie", aid: "1abc", title: "", saved: false };
  const row = { listNum: 3, title: "x", saved: false };
  const current = { ...link, current: true };
  for (const t of [link, row])
    for (const mobile of [false, true])
      expect(keys({ ...BASE, mobile, readLaterTarget: t })).toContain(
        "readLater",
      );
  expect(keys({ ...BASE, readLaterTarget: current })).toContain("readLater");
  expect(
    keys({ ...BASE, mobile: true, readLaterTarget: current }),
  ).not.toContain("readLater");
  expect(
    keys({ ...BASE, mobile: true, readLaterTarget: { ...link, saved: true } }),
  ).toContain("removeReadLater");
});

test("看板列表「<板名> 設為已讀」：桌機與手機長按都在（要指定是哪一列）", () => {
  const calls = [];
  const p = {
    ...BASE,
    markAllReadEnabled: false,
    boardMarkReadTarget: { num: 5, name: "C_Chat" },
    onMenuSelect: (k) => calls.push(k),
  };
  for (const mobile of [false, true]) {
    const item = buildContextMenuEntries({ ...p, mobile }).find(
      (e) => e.key === "boardMarkRead",
    );
    expect(item).toBeDefined();
    expect(item.label).toContain("C_Chat");
    item.onClick({});
  }
  expect(calls).toEqual(["boardMarkRead", "boardMarkRead"]);
  expect(keys({ ...p, boardMarkReadTarget: null })).not.toContain(
    "boardMarkRead",
  );
});

test("回覆這則：有目標才出現（推文段最前面），標題帶帳號，點下去走 onMenuSelect('replyComment')", () => {
  const calls = [];
  const entries = buildContextMenuEntries({
    ...BASE,
    mobile: true,
    replyCommentTarget: "abc123",
    previews: { copyComment: "abc123: 推文" },
    onMenuSelect: (k) => calls.push(k),
  });
  const ks = entries.map((e) => e.key);
  expect(ks.indexOf("replyComment")).toBe(ks.indexOf("copyComment") - 1);
  const item = entries.find((e) => e.key === "replyComment");
  expect(item.label).toContain("abc123");
  item.onClick({});
  expect(calls).toEqual(["replyComment"]);
  expect(keys(BASE)).not.toContain("replyComment");
});

test("存到本機（P64）：桌機 saveLocalEnabled 才有，點下去走 onMenuSelect('saveLocal')", () => {
  expect(keys(BASE)).not.toContain("saveLocal");
  const calls = [];
  const item = buildContextMenuEntries({
    ...BASE,
    saveLocalEnabled: true,
    onMenuSelect: (k) => calls.push(k),
  }).find((e) => e.key === "saveLocal");
  expect(item).toBeDefined();
  item.onClick({});
  expect(calls).toEqual(["saveLocal"]);
});

test("分隔線只在兩段之間：不在開頭結尾、不連續", () => {
  const variants = [
    BASE,
    EVERYTHING,
    { ...BASE, normalEnabled: false, urlEnabled: true },
    { ...BASE, authorBlacklistId: "abc" },
    { ...BASE, previews: { copyComment: "x" } },
  ];
  for (const v of variants)
    for (const mobile of [false, true]) {
      const types = buildContextMenuEntries({ ...v, mobile }).map(
        (e) => e.type,
      );
      if (!types.length) continue;
      expect(types[0]).not.toBe("divider");
      expect(types[types.length - 1]).not.toBe("divider");
      for (let i = 1; i < types.length; ++i)
        expect(types[i] === "divider" && types[i - 1] === "divider").toBe(
          false,
        );
    }
});

// 手機推文卡片：長按就能「複製這則推文」（推文第一個字貼著螢幕左緣，拉不到選取把手）。
// 出現條件＝預覽算得出來，與連結旗標無關（長按推文裡的網址也要給）。
describe("複製推文", () => {
  test("有預覽才出現，點下去走 onMenuSelect 帶 key，預覽畫在第二行", () => {
    const calls = [];
    const entries = buildContextMenuEntries({
      ...BASE,
      mobile: true,
      normalEnabled: false,
      urlEnabled: true,
      previews: { copyComment: "這則", copyCommentAll: "這則\n下一則" },
      onMenuSelect: (k) => calls.push(k),
    });
    const one = entries.find((e) => e.key === "copyComment");
    const all = entries.find((e) => e.key === "copyCommentAll");
    expect(one.preview).toBe("這則");
    expect(all.preview).toBe("這則\n下一則");
    one.onClick({});
    all.onClick({});
    expect(calls).toEqual(["copyComment", "copyCommentAll"]);
  });

  test("沒有預覽（不在推文卡片上／桌機）⇒ 不出現", () => {
    expect(keys({ ...BASE, previews: {} })).not.toContain("copyComment");
    expect(keys({ ...BASE, previews: {} })).not.toContain("copyCommentAll");
  });
});

// P93：文章裡「複製本篇連結」開關開著 ⇒ 一列三顆（chips），點哪顆走哪個 onMenuSelect key；
// 「分享連結」沿用 copyArticleLink（handler 與預覽不變）。關掉 ⇒ 原本的單一項。
describe("複製本篇連結一列三顆（P93）", () => {
  const P = {
    ...BASE,
    articleLinkEnabled: true,
    previews: {
      copyArticleLink: "https://x/#movie/M.1.A.2.html",
      copyArticlePttUrl: "https://www.ptt.cc/bbs/movie/M.1.A.2.html",
      copyArticleCode: "#1abc (movie)",
    },
  };

  test("每顆帶自己的預覽；整列的預覽＝第一顆（PTT 網址）；算不出來是 null", () => {
    const row = buildContextMenuEntries({ ...P, articleLinkRow: true }).find(
      (e) => e.key === "copyArticleLinkRow",
    );
    expect(row.chips.map((c) => c.preview)).toEqual([
      P.previews.copyArticlePttUrl,
      P.previews.copyArticleCode,
      P.previews.copyArticleLink,
    ]);
    expect(row.preview).toBe(P.previews.copyArticlePttUrl);
    const bare = buildContextMenuEntries({
      ...P,
      previews: {},
      articleLinkRow: true,
    }).find((e) => e.key === "copyArticleLinkRow");
    expect(bare.preview).toBeNull();
    expect(bare.chips.map((c) => c.preview)).toEqual([null, null, null]);
  });

  test("開著：一個 chips 項，三顆依序是 PTT 網址／AID／分享連結（手機在「更多 → 分享」）", () => {
    for (const mobile of [false]) {
      const calls = [];
      const entries = buildContextMenuEntries({
        ...P,
        mobile,
        articleLinkRow: true,
        onMenuSelect: (k) => calls.push(k),
      });
      expect(entries.find((e) => e.key === "copyArticleLink")).toBeUndefined();
      const row = entries.find((e) => e.key === "copyArticleLinkRow");
      expect(row.type).toBe("chips");
      expect(row.chips.map((c) => c.key)).toEqual([
        "copyArticlePttUrl",
        "copyArticleCode",
        "copyArticleLink",
      ]);
      row.chips.forEach((c) => c.onClick({}));
      expect(calls).toEqual([
        "copyArticlePttUrl",
        "copyArticleCode",
        "copyArticleLink",
      ]);
    }
  });

  test("關掉：照舊只有「複製本篇文章連結」一項；不在文章裡兩種都沒有", () => {
    expect(keys({ ...P, articleLinkRow: false })).toContain("copyArticleLink");
    expect(keys({ ...P, articleLinkRow: false })).not.toContain(
      "copyArticleLinkRow",
    );
    const k = keys({ ...P, articleLinkEnabled: false, articleLinkRow: true });
    expect(k).not.toContain("copyArticleLink");
    expect(k).not.toContain("copyArticleLinkRow");
  });
});
