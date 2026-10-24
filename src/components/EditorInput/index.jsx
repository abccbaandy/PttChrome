import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Alert, Button, Group, Modal, Stack, Text, Textarea } from "@mantine/core";
import { IconKeyboard } from "@tabler/icons-react";
import { i18n } from "../../js/i18n";
import { EDITOR_INPUT_ID, prepareEditorInsert } from "../../js/editor_input";
import MobileSheet from "../MobileSheet";
import "./EditorInput.css";

// 編輯器輸入框（P27，邏輯在 js/editor_input.js，設計見 docs/editor-input.md）。
// 入口：桌機是終端機右下角的鈕（這裡畫）；手機是底部導覽第一格（MobileToolbar 呼叫
// pttchrome.editorInput.open()）。框：桌機 Mantine Modal、手機 MobileSheet。
//
// modal 閘門：MobileSheet 自己經 App.setModalOpen 推導；桌機 Modal 由這裡依 render state
// 推導（具名來源 "editorInput"，CLAUDE.md「modalShown 是推導值」）。
// 鈕的事件規則同 SearchStatus：mousedown preventDefault（不搶 #t 焦點），滑鼠事件
// stopPropagation（App 的滑鼠入口在 window），App._onUploadLayer 也認 #editorInputChip。
const keepFocus = (e) => {
  e.preventDefault();
  e.stopPropagation();
};
const swallow = (e) => e.stopPropagation();

const replaceI18n = (id, replacements) =>
  i18n(id)
    .split(/#(\S+)#/gi)
    .map((it, index) =>
      index % 2 === 1 && it in replacements ? replacements[it] : it,
    )
    .join("");

export const EditorInput = ({ pttchrome }) => {
  const ctl = pttchrome && pttchrome.editorInput;
  const [state, setState] = useState(() => (ctl ? ctl.state : null));
  const [value, setValue] = useState("");
  const [notEditor, setNotEditor] = useState(false);
  const formId = "editorInputForm" + useId().replace(/:/g, "");

  useEffect(() => {
    if (!ctl || typeof ctl.onChange !== "function") return undefined;
    return ctl.onChange((s) => setState(s));
  }, [ctl]);

  const open = !!(state && state.open);
  const mobile = !!(state && state.mobile);
  useEffect(() => {
    if (mobile || !pttchrome || typeof pttchrome.setModalOpen !== "function")
      return undefined;
    pttchrome.setModalOpen("editorInput", open);
    return () => pttchrome.setModalOpen("editorInput", false);
  }, [pttchrome, open, mobile]);
  useEffect(() => {
    if (open) setNotEditor(false);
  }, [open]);

  const parsed = useMemo(() => prepareEditorInsert(value), [value]);
  const onHide = useCallback(() => ctl && ctl.close(), [ctl]);
  const onSubmit = useCallback(
    (e) => {
      if (e) e.preventDefault();
      if (!ctl) return;
      const r = ctl.insert(value);
      if (r.ok) setValue("");
      else if (r.reason === "not-editor") setNotEditor(true);
    },
    [ctl, value],
  );
  // Ctrl+Enter（⌘+Enter）＝插入；一般 Enter 是換行（多段文字）。組字中的 Enter 屬於 IME。
  const onKeyDown = useCallback(
    (e) => {
      if (e.key !== "Enter" || (!e.ctrlKey && !e.metaKey)) return;
      if (e.nativeEvent?.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      onSubmit();
    },
    [onSubmit],
  );

  if (!state) return null;

  const chip =
    state.available && !state.open && !state.mobile ? (
      <button
        type="button"
        id={EDITOR_INPUT_ID}
        className="nomouse_command editorInputChip"
        style={{ right: state.right + 8, bottom: state.bottom + 6 }}
        title={i18n("editorInput_tip")}
        onMouseDown={keepFocus}
        onMouseUp={swallow}
        onContextMenu={swallow}
        onClick={(e) => {
          e.stopPropagation();
          ctl.open();
        }}
      >
        <IconKeyboard size={15} stroke={2} aria-hidden="true" />
        <span>{i18n("editorInput_open")}</span>
      </button>
    ) : null;

  const fields = (
    <Stack gap="xs">
      <Textarea
        data-autofocus
        name="editorInputText"
        label={i18n("editorInput_label")}
        placeholder={i18n("editorInput_placeholder")}
        autosize
        minRows={mobile ? 4 : 8}
        maxRows={mobile ? 10 : 18}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <Text size="xs" c="dimmed">
        {i18n("editorInput_hint")}
      </Text>
      {parsed.dropped.length > 0 && (
        <Alert color="yellow" variant="light">
          {replaceI18n("longPushModal_dropped", {
            chars: Array.from(new Set(parsed.dropped)).join(" "),
          })}
        </Alert>
      )}
      {notEditor && (
        <Alert color="red" variant="light">
          {i18n("editorInput_notEditor")}
        </Alert>
      )}
    </Stack>
  );
  const buttons = (
    <Group justify="flex-end" mt={mobile ? 0 : "md"}>
      <Button variant="default" onClick={onHide}>
        {i18n("editorInput_cancel")}
      </Button>
      <Button
        type="submit"
        form={formId}
        disabled={parsed.empty}
        aria-keyshortcuts="Control+Enter Meta+Enter"
      >
        {i18n("editorInput_insert")}
      </Button>
    </Group>
  );
  const form = (
    <form id={formId} onSubmit={onSubmit} onKeyDown={onKeyDown}>
      {fields}
      {mobile ? null : buttons}
    </form>
  );

  return (
    <>
      {chip}
      {mobile ? (
        <MobileSheet
          pttchrome={pttchrome}
          opened={open}
          onClose={onHide}
          closeOnClickOutside={false}
          title={i18n("editorInput_title")}
          sheetKey="editorInput"
          footer={buttons}
        >
          {form}
        </MobileSheet>
      ) : (
        <Modal
          opened={open}
          onClose={onHide}
          title={i18n("editorInput_title")}
          centered
          size="lg"
          closeOnClickOutside={false}
        >
          {form}
        </Modal>
      )}
    </>
  );
};

export default EditorInput;
