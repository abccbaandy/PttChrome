// 內文跨行連結（src/js/body_wrap.js）的 Screen 接線守護。
//
// 使用者 2026-08-30 回報：`※ 文章網址:` 那行被 PTT 切成兩列之後，
// 「複製文章代碼／複製文章 deep link」整組消失（articleTargetFromAnchor →
// parseArticleUrl 對殘段回 null）。修法**不是**在下面補一行 ↳ 修復連結，而是讓
// 兩列的殘段本身變成同一條 <a>。
import { mountScreen, unmountAll } from "./helpers/mount_screen";
import { seg, link, row } from "./helpers/screen_fixtures";
import { parseArticleUrl } from "../../src/js/aid_codec";

// 跨行連結一定會掛延遲載入佔位盒，resolver 在後續 microtask reject。
const flushPreviews = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(unmountAll);

const PREFIX = "08/30/2026 06:06:19 ※ 文章網址: "; // 33 欄
const FRAG_L = "https://www.ptt.cc/bbs/PttBug/M.1788041180.A."; // 收在 col 77
const FRAG_R = "404.html";
const FULL = FRAG_L + FRAG_R;

const lines = [
  row(seg("作者  show800829 (showtime) 看板  PttBug")),
  row(seg(PREFIX), link(FRAG_L, FRAG_L)),
  row(seg(FRAG_R)),
];

const render = (props) =>
  mountScreen({
    lines,
    enableLinkInlinePreview: true,
    enableLinkHoverPreview: false,
    enhance: {
      pageState: 3,
      easyReading: true,
      dropHidden: true,
      articleId: "body-wrap-1",
      autoFixUrl: true,
      ...props,
    },
  });

const anchorsIn = (c, dataRow) =>
  Array.from(
    c.querySelectorAll(`[data-type="bbsline"][data-row="${dataRow}"] a`),
  );

describe("Screen 內文跨行連結", () => {
  test("兩列都變成指向完整網址的同一條連結", async () => {
    const { container: c } = render();
    const left = anchorsIn(c, 1);
    const right = anchorsIn(c, 2);
    expect(left).toHaveLength(1);
    expect(right).toHaveLength(1);
    // class="y" ＝一般超連結：底線樣式／hover 預覽／isAnchorTarget／右鍵
    // contextOnUrl 全部沿用，消費端一行都不用改。
    expect(left[0].className).toBe("y");
    expect(right[0].className).toBe("y");
    expect(left[0].getAttribute("href")).toBe(FULL);
    expect(right[0].getAttribute("href")).toBe(FULL);
    // 原文一個字都不改，只是被包進 <a>。
    expect(left[0].textContent).toBe(FRAG_L);
    expect(right[0].textContent).toBe(FRAG_R);
    await flushPreviews();
  });

  test("右鍵的「複製文章代碼／deep link」拿得到 board+aid（回報的症狀）", async () => {
    const { container: c } = render();
    const href = anchorsIn(c, 1)[0].getAttribute("href");
    expect(parseArticleUrl(href)).toEqual({ board: "PttBug", aid: "1garVSG4" });
    // 對照組：殘段自己是解不出來的，這正是功能消失的原因。
    expect(parseArticleUrl(FRAG_L)).toBeNull();
    await flushPreviews();
  });

  test("一條網址只開一張圖：預覽 slot 只掛在最後一段", async () => {
    const { container: c } = render();
    expect(c.querySelectorAll(".inlinePreviewSlot")).toHaveLength(1);
    // slot 掛在右列（最後一段）那一列底下。
    const rightRow = c.querySelector('[type="bbsrow"][srow="2"]');
    expect(rightRow.querySelectorAll(".inlinePreviewSlot")).toHaveLength(1);
    await flushPreviews();
  });

  test("不是走 ↳ 修復行那條路", async () => {
    const { container: c } = render();
    expect(c.querySelector(".fixedUrlLine")).toBeNull();
    await flushPreviews();
  });

  test("關掉「自動修復斷掉的連結」→ 退回原狀（殘段連到 404、右列不是連結）", async () => {
    const { container: c } = render({ autoFixUrl: false });
    const left = anchorsIn(c, 1);
    expect(left).toHaveLength(1);
    expect(left[0].getAttribute("href")).toBe(FRAG_L);
    expect(anchorsIn(c, 2)).toHaveLength(0);
    await flushPreviews();
  });
});
