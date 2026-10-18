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
  sanitizeBoardQuery,
  resolvedBoardName,
  interimCandidates,
} from "../../js/board_search_bridge";
import {
  readSearchHistory,
  forgetSearch,
  forgetSearchKind,
} from "../../js/search_history";
import "./SearchModal.css";

// 搜尋彈窗（docs/article-search.md）。取代 PTT 原生的 / ? a Z s prompt：
//   - ↑／↓ 在輸入框裡循環**這個種類**的本機記憶（↑ 從最新的開始，比照 PTT 的
//     輸入記憶；回到最底就還原自己打到一半的字）。
//   - 下方列出最近幾筆可以直接點（手機軟鍵盤沒有方向鍵）；每筆旁的 × 刪那一筆，
//     「全部清除」清掉目前這一類（其他種類的紀錄不動）。
//   - 看板種類比照 PTT 原生補全（board_search_bridge.js）：createBoardSearch 開出背景的
//     原生 `s` prompt，打字即查、沒有這個開頭的看板就把那個字退回並提示、空白鍵
//     自動完成、下方列出符合的看板可直接點。沒給 createBoardSearch（或 prompt 開不出來）
//     ＝退回普通輸入框。
// 送出交給呼叫端（ContextMenu → bridge.submit／article_search.submitSearch），這裡只管輸入。
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
  createBoardSearch,
  aidTarget,
}) => {
  // aidTarget＝{ aid, token }：沒寫看板的 #AID 要跳到哪個看板（aid_board_choice.js）。
  // 輸入與原生補全跟一般的看板搜尋完全相同，只有標題／送出鈕的字不同，送出後
  // 由呼叫端在進板之後接著跑 AID 跳轉。
  const [currentKind, setCurrentKind] = useState(kind || "title");
  const [value, setValue] = useState("");
  const [history, setHistory] = useState(() => readSearchHistory());
  // -1 ＝ 正在編輯自己的字；0.. ＝ 正顯示記憶的第幾筆。
  const indexRef = useRef(-1);
  const draftRef = useRef("");
  const inputRef = useRef(null);
  // 看板補全：bridge 只在看板種類＋彈窗開著時存在；board＝它最近一次回報的
  // { status, result }。boardRejected＝最近被 PTT 退回的那串（提示用）。
  const bridgeRef = useRef(null);
  const [board, setBoard] = useState(null);
  const [boardRejected, setBoardRejected] = useState("");

  // 每次打開都重新讀（元件常駐，初值會過期），種類跟著觸發的按鍵。
  useEffect(() => {
    if (!show) return;
    setCurrentKind(kind || "title");
    setValue("");
    setHistory(readSearchHistory());
    indexRef.current = -1;
    draftRef.current = "";
  }, [show, kind]);

  const isBoard = currentKind === "board";
  const valueRef = useRef(value);
  valueRef.current = value;
  useEffect(() => {
    if (!show || !isBoard || !createBoardSearch) return undefined;
    const bridge = createBoardSearch((next) => setBoard(next));
    bridgeRef.current = bridge;
    setBoard({ status: bridge.status, result: bridge.result });
    setBoardRejected("");
    bridge.query(valueRef.current);
    return () => {
      bridgeRef.current = null;
      setBoard(null);
      bridge.cancel(); // 已送出時是 noop
    };
  }, [show, isBoard, createBoardSearch]);
  useEffect(() => {
    if (bridgeRef.current) bridgeRef.current.query(value);
  }, [value]);

  const boardQuery = isBoard ? sanitizeBoardQuery(value) : "";
  const boardResult =
    board &&
    board.result &&
    board.result.query.toLowerCase() === boardQuery.toLowerCase()
      ? board.result
      : null;
  // 上一份收下的清單：查詢在飛時拿它本地篩選先顯示（interimCandidates），清單不會
  // 每打一個字就先清空再長回來。
  const lastAcceptedRef = useRef(null);
  if (!board) lastAcceptedRef.current = null;
  else if (board.result && !board.result.rejected && !board.result.unknown)
    lastAcceptedRef.current = board.result;
  // PTT 收不下的字（沒有看板以這串開頭）：退回到收得下的前綴，同原生的 bell＋丟字。
  const latestResult = board && board.result;
  // 使用者在回應回來前又多打了字也一樣（那些字接在被拒的字後面，一起丟）。
  useEffect(() => {
    if (!latestResult || !latestResult.rejected) return;
    const cur = sanitizeBoardQuery(valueRef.current);
    if (cur.toLowerCase().indexOf(latestResult.query.toLowerCase()) !== 0)
      return;
    const kept = cur.slice(0, latestResult.accepted);
    setBoardRejected(latestResult.query.slice(0, latestResult.accepted + 1));
    setValue(kept);
    indexRef.current = -1;
    draftRef.current = kept;
  }, [latestResult]);

  const boardResolved = boardResult
    ? resolvedBoardName(boardResult, boardQuery)
    : "";
  // 查到了而且 Enter 進不了板（多個符合）＝擋下送出，跟原生一樣什麼都不會發生。
  // unknown（PTT 沒回出可判的畫面）不擋：交給 PTT 自己判。
  const boardBlocks =
    isBoard &&
    !!boardResult &&
    !boardResult.unknown &&
    !!boardQuery &&
    !boardResolved;

  const list = history[currentKind] || [];
  const valid = !!normalizeSearchText(currentKind, value) && !boardBlocks;

  const onKindChange = useCallback((k) => {
    setCurrentKind(k);
    setValue("");
    indexRef.current = -1;
    draftRef.current = "";
    if (inputRef.current) inputRef.current.focus();
  }, []);

  const onChange = useCallback(
    (event) => {
      let next = event.target.value;
      if (currentKind === "board" && /\s/.test(next)) {
        // 空白鍵＝PTT 的「自動搜尋」：補到所有符合者的共同前綴（唯一就補完整名）。
        // 手機軟鍵盤沒有可靠的 keydown，所以在 onChange 看結果。
        next = next.replace(/\s+/g, "");
        const r = bridgeRef.current && bridgeRef.current.result;
        if (
          r &&
          !r.rejected &&
          r.query.toLowerCase() === next.toLowerCase() &&
          r.completion.length > next.length
        )
          next = r.completion;
      }
      setValue(next);
      setBoardRejected("");
      indexRef.current = -1;
      draftRef.current = next;
    },
    [currentKind],
  );

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
      if (currentKind !== "board")
        return onConfirm({ kind: currentKind, text });
      // 唯一符合時 PTT 會進那個板：記憶裡存完整板名，不存打到一半的字。
      const bridge = bridgeRef.current;
      const resolved = resolvedBoardName(
        bridge && bridge.result,
        sanitizeBoardQuery(text),
      );
      const payload = { kind: currentKind, text: resolved || text };
      if (bridge) payload.bridge = bridge;
      if (aidTarget) payload.aidTarget = aidTarget;
      onConfirm(payload);
    },
    [currentKind, onConfirm, aidTarget],
  );

  const onSubmit = useCallback(
    (event) => {
      event.preventDefault();
      if (!valid) return; // Enter 跟停用的「搜尋」鈕同一個判準
      submit(value);
    },
    [submit, value, valid],
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
  const title = aidTarget
    ? i18n("aidBoardChoice_pickTitle").replace("{0}", "#" + aidTarget.aid)
    : i18n("searchModal_title");

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
      {isBoard && board && (
        <BoardSuggestions
          board={board}
          query={boardQuery}
          result={boardResult}
          rejected={boardRejected}
          blocks={boardBlocks}
          ascii={!value || !!normalizeSearchText("board", value)}
          interim={
            boardResult
              ? null
              : interimCandidates(lastAcceptedRef.current, boardQuery)
          }
          mobile={mobile}
          onPick={submit}
        />
      )}
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
          {i18n(aidTarget ? "aidBoardChoice_jump" : "searchModal_confirm")}
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
        title={title}
        sheetKey="search"
      >
        {form}
      </MobileSheet>
    );
  return (
    <Modal
      opened={show}
      onClose={onHide}
      title={title}
      // 貼頂不置中：置中時內容一變高（切種類、刪記憶）輸入框就跟著上下跳。
      yOffset="10vh"
      size="lg"
    >
      {form}
    </Modal>
  );
};

// 看板補全的狀態列＋符合清單（PTT「相關資訊一覽表」的第一頁）。
// 版面固定（SearchModal.css）：狀態列恆佔一行、清單框恆定高度、「還有更多」放在框內，
// 打字時彈窗不跟著結果長縮（使用者回報：邊打字視窗邊抖動）。
// interim：查詢在飛時先顯示的清單（上一份本地篩選，淡化），result 回來就換掉。
const BoardSuggestions = ({
  board,
  query,
  result,
  rejected,
  blocks,
  ascii,
  interim,
  mobile,
  onPick,
}) => {
  let status = null;
  if (!ascii) status = i18n("searchModal_boardAscii");
  else if (rejected)
    status = i18n("searchModal_boardNoMatch").replace("{0}", rejected);
  else if (board.status === "opening")
    status = i18n("searchModal_boardOpening");
  else if (board.status === "unavailable")
    status = i18n("searchModal_boardUnavailable");
  else if (query && !result) status = i18n("searchModal_boardPending");
  else if (blocks) status = i18n("searchModal_boardAmbiguous");
  const pending = !result && !!interim && interim.length > 0;
  const names = result ? result.candidates || [] : pending ? interim : [];
  return (
    <div
      className="searchBoardSuggest"
      data-mobile={mobile ? "" : undefined}
      data-board-suggest={board.status}
    >
      <Text
        size="xs"
        c={rejected || !ascii ? "red" : "dimmed"}
        className="searchBoardStatus"
        title={status || undefined}
        data-board-status={status ? "" : undefined}
      >
        {status}
      </Text>
      {/* 一頁最多約 60 個（PTT 三欄×20 列）：框內捲動，不把表單撐出畫面。 */}
      <div
        className="searchBoardCandidates"
        data-board-candidates
        data-board-interim={pending ? "" : undefined}
      >
        <Group gap={4}>
          {names.map((name) => (
            <Button
              key={name}
              size="compact-xs"
              variant="default"
              data-board-candidate={name}
              onClick={() => onPick(name)}
            >
              {name}
            </Button>
          ))}
        </Group>
        {result && result.more && (
          <Text size="xs" c="dimmed" mt={4} data-board-more>
            {i18n("searchModal_boardMore")}
          </Text>
        )}
      </div>
    </div>
  );
};

export default SearchModal;
