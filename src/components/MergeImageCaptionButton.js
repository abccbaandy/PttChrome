import { i18n } from "../js/i18n";

// 好讀模式「圖左字右合併」浮動切換按鈕（容器仿 DebugRecordButton；bottom:64
// 避開 debug 錄製按鈕的 bottom:16）。顯示條件在 Screen（好讀文章頁且偵測到
// ≥2 個「圖＋說明」塊）。
// 三態循環（mode）：null（關）→ "imageFirst"（上圖下文）→ "captionFirst"
// （上文下圖）→ null；label 一律顯示「點下去會發生什麼」。
// 注意：Screen 的 React root（#mainContainer）不在 MantineProvider 底下——
// Mantine 元件在此會 throw，故用純 <button>＋inline style 仿 Mantine xs 按鈕外觀。
export const MergeImageCaptionButton = ({ mode, onToggle }) => (
  <div
    style={{
      position: "fixed",
      right: 16,
      bottom: 64,
      zIndex: 3000,
    }}
  >
    <button
      id="mergeImageCaptionBtn"
      type="button"
      onClick={onToggle}
      style={{
        cursor: "pointer",
        fontSize: 12,
        lineHeight: "1.4",
        padding: "4px 10px",
        borderRadius: 4,
        color: "#fff",
        background: mode ? "#0ca678" : "#495057",
        border: mode ? "2px solid #12b886" : "2px solid #ced4da",
        boxShadow: "0 0 6px rgba(0,0,0,0.6)",
      }}
    >
      {mode === null
        ? i18n("mergeImageCaption_on")
        : mode === "imageFirst"
          ? i18n("mergeImageCaption_captionFirst")
          : i18n("mergeImageCaption_off")}
    </button>
  </div>
);

export default MergeImageCaptionButton;
