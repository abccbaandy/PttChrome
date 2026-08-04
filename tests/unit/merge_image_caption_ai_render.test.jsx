// 好讀「左圖右文」AI 校正的 Screen 接線守護（仿 merge_image_caption_render）。
// 回歸來源：翻譯被空行切成多段時規則只配到第一段（打蚊子那篇）——這裡用假的
// window.LanguageModel 驗「AI 回 keep=N → 整段翻譯搬進右欄」。
// 也守「沒有 Prompt API / 設定沒開 → 畫面與現況完全相同」。
import { render, fireEvent, waitFor } from "@testing-library/react";
import Screen from "../../src/components/Screen";

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

// 圖 → 空行 → 開場白 → 空行 → 對話 → 空行 → 收尾（規則只取「開場白」）。
const lines = [
  line("https://i.imgur.com/aaa111.jpg"), // 0 圖1
  line(""), // 1
  line("開場白這一段"), // 2
  line(""), // 3
  line("對話第一句"), // 4
  line("對話第二句"), // 5
  line(""), // 6
  line("收尾這一段"), // 7
  line(""), // 8
  line("https://i.imgur.com/bbb222.jpg"), // 9 圖2
  line("第二張的翻譯"), // 10
  line("--"), // 11
];

const rowsIn = (el) =>
  Array.from(el.querySelectorAll("[data-row]")).map((n) =>
    parseInt(n.getAttribute("data-row"), 10),
  );

const enhance = {
  pageState: 3,
  easyReading: true,
  dropHidden: true,
  articleId: 1,
  captionAiEnabled: true,
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
  return render(
    <Screen
      lines={lines}
      forceWidth={20}
      enableLinkInlinePreview={false}
      enableLinkHoverPreview={false}
      enhance={{ ...enhance, ...(props || {}) }}
    />,
  );
}

afterEach(() => {
  delete window.LanguageModel;
});

// availability() 是 async：按鈕晚一拍才掛上。
const waitForAiBtn = (c) =>
  waitFor(() =>
    expect(c.querySelector("#mergeImageCaptionAiBtn")).not.toBeNull(),
  );

describe("Screen 圖文合併 × 裝置端 AI", () => {
  test("AI 回 keep=3 → 開場白/對話/收尾整段進右欄（規則只會給開場白）", async () => {
    installLM('{"keep": 3}');
    const { container: c } = renderScreen();
    // availability() 是 async → 按鈕晚一拍才出現（不可用的環境永遠不出現）。
    await waitFor(() =>
      expect(c.querySelector("#mergeImageCaptionAiBtn")).not.toBeNull(),
    );
    const aiBtn = c.querySelector("#mergeImageCaptionAiBtn");
    expect(aiBtn.getAttribute("data-ai")).toBe("off");

    // 按 AI 鈕：順手開啟合併（原本沒開）→ 先看到規則結果（只有 row 2）。
    fireEvent.click(aiBtn);
    expect(c.querySelectorAll(".mergedImageBlock").length).toBe(2);
    expect(rowsIn(c.querySelectorAll(".mergedCaptionCol")[0])).toEqual([2]);

    // AI 回來後右欄擴張到 row 2~7（空行也一起搬過去，維持段落間距）。
    await waitFor(() =>
      expect(rowsIn(c.querySelectorAll(".mergedCaptionCol")[0])).toEqual([
        2, 3, 4, 5, 6, 7,
      ]),
    );
    // 內容零遺失：所有列仍在畫面上，絕對 index 不變。
    expect(
      Array.from(c.querySelectorAll('[data-type="bbsline"]'))
        .map((n) => parseInt(n.getAttribute("data-row"), 10))
        .sort((a, b) => a - b),
    ).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(c.querySelector("#mergeImageCaptionAiBtn").getAttribute("data-ai")).toBe(
      "on",
    );
  });

  test("再按一次關 AI → 回到規則結果，手動合併狀態保留", async () => {
    installLM('{"keep": 3}');
    const { container: c } = renderScreen();
    await waitForAiBtn(c);
    fireEvent.click(c.querySelector("#mergeImageCaptionAiBtn"));
    await waitFor(() =>
      expect(rowsIn(c.querySelectorAll(".mergedCaptionCol")[0]).length).toBe(6),
    );
    fireEvent.click(c.querySelector("#mergeImageCaptionAiBtn"));
    expect(rowsIn(c.querySelectorAll(".mergedCaptionCol")[0])).toEqual([2]);
    expect(c.querySelectorAll(".mergedImageBlock").length).toBe(2); // 合併仍開著
  });

  test("模型回垃圾 → 靜靜退回規則結果（不炸、不亂配）", async () => {
    installLM("sorry, I can't do that");
    const { container: c } = renderScreen();
    await waitForAiBtn(c);
    fireEvent.click(c.querySelector("#mergeImageCaptionAiBtn"));
    await waitFor(() =>
      expect(
        c.querySelector("#mergeImageCaptionAiBtn").getAttribute("data-ai"),
      ).toBe("on"),
    );
    expect(rowsIn(c.querySelectorAll(".mergedCaptionCol")[0])).toEqual([2]);
  });

  test("沒有 Prompt API（Firefox/Safari）→ 不出現 AI 按鈕", async () => {
    delete window.LanguageModel;
    const { container: c } = renderScreen();
    await new Promise((r) => setTimeout(r, 0));
    expect(c.querySelector("#mergeImageCaptionAiBtn")).toBeNull();
    expect(c.querySelector("#mergeImageCaptionBtn")).not.toBeNull();
  });

  test("有 API 但模型不可用（Chromium/未下載）→ 不出現 AI 按鈕", async () => {
    window.LanguageModel = {
      availability: () => Promise.resolve("unavailable"),
      create: () => Promise.reject(new Error("should not be called")),
    };
    const { container: c } = renderScreen();
    await new Promise((r) => setTimeout(r, 0));
    expect(c.querySelector("#mergeImageCaptionAiBtn")).toBeNull();
  });

  test("設定沒開 → 不出現 AI 按鈕（原有圖文按鈕不受影響）", async () => {
    installLM('{"keep": 3}');
    const { container: c } = renderScreen({ captionAiEnabled: false });
    await new Promise((r) => setTimeout(r, 0));
    expect(c.querySelector("#mergeImageCaptionAiBtn")).toBeNull();
    fireEvent.click(c.querySelector("#mergeImageCaptionBtn"));
    expect(rowsIn(c.querySelectorAll(".mergedCaptionCol")[0])).toEqual([2]);
  });

  test("換文章（articleId 變）→ AI 校正與結果一起重置", async () => {
    installLM('{"keep": 3}');
    const { container: c, rerender } = renderScreen();
    await waitForAiBtn(c);
    fireEvent.click(c.querySelector("#mergeImageCaptionAiBtn"));
    await waitFor(() =>
      expect(rowsIn(c.querySelectorAll(".mergedCaptionCol")[0]).length).toBe(6),
    );
    rerender(
      <Screen
        lines={lines}
        forceWidth={20}
        enableLinkInlinePreview={false}
        enableLinkHoverPreview={false}
        enhance={{ ...enhance, articleId: 2 }}
      />,
    );
    expect(c.querySelectorAll(".mergedImageBlock").length).toBe(0);
    expect(c.querySelector("#mergeImageCaptionAiBtn").getAttribute("data-ai")).toBe(
      "off",
    );
  });

  test("圖文按鈕循環回「還原排版」時 AI 也一起關掉", async () => {
    installLM('{"keep": 3}');
    const { container: c } = renderScreen();
    await waitForAiBtn(c);
    fireEvent.click(c.querySelector("#mergeImageCaptionAiBtn"));
    await waitFor(() =>
      expect(rowsIn(c.querySelectorAll(".mergedCaptionCol")[0]).length).toBe(6),
    );
    // imageFirst → captionFirst → 關
    fireEvent.click(c.querySelector("#mergeImageCaptionBtn"));
    fireEvent.click(c.querySelector("#mergeImageCaptionBtn"));
    expect(c.querySelectorAll(".mergedImageBlock").length).toBe(0);
    expect(c.querySelector("#mergeImageCaptionAiBtn").getAttribute("data-ai")).toBe(
      "off",
    );
  });
});
