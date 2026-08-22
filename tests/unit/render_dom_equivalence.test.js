// 核心畫面渲染鏈的 **DOM 契約 golden**。
//
// 為什麼是整份快照而不是逐條斷言：渲染鏈的產物有一票消費端在 unit 測不到的地方
// （term_view.countCol 的選取複製反查、fixedResize 直接掃 .wpadding、ContextMenu
// 讀 data-pusher-col/data-list-*、main.css 的一堆 class），逐條寫斷言不可能不漏。
//
// tests/unit/fixtures/screen_golden/*.html 最初是用**去 React 化之前**的
// <Screen>/<Row> 產生的（2026-08），所以這一檔同時也是那次改寫的等價性證明。
//
// 更新 golden：`UPDATE_GOLDEN=1 yarn test:unit render_dom_equivalence`
// —— 只有在**刻意**要改渲染輸出時才這樣做，並在 review 時逐行看 diff。
//
// ImagePreviewer（唯一留在核心畫面裡的 React 葉子島）的內部已被 normalizeHtml 剪掉。

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ScreenController } from "../../src/render/screen";
import {
  SCENARIOS,
  INTERACTIONS,
  normalizeHtml,
} from "./helpers/screen_fixtures";

const GOLDEN_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "screen_golden",
);

const UPDATE = !!process.env.UPDATE_GOLDEN;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("核心畫面渲染鏈的 DOM 契約", () => {
  for (const sc of SCENARIOS) {
    test(sc.name, async () => {
      const root = document.createElement("div");
      document.body.appendChild(root);
      const controller = new ScreenController(root);
      controller.update({
        lines: sc.lines,
        forceWidth: sc.forceWidth,
        enableLinkInlinePreview: sc.enableLinkInlinePreview,
        enableLinkHoverPreview: sc.enableLinkHoverPreview,
        enhance: sc.enhance,
      });
      await settle();

      const actions = INTERACTIONS[sc.name];
      if (actions && actions.cursorHighlight) {
        controller.setCursorHighlight(actions.cursorHighlight);
      }
      if (actions && actions.mergeCaption) {
        const btn = controller.container.querySelector("#mergeImageCaptionBtn");
        expect(btn).not.toBeNull();
        const order = [null, "imageFirst", "captionFirst"];
        const times = order.indexOf(actions.mergeCaption);
        for (let i = 0; i < times; ++i) btn.click();
        await settle();
      }

      const html = normalizeHtml(controller.container);
      const goldenPath = path.join(GOLDEN_DIR, sc.name + ".html");
      if (UPDATE) {
        // 唯一的寫檔點。沒帶 UPDATE_GOLDEN 時這一段完全不執行 ⇒ 一般 CI／本機
        // 跑測試絕不可能覆寫 golden。
        fs.writeFileSync(goldenPath, html + "\n");
      } else {
        const golden = fs
          .readFileSync(goldenPath, "utf8")
          .replace(/\n$/, "");
        expect(html).toBe(golden);
      }

      controller.destroy();
      root.remove();
    });
  }
});
