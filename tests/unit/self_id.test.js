// @unit-env browser
// 自己的推文標示（P12）：登入者帳號取自選單底部狀態列（term_view._noteSelfId），
// 只在 pageState＝選單時讀，換連線清空；開關關掉時 enhance.selfId 給 null。
// 解析本身由 string_util.test.js 的 parseStatusUserid 守，這裡只守接線。
import { TermView } from "../../src/js/term_view";

const MENU_STATUS = " 主功能表 [ 射手時 ]     10/20 週二 6:40 | SomeUser1 | 線上25809人   (h)說明 ";

function fakeView(pageState, lastRow) {
  const v = Object.create(TermView.prototype);
  v._selfId = null;
  v.buf = {
    pageState,
    rows: 24,
    cols: 80,
    getRowText: (r) => (r === 23 ? lastRow : ""),
  };
  return v;
}

describe("TermView._noteSelfId", () => {
  test("選單畫面的底列 ⇒ 記下帳號（小寫）", () => {
    const v = fakeView(1, MENU_STATUS);
    v._noteSelfId();
    expect(v._selfId).toBe("someuser1");
  });

  test("不是選單（文章、列表）⇒ 不讀底列，也不清掉已知的帳號", () => {
    const v = fakeView(3, MENU_STATUS);
    v._noteSelfId();
    expect(v._selfId).toBe(null);
    v._selfId = "me";
    v.buf.pageState = 2;
    v._noteSelfId();
    expect(v._selfId).toBe("me");
  });

  test("選單但底列認不出 ⇒ 保留原值；resetSelfId 清掉", () => {
    const v = fakeView(1, " 文章選讀 (y)回應(X)推文 ");
    v._selfId = "me";
    v._noteSelfId();
    expect(v._selfId).toBe("me");
    v.resetSelfId();
    expect(v._selfId).toBe(null);
  });
});
