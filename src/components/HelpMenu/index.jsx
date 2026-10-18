import { useState, useEffect, useCallback, useRef } from "react";
import { Modal, Button, Group, Text } from "@mantine/core";
import { i18n } from "../../js/i18n";
import MobileSheet from "../MobileSheet";
import "./HelpMenu.css";

// 說明選單好讀（docs/help-menu.md）：PTT 新版 `h` 說明（分頁的游標選單）由
// js/help_menu.js#HelpMenuController 認出、背景補齊全部頁，這裡一次列出來，點一下＝
// 執行（控制器送 Home → PgDn… → ↓… → Enter，等同原生在那一項上按 Enter）。
// 桌機＝Mantine Modal（↑↓／Home／End 移動、Enter 執行、q／←／Esc 離開，同原生鍵位）；
// 手機＝bottom sheet（系統返回＝離開，同原生 q）。
// 開著＝modal：桌機經 App.setModalOpen("helpMenu")；手機 MobileSheet 自己登記。
const EMPTY = {
  open: false,
  caption: "",
  angel: false,
  items: [],
  loading: false,
};

export const HelpMenu = ({ pttchrome, mobile }) => {
  const ctrl = pttchrome ? pttchrome.helpMenu : null;
  const [snap, setSnap] = useState(() => (ctrl ? ctrl.snapshot() : EMPTY));
  const [active, setActive] = useState(0);
  const itemRefs = useRef([]);

  useEffect(() => {
    if (!ctrl) return undefined;
    ctrl.onChange = setSnap;
    setSnap(ctrl.snapshot());
    return () => {
      if (ctrl.onChange === setSnap) ctrl.onChange = null;
    };
  }, [ctrl]);

  useEffect(() => {
    if (mobile || !pttchrome || typeof pttchrome.setModalOpen !== "function")
      return undefined;
    pttchrome.setModalOpen("helpMenu", snap.open);
    return () => pttchrome.setModalOpen("helpMenu", false);
  }, [pttchrome, mobile, snap.open]);

  useEffect(() => {
    if (snap.open) setActive(0);
  }, [snap.open]);

  const onClose = useCallback(() => ctrl && ctrl.close(), [ctrl]);
  const onNative = useCallback(() => ctrl && ctrl.showNative(), [ctrl]);
  const onAngel = useCallback(() => ctrl && ctrl.callAngel(), [ctrl]);
  const onSelect = useCallback((i) => ctrl && ctrl.select(i), [ctrl]);

  const focusItem = useCallback((i) => {
    setActive(i);
    const el = itemRefs.current[i];
    if (el) {
      el.focus();
      if (el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
    }
  }, []);

  // 鍵位比照原生說明選單（psb.c#cmd_show_help_layers_inner）。Esc 由 Modal 自己收。
  const onKeyDown = useCallback(
    (e) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const n = snap.items.length;
      let handled = true;
      switch (e.key) {
        case "ArrowDown":
          if (n) focusItem(Math.min(n - 1, active + 1));
          break;
        case "ArrowUp":
          if (n) focusItem(Math.max(0, active - 1));
          break;
        case "Home":
          if (n) focusItem(0);
          break;
        case "End":
          if (n) focusItem(n - 1);
          break;
        case "Enter":
        case "ArrowRight":
          if (n) onSelect(active);
          break;
        case "q":
        case "Q":
        case "ArrowLeft":
          onClose();
          break;
        case "h":
        case "H":
          if (snap.angel) onAngel();
          else handled = false;
          break;
        default:
          handled = false;
      }
      if (handled) e.preventDefault();
    },
    [
      snap.items.length,
      snap.angel,
      active,
      focusItem,
      onSelect,
      onClose,
      onAngel,
    ],
  );

  const title = snap.caption
    ? i18n("helpMenu_titleWith").replace("{0}", snap.caption)
    : i18n("helpMenu_title");

  const list = (
    <div
      className="helpMenuList"
      data-help-menu-list
      data-mobile={mobile ? "" : undefined}
      role="listbox"
      aria-label={title}
    >
      {snap.items.map((item, i) => (
        <button
          type="button"
          key={item.keysText + "\t" + item.label}
          ref={(el) => {
            itemRefs.current[i] = el;
          }}
          className="helpMenuItem"
          role="option"
          aria-selected={i === active}
          data-help-item={i}
          data-active={i === active ? "" : undefined}
          // Modal 開的當下焦點落在第一項：鍵盤使用者直接 ↑↓／Enter。
          data-autofocus={i === 0 ? true : undefined}
          onClick={() => onSelect(i)}
          onFocus={() => setActive(i)}
        >
          <span className="helpMenuKeys">
            {item.keys.map((k, j) => (
              <kbd key={j} className="helpMenuKey">
                {k}
              </kbd>
            ))}
          </span>
          <span className="helpMenuLabel">{item.label}</span>
          <span className="helpMenuDesc">{item.help}</span>
        </button>
      ))}
      {snap.loading ? (
        <Text
          size="xs"
          c="dimmed"
          className="helpMenuLoading"
          data-help-loading
        >
          {i18n("helpMenu_loading")}
        </Text>
      ) : null}
    </div>
  );

  const footer = (
    <Group gap="xs" justify="flex-end" className="helpMenuFooter">
      <Button
        variant="subtle"
        size={mobile ? "sm" : "xs"}
        onClick={onNative}
        data-help-native
      >
        {i18n("helpMenu_native")}
      </Button>
      {snap.angel ? (
        <Button
          variant="default"
          size={mobile ? "sm" : "xs"}
          onClick={onAngel}
          data-help-angel
        >
          {i18n("helpMenu_angel")}
        </Button>
      ) : null}
      <Button
        variant="default"
        size={mobile ? "sm" : "xs"}
        onClick={onClose}
        data-help-close
      >
        {i18n("helpMenu_close")}
      </Button>
    </Group>
  );

  if (mobile)
    return (
      <MobileSheet
        pttchrome={pttchrome}
        opened={snap.open}
        onClose={onClose}
        title={title}
        sheetKey="help"
        footer={footer}
      >
        {list}
      </MobileSheet>
    );
  return (
    <Modal
      opened={snap.open}
      onClose={onClose}
      title={title}
      size="lg"
      yOffset="5vh"
    >
      <div onKeyDown={onKeyDown} data-help-menu>
        {list}
        {footer}
      </div>
    </Modal>
  );
};

export default HelpMenu;
