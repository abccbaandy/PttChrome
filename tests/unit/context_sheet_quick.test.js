// P37 手機長按推文選單的圖示列分組（純資料）：只重新分組，不增不減項目。
import {
  splitQuickActions,
  QUICK_ACTION_KEYS,
  QUICK_ACTION_LABEL_KEYS,
  QUICK_ACTION_MAX,
} from "../../src/components/ContextMenu/context_sheet_quick";
import { zh_TW as zh } from "../../src/js/zh_TW_messages";
import { en_US as en } from "../../src/js/en_US_messages";

const it = (key) => ({ type: "item", key, label: key, onClick: () => {} });
const dv = (key) => ({ type: "divider", key });

describe("splitQuickActions", () => {
  test("推文項目 ≥3 ⇒ 依優先序收前 5 顆；剩下的分隔線不重複、不在開頭結尾", () => {
    const entries = [
      it("addAuthorBlacklist"),
      it("addAuthorFollow"),
      dv("d-blacklist"),
      it("replyComment"),
      it("copyComment"),
      it("copyCommentAll"),
      it("filterCommentUser"),
      it("filterCommentOp"),
      dv("d-comment"),
      it("paste"),
      dv("d-main"),
      it("settings"),
    ];
    const { quick, rest } = splitQuickActions(entries);
    expect(quick.map((e) => e.key)).toEqual(
      QUICK_ACTION_KEYS.filter((k) => k !== "clearCommentFilter").slice(
        0,
        QUICK_ACTION_MAX,
      ),
    );
    expect(rest.map((e) => e.key)).toEqual([
      "addAuthorBlacklist",
      "d-blacklist",
      "copyCommentAll",
      "d-comment",
      "paste",
      "d-main",
      "settings",
    ]);
    // 項目一個不少
    expect([...quick, ...rest].filter((e) => e.type === "item").length).toBe(
      entries.filter((e) => e.type === "item").length,
    );
  });

  test("收完開頭剩分隔線 ⇒ 拿掉", () => {
    const { rest } = splitQuickActions([
      it("replyComment"),
      it("copyComment"),
      it("filterCommentUser"),
      dv("d"),
      it("settings"),
    ]);
    expect(rest.map((e) => e.key)).toEqual(["settings"]);
  });

  test("沒有推文項目（列表卡片長按）、或少於 3 顆 ⇒ 不收，原封不動", () => {
    const list = [
      it("addAuthorBlacklist"),
      it("addAuthorFollow"),
      it("addTitleBlacklist"),
      dv("d"),
      it("settings"),
    ];
    expect(splitQuickActions(list)).toEqual({ quick: [], rest: list });
    const few = [
      it("copyComment"),
      it("copyCommentAll"),
      dv("d"),
      it("settings"),
    ];
    expect(splitQuickActions(few)).toEqual({ quick: [], rest: few });
  });

  test("每顆都有短字（兩語系）", () => {
    for (const k of QUICK_ACTION_KEYS) {
      const id = QUICK_ACTION_LABEL_KEYS[k];
      expect(zh[id] && zh[id].message, k).toBeTruthy();
      expect(en[id] && en[id].message, k).toBeTruthy();
    }
  });
});
