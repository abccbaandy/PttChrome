// 好讀模式的兩顆浮動按鈕（原 src/components/MergeImageCaptionButton.jsx 與
// MergeImageCaptionAiButton.jsx 的純 JS 版）。
//
// 它們住在 #mainContainer 尾端、位置固定，不參與列 diff。舊版就刻意不用 Mantine
// （Screen 的 root 不在 MantineProvider 底下，Mantine 元件在此會 throw），所以是
// 純 <button> ＋ inline style 仿 Mantine xs 按鈕外觀 —— 樣式一字照抄。
//
// update() 每次都把整份 style 重下一遍（先清空再依序套）：inline style 的宣告順序
// 是序列化結果的一部分，而 golden 是逐字比對的；分兩次套會讓 background/border 跑到
// box-shadow 後面。
import { i18n } from "../js/i18n";
import { el, applyStyle } from "./dom";

function floatingButton(id, bottom, onToggle) {
  const button = el("button", { id, type: "button" });
  button.addEventListener("click", onToggle);
  const wrap = el("div", null, button);
  applyStyle(wrap, {
    position: "fixed",
    right: "16px",
    bottom: `${bottom}px`,
    zIndex: "3000",
  });
  return { wrap, button };
}

function restyle(button, background, border) {
  button.removeAttribute("style");
  applyStyle(button, {
    cursor: "pointer",
    fontSize: "12px",
    lineHeight: "1.4",
    padding: "4px 10px",
    borderRadius: "4px",
    color: "#fff",
    background,
    border,
    boxShadow: "0 0 6px rgba(0,0,0,0.6)",
  });
}

// 「圖左字右合併」三態循環（mode）：null（關）→ "imageFirst"（上圖下文）→
// "captionFirst"（上文下圖）→ null；label 一律顯示「點下去會發生什麼」。
// 容器仿 DebugRecordButton；bottom:64 避開 debug 錄製按鈕的 bottom:16。
export function createMergeImageCaptionButton(onToggle) {
  const { wrap, button } = floatingButton("mergeImageCaptionBtn", 64, onToggle);
  return {
    el: wrap,
    update(mode) {
      restyle(
        button,
        mode ? "#0ca678" : "#495057",
        mode ? "2px solid #12b886" : "2px solid #ced4da",
      );
      button.textContent =
        mode === null
          ? i18n("mergeImageCaption_on")
          : mode === "imageFirst"
            ? i18n("mergeImageCaption_captionFirst")
            : i18n("mergeImageCaption_off");
    },
  };
}

// 裝置端 AI 校正鈕（bottom:112 疊在圖文鈕的 64 之上、debug 錄製鈕的 16 之上）。
// 純規則只取「最近一段」，說明被空行切成多段時只配到第一段；AI 只回答「保留幾段」，
// 答不出來就退回規則（見 caption_ai_logic.js）。
export function createMergeImageCaptionAiButton(onToggle) {
  const { wrap, button } = floatingButton(
    "mergeImageCaptionAiBtn",
    112,
    onToggle,
  );
  return {
    el: wrap,
    update(active, pending) {
      button.setAttribute(
        "data-ai",
        pending ? "pending" : active ? "on" : "off",
      );
      restyle(
        button,
        active ? "#7048e8" : "#495057",
        active ? "2px solid #9775fa" : "2px solid #ced4da",
      );
      button.textContent = pending
        ? i18n("mergeImageCaptionAi_pending") + " " + pending
        : active
          ? i18n("mergeImageCaptionAi_off")
          : i18n("mergeImageCaptionAi_on");
    },
  };
}
