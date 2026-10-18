import { Modal, Button, Stack, Text } from "@mantine/core";
import { i18n } from "../../js/i18n";
import MobileSheet from "../MobileSheet";

// 沒寫看板的 #AID 點下去的二選一（js/aid_board_choice.js）：
//   - 本版跳轉：在目前文章的看板找（舊版的唯一行為）；目前看板判不出來時停用。
//   - 指定看板：交給搜尋彈窗的看板種類挑板名（SearchModal 的 aidTarget）。
// choice＝{ aid, currentBoard }；null ＝收起。
export const AidBoardChoiceModal = ({
  choice,
  onHide,
  onCurrent,
  onPickBoard,
  mobile,
  pttchrome,
}) => {
  const aid = choice ? choice.aid : "";
  const current = choice ? choice.currentBoard : null;
  const title = i18n("aidBoardChoice_title").replace("{0}", "#" + aid);
  const body = (
    <Stack gap="sm" data-aid-board-choice={aid}>
      <Text size="sm" c="dimmed">
        {i18n("aidBoardChoice_hint")}
      </Text>
      <Button
        data-autofocus
        data-aid-choice="current"
        disabled={!current}
        onClick={() => onCurrent(choice)}
      >
        {current
          ? i18n("aidBoardChoice_current").replace("{0}", current)
          : i18n("aidBoardChoice_currentUnknown")}
      </Button>
      <Button
        variant="light"
        data-aid-choice="pick"
        onClick={() => onPickBoard(choice)}
      >
        {i18n("aidBoardChoice_pick")}
      </Button>
    </Stack>
  );

  if (mobile)
    return (
      <MobileSheet
        pttchrome={pttchrome}
        opened={!!choice}
        onClose={onHide}
        title={title}
        sheetKey="aidBoardChoice"
      >
        {body}
      </MobileSheet>
    );
  return (
    <Modal opened={!!choice} onClose={onHide} title={title} centered>
      {body}
    </Modal>
  );
};

export default AidBoardChoiceModal;
