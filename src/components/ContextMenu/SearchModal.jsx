import { useState, useEffect, useCallback, useRef } from "react";
import {
  Modal,
  TextInput,
  Button,
  Group,
  SegmentedControl,
  Text,
  CloseButton,
} from "@mantine/core";
import { i18n } from "../../js/i18n";
import MobileSheet from "../MobileSheet";
import { normalizeSearchText } from "../../js/article_search";
import {
  readSearchHistory,
  forgetSearch,
  forgetSearchKind,
} from "../../js/search_history";

// 搜尋彈窗（docs/article-search.md）。取代 PTT 原生的 / ? a Z s prompt：
//   - ↑／↓ 在輸入框裡循環**這個種類**的本機記憶（↑ 從最新的開始，比照 PTT 的
//     輸入記憶；回到最底就還原自己打到一半的字）。
//   - 下方列出最近幾筆可以直接點（手機軟鍵盤沒有方向鍵）；每筆旁的 × 刪那一筆，
//     「全部清除」清掉目前這一類（其他種類的紀錄不動）。
// 送出交給呼叫端（ContextMenu → article_search.submitSearch），這裡只管輸入。
const KIND_LABEL_KEY = {
  title: "searchModal_kindTitle",
  author: "searchModal_kindAuthor",
  push: "searchModal_kindPush",
  board: "searchModal_kindBoard",
};
const KIND_PLACEHOLDER_KEY = {
  title: "searchModal_placeholderTitle",
  author: "searchModal_placeholderAuthor",
  push: "searchModal_placeholderPush",
  board: "searchModal_placeholderBoard",
};
// 直接列出來可點的筆數（其餘仍可用 ↑ 叫回）。
export const SEARCH_RECENT_SHOWN = 6;

// mobile：手機版面改用 bottom sheet 外殼（components/MobileSheet，系統返回＝收起），
// 內容（表單、記憶、送出）完全相同。
export const SearchModal = ({
  show,
  kind,
  kinds,
  onHide,
  onConfirm,
  mobile,
  pttchrome,
}) => {
  const [currentKind, setCurrentKind] = useState(kind || "title");
  const [value, setValue] = useState("");
  const [history, setHistory] = useState(() => readSearchHistory());
  // -1 ＝ 正在編輯自己的字；0.. ＝ 正顯示記憶的第幾筆。
  const indexRef = useRef(-1);
  const draftRef = useRef("");
  const inputRef = useRef(null);

  // 每次打開都重新讀（元件常駐，初值會過期），種類跟著觸發的按鍵。
  useEffect(() => {
    if (!show) return;
    setCurrentKind(kind || "title");
    setValue("");
    setHistory(readSearchHistory());
    indexRef.current = -1;
    draftRef.current = "";
  }, [show, kind]);

  const list = history[currentKind] || [];
  const valid = !!normalizeSearchText(currentKind, value);

  const onKindChange = useCallback((k) => {
    setCurrentKind(k);
    setValue("");
    indexRef.current = -1;
    draftRef.current = "";
    if (inputRef.current) inputRef.current.focus();
  }, []);

  const onChange = useCallback((event) => {
    setValue(event.target.value);
    indexRef.current = -1;
    draftRef.current = event.target.value;
  }, []);

  const onKeyDown = useCallback(
    (event) => {
      if (event.nativeEvent && event.nativeEvent.isComposing) return;
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      if (!list.length) return;
      event.preventDefault();
      let i = indexRef.current + (event.key === "ArrowUp" ? 1 : -1);
      if (i >= list.length) i = list.length - 1;
      if (i < -1) i = -1;
      indexRef.current = i;
      setValue(i < 0 ? draftRef.current : list[i]);
    },
    [list],
  );

  const submit = useCallback(
    (text) => {
      if (!normalizeSearchText(currentKind, text)) return;
      onConfirm({ kind: currentKind, text });
    },
    [currentKind, onConfirm],
  );

  const onSubmit = useCallback(
    (event) => {
      event.preventDefault();
      submit(value);
    },
    [submit, value],
  );

  // 刪除後 ↑ 的游標歸零（索引會對不上），並把焦點還給輸入框（點 × 會搶走焦點）。
  const afterForget = useCallback((next) => {
    setHistory(next);
    indexRef.current = -1;
    if (inputRef.current) inputRef.current.focus();
  }, []);
  const onForget = useCallback(
    (text) => afterForget(forgetSearch(currentKind, text)),
    [currentKind, afterForget],
  );
  const onForgetAll = useCallback(
    () => afterForget(forgetSearchKind(currentKind)),
    [currentKind, afterForget],
  );

  const shownKinds = kinds && kinds.length ? kinds : [currentKind];

  const form = (
    <form onSubmit={onSubmit} data-search-modal>
      {shownKinds.length > 1 && (
        <SegmentedControl
          fullWidth
          mb="sm"
          value={currentKind}
          onChange={onKindChange}
          data={shownKinds.map((k) => ({
            value: k,
            label: i18n(KIND_LABEL_KEY[k]),
          }))}
        />
      )}
      <TextInput
        data-autofocus
        ref={inputRef}
        name="searchKeyword"
        label={
          shownKinds.length > 1 ? undefined : i18n(KIND_LABEL_KEY[currentKind])
        }
        placeholder={i18n(KIND_PLACEHOLDER_KEY[currentKind])}
        inputMode={currentKind === "push" ? "numeric" : undefined}
        autoComplete="off"
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
      />
      {list.length > 0 && (
        <Group gap={6} mt="sm" data-search-recent>
          <Text size="xs" c="dimmed">
            {i18n("searchModal_recent")}
          </Text>
          {list.slice(0, SEARCH_RECENT_SHOWN).map((it) => (
            <Group key={it} gap={0} wrap="nowrap">
              <Button
                size="compact-xs"
                variant="light"
                data-search-recent-item={it}
                onClick={() => submit(it)}
              >
                {it}
              </Button>
              <CloseButton
                size="sm"
                aria-label={i18n("searchModal_forget") + " " + it}
                data-search-forget={it}
                onClick={() => onForget(it)}
              />
            </Group>
          ))}
          <Button
            size="compact-xs"
            variant="subtle"
            color="gray"
            data-search-forget-all
            onClick={onForgetAll}
          >
            {i18n("searchModal_forgetAll")}
          </Button>
        </Group>
      )}
      <Group justify="flex-end" mt="md">
        <Button variant="default" onClick={onHide}>
          {i18n("searchModal_cancel")}
        </Button>
        <Button type="submit" disabled={!valid}>
          {i18n("searchModal_confirm")}
        </Button>
      </Group>
    </form>
  );

  if (mobile)
    return (
      <MobileSheet
        pttchrome={pttchrome}
        opened={show}
        onClose={onHide}
        title={i18n("searchModal_title")}
        sheetKey="search"
      >
        {form}
      </MobileSheet>
    );
  return (
    <Modal
      opened={show}
      onClose={onHide}
      title={i18n("searchModal_title")}
      centered
      size="lg"
    >
      {form}
    </Modal>
  );
};

export default SearchModal;
