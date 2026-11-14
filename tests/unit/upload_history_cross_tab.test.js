// @unit-env browser
// 上傳紀錄跨分頁不互蓋（同 #357 的形狀：記憶體裡的舊快照寫回 localStorage）。
//
// 症狀：分頁 A 開著（建構時讀一次紀錄），分頁 B 上傳了兩張圖；之後 A 直接拖放／貼上
// 上傳（沒開過面板），A 拿建構時的舊清單加一筆寫回 ⇒ B 那兩筆整個消失。刪一筆同理。
// 守的是「寫回前以 storage 現值為準」。
import { ImageUploadController } from "../../src/js/image_upload_controller";
import { readHistory } from "../../src/js/upload_history";

const KEY = "pttchrome.upload.v1";
const entry = (name) => ({
  url: `https://i.urusai.cc/${name}.png`,
  deleteUrl: `https://urusai.cc/del/${name}`,
  filename: `${name}.png`,
  at: 1755000000000,
});

beforeEach(() => {
  window.localStorage.removeItem(KEY);
});
afterAll(() => {
  window.localStorage.removeItem(KEY);
});

describe("上傳紀錄：別的分頁寫過之後不被舊快照蓋掉", () => {
  test("新增一筆：別的分頁剛加的紀錄還在", () => {
    window.localStorage.setItem(KEY, JSON.stringify([entry("old")]));
    const ctl = new ImageUploadController({});
    // 別的分頁在這之後上傳了兩張。
    window.localStorage.setItem(
      KEY,
      JSON.stringify([entry("b2"), entry("b1"), entry("old")]),
    );
    ctl._pushHistory(entry("mine"));
    expect(readHistory().map((it) => it.filename)).toEqual([
      "mine.png",
      "b2.png",
      "b1.png",
      "old.png",
    ]);
  });

  test("刪一筆：只刪那一筆，別的分頁剛加的紀錄還在", () => {
    window.localStorage.setItem(KEY, JSON.stringify([entry("old")]));
    const ctl = new ImageUploadController({});
    window.localStorage.setItem(KEY, JSON.stringify([entry("b1"), entry("old")]));
    ctl.removeHistory(entry("old").url);
    expect(readHistory().map((it) => it.filename)).toEqual(["b1.png"]);
    // 面板顯示的清單跟 storage 一致。
    expect(ctl._state.history.map((it) => it.filename)).toEqual(["b1.png"]);
  });
});
