import { useState, useCallback } from "react";
import { Button, Text, CloseButton, Group } from "@mantine/core";
import { i18n } from "../../js/i18n";
import { DebugRecorder } from "../../js/debug_recorder";
import { downloadAsFile } from "../../js/util";
import { readValuesWithDefault } from "../../js/pref_storage";

// Debug 錄製浮動按鈕：debug mode（設定→關於，runtime-only）開啟時才渲染。
// 點一下開始錄製（monkey-patch onData/_sendRaw），再點一下停止 → redact →
// 觸發瀏覽器下載 JSON（schema 見 src/js/debug_recorder_logic.js）。
const pad2 = (n) => String(n).padStart(2, "0");
const stampName = () => {
  const d = new Date();
  return (
    "ptt-debug-" +
    d.getFullYear() +
    pad2(d.getMonth() + 1) +
    pad2(d.getDate()) +
    "-" +
    pad2(d.getHours()) +
    pad2(d.getMinutes()) +
    pad2(d.getSeconds()) +
    ".json"
  );
};

export const DebugRecordButton = ({ pttchrome }) => {
  const [recording, setRecording] = useState(
    () => !!pttchrome.debugRecorder?.isRecording,
  );
  const [downloaded, setDownloaded] = useState(false);

  const onClick = useCallback(() => {
    if (!pttchrome.debugRecorder?.isRecording) {
      pttchrome.debugRecorder = new DebugRecorder(pttchrome);
      pttchrome.debugRecorder.start();
      setDownloaded(false);
      setRecording(true);
    } else {
      const json = pttchrome.debugRecorder.stop({
        prefs: readValuesWithDefault(),
      });
      pttchrome.debugRecorder = null;
      if (json) downloadAsFile(stampName(), json);
      setRecording(false);
      setDownloaded(true);
    }
    // 焦點還給終端機隱藏輸入框，避免按鈕吃掉鍵盤。
    pttchrome.setInputAreaFocus();
  }, [pttchrome]);

  return (
    <div
      style={{
        position: "fixed",
        right: 16,
        bottom: 16,
        zIndex: 3000,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        gap: 4,
        maxWidth: 280,
      }}
    >
      {downloaded && (
        <Group
          gap={4}
          wrap="nowrap"
          align="flex-start"
          style={{
            background: "rgba(0,0,0,0.7)",
            padding: "2px 6px",
            borderRadius: 4,
          }}
        >
          <Text size="xs" c="yellow">
            {i18n("debugRecord_downloaded_warning")}
          </Text>
          <CloseButton
            size="xs"
            aria-label="Close"
            onClick={() => setDownloaded(false)}
          />
        </Group>
      )}
      <Button
        id="debugRecordBtn"
        size="xs"
        color={recording ? "red" : "gray"}
        variant="filled"
        onClick={onClick}
        style={{
          // 仿錄製中的紅色明顯外框：未錄製也給一個醒目框，避免按鈕沉進畫面。
          border: recording ? "2px solid #fa5252" : "2px solid #ced4da",
          boxShadow: "0 0 6px rgba(0,0,0,0.6)",
        }}
      >
        {recording
          ? "■ " + i18n("debugRecord_stop")
          : "● " + i18n("debugRecord_start")}
      </Button>
    </div>
  );
};

export default DebugRecordButton;
