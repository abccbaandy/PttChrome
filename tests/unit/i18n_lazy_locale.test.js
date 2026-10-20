// 英文語系是 lazy chunk（src/js/i18n.js 檔頭、docs/build-modernization.md「主 bundle 拆檔」）。
// 鎖：
//  1. 還沒載入時 setupI18n() 不會整頁沒字（退回中文）；loadI18n() 之後就是英文；
//  2. 瀏覽器是中文就根本不載英文；
//  3. main.jsx 開站前一定 await loadI18n()（不然英文使用者開站第一眼全是中文）。
// 「英文語系不在開站必載的靜態 import 圖裡」由 lazy_modal_chunks.test.js 守。
import fs from "node:fs";
import path from "node:path";
import { setupI18n, loadI18n, registerLocale, i18n, getLang } from "../../src/js/i18n";
import { en_US } from "../../src/js/en_US_messages";
import { zh_TW } from "../../src/js/zh_TW_messages";

const navProto = Object.getPrototypeOf(navigator);

afterEach(() => {
  vi.restoreAllMocks();
  registerLocale("en_us", en_US); // tests/unit/setup.js 的狀態
  setupI18n();
});

test("英文還沒載入：先用中文；loadI18n() 之後換成英文", async () => {
  vi.spyOn(navProto, "languages", "get").mockReturnValue(["en-US"]);
  registerLocale("en_us", undefined);
  expect(getLang()).toBe("en_us");
  setupI18n();
  expect(i18n("inbox_mail")).toBe(zh_TW.inbox_mail.message);
  await loadI18n();
  setupI18n();
  expect(i18n("inbox_mail")).toBe(en_US.inbox_mail.message);
});

test("瀏覽器是中文：不載英文", async () => {
  vi.spyOn(navProto, "languages", "get").mockReturnValue(["zh-TW", "en-US"]);
  registerLocale("en_us", undefined);
  await loadI18n();
  setupI18n();
  expect(i18n("inbox_mail")).toBe(zh_TW.inbox_mail.message);
  // 沒被載進來：切回英文偏好時仍要再 loadI18n() 一次。
  vi.spyOn(navProto, "languages", "get").mockReturnValue(["en-US"]);
  setupI18n();
  expect(i18n("inbox_mail")).toBe(zh_TW.inbox_mail.message);
});

test("main.jsx 在 startApp 之前 await loadI18n()", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "src/js/main.jsx"), "utf8");
  const load = src.slice(src.indexOf("function loadResources"));
  const all = load.slice(load.indexOf("Promise.all(["), load.indexOf("]).then("));
  expect(all).toContain("loadI18n()");
  expect(load.indexOf("]).then(")).toBeLessThan(load.indexOf("startApp)"));
  expect(load.indexOf("]).then(")).toBeLessThan(load.indexOf("startApp();"));
});
