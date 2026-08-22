// URL 修復 gray 候選的渲染接線守護（仿 merge_image_caption_ai_render）。
// 回歸來源：`The goal was to match a modern Call of Duty. It does not.` 被修成
// https://Duty.It（`it` = 義大利 ccTLD，剛好也是英文單字）。
//
// 鎖的是**症狀**：那一列不得長出修復連結。方向與裸網域相反——gray 候選規則層
// 預設不修，只有裝置端 AI 明確答 true 才放行（見 url_ai_logic.js applyAiFix）。
import { waitFor } from "@testing-library/dom";
import { mountScreen, unmountAll } from "./helpers/mount_screen";

const COLOR = {
  fg: 7,
  bg: 0,
  blink: false,
  equals(o) {
    return o === this;
  },
};

function cell(c) {
  return {
    ch: c,
    isLeadByte: false,
    isStartOfURL: () => false,
    isEndOfURL: () => false,
    getFullURL: () => null,
    getColor: () => COLOR,
  };
}
const line = (str) => str.split("").map(cell);

const PROSE = "The goal was to match a modern Call of Duty. It does not.";
// 有路徑 ⇒ 非 gray ⇒ 不受 AI 閘門影響，永遠修。
const BROKEN = "圖在 example.com /badpath.jpg 這裡";
// 無 scheme 無路徑、真的被空白打斷 ⇒ gray，與上面的散文同形。
const SPACED = "官網在這 www . a .com 記得去看";

const lines = [line(PROSE), line(BROKEN), line(SPACED)];

const enhance = {
  pageState: 3,
  easyReading: true,
  dropHidden: true,
  articleId: 1,
  autoFixUrl: true,
};

function installLM(reply) {
  const calls = [];
  const session = {
    prompt: (text) => {
      calls.push(text);
      return Promise.resolve(typeof reply === "function" ? reply(text) : reply);
    },
    clone: () => Promise.resolve(session),
    destroy: () => {},
  };
  window.LanguageModel = {
    availability: () => Promise.resolve("available"),
    create: () => Promise.resolve(session),
  };
  return calls;
}

function renderScreen(props) {
  return mountScreen({
    lines,
    forceWidth: 80,
    // 修復連結另起一行，只在好讀（＝有 inline preview）時渲染，見 link_segment.js。
    // 本測試三列都沒有帶 scheme 的真 URL，不會發預覽請求。
    enableLinkInlinePreview: true,
    enableLinkHoverPreview: false,
    enhance: { ...enhance, ...(props || {}) },
  });
}

const fixedHrefs = (c) =>
  Array.from(c.querySelectorAll(".fixedUrlLine a")).map((a) =>
    a.getAttribute("href"),
  );

afterEach(() => {
  unmountAll();
  delete window.LanguageModel;
});

describe("畫面 URL 修復 × gray 候選閘門", () => {
  test("AI 關閉（預設）：句號誤判不出現，有路徑的修復照舊", () => {
    const { container: c } = renderScreen();
    expect(fixedHrefs(c)).toEqual(["https://example.com/badpath.jpg"]);
  });

  test("AI 關閉：連真的被打斷的裸網域也不修（形狀分不出來，保守側）", () => {
    const { container: c } = renderScreen();
    expect(fixedHrefs(c)).not.toContain("https://www.a.com");
  });

  test("沒有 Prompt API 但設定開著 → 與 AI 關閉時完全相同", async () => {
    delete window.LanguageModel;
    const { container: c } = renderScreen({ fixAiEnabled: true });
    await waitFor(() => expect(fixedHrefs(c).length).toBe(1));
    expect(fixedHrefs(c)).toEqual(["https://example.com/badpath.jpg"]);
  });

  test("AI 答 true → 放行；散文那列仍靠 AI 自己答 false 擋掉", async () => {
    // 只有真的被空白打斷的那筆答 true，散文答 false。
    installLM((text) =>
      text.includes("www . a .com") ? '{"link": true}' : '{"link": false}',
    );
    const { container: c } = renderScreen({ fixAiEnabled: true });
    await waitFor(() => expect(fixedHrefs(c)).toContain("https://www.a.com"));
    expect(fixedHrefs(c)).not.toContain("https://Duty.It");
  });

  test("AI 全部答 false → 只剩非 gray 的修復", async () => {
    installLM('{"link": false}');
    const { container: c } = renderScreen({ fixAiEnabled: true });
    await waitFor(() => expect(window.LanguageModel).toBeDefined());
    expect(fixedHrefs(c)).toEqual(["https://example.com/badpath.jpg"]);
  });

  test("AI 回垃圾（解析不出來）→ 不放行，等同 AI 關閉", async () => {
    installLM("I cannot help with that.");
    const { container: c } = renderScreen({ fixAiEnabled: true });
    await waitFor(() => expect(window.LanguageModel).toBeDefined());
    expect(fixedHrefs(c)).toEqual(["https://example.com/badpath.jpg"]);
  });
});
