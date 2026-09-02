// `termBuf.listRenderMode` 的所有權層（src/js/list_render_owner.js）。
//
// 兩種列表好讀（文章列表 ListSession／看板列表 BoardListSession）共用同一個旗標
// ——那是刻意的，因為它已是十幾個消費端的分岔點。但兩者都掛在 `screenSettled`
// 上，**同一幀**可能一邊要 engage、另一邊要收攤（進板：ListSession 接手、
// BoardListSession 收攤；離板：反過來）。沒有所有權，畫面就取決於兩個 listener
// 誰先跑 —— 那是靜默的競態。這支釘住「誰先跑都得到同一個結果」。
import {
  defineOwnedRenderMode,
  listRenderOwnerOf,
  OWNER_ARTICLE_LIST,
  OWNER_BOARD_LIST,
  BRD_CMD_PREFIX,
  isBoardListCommandKind,
} from "../../src/js/list_render_owner";

function makeBuf() {
  return { listRenderMode: "native", listRenderOwner: null };
}

function makeSessions() {
  const buf = makeBuf();
  const article = {};
  const board = {};
  defineOwnedRenderMode(article, buf, OWNER_ARTICLE_LIST);
  defineOwnedRenderMode(board, buf, OWNER_BOARD_LIST);
  return { buf, article, board };
}

describe("defineOwnedRenderMode", () => {
  test("寫 buffer/frozen ＝宣告所有權", () => {
    const { buf, article } = makeSessions();
    article._renderMode = "buffer";
    expect(buf.listRenderMode).toBe("buffer");
    expect(buf.listRenderOwner).toBe(OWNER_ARTICLE_LIST);
    article._renderMode = "frozen";
    expect(buf.listRenderMode).toBe("frozen");
  });

  test("讀：別人持有時一律回 'native'（＝我沒有在畫）", () => {
    const { article, board } = makeSessions();
    board._renderMode = "buffer";
    expect(board._renderMode).toBe("buffer");
    expect(article._renderMode).toBe("native");
  });

  test("REGRESSION：寫 native 只釋放自己持有的，別人已接手時是 no-op", () => {
    // 「Enter 進看板」那一幀：ListSession 先 seed（宣告所有權），BoardListSession
    // 的交易 onDone 隨後收攤。收攤若無條件寫回 native，就會把對方剛畫上的畫面關掉。
    const { buf, article, board } = makeSessions();
    board._renderMode = "frozen"; // 看板列表的開板交易在飛
    article._renderMode = "buffer"; // 文章列表在同一幀 engage
    board._renderMode = "native"; // 看板列表收攤
    expect(buf.listRenderMode).toBe("buffer");
    expect(buf.listRenderOwner).toBe(OWNER_ARTICLE_LIST);
  });

  test("REGRESSION：反向順序（收攤在前、engage 在後）結果相同", () => {
    const { buf, article, board } = makeSessions();
    board._renderMode = "frozen";
    board._renderMode = "native"; // 先收攤
    expect(buf.listRenderOwner).toBeNull();
    article._renderMode = "buffer"; // 再 engage
    expect(buf.listRenderMode).toBe("buffer");
    expect(buf.listRenderOwner).toBe(OWNER_ARTICLE_LIST);
  });

  test("持有者自己寫 native ＝真的釋放", () => {
    const { buf, article } = makeSessions();
    article._renderMode = "buffer";
    article._renderMode = "native";
    expect(buf.listRenderMode).toBe("native");
    expect(buf.listRenderOwner).toBeNull();
  });
});

describe("listRenderOwnerOf", () => {
  test("原生（或沒有 buf）＝ null", () => {
    expect(listRenderOwnerOf(null)).toBeNull();
    expect(listRenderOwnerOf(makeBuf())).toBeNull();
  });

  test("buffer/frozen 時回持有者", () => {
    const { buf, board } = makeSessions();
    board._renderMode = "buffer";
    expect(listRenderOwnerOf(buf)).toBe(OWNER_BOARD_LIST);
    board._renderMode = "frozen";
    expect(listRenderOwnerOf(buf)).toBe(OWNER_BOARD_LIST);
  });
});

describe("佇列所有權（isBoardListCommandKind）", () => {
  test("只有 brd- 前綴算看板列表的命令", () => {
    expect(isBoardListCommandKind(BRD_CMD_PREFIX + "fetch-down")).toBe(true);
    // ListSession / AidNavigation / LongPush 的 kind 都不得命中
    for (const k of [
      "prefetch-down",
      "open-jump",
      "leave-board",
      "native-key",
      "aid-board-jump",
      null,
      undefined,
      "",
    ])
      expect(isBoardListCommandKind(k)).toBe(false);
  });
});
