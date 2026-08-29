// 總開關必須真的管得住全部。改版前 middleMouse_down 與 mouse_scroll 完全不看
// useMouseBrowsing —— 「關掉滑鼠瀏覽」只關得掉移動與左鍵，中鍵貼上與滾輪翻頁
// 照樣生效。這支就是那個漏洞的回歸鎖。
import { resolveMouseGates } from "../../src/js/mouse_regions";

const ALL_ON = {
  useMouseBrowsing: true,
  mouseLeftClick: true,
  mouseMisclickGuard: true,
  mouseMiddleClick: 1,
  mouseWheel: 1,
  mouseWheelSmoothScroll: true,
};

describe("總開關", () => {
  test("關掉就是全關（含中鍵與滾輪）", () => {
    const g = resolveMouseGates({ ...ALL_ON, useMouseBrowsing: false });
    expect(g.move).toBe(false);
    expect(g.leftClick).toBe(false);
    expect(g.cursorIcon).toBe(false);
    expect(g.middleClick).toBe(0);
    expect(g.wheel).toBe(false);
    expect(g.wheelSmoothScroll).toBe(false);
    // 總開關關掉時左鍵／指標／提示帶全滅 ⇒ 沒有誤觸要防，防誤觸也一併關掉
    // （推文列的 pusher 高亮因此退回整列可點）。
    expect(g.misclickGuard).toBe(false);
  });

  test("開啟時各子開關各自生效", () => {
    const g = resolveMouseGates(ALL_ON);
    expect(g.move).toBe(true);
    expect(g.leftClick).toBe(true);
    expect(g.cursorIcon).toBe(true);
    expect(g.misclickGuard).toBe(true);
    expect(g.middleClick).toBe(1);
    expect(g.wheel).toBe(true);
    expect(g.wheelSmoothScroll).toBe(true);
  });
});

describe("子開關互不牽連", () => {
  test("左鍵關 ⇒ 指標圖示也關，但滑鼠移動（底色）仍在", () => {
    const g = resolveMouseGates({ ...ALL_ON, mouseLeftClick: false });
    expect(g.leftClick).toBe(false);
    expect(g.cursorIcon).toBe(false);
    expect(g.move).toBe(true);
    expect(g.wheel).toBe(true);
  });

  test("防誤觸關 ⇒ 只有它自己關，左鍵與底色照舊", () => {
    const g = resolveMouseGates({ ...ALL_ON, mouseMisclickGuard: false });
    expect(g.misclickGuard).toBe(false);
    expect(g.leftClick).toBe(true);
    expect(g.move).toBe(true);
  });

  test("左鍵關不影響防誤觸（推文的 pusher 高亮不歸左鍵管）", () => {
    expect(
      resolveMouseGates({ ...ALL_ON, mouseLeftClick: false }).misclickGuard,
    ).toBe(true);
  });

  test("滾輪關不影響左鍵與中鍵", () => {
    const g = resolveMouseGates({ ...ALL_ON, mouseWheel: 0 });
    expect(g.wheel).toBe(false);
    expect(g.leftClick).toBe(true);
    expect(g.middleClick).toBe(1);
  });

  test("中鍵的三態原樣傳出（0 關閉／1 貼上／2 左方向鍵）", () => {
    expect(resolveMouseGates({ ...ALL_ON, mouseMiddleClick: 0 }).middleClick).toBe(0);
    expect(resolveMouseGates({ ...ALL_ON, mouseMiddleClick: 2 }).middleClick).toBe(2);
  });

  test("設定頁存成字串時照樣可用", () => {
    expect(resolveMouseGates({ ...ALL_ON, mouseMiddleClick: "2" }).middleClick).toBe(2);
  });
});

test("缺值一律當關閉，不會意外發鍵", () => {
  const g = resolveMouseGates();
  expect(g.leftClick).toBe(false);
  expect(g.misclickGuard).toBe(false);
  expect(g.middleClick).toBe(0);
  expect(g.wheel).toBe(false);
});

describe("滾輪平滑捲動（列表好讀模式）", () => {
  test("滾輪本身關掉時，平滑捲動也不可能生效", () => {
    const g = resolveMouseGates({ ...ALL_ON, mouseWheel: 0 });
    expect(g.wheel).toBe(false);
    expect(g.wheelSmoothScroll).toBe(false);
  });

  test("單獨關掉平滑捲動 ⇒ 滾輪仍在（退回一次一頁）", () => {
    const g = resolveMouseGates({ ...ALL_ON, mouseWheelSmoothScroll: false });
    expect(g.wheel).toBe(true);
    expect(g.wheelSmoothScroll).toBe(false);
  });
});
