import { Modal, Button } from "@mantine/core";
import { i18n } from "../js/i18n";

// 與 Developer/Connection 兩個頂部橫幅 alert 不同，貼上提示是個對話框（需 backdrop +
// ESC）。直接用 Mantine Modal 自帶；掛載端（pttchrome.showPasteUnimplemented）傳
// opened/onClose，× / 按鈕 / ESC 皆走 onClose → unmount 容器。
export const PasteShortcutAlert = ({ opened, onClose }) => (
  <Modal
    opened={opened}
    onClose={onClose}
    title={i18n("alert_pasteShortcutHeader")}
  >
    <p>{i18n("alert_pasteShortcutText")}</p>
    <Button onClick={onClose}>{i18n("alert_pasteShortcutClose")}</Button>
  </Modal>
);

export default PasteShortcutAlert;
