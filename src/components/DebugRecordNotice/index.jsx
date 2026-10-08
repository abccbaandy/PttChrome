import { useState, useEffect } from "react";
import { Text, CloseButton, Group } from "@mantine/core";
import { i18n } from "../../js/i18n";

// 「已下載錄製檔」提示：錄製鈕本身在「⋯」浮動工具裡（render/merge_buttons.js），
// 停止錄製（或關掉 debug 模式時自動停止）下載完檔案後，App 經
// onDebugRecordDownloaded 通知這裡。提示留著直到使用者按 X —— 內容是隱私警告，
// 不可以閃一下就消失。
export const DebugRecordNotice = ({ pttchrome }) => {
  const [shown, setShown] = useState(false);

  useEffect(
    () => pttchrome.onDebugRecordDownloaded(() => setShown(true)),
    [pttchrome],
  );

  if (!shown) return null;
  return (
    <Group
      id="debugRecordNotice"
      gap={4}
      wrap="nowrap"
      align="flex-start"
      style={{
        position: "fixed",
        left: "50%",
        bottom: 120,
        transform: "translateX(-50%)",
        zIndex: 3000,
        width: "max-content",
        maxWidth: "min(360px, calc(100vw - 32px))",
        background: "rgba(0,0,0,0.8)",
        padding: "4px 8px",
        borderRadius: 4,
        boxShadow: "0 0 6px rgba(0,0,0,0.6)",
      }}
    >
      <Text size="xs" c="yellow">
        {i18n("debugRecord_downloaded_warning")}
      </Text>
      <CloseButton
        size="xs"
        aria-label="Close"
        onClick={() => {
          setShown(false);
          pttchrome.setInputAreaFocus();
        }}
      />
    </Group>
  );
};

export default DebugRecordNotice;
