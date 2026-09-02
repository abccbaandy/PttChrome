// 看板列表平滑捲動的 render 合約（term_view 交給 render/screen.js 的那份 enhance）。
//
// 捲動視口本身的機制（overflow 開關、scroll 接線、切走時要收掉）已由
// render_list_scroll.test.js 守住；這一支只釘住**看板列表專屬**的兩件事：
//   1. body 從 row 3 起（board.c 的 `while (++myrow < b_lines)`，myrow 從 2 起算），
//      header 3 列與 footer 留在容器直系子層、不跟著捲；
//   2. **pageState pin 成 1（MENU）且不帶 listEasyReading / inListContext** ——
//      computeAnnotations 的 PAGE_LIST 分支會對每一列跑 parseListAuthor ＋黑名單
//      比對，而看板列的「作者欄」（cols 17-28）落在看板名／類別上：誤命中就
//      整個看板從清單消失。pin 成 1 只跑 applyFunctionKeys，功能鍵按鈕零損失
//      （functionKeyRows(1, n) 與 (2, n) 回傳相同，見 footer_keys.js）。
import { mountScreen, unmountAll } from "./helpers/mount_screen";
import { row, seg } from "./helpers/screen_fixtures";
import { functionKeyRows } from "../../src/js/footer_keys";

afterEach(() => unmountAll());

const pad7 = (n) => String(n).padStart(7, " ");
// 看板列：cols 0-6 是 %7d、7 是隱板旗標、8-9 是標記/未讀、10 起是板名(13)。
// 作者欄（cols 17-28，文章列表的欄位定義）在這裡落在板名尾巴＋類別上。
const brdRow = (num, name) =>
  row(seg(pad7(num) + "  " + name.padEnd(13, " ") + "綜合 ｜閒聊｜ 測試看板"));

const BODY_ROWS = 30;
const LINES = (() => {
  const out = [
    row(seg("【看板列表】 批踢踢實業坊")),
    row(seg("[←][q]回上層 [→][r]閱讀 [↑↓]選擇 [PgUp][PgDn]翻頁 [c]新文章")),
    row(seg("   編號   看  板       類別   中   文   敘   述")),
  ];
  for (let i = 0; i < BODY_ROWS; ++i) out.push(brdRow(i + 1, "Board" + (i + 1)));
  out.push(
    row(seg("  選擇看板    (a)增加看板 (s)進入已知板名 (y)列出全部 (v/V)已讀/未讀"))
  );
  return out;
})();

// term_view 的看板列表分支實際交出去的那份 enhance。
const props = (over = {}) => ({
  lines: LINES,
  enableLinkInlinePreview: false,
  enableLinkHoverPreview: false,
  enhance: {
    pageState: 1,
    inListContext: false,
    rowIdentityStable: true,
    blacklist: new Set(),
    titleBlacklist: [],
    listScroll: { bodyStart: 3, viewportPx: 400, scrollable: true },
    ...over,
  },
});

const rowOf = (n) => n.querySelector("[data-row]").getAttribute("data-row");

describe("看板列表的捲動視窗", () => {
  test("header 3 列與 footer 留在容器；整段序列住進 .listBodyView", () => {
    const m = mountScreen(props());
    const view = m.container.querySelector(".listBodyView");
    expect(view).not.toBeNull();
    expect(view.style.height).toBe("400px");

    const kids = Array.from(m.container.children);
    expect(kids.indexOf(view)).toBe(3);
    expect(kids.slice(0, 3).map(rowOf)).toEqual(["0", "1", "2"]);
    expect(rowOf(kids[4])).toBe(String(3 + BODY_ROWS)); // footer 恆是最後一列

    const inView = Array.from(view.children).map(rowOf);
    expect(inView).toHaveLength(BODY_ROWS);
    expect(inView[0]).toBe("3");
  });
});

describe("REGRESSION：pageState 必須 pin 成 1，不得沿用列表(2)的標註規則", () => {
  // 合成的最壞情況：把一個合法 userid 擺在**文章列表的作者欄**（cols 17-28）。
  // 真實看板列在那一段是「板名尾巴＋類別」，一般是中文（USERID_RE 不會命中），
  // 但看板名／類別都是站方資料、隨時可能變 —— 而一旦命中，PAGE_LIST 分支的
  // hidden 就會讓那個看板從清單裡整列消失（原生模式至少還換成通知列看得到）。
  // 這兩則的差別只有 enhance，列本身完全相同。
  const linesWithHit = LINES.slice();
  linesWithHit[5] = row(
    seg(pad7(3) + " ".repeat(10) + "someuser".padEnd(12, " ") + "測試看板")
  );

  const mountWith = (enhance) =>
    mountScreen({
      lines: linesWithHit,
      enableLinkInlinePreview: false,
      enableLinkHoverPreview: false,
      enhance: {
        rowIdentityStable: true,
        blacklist: new Set(["someuser"]),
        titleBlacklist: [],
        listScroll: { bodyStart: 3, viewportPx: 400, scrollable: true },
        ...enhance,
      },
    });

  // hidden 標註是畫在 bbsrow 節點本身（render/row.js:161），而 bbsrow 就是視口的
  // 直系子節點 —— 別往下 querySelector。
  const hiddenRows = (m) =>
    Array.from(m.container.querySelector(".listBodyView").children).filter(
      (n) => n.style.visibility === "hidden"
    );

  test("pin 1（正式行為）：黑名單不作用在看板列上，看板不會憑空消失", () => {
    const m = mountWith({ pageState: 1, inListContext: false });
    expect(hiddenRows(m)).toHaveLength(0);
    // 也不該帶上文章列表專用的欄位屬性（右鍵「加入黑名單」是文章列表的功能）
    expect(m.container.querySelector("[data-list-author]")).toBeNull();
  });

  test("對照組：同一列改用 pageState 2 + listEasyReading 就會被整列隱藏", () => {
    const m = mountWith({ pageState: 2, listEasyReading: true });
    expect(hiddenRows(m).length).toBeGreaterThan(0);
  });
});

describe("功能鍵按鈕：pin 成 1 之後掃的列與 pin 成 2 完全相同", () => {
  test("functionKeyRows(1, n) === functionKeyRows(2, n)", () => {
    // pin pageState 的代價必須是零：row1 的熱鍵列與最後一列的 footer 照樣可點。
    for (const n of [24, 34, 304])
      expect(functionKeyRows(1, n)).toEqual(functionKeyRows(2, n));
  });
});
