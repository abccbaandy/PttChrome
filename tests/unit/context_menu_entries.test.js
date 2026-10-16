// 右鍵／長按選單的項目清單（components/ContextMenu/context_menu_entries.js）。
// 鎖：「設為全部已讀」只在桌機右鍵選單；手機長按選單不放全選／圖片上傳／設為全部已讀
// （改在工具列「更多」，tests/unit/mobile_toolbar.test.jsx），且不留連續的分隔線。
import { buildContextMenuEntries } from "../../src/components/ContextMenu/context_menu_entries";
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
const MOVED = ["selectAll", "uploadImage", "uploadHistory", "markAllRead"];

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
  for (const k of MOVED) expect(keys(BASE)).toContain(k);
});

test("桌機：不在文章列表（markAllReadEnabled 假）就沒有", () => {
  expect(keys({ ...BASE, markAllReadEnabled: false })).not.toContain(
    "markAllRead",
  );
});

test("手機：全選／圖片上傳／設為全部已讀都不在長按選單", () => {
  const k = keys({ ...BASE, mobile: true });
  for (const m of MOVED) expect(k).not.toContain(m);
  expect(k).toContain("paste");
  expect(k).toContain("settings");
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

test("沒有連續的分隔線（手機工具段搬空時）", () => {
  for (const p of [BASE, { ...BASE, mobile: true }]) {
    const types = buildContextMenuEntries(p).map((e) => e.type);
    for (let i = 1; i < types.length; ++i)
      expect(types[i] === "divider" && types[i - 1] === "divider").toBe(false);
  }
});
