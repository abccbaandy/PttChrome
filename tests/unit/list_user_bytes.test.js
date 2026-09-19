// 列表好讀「使用者 byte 要上線時」的決策層（純函式）。
// 存在理由與四次復發史見 src/js/list_user_bytes.js 檔頭。
import { decideUserBytes, ADOPT, SWALLOW, PASS } from "../../src/js/list_user_bytes";

describe("decideUserBytes（四分支全枚舉）", () => {
  test("原生鏡像一律放行——選取即真游標，沒有東西要保護", () => {
    for (const state of ["idle", "active", "opening", "functionMode", "suspended"])
      expect(decideUserBytes({ renderMode: "native", state })).toBe(PASS);
  });

  test("好讀緩衝中（active）＝接手，這正是「選取 ≠ 真游標」的那個狀態", () => {
    expect(decideUserBytes({ renderMode: "buffer", state: "active" })).toBe(ADOPT);
    expect(decideUserBytes({ renderMode: "frozen", state: "active" })).toBe(ADOPT);
  });

  test("序列化開文在途＝吞掉（放行會與 jump/enter 序列競態）", () => {
    expect(decideUserBytes({ renderMode: "buffer", state: "opening" })).toBe(SWALLOW);
    expect(decideUserBytes({ renderMode: "frozen", state: "opening" })).toBe(SWALLOW);
  });

  test("凍結畫面背後有交易在飛＝吞掉", () => {
    expect(decideUserBytes({ renderMode: "frozen", state: "functionMode" })).toBe(
      SWALLOW,
    );
  });

  test("functionMode 但畫面是 buffer ⇒ 不搶（判不準就不接手）", () => {
    // fail-closed 只針對「確定歸我」的情況。對不確定的情況硬接手只會製造新的
    // 靜默 bug（原生鏡像下 server 的真游標就是使用者看到的那一列）。
    expect(decideUserBytes({ renderMode: "buffer", state: "functionMode" })).toBe(PASS);
    for (const state of ["idle", "suspended", "cleanup"])
      expect(decideUserBytes({ renderMode: "buffer", state })).toBe(PASS);
  });

  test("renderMode 缺值／未知值走放行（不是接手）", () => {
    expect(decideUserBytes({ renderMode: undefined, state: "active" })).toBe(PASS);
    expect(decideUserBytes({ renderMode: "", state: "active" })).toBe(PASS);
  });
});
