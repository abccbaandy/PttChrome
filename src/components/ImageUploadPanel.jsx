import { ActionIcon, Anchor, Button, Group, Paper, Text } from "@mantine/core";
import { i18n } from "../js/i18n";
import "./ImageUpload.css";

const formatTime = (at) => {
  if (!at) return "";
  try {
    return new Date(at).toLocaleString();
  } catch (e) {
    return "";
  }
};

// 上傳紀錄的浮動面板：挑一張舊圖再插入推文／內文，不必重傳。
//
// **不是 modal**（終端機要能繼續收鍵盤），所以每個可點元素都掛 nomouse_command，
// 且 pttchrome.jsx 的 mouse_* 入口會先問 isUploadLayerTarget 整條讓開——少了那條，
// 點「插入」會順便在 PTT 上送出一次滑鼠動作、面板內滾動會變成 PTT 翻頁。
export const ImageUploadPanel = ({
  history = [],
  onInsert,
  onCopy,
  onRemove,
  onClear,
  onClose,
}) => (
  <Paper
    shadow="md"
    p="sm"
    withBorder
    className="ImageUploadPanel nomouse_command"
  >
    <Group justify="space-between" mb="xs" className="nomouse_command">
      <Text fw={700} size="sm" className="nomouse_command">
        {i18n("imageUpload_historyTitle")}
      </Text>
      <Group gap="xs" className="nomouse_command">
        <Button
          size="compact-xs"
          variant="subtle"
          color="red"
          className="ImageUploadPanel__Clear nomouse_command"
          disabled={!history.length}
          onClick={onClear}
        >
          {i18n("imageUpload_clearAll")}
        </Button>
        <ActionIcon
          size="sm"
          variant="subtle"
          className="nomouse_command"
          aria-label={i18n("imageUpload_close")}
          onClick={onClose}
        >
          ✕
        </ActionIcon>
      </Group>
    </Group>
    {history.length === 0 ? (
      <Text size="sm" c="dimmed" className="nomouse_command">
        {i18n("imageUpload_historyEmpty")}
      </Text>
    ) : (
      <div className="ImageUploadPanel__Scroll nomouse_command">
        {/* 捲動用原生 overflow 而不是 Mantine ScrollArea：後者在 jsdom 需要
            ResizeObserver（測試環境沒有），而這裡只是一段清單，換不到任何行為。
            面板內滾動不會變成 PTT 翻頁——pttchrome 的 mouse_scroll 會先讓開。 */}
        <ul className="ImageUploadPanel__List nomouse_command">
          {history.map((item) => (
            <li
              key={item.url}
              className="ImageUploadPanel__Item nomouse_command"
            >
              <img
                className="ImageUploadPanel__Thumb nomouse_command"
                src={item.url}
                alt={item.filename || ""}
                loading="lazy"
              />
              <div className="ImageUploadPanel__Meta nomouse_command">
                <Text size="xs" className="nomouse_command" lineClamp={1}>
                  {item.filename || item.url}
                </Text>
                <Text size="xs" c="dimmed" className="nomouse_command">
                  {formatTime(item.at)}
                </Text>
                <Group gap="xs" mt={4} className="nomouse_command">
                  <Button
                    size="compact-xs"
                    className="ImageUploadPanel__Insert nomouse_command"
                    onClick={() => onInsert(item.url)}
                  >
                    {i18n("imageUpload_insert")}
                  </Button>
                  <Button
                    size="compact-xs"
                    variant="light"
                    className="ImageUploadPanel__Copy nomouse_command"
                    onClick={() => onCopy(item.url)}
                  >
                    {i18n("imageUpload_copyUrl")}
                  </Button>
                  {item.deleteUrl && (
                    <Anchor
                      size="xs"
                      className="nomouse_command"
                      href={item.deleteUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      {i18n("imageUpload_deleteLink")}
                    </Anchor>
                  )}
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    color="red"
                    className="ImageUploadPanel__Remove nomouse_command"
                    onClick={() => onRemove(item.url)}
                  >
                    {i18n("imageUpload_removeEntry")}
                  </Button>
                </Group>
              </div>
            </li>
          ))}
        </ul>
      </div>
    )}
  </Paper>
);

export default ImageUploadPanel;
