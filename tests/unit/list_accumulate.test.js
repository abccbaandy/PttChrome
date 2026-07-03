// v4-stabilize bug 2 回归（使用者实测：置底文有时少一篇）：
//   (a) pinned map 的 key 必须含作者（author|title）——两篇「标题栏切片相同、
//       作者不同」的置底公告若只用标题当 key 会互相覆写、少一篇。
//   (b) 游标停在置底列时该列也要收录（旧守门 i!==cur_y 一刀切，游标長期停在
//       置底列时它永远进不了 buffer）。真置底列即使被 ● 盖头，★ 仍在第 4-5 格
//       可辨识；收录时把 ● 的两格还原成空白。游标停在「序号不可回推的一般文章
//       列」（无 ★）时仍须排除（避免 ● 列被误档成置底，v3 坑 4）。
// 直接以 stub buf 呼叫真的 TermView.prototype.accumulateListLines（逻辑不碰 DOM）。
import { TermView } from "../../src/js/term_view";
import { pinnedRowKey } from "../../src/js/list_session";

function chRow(text, cols = 80) {
  const padded = text.padEnd(cols);
  const row = [];
  for (const c of padded) row.push({ ch: c, isLeadByte: false });
  return row;
}

function fakeView(texts, curY) {
  const lines = texts.map((t) => chRow(t));
  return {
    buf: {
      rows: texts.length,
      cols: 80,
      cur_y: curY,
      lines,
      listLines: [],
      listLineNums: [],
      getRowText(r) {
        return texts[r];
      },
    },
    _listNumMap: null,
    _listPinnedMap: null,
    accumulateListLines: TermView.prototype.accumulateListLines,
    resetListAccumulation: TermView.prototype.resetListAccumulation,
  };
}

const rowToStr = (row) => row.map((c) => c.ch).join("").replace(/\s+$/, "");

describe("pinnedRowKey", () => {
  test("同标题不同作者 → 不同 key；推文数变动 → 同 key", () => {
    const a = "    ★  m 1 6/01 arrenwu      轉 [公告] 板規";
    const a2 = "    ★  m 9 6/01 arrenwu      轉 [公告] 板規"; // 推文数变了
    const b = "    ★  M 3 6/13 SaberTheBest 轉 [公告] 板規"; // 同标题、别的作者
    expect(pinnedRowKey(a)).toBe(pinnedRowKey(a2));
    expect(pinnedRowKey(a)).not.toBe(pinnedRowKey(b));
  });
  test("游标变体（● 盖头）与干净列同 key", () => {
    const clean = "    ★  m 1 6/01 arrenwu      轉 [公告] 板規";
    const cursor = "●  ★  m 1 6/01 arrenwu      轉 [公告] 板規";
    expect(pinnedRowKey(cursor)).toBe(pinnedRowKey(clean));
  });
});

describe("accumulateListLines（置底文收录）", () => {
  const header = [
    "【板主:abc】看板《C_Chat》",
    "[←]離開 [→]閱讀",
    "   編號    日 期 作  者       文  章  標  題",
  ];
  const article = " 350001 + 2 6/14 someoneA     □ [閒聊] 一般文章";
  const feeter = " 文章選讀  (y)回應(X)推文";

  test("同标题不同作者的两篇置底都保留（bug 2a）", () => {
    const texts = header.concat([
      article,
      "    ★  m 1 6/01 arrenwu      轉 [公告] 板規",
      "    ★  M 3 6/13 SaberTheBest 轉 [公告] 板規",
      feeter,
    ]);
    const v = fakeView(texts, 3);
    v.accumulateListLines();
    const pinned = v.buf.listLineNums.filter((n) => n == null).length;
    expect(pinned).toBe(2);
  });

  test("游标停在置底列（●…★）仍收录，且 ● 两格还原空白（bug 2b）", () => {
    const texts = header.concat([
      article,
      "●  ★  m 1 6/01 arrenwu      轉 [公告] 板規", // 游标在置底列
      feeter,
    ]);
    const v = fakeView(texts, 4);
    v.accumulateListLines();
    const pinnedIdx = v.buf.listLineNums.indexOf(null);
    expect(pinnedIdx).not.toBe(-1);
    const text = rowToStr(v.buf.listLines[pinnedIdx]);
    expect(text).not.toContain("●");
    expect(text).toContain("★");
  });

  test("游标停在序号不可回推的一般文章列（无★）仍排除（v3 坑 4 不回归）", () => {
    // 只有游标列一列「像文章但读不到序号」：无数字邻居可回推 → nums 全 null。
    const texts = header.concat([
      "●50039 + 1 6/14 JHENGKUNLIN  □ [母雞] foo", // ● 盖掉序号最高位
      feeter,
    ]);
    const v = fakeView(texts, 3);
    v.accumulateListLines();
    // 不得被误档成置底（无★），也没有可用序号 → buffer 应为空。
    expect(v.buf.listLines.length).toBe(0);
  });

  test("推文数变动的置底再累积不产生重复列（v3 bug 5a 不回归）", () => {
    const mk = (cnt) =>
      header.concat([
        article,
        `    ★  m ${cnt} 6/01 arrenwu      轉 [公告] 板規`,
        feeter,
      ]);
    const v = fakeView(mk(1), 3);
    v.accumulateListLines();
    // 同页重画、推文数 1 → 2。
    const texts2 = mk(2);
    v.buf.lines = texts2.map((t) => chRow(t));
    v.buf.getRowText = (r) => texts2[r];
    v.accumulateListLines();
    const pinned = v.buf.listLineNums.filter((n) => n == null).length;
    expect(pinned).toBe(1);
  });
});
