import {
  Modal,
  Textarea,
  Button,
  Group,
  Text,
  Alert,
  Stack,
} from "@mantine/core";
import { i18n } from "../../js/i18n";

// 長推文推不出去時的錯誤框（探路被擋、送出途中中止、取消）。
//
// 兩條規矩，改這個檔案之前先讀 docs/long-push.md：
//
// 1. **PTT 的訊息原文照錄**。error.message 在 source==='ptt' 時就是
//    classifyPushScreen 從畫面讀到的那一行（已經剝掉 ◆ 與 [按任意鍵繼續]），這裡
//    不做任何字串處理、不對照翻譯、不套自己的說法。理由：PTT 的擋人訊息會隨站方
//    設定與版本變（「無法推文: <reason>」的 reason 更是動態的），任何硬寫的對照表
//    都會在改版那天靜默壞掉，而使用者會看到一句與 PTT 無關的話。來源用下面那行
//    dimmed 小字標示，讓使用者知道這句話是誰說的。
// 2. **剩餘內容不自動進剪貼簿**，放在唯讀 Textarea 裡讓使用者自己選取或按鈕複製
//    （舊版偷偷 doCopy，等於無聲蓋掉他手上的剪貼簿內容）。

const replaceI18n = (id, replacements) =>
  i18n(id)
    .split(/#(\S+)#/gi)
    .map((it, index) =>
      index % 2 === 1 && it in replacements ? replacements[it] : it,
    )
    .join("");

const titleOf = (phase) => {
  if (phase === "cancelled") return i18n("longPushError_titleCancelled");
  if (phase === "sending") return i18n("longPushError_titleSending");
  return i18n("longPushError_title");
};

export const LongPushErrorModal = ({ error, onHide, onCopy }) => {
  const rest = (error && error.rest) || "";
  const sent = (error && error.sent) || 0;
  return (
    <Modal
      opened={!!error}
      onClose={onHide}
      title={titleOf(error && error.phase)}
      centered
      size="lg"
      // 剩下的稿子還在這個框裡，點一下外面就沒了是不能接受的（同 LongPushModal）。
      closeOnClickOutside={false}
    >
      {error && (
        <>
          <Stack gap="xs">
            <Alert color="red" variant="light">
              <Text
                data-testid="longPushErrorMessage"
                style={{ whiteSpace: "pre-wrap" }}
              >
                {error.message}
              </Text>
            </Alert>
            <Text size="xs" c="dimmed" data-testid="longPushErrorSource">
              {error.source === "ptt"
                ? i18n("longPushError_sourcePtt")
                : i18n("longPushError_sourceClient")}
            </Text>
            {error.reason && (
              <Text size="xs" c="dimmed">
                {replaceI18n("longPushError_reason", { r: error.reason })}
              </Text>
            )}
            <Text size="sm" data-testid="longPushErrorSent">
              {sent
                ? replaceI18n("longPushError_sent", { n: sent })
                : i18n("longPushError_sentNone")}
            </Text>
            {sent > 0 && (
              <Text size="xs" c="dimmed">
                {i18n("longPushError_noRecall")}
              </Text>
            )}
            {rest && (
              <Textarea
                name="longPushRest"
                label={i18n("longPushError_restLabel")}
                readOnly
                autosize
                minRows={3}
                maxRows={10}
                value={rest}
              />
            )}
          </Stack>
          <Group justify="flex-end" mt="md">
            {rest && (
              <Button variant="default" mr="auto" onClick={() => onCopy(rest)}>
                {i18n("longPushError_copyRest")}
              </Button>
            )}
            <Button onClick={onHide}>{i18n("longPushError_close")}</Button>
          </Group>
        </>
      )}
    </Modal>
  );
};

export default LongPushErrorModal;
