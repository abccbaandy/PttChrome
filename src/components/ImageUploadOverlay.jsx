import { Alert, Button, Group, Paper, Progress, Text } from "@mantine/core";
import { i18n } from "../js/i18n";
import "./ImageUpload.css";

// 失敗原因 → 文案。reason 可能是本地判斷的機器碼（type/size/network/timeout/busy），
// 也可能是 urusai 回來的 message 原文（未知碼一律原樣顯示，不吞掉伺服器說的話）。
export const uploadErrorText = (reason) => {
  const key = "imageUploadErr_" + String(reason || "");
  if (String(reason || "").indexOf("http_") === 0)
    return i18n("imageUploadErr_http") + " (" + reason + ")";
  const known = [
    "type",
    "size",
    "network",
    "timeout",
    "busy",
    "invalid_response",
  ];
  return known.indexOf(String(reason)) >= 0 ? i18n(key) : String(reason);
};

// 拖曳遮罩／上傳進度／結果提示。三者都是**非 modal** 浮層：終端機要能繼續打字，
// 而且插入動作本來就需要焦點留在終端機（見 docs/image-upload.md）。
export const ImageUploadOverlay = ({
  dragging,
  uploading,
  notice,
  onOpenPanel,
  onDismiss,
}) => (
  <div className="nomouse_command">
    {dragging && (
      <div className="ImageUploadDropZone nomouse_command">
        <div className="ImageUploadDropZone__Box nomouse_command">
          <Text size="xl" fw={700} className="nomouse_command">
            {i18n("imageUpload_dropHint")}
          </Text>
          <Text size="sm" c="dimmed" className="nomouse_command">
            {i18n("imageUpload_dropSubHint")}
          </Text>
        </div>
      </div>
    )}
    {uploading && (
      <Paper
        shadow="md"
        p="sm"
        withBorder
        className="ImageUploadCard nomouse_command"
      >
        <Text size="sm" className="nomouse_command">
          {i18n("imageUpload_uploading")} {uploading.index}/{uploading.total}
          {uploading.filename ? " — " + uploading.filename : ""}
        </Text>
        <Progress
          value={uploading.percent}
          size="sm"
          mt="xs"
          className="nomouse_command"
        />
      </Paper>
    )}
    {notice && (
      <Alert
        color={notice.type === "success" ? "teal" : "red"}
        className="ImageUploadCard ImageUploadCard--notice nomouse_command"
        withCloseButton
        onClose={onDismiss}
        closeButtonLabel={i18n("imageUpload_close")}
        title={
          notice.type === "success"
            ? notice.mode === "send"
              ? i18n("imageUpload_insertedSend")
              : i18n("imageUpload_insertedClipboard")
            : i18n("imageUpload_failed")
        }
      >
        {notice.urls && notice.urls.length > 0 && (
          <Text size="xs" className="ImageUploadCard__Urls nomouse_command">
            {notice.urls.join(" ")}
          </Text>
        )}
        {notice.failures && notice.failures.length > 0 && (
          <ul className="ImageUploadCard__Failures nomouse_command">
            {notice.failures.map((f, i) => (
              <li key={i} className="nomouse_command">
                {f.name ? f.name + "：" : ""}
                {uploadErrorText(f.reason)}
              </li>
            ))}
          </ul>
        )}
        <Group gap="xs" mt="xs" className="nomouse_command">
          <Button
            size="compact-xs"
            variant="light"
            className="nomouse_command"
            onClick={onOpenPanel}
          >
            {i18n("imageUpload_openHistory")}
          </Button>
        </Group>
      </Alert>
    )}
  </div>
);

export default ImageUploadOverlay;
