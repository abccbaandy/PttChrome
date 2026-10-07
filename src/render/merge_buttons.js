// 文章畫面右下角的浮動工具（原 src/components/MergeImageCaptionButton.jsx 與
// MergeImageCaptionAiButton.jsx 的純 JS 版，後來又多了「開燈」）。
//
// 三顆工具按鈕收在一顆「⋯」圓鈕（createFloatingTools）裡：平常只佔一顆圓鈕的面積，
// 桌機滑鼠移上去自動展開（純 CSS :hover，main.css `.floatTools`），觸控點一下展開、
// 選完自動收合。理由：手機換行版面的文字佔滿全寬，攤開的一疊按鈕會蓋住文章／推文。
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
import {
  FLOAT_TOOLS_POS_STORAGE_KEY,
  FLOAT_TOOLS_DEFAULT_POS,
  KEYPAD_DRAG_THRESHOLD_PX,
  clampFloatPos,
  loadFloatPos,
  saveFloatPos,
} from "../js/mobile_layout";

function floatingButton(id, onToggle) {
  const button = el("button", { id, type: "button" });
  button.addEventListener("click", onToggle);
  return button;
}

// 「⋯」圓鈕＋工具面板。位置 {right,bottom} 存 localStorage（不寫 prefs：prefs 會
// 同步到其他裝置），可拖曳；位移 < KEYPAD_DRAG_THRESHOLD_PX 才算點擊。
//
// 面板 absolute 貼在圓鈕外側（data-vdir：圓鈕在視窗下半 ⇒ 往上展開，否則往下；
// data-hdir＝圓鈕在視窗的哪一半，面板往內側展開），**圓鈕本身永遠不動**——若面板
// 撐大外框、把圓鈕推走，滑鼠就離開 :hover 範圍 ⇒ 展開／收合來回閃。
//
// data-own-control：App 的滑鼠入口（pttchrome.jsx#isOwnControlTarget）看它把整塊
// （含面板的間隙）當成我們自己的控制項，不落到邊緣翻頁。
export function createFloatingTools(storage) {
  const panel = el("div", { class: "floatTools__panel" });
  const fab = el(
    "button",
    {
      type: "button",
      class: "floatTools__fab",
      "aria-label": i18n("floatTools_toggle"),
      "aria-expanded": "false",
    },
    "⋯",
  );
  const root = el(
    "div",
    { id: "floatTools", class: "floatTools", "data-own-control": "" },
    [panel, fab],
  );
  let pos = loadFloatPos(
    FLOAT_TOOLS_POS_STORAGE_KEY,
    FLOAT_TOOLS_DEFAULT_POS,
    storage,
  );
  let drag = null;
  let suppressClick = false;
  let tools = [];

  const viewport = () => ({
    vw: window.innerWidth,
    vh: window.innerHeight,
    w: fab.offsetWidth,
    h: fab.offsetHeight,
  });
  const place = () => {
    root.style.right = pos.right + "px";
    root.style.bottom = pos.bottom + "px";
    const { vw, vh, w, h } = viewport();
    root.setAttribute("data-vdir", pos.bottom + h / 2 < vh / 2 ? "up" : "down");
    root.setAttribute(
      "data-hdir",
      pos.right + w / 2 < vw / 2 ? "right" : "left",
    );
  };
  const setOpen = (open) => {
    if (open) {
      // 開之前重新夾一次：轉向／縮放視窗後舊位置可能已在視窗外。
      if (root.isConnected)
        pos = clampFloatPos(pos, viewport(), FLOAT_TOOLS_DEFAULT_POS);
      place();
      root.setAttribute("data-open", "");
    } else {
      root.removeAttribute("data-open");
    }
    fab.setAttribute("aria-expanded", open ? "true" : "false");
  };
  const refocusTerminal = () => {
    const input = document.getElementById("t");
    if (input) input.focus();
  };

  // 桌機 hover 展開不經過 setOpen：滑鼠進來時重算展開方向（視窗可能縮放過）。
  root.addEventListener("pointerenter", () => {
    if (!drag) place();
  });
  fab.addEventListener("pointerdown", (e) => {
    drag = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      start: pos,
      moved: false,
    };
    if (fab.setPointerCapture) {
      try {
        fab.setPointerCapture(e.pointerId);
      } catch (err) {
        // 合成事件沒有對應的 active pointer ⇒ 不 capture 也能拖（只是出界會斷）。
      }
    }
  });
  fab.addEventListener("pointermove", (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < KEYPAD_DRAG_THRESHOLD_PX) return;
    drag.moved = true;
    pos = clampFloatPos(
      { right: drag.start.right - dx, bottom: drag.start.bottom - dy },
      viewport(),
      FLOAT_TOOLS_DEFAULT_POS,
    );
    place();
  });
  const endDrag = (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    const moved = drag.moved;
    drag = null;
    if (!moved) return;
    suppressClick = true;
    saveFloatPos(FLOAT_TOOLS_POS_STORAGE_KEY, pos, storage);
  };
  fab.addEventListener("pointerup", endDrag);
  fab.addEventListener("pointercancel", endDrag);
  fab.addEventListener("click", () => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    setOpen(!root.hasAttribute("data-open"));
    refocusTerminal();
  });
  // 按下工具的當下把面板寬度釘住：按鈕 label 一律是「點下去會發生什麼」，點完常常
  // 變短（「開燈（顯示隱藏文字）」→「關燈」）⇒ 靠右對齊的按鈕往右縮、游標落到面板
  // 外 ⇒ :hover 掉了、面板在游標底下收起來。滑鼠離開整塊才解除（那時本來就收合；
  // 觸控的 pointer 在放開後也會 leave）。**不可**在 setOpen(false) 解除：點工具會
  // 走到那裡，等於當場把釘住的寬度放掉。
  const releaseWidth = () => {
    panel.style.minWidth = "";
  };
  panel.addEventListener("pointerdown", () => {
    panel.style.minWidth = panel.offsetWidth + "px";
  });
  root.addEventListener("pointerleave", releaseWidth);
  // 點了面板裡的工具 ⇒ 收合（觸控的「選完自動收合」；桌機 hover 展開不受影響）。
  // 工具自己的 listener 在 target 階段先跑完，這裡是冒泡上來之後。
  panel.addEventListener("click", (e) => {
    if (e.target && e.target.closest && e.target.closest("button"))
      setOpen(false);
  });

  place();
  return {
    el: root,
    fab,
    panel,
    setTools(buttons) {
      const same =
        buttons.length === tools.length &&
        buttons.every((b, i) => b === tools[i]);
      if (same) return;
      tools = buttons.slice();
      panel.replaceChildren(...tools);
    },
    // 任一工具作用中（圖文並排／燈／AI）⇒ 收合時圓鈕也看得出來。
    setActive(active) {
      if (active) root.setAttribute("data-active", "");
      else root.removeAttribute("data-active");
    },
    setOpen,
  };
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
// 「⋯」預設 bottom:64 避開 debug 錄製按鈕的 bottom:16。
export function createMergeImageCaptionButton(onToggle) {
  const button = floatingButton("mergeImageCaptionBtn", onToggle);
  return {
    el: button,
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

// 裝置端 AI 校正鈕（面板裡排在圖文鈕之後）。
// 純規則只取「最近一段」，說明被空行切成多段時只配到第一段；AI 只回答「保留幾段」，
// 答不出來就退回規則（見 caption_ai_logic.js）。
export function createMergeImageCaptionAiButton(onToggle) {
  const button = floatingButton("mergeImageCaptionAiBtn", onToggle);
  return {
    el: button,
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

// 「開燈」鈕（面板裡排最後）。隱藏文字（前景色==背景色）
// 分兩軌，見 js/hidden_text.js：軌 A 純 CSS 提亮（容器加 .lightsOn），軌 B 的內容
// PTT **根本沒送出來**，只能替使用者切成純文字模式重讀整篇。
//
// label 一律顯示「點下去會發生什麼」，與圖文並排鈕同慣例。
export function createLightsOnButton(onToggle) {
  const button = floatingButton("lightsOnBtn", onToggle);
  return {
    el: button,
    update(active) {
      button.setAttribute("data-lights", active ? "on" : "off");
      restyle(
        button,
        active ? "#f59f00" : "#495057",
        active ? "2px solid #ffd43b" : "2px solid #ced4da",
      );
      button.textContent = active ? i18n("lightsOn_off") : i18n("lightsOn_on");
    },
  };
}
