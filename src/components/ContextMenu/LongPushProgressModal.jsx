import { Modal, Progress, Button, Group, Text, Stack } from "@mantine/core";
import { i18n } from "../../js/i18n";

// 長推文送出中的全版遮罩。
//
// 刻意是**真 modal**（backdrop、不可點外面關、沒有右上角叉叉）：整段序列都在
// 程式化地按 PTT 的鍵，使用者這時打字或用滑鼠移動游標，會插進 X → 型別 → 內容
// 的中間（pttbbs 的 typeahead 會把中間那幀吞掉，見 command_queue.js 檔頭）。
// modalShown 由 ContextMenu 的 render state 推導，終端機因此完全讓位。
//
// 唯一的出口是「取消」——PTT 沒有收回推文的辦法，所以只能停掉還沒送出的部分，
// 這點在遮罩上寫清楚。

const replaceI18n = (id, replacements) =>
  i18n(id)
    .split(/#(\S+)#/gi)
    .map((it, index) =>
      index % 2 === 1 && it in replacements ? replacements[it] : it,
    )
    .join("");

export const LongPushProgressModal = ({ progress, onCancel }) => {
  const p = progress || { index: 0, total: 0, phase: "sending" };
  const percent = p.total ? Math.round(((p.index - 1) / p.total) * 100) : 0;
  const status =
    p.phase === "cancelling"
      ? i18n("longPushProgress_cancelling")
      : p.phase === "cooldown"
        ? replaceI18n("longPushProgress_cooldown", { s: p.waitSec })
        : replaceI18n("longPushProgress_sending", { n: p.index, m: p.total });

  return (
    <Modal
      opened={!!progress}
      onClose={() => {}}
      title={i18n("longPushProgress_title")}
      centered
      size="md"
      withCloseButton={false}
      closeOnClickOutside={false}
      closeOnEscape={false}
    >
      <Stack gap="sm">
        <Text size="sm" data-testid="longPushProgressStatus">
          {status}
        </Text>
        <Progress value={percent} animated={p.phase !== "cooldown"} />
        {p.message && (
          <Text size="xs" c="dimmed">
            {p.message}
          </Text>
        )}
        <Text size="xs" c="dimmed">
          {i18n("longPushProgress_note")}
        </Text>
        <Group justify="flex-end">
          <Button
            variant="default"
            onClick={onCancel}
            disabled={p.phase === "cancelling"}
          >
            {i18n("longPushProgress_cancel")}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
};

export default LongPushProgressModal;
