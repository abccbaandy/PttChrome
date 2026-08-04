import { i18n } from "../js/i18n";

// 好讀「左圖右文」的**裝置端 AI 校正**浮動按鈕（與 MergeImageCaptionButton 分開，
// bottom:112 疊在它的 64 之上、debug 錄製鈕的 16 之上）。
// 顯示條件在 Screen：現有圖文按鈕的條件 ＋ 設定啟用 ＋ 這個瀏覽器有 Prompt API。
// 純規則只取「最近一段」，說明被空行切成多段時只配到第一段；AI 只回答「保留
// 幾段」，答不出來就退回規則（見 caption_ai_logic.js）。
// 同 MergeImageCaptionButton：Screen 的 React root 不在 MantineProvider 底下，
// 故用純 <button> ＋ inline style。
export const MergeImageCaptionAiButton = ({ active, pending, onToggle }) => (
  <div
    style={{
      position: "fixed",
      right: 16,
      bottom: 112,
      zIndex: 3000,
    }}
  >
    <button
      id="mergeImageCaptionAiBtn"
      type="button"
      onClick={onToggle}
      data-ai={pending ? "pending" : active ? "on" : "off"}
      style={{
        cursor: "pointer",
        fontSize: 12,
        lineHeight: "1.4",
        padding: "4px 10px",
        borderRadius: 4,
        color: "#fff",
        background: active ? "#7048e8" : "#495057",
        border: active ? "2px solid #9775fa" : "2px solid #ced4da",
        boxShadow: "0 0 6px rgba(0,0,0,0.6)",
      }}
    >
      {pending
        ? i18n("mergeImageCaptionAi_pending") + " " + pending
        : active
          ? i18n("mergeImageCaptionAi_off")
          : i18n("mergeImageCaptionAi_on")}
    </button>
  </div>
);

export default MergeImageCaptionAiButton;
