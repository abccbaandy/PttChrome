import { useState, useEffect, useMemo, useCallback } from "react";
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
import { stripNonBig5, splitPushSegments } from "../../js/long_push";

// 長推文輸入框：使用者打一大段話，這裡即時算出「會被切成幾則」與「有哪些字
// PTT 顯示不出來」，按下確定後把**已過濾**的內容交給 LongPushSession 送出。
//
// 為什麼一定要先過濾：u2b 對轉不出 Big5 的字回 '\xFF\xFD'，PTT 根本畫不出來，
// 而使用者不會知道自己打的字被吃了。（0xFF 的 telnet IAC 問題已在傳輸層修掉，
// 見 telnet.js#_sendEscaped。）詳見 long_push.js#stripNonBig5。

const replaceI18n = (id, replacements) =>
  i18n(id)
    .split(/#(\S+)#/gi)
    .map((it, index) =>
      index % 2 === 1 && it in replacements ? replacements[it] : it,
    )
    .join("");

// 超過這個則數就先問一次：PTT 有推文冷卻，整段可能要跑好幾分鐘。
const CONFIRM_THRESHOLD = 20;

export const LongPushModal = ({ show, maxBytes, onHide, onConfirm }) => {
  const [value, setValue] = useState("");
  const [type, setType] = useState("push");
  const [confirming, setConfirming] = useState(false);

  // 元件跨開關保持掛載，光靠 initial state 會殘留上一次的內容（同
  // TitleBlacklistModal 的慣例）。
  useEffect(() => {
    if (show) {
      setValue("");
      setConfirming(false);
    }
  }, [show]);

  const parsed = useMemo(() => {
    const { text, dropped } = stripNonBig5(value);
    return { text, dropped, segments: splitPushSegments(text, maxBytes) };
  }, [value, maxBytes]);

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
    >
      <form onSubmit={onSubmit}>
        <Stack gap="xs">
          <Textarea
            data-autofocus
            name="longPushText"
            label={i18n("longPushModal_label")}
            placeholder={i18n("longPushModal_placeholder")}
            autosize
            minRows={6}
            maxRows={16}
            value={value}
            onChange={(event) => setValue(event.target.value)}
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
          {parsed.dropped.length > 0 && (
            <Alert color="yellow" variant="light">
              {replaceI18n("longPushModal_dropped", {
                chars: Array.from(new Set(parsed.dropped)).join(" "),
              })}
            </Alert>
          )}
          {confirming && (
            <Alert color="orange" variant="light">
              {replaceI18n("longPushModal_tooMany", { n: count })}
            </Alert>
          )}
        </Stack>
        <Group justify="flex-end" mt="md">
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
