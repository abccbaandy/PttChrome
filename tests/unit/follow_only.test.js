// @unit-env browser
// real-input: tests/e2e/offline/follow_only.offline.spec.js
// 只看關注（P36，js/follow_only.js、docs/list-row-filter.md「只看關注」）。
//
// 鎖的症狀：
//   1. 判準：列表形、沒命中關注名單的列藏起來；不是列表形的列（表頭、說明列）一律看得到。
//   2. 列表好讀的藏列兩處同一份（不變量 10）：list_session#visibleListIndices 與
//      screen_annotations 的 listEasyReading 分支；原生列表（不帶 listEasyReading）不藏。
//   3. view.listFollowOnly：切換鈕＋功能開關＋名單開關＋名單不空才生效；開關進 annotationsKey。
//   4. 切換鈕：只在列表好讀的文章列表出現；按一下只改顯示＋重畫（不送鍵），存 localStorage；
//      整段都被收起時寫「這一段沒有」。
import { isFollowOnlyHidden } from "../../src/js/list_row_filter";
import { visibleListIndices, isHiddenListRow } from "../../src/js/list_session";
import { computeAnnotations } from "../../src/js/screen_annotations";
import { annotationsKey } from "../../src/js/screen_annotate_cache";
import { parseBlacklist, parseTitleBlacklist } from "../../src/js/comment_parse";
import {
  FollowOnly,
  followOnlyAvailable,
  FOLLOW_ONLY_KEY,
} from "../../src/js/follow_only";
import { OWNER_ARTICLE_LIST } from "../../src/js/list_render_owner";
import { TermView } from "../../src/js/term_view";
import { DEFAULT_PREFS } from "../../src/js/pref_storage";
import { row, seg } from "./helpers/screen_fixtures";

const listRow = (num, author, title) =>
  `${String(num).padStart(7)} + 2 6/14 ${(author + "            ").slice(0, 13)}${title}`;

const FOLLOW = {
  authors: parseBlacklist("friend"),
  keywords: parseTitleBlacklist("心得"),
};

describe("isFollowOnlyHidden", () => {
  test("關注的作者、標題關鍵字 ⇒ 看得到；其他列表列 ⇒ 藏；非列表形的列不藏；沒開 ⇒ 不藏", () => {
    expect(isFollowOnlyHidden(listRow(1, "friend", "□ [問題] 隨便"), FOLLOW)).toBe(false);
    expect(isFollowOnlyHidden(listRow(2, "other", "□ [心得] 好文"), FOLLOW)).toBe(false);
    expect(isFollowOnlyHidden(listRow(3, "other", "□ [問題] 隨便"), FOLLOW)).toBe(true);
    expect(isFollowOnlyHidden("  編號    日 期 作  者       文  章  標  題", FOLLOW)).toBe(false);
    expect(isFollowOnlyHidden(listRow(3, "other", "□ [問題] 隨便"), null)).toBe(false);
  });
});

describe("列表好讀的藏列（不變量 10：兩處同一份）", () => {
  const TEXTS = [
    listRow(10, "friend", "□ [問題] 一"),
    listRow(11, "other", "□ [問題] 二"),
    listRow(12, "other", "□ [心得] 三"),
    listRow(13, "badguy", "□ [心得] 四"),
    listRow(14, "other", "□ [閒聊] 五"),
  ];
  const BL = new Set(["badguy"]);

  test("visibleListIndices：followOnly 開 ⇒ 只剩關注的列（黑名單照擋）；沒開 ⇒ 跟以前一樣", () => {
    expect(visibleListIndices(TEXTS, BL, [], FOLLOW)).toEqual([0, 2]);
    expect(visibleListIndices(TEXTS, BL, [])).toEqual([0, 1, 2, 4]);
    expect(isHiddenListRow(row(seg(TEXTS[1])), BL, [], FOLLOW)).toBe(true);
    expect(isHiddenListRow(row(seg(TEXTS[1])), BL, [])).toBe(false);
  });

  const annotate = (over) =>
    computeAnnotations(
      TEXTS.map((t) => row(seg(t))),
      {
        pageState: 2,
        blacklist: BL,
        titleBlacklist: [],
        followAuthors: FOLLOW.authors,
        followTitleKeywords: FOLLOW.keywords,
        listEasyReading: true,
        listFollowOnly: true,
        ...over,
      },
      null,
      false,
      {},
      {},
      {},
      null,
      null,
    ).annotations;

  test("screen_annotations 的 listEasyReading 分支藏的列＝visibleListIndices 藏的列", () => {
    const a = annotate();
    const shown = TEXTS.map((_, i) => i).filter((i) => !(a[i] && a[i].hidden));
    expect(shown).toEqual(visibleListIndices(TEXTS, BL, [], FOLLOW));
  });

  test("原生列表（不帶 listEasyReading）不藏；沒開 followOnly 也不藏", () => {
    const native = annotate({ listEasyReading: false });
    expect(native.filter((x) => x && x.hidden).length).toBe(0);
    const off = annotate({ listFollowOnly: false });
    expect([1, 4].every((i) => !(off[i] && off[i].hidden))).toBe(true);
    const key = (v) => annotationsKey({ enhance: { listFollowOnly: v } }).sig;
    expect(key(true)).not.toBe(key(false));
  });
});

describe("view.listFollowOnly", () => {
  const makeView = () => {
    const v = Object.create(TermView.prototype);
    v.followOnly = true;
    v.enableFollowOnly = true;
    v.enableFollowList = true;
    v.followAuthors = FOLLOW.authors;
    v.followTitleKeywords = [];
    v._followOnlyCache = null;
    return v;
  };

  test("四個條件都成立才生效；同一份名單回傳同一個物件", () => {
    const v = makeView();
    const f = v.listFollowOnly();
    expect(f).toMatchObject({ authors: FOLLOW.authors });
    expect(v.listFollowOnly()).toBe(f);
    for (const k of ["followOnly", "enableFollowOnly", "enableFollowList"]) {
      const w = makeView();
      w[k] = false;
      expect(w.listFollowOnly(), k).toBeNull();
    }
    const empty = makeView();
    empty.followAuthors = new Set();
    expect(empty.listFollowOnly()).toBeNull();
  });

  test("功能開關預設開", () => {
    expect(DEFAULT_PREFS.enableFollowOnly).toBe(true);
  });
});

describe("切換鈕（FollowOnly）", () => {
  const base = {
    enabled: true,
    followListOn: true,
    hasFollow: true,
    listWindow: true,
    pageState: 2,
  };

  test("followOnlyAvailable：只在列表好讀的文章列表、名單不空、開關都開時出現", () => {
    expect(followOnlyAvailable(base)).toBe(true);
    for (const k of ["enabled", "followListOn", "hasFollow", "listWindow"])
      expect(followOnlyAvailable({ ...base, [k]: false }), k).toBe(false);
    expect(followOnlyAvailable({ ...base, pageState: 3 })).toBe(false);
    expect(followOnlyAvailable(null)).toBe(false);
  });

  const makeCore = (visible) => {
    const listeners = {};
    const storage = new Map();
    const core = {
      view: {
        followOnly: false,
        enableFollowList: true,
        followAuthors: FOLLOW.authors,
        followTitleKeywords: [],
        redraw: vi.fn(),
        mainDisplay: { getBoundingClientRect: () => ({ width: 800, right: 900, top: 40 }) },
      },
      buf: {
        pageState: 2,
        listRenderMode: "buffer",
        listRenderOwner: OWNER_ARTICLE_LIST,
        addEventListener: (n, fn) => (listeners[n] = fn),
      },
      activeListSession: () => ({ visibleRowCount: () => visible.n }),
    };
    const st = {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, v),
      removeItem: (k) => storage.delete(k),
    };
    return { core, listeners, st, storage };
  };

  test("按一下：只改 view.followOnly＋重畫、存 localStorage；再按一下關掉", () => {
    const visible = { n: 3 };
    const { core, st, storage } = makeCore(visible);
    const fo = new FollowOnly(core, { storage: st });
    fo.refresh();
    expect(fo.state).toMatchObject({ visible: true, on: false, empty: false });
    fo.toggle();
    expect(core.view.followOnly).toBe(true);
    expect(core.view.redraw).toHaveBeenCalledWith(true);
    expect(storage.get(FOLLOW_ONLY_KEY)).toBe("1");
    expect(fo.state.on).toBe(true);
    fo.toggle();
    expect(core.view.followOnly).toBe(false);
    expect(storage.has(FOLLOW_ONLY_KEY)).toBe(false);
  });

  test("開著、這一段一列都沒有 ⇒ empty（鈕上寫「這一段沒有」）；載入時讀回上次的狀態", () => {
    const visible = { n: 0 };
    const { core, st } = makeCore(visible);
    st.setItem(FOLLOW_ONLY_KEY, "1");
    const fo = new FollowOnly(core, { storage: st });
    expect(core.view.followOnly).toBe(true);
    fo.refresh();
    expect(fo.state).toMatchObject({ visible: true, on: true, empty: true });
    visible.n = 2;
    fo.refresh();
    expect(fo.state.empty).toBe(false);
  });

  test("不是列表好讀（原生鏡像）／看文章 ⇒ 不出現", () => {
    const { core, st } = makeCore({ n: 1 });
    const fo = new FollowOnly(core, { storage: st });
    core.buf.listRenderMode = "native";
    fo.refresh();
    expect(fo.state.visible).toBe(false);
    core.buf.listRenderMode = "buffer";
    core.buf.pageState = 3;
    fo.refresh();
    expect(fo.state.visible).toBe(false);
  });
});
