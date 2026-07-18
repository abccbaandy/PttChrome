import { useState, useEffect, useCallback } from "react";
import { Modal, TextInput, Button, Group } from "@mantine/core";
import { i18n } from "../../js/i18n";

// Quick-add title blacklist prompt (right-click a board-list title → this modal,
// prefilled with the FULL raw-case title so the user can trim it down to the
// keyword they actually want). Confirm hands the edited keyword to the caller
// (ContextMenu#onTitleBlacklistConfirm → quickAddBlacklist); empty input is a
// no-op there, so no validation UI is needed here.
export const TitleBlacklistModal = ({ show, draft, onHide, onConfirm }) => {
  const [value, setValue] = useState("");
  // Re-seed from the clicked row's title on every open (the component stays
  // mounted across opens, so initial state alone would go stale).
  useEffect(() => {
    if (show) setValue(draft);
  }, [show, draft]);

  const onSubmit = useCallback(
    (event) => {
      event.preventDefault();
      onConfirm(value);
    },
    [value, onConfirm],
  );

  return (
    <Modal
      opened={show}
      onClose={onHide}
      title={i18n("titleBlacklistModal_title")}
      centered
      size="lg"
    >
      <form onSubmit={onSubmit}>
        <TextInput
          data-autofocus
          name="titleBlacklistKeyword"
          label={i18n("titleBlacklistModal_label")}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={onHide}>
            {i18n("titleBlacklistModal_cancel")}
          </Button>
          <Button type="submit">{i18n("titleBlacklistModal_confirm")}</Button>
        </Group>
      </form>
    </Modal>
  );
};

export default TitleBlacklistModal;
