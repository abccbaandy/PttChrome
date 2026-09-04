import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  Modal,
  Textarea,
  Button,
  Group,
  Text,
  Alert,
  SegmentedControl,
  Stack,
} from "@mantine/core";
import { i18n } from "../../js/i18n";
import {
  stripNonBig5,
  splitPushSegments,
  big5ByteLength,
  findUrlSpans,
} from "../../js/long_push";

// 長推文輸入框：使用者打一大段話，這裡即時算出「會被切成幾則」與「有哪些字
// PTT 顯示不出來」，按下確定後把**已過濾**的內容交給 LongPushSession 送出。
//
// 為什麼一定要先過濾：u2b 對轉不出 Big5 的字回 '\xFF\xFD'，PTT 根本畫不出來，
// 而使用者不會知道自己打的字被吃了。（0xFF 的 telnet IAC 問題已在傳輸層修掉，
// 見 telnet.js#_sendEscaped。）詳見 long_push.js#stripNonBig5。
//
// 圖片上傳（imageUpload prop ＝ ImageUploadController）：這個 modal 開著時把自己
// 註冊成插入目標，上傳完的 url_direct 就插進**下面這個 Textarea 的游標處**，而不是
// 送進終端機——此時底下的畫面是文章／文章列表，送字等於把網址的每個字元當成
// 列表快捷鍵按下去（image_upload.js#decideInsertMode 的不變量）。詳見
// docs/image-upload.md 的決策表。

const replaceI18n = (id, replacements) =>
  i18n(id)
    .split(/#(\S+)#/gi)
    .map((it, index) =>
      index % 2 === 1 && it in replacements ? replacements[it] : it,
    )
    .join("");

// 超過這個則數就先問一次：PTT 有推文冷卻，整段可能要跑好幾分鐘。
const CONFIRM_THRESHOLD = 20;

export const LongPushModal = ({
  show,
  maxBytes,
  imageUpload,
  onHide,
  onConfirm,
}) => {
  const [value, setValue] = useState("");
  const [type, setType] = useState("push");
  const [confirming, setConfirming] = useState(false);
  const textareaRef = useRef(null);
  // 插入是從 React 樹外面（上傳完成的 callback）打進來的，讀 state 會讀到閉包當時
  // 的舊值 ⇒ 走 ref。
  const valueRef = useRef("");
  valueRef.current = value;
  const caretRef = useRef(null);

  // 元件跨開關保持掛載，光靠 initial state 會殘留上一次的內容（同
  // TitleBlacklistModal 的慣例）。
  useEffect(() => {
    if (show) {
      setValue("");
      setConfirming(false);
    }
  }, [show]);

  // 插在**游標處**（不是尾端）。前後視情況補一個空白讓網址獨立成 token，
  // splitPushSpans 的 URL 保護才有機會把它整條留在同一則。
  const insertAtCursor = useCallback((text) => {
    const el = textareaRef.current;
    const prev = valueRef.current;
    const start =
      el && el.selectionStart != null ? el.selectionStart : prev.length;
    const end = el && el.selectionEnd != null ? el.selectionEnd : prev.length;
    const before = prev.slice(0, start);
    const after = prev.slice(end);
    const chunk =
      (before && !/\s$/.test(before) ? " " : "") +
      text +
      (after && !/^\s/.test(after) ? " " : "");
    caretRef.current = before.length + chunk.length;
    setValue(before + chunk + after);
  }, []);

  // useState 更新後直接設 selectionStart 會被接下來的 re-render 蓋掉 ⇒ 等這次
  // commit 完成再移游標。
  useEffect(() => {
    const caret = caretRef.current;
    if (caret == null) return;
    caretRef.current = null;
    const el = textareaRef.current;
    if (!el || !el.setSelectionRange) return;
    el.focus();
    el.setSelectionRange(caret, caret);
  }, [value]);

  // 註冊／解除插入目標。**enableImageUpload 關掉時不要註冊**：controller 的
  // enabled() 已擋住上傳，但註冊了會讓 decideInsertMode 判成 target 卻沒東西可插。
  // 清除時把自己傳回去，避免「A 關閉時把後開的 B 清掉」。
  const uploadEnabled = !!(
    imageUpload &&
    imageUpload.enabled &&
    imageUpload.enabled()
  );
  useEffect(() => {
    if (!show || !uploadEnabled) return undefined;
    const target = { insert: (text) => insertAtCursor(text) };
    imageUpload.setInsertTarget(target);
    return () => imageUpload.clearInsertTarget(target);
  }, [show, uploadEnabled, imageUpload, insertAtCursor]);

  // 截圖直接貼進輸入框。走 controller 而不是 App.onDOMPaste：後者的後半段會
  // onPasteDone 把內容送進終端機。沒有圖就回 false，文字貼上維持瀏覽器原生行為。
  const onPaste = useCallback(
    (event) => {
      if (uploadEnabled) imageUpload.tryClipboardImage(event);
    },
    [uploadEnabled, imageUpload],
  );

  const parsed = useMemo(() => {
    const { text, dropped } = stripNonBig5(value);
    return { text, dropped, segments: splitPushSegments(text, maxBytes) };
  }, [value, maxBytes]);

  // 網址本身就比單則上限長時 splitPushSpans 只能硬切 ⇒ 圖開不起來。maxBytes 只是
  // 預估（送出時由畫面校正，而且是雙向的：IP 板與否決定 base 是 61 還是 46），
  // 所以文案寫「可能」，不寫成斷言。**警告不擋送出**。
  const urlTooLong = useMemo(
    () =>
      findUrlSpans(parsed.text).some(
        (s) => big5ByteLength(parsed.text.slice(s.start, s.end)) > maxBytes,
      ),
    [parsed.text, maxBytes],
  );

  const count = parsed.segments.length;
  // 打字改變則數之後，先前那次「還是要送」的確認就不算數了。
  useEffect(() => setConfirming(false), [count]);

  const onSubmit = useCallback(
    (event) => {
      event.preventDefault();
      if (!count) return;
      if (count > CONFIRM_THRESHOLD && !confirming) {
        setConfirming(true);
        return;
      }
      onConfirm({ text: parsed.text, type });
    },
    [count, confirming, parsed.text, type, onConfirm],
  );

  return (
    <Modal
      opened={show}
      onClose={onHide}
      title={i18n("longPushModal_title")}
      centered
      size="lg"
      // 上傳的通知卡／紀錄面板是另一個 React root（#imageUploadReact，portal 在
      // body 上）⇒ 對 Modal 而言算「外面」。少了這行，打了一大段話點一下「開啟
      // 上傳紀錄」就整段沒了。
      closeOnClickOutside={false}
    >
      <form onSubmit={onSubmit}>
        <Stack gap="xs">
          <Textarea
            data-autofocus
            ref={textareaRef}
            name="longPushText"
            label={i18n("longPushModal_label")}
            placeholder={i18n("longPushModal_placeholder")}
            autosize
            minRows={6}
            maxRows={16}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onPaste={onPaste}
          />
          <Group gap="md" align="center">
            <Text size="sm">{i18n("longPushModal_type")}</Text>
            <SegmentedControl
              name="longPushType"
              size="xs"
              value={type}
              onChange={setType}
              data={[
                { value: "push", label: i18n("longPushModal_typePush") },
                { value: "boo", label: i18n("longPushModal_typeBoo") },
                { value: "arrow", label: i18n("longPushModal_typeArrow") },
              ]}
            />
            <Text size="sm" c="dimmed" data-testid="longPushSegments">
              {replaceI18n("longPushModal_segments", { n: count })}
            </Text>
          </Group>
          <Text size="xs" c="dimmed">
            {i18n("longPushModal_typeNote")}
          </Text>
          {uploadEnabled && (
            <Text size="xs" c="dimmed">
              {i18n("longPushModal_uploadHint")}
            </Text>
          )}
          {parsed.dropped.length > 0 && (
            <Alert color="yellow" variant="light">
              {replaceI18n("longPushModal_dropped", {
                chars: Array.from(new Set(parsed.dropped)).join(" "),
              })}
            </Alert>
          )}
          {urlTooLong && (
            <Alert color="yellow" variant="light">
              {i18n("longPushModal_urlTooLong")}
            </Alert>
          )}
          {confirming && (
            <Alert color="orange" variant="light">
              {replaceI18n("longPushModal_tooMany", { n: count })}
            </Alert>
          )}
        </Stack>
        <Group justify="flex-end" mt="md">
          {uploadEnabled && (
            <Button
              variant="default"
              mr="auto"
              onClick={() => imageUpload.openFilePicker()}
            >
              {i18n("longPushModal_uploadImage")}
            </Button>
          )}
          <Button variant="default" onClick={onHide}>
            {i18n("longPushModal_cancel")}
          </Button>
          <Button type="submit" disabled={!count}>
            {confirming
              ? i18n("longPushModal_confirmAnyway")
              : i18n("longPushModal_confirm")}
          </Button>
        </Group>
      </form>
    </Modal>
  );
};

export default LongPushModal;
