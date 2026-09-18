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
import { modEnterShortcutLabel } from "../../js/platform";
import {
  stripNonBig5,
  splitPushSegments,
  big5ByteLength,
  findUrlSpans,
  PUSH_TYPE_COLOR,
} from "../../js/long_push";
import { readDraft, writeDraft, clearDraft } from "../../js/long_push_draft";

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

// 型別選項的標籤：把字畫在一小塊黑底上，就是終端機裡長的樣子。
//
// 為什麼要黑底而不是單純把文字染色：顏色取自 PTT 原生的 ctype_attr（亮黃／亮紅／
// 亮白，見 long_push.js#PUSH_TYPE_COLOR），而 Mantine 的色彩主題是可切的
// （MantineRoot 預設暗色，但設定頁讓使用者改）—— 亮色主題下亮黃與亮白等於看不見。
// 黑底同時解決可讀性與「跟終端機長得一樣」兩件事。
//
// disabled（禁噓板）時退回純文字：內聯的 color 會蓋掉 Mantine 用來表示 disabled
// 的調暗樣式 ⇒ 看起來像可以選。
//
// 未選中的調暗（opacity）：黑底色塊會**蓋掉 SegmentedControl 的選中指示器**
// —— 指示器只是把該格背景換成淺一階的灰，色塊壓在上面之後三格長得一模一樣，
// 使用者看不出自己選了哪個（噓推錯了收不回來）。調暗是主題無關的替代訊號。
const TypeLabel = ({ type, text, disabled, selected }) =>
  disabled ? (
    text
  ) : (
    <span
      data-push-type={type}
      data-selected={selected ? "true" : undefined}
      style={{
        display: "inline-block",
        padding: "0 6px",
        borderRadius: 2,
        background: "#000000",
        color: PUSH_TYPE_COLOR[type],
        opacity: selected ? 1 : 0.45,
      }}
    >
      {text}
    </span>
  );

// preflight ＝ 開這個框之前那一次探路（LongPushSession.startPreflight）從 PTT 畫面
// 讀回來的事實：這塊板讓不讓噓、這次會不會被降級成 →、目前在不在冷卻。**全部是
// 讀畫面讀到的，不是猜的**，所以這裡的文案可以寫成肯定句；null（沒探過路的降級
// 路徑）時整個區塊消失，行為與探路上線前一樣。
export const LongPushModal = ({
  show,
  maxBytes,
  preflight,
  imageUpload,
  onHide,
  onConfirm,
}) => {
  const [value, setValue] = useState("");
  const [type, setType] = useState("push");
  const [confirming, setConfirming] = useState(false);
  // 這一次開框的內容是「上次留下來的草稿」還是使用者現在打的？單一份草稿不綁
  // 文章 ⇒ 在 A 文章打的會出現在 B 文章的輸入框，一定要講一聲並給清除鍵，
  // 不可以默默塞進去（long_push_draft.js 檔頭）。
  const [restored, setRestored] = useState(false);
  const textareaRef = useRef(null);
  // 插入是從 React 樹外面（上傳完成的 callback）打進來的，讀 state 會讀到閉包當時
  // 的舊值 ⇒ 走 ref。
  const valueRef = useRef("");
  valueRef.current = value;
  const caretRef = useRef(null);

  // 元件跨開關保持掛載，光靠 initial state 會殘留上一次的內容（同
  // TitleBlacklistModal 的慣例）。
  //
  // 兩件事刻意不一樣：
  //   - 內容**還原草稿**而不是清空（打到一半誤關不該白打）
  //   - 型別一律回到「推」。以前刻意不重置，於是上次選的噓會沿用到下一次開框；
  //     按 X 的預期一律是推，而噓錯了收不回來（PTT 沒有撤回 API）。
  useEffect(() => {
    if (show) {
      const draft = readDraft();
      setValue(draft);
      setRestored(!!draft);
      setType("push");
      setConfirming(false);
    }
  }, [show]);

  // 草稿寫在**真正的兩個變更點**（這裡與 insertAtCursor），刻意不用 effect：
  // show false→true 那一次 commit 裡 value 還是舊值，任何沾到 show 的寫入 effect
  // 都會拿它蓋掉剛讀回來的草稿；最惡劣的情況是上次已經送成功、clearDraft() 過了，
  // 元件裡的 value 還留著整段文字 ⇒ 一開框就把已經送出去的內容復活成草稿。
  const setValueAndDraft = useCallback((next) => {
    setValue(next);
    setRestored(false);
    writeDraft(next);
  }, []);

  const onClearDraft = useCallback(() => {
    setValue("");
    setRestored(false);
    clearDraft();
  }, []);

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
    const next = before + chunk + after;
    setValue(next);
    setRestored(false);
    writeDraft(next);
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

  // 禁噓板（BRD_NOBOO）：型別選單上根本沒有 "2."，送 2 會被 vkey() 當成預設值＝推。
  const booAllowed = !preflight || preflight.booAllowed !== false;
  useEffect(() => {
    if (!booAllowed && type === "boo") setType("push");
  }, [booAllowed, type]);

  const count = parsed.segments.length;
  // 打字改變則數之後，先前那次「還是要送」的確認就不算數了。
  useEffect(() => setConfirming(false), [count]);

  // 送出鍵與 Ctrl+Enter 共用**同一段**，二次確認的語意才不會兩條路各走各的。
  const trySubmit = useCallback(() => {
    if (!count) return;
    if (count > CONFIRM_THRESHOLD && !confirming) {
      setConfirming(true);
      return;
    }
    onConfirm({ text: parsed.text, type });
  }, [count, confirming, parsed.text, type, onConfirm]);

  const onSubmit = useCallback(
    (event) => {
      event.preventDefault();
      trySubmit();
    },
    [trySubmit],
  );

  // Ctrl+Enter（Mac 的 ⌘+Enter）送出。**兩個修飾鍵都收、不偵測平台**：偵測錯的人
  // 不是退化成沒快捷鍵，而是按了沒反應（同 term_keyboard.js:236-242 的立場）。
  // 掛在 <form> 而不是 Textarea：游標在型別選單或按鈕上時一樣送得出去。
  // 不需要 stopPropagation —— 終端機的 global keydown 被 term_view 的
  // shouldAcceptInput()（modalShown）擋著，這一下不會漏到 PTT。
  const onKeyDown = useCallback(
    (event) => {
      if (event.key !== "Enter") return;
      if (!event.ctrlKey && !event.metaKey) return;
      // 組字中的 Enter 屬於 IME（上字／選字），不能當成送出。
      if (event.nativeEvent?.isComposing || event.keyCode === 229) return;
      // 擋掉 textarea 自己插的那個換行。
      event.preventDefault();
      trySubmit();
    },
    [trySubmit],
  );

  // 只影響提示文字；navigator 不會在 page lifetime 內變。
  const shortcutLabel = useMemo(() => modEnterShortcutLabel(), []);

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
      <form onSubmit={onSubmit} onKeyDown={onKeyDown}>
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
            onChange={(event) => setValueAndDraft(event.target.value)}
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
                {
                  value: "push",
                  label: (
                    <TypeLabel
                      type="push"
                      selected={type === "push"}
                      text={i18n("longPushModal_typePush")}
                    />
                  ),
                },
                {
                  value: "boo",
                  label: (
                    <TypeLabel
                      type="boo"
                      selected={type === "boo"}
                      text={i18n("longPushModal_typeBoo")}
                      disabled={!booAllowed}
                    />
                  ),
                  disabled: !booAllowed,
                },
                {
                  value: "arrow",
                  label: (
                    <TypeLabel
                      type="arrow"
                      selected={type === "arrow"}
                      text={i18n("longPushModal_typeArrow")}
                    />
                  ),
                },
              ]}
            />
            <Text size="sm" c="dimmed" data-testid="longPushSegments">
              {replaceI18n("longPushModal_segments", { n: count })}
            </Text>
          </Group>
          {/* 探過路就用畫面上的事實取代那句「90 秒內連推會改成 →」的推測。 */}
          {preflight && preflight.degraded ? (
            <Alert
              color="yellow"
              variant="light"
              data-testid="longPushArrowNote"
            >
              {i18n("longPushModal_preflightArrow")}
            </Alert>
          ) : (
            <Text size="xs" c="dimmed">
              {i18n("longPushModal_typeNote")}
            </Text>
          )}
          {!booAllowed && (
            <Text size="xs" c="dimmed" data-testid="longPushNoBooNote">
              {i18n("longPushModal_preflightNoBoo")}
            </Text>
          )}
          {/* 冷卻**不算不能推**：打完字通常早就過了那幾秒，真的還沒過，送出時的
              等待邏輯會處理。所以只提示，不擋。 */}
          {preflight && preflight.cooldownSec > 0 && (
            <Alert
              color="blue"
              variant="light"
              data-testid="longPushCooldownNote"
            >
              {replaceI18n("longPushModal_preflightCooldown", {
                s: preflight.cooldownSec,
              })}
              {preflight.cooldownMessage && (
                <Text size="xs" c="dimmed" mt={4}>
                  {preflight.cooldownMessage}
                </Text>
              )}
            </Alert>
          )}
          {/* 草稿是**單一份、不綁文章**的（long_push_draft.js 檔頭）⇒ 帶回來的
              內容可能是在別篇文章打的，一定要講一聲並給清除鍵。 */}
          {restored && (
            <Group gap="xs" align="center" data-testid="longPushDraftNote">
              <Text size="xs" c="dimmed">
                {i18n("longPushModal_draftNote")}
              </Text>
              <Button size="compact-xs" variant="subtle" onClick={onClearDraft}>
                {i18n("longPushModal_draftClear")}
              </Button>
            </Group>
          )}
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
          {/* 提示一定要 aria-hidden：不然它會被算進按鈕的 accessible name，
              所有用按鈕名稱抓元素的測試（unit 與 offline e2e）一起靜默失效。
              輔助技術那份改由 aria-keyshortcuts 提供。 */}
          <Button
            type="submit"
            disabled={!count}
            aria-keyshortcuts="Control+Enter Meta+Enter"
            rightSection={
              <span
                aria-hidden="true"
                data-testid="longPushSubmitHint"
                style={{ fontSize: 12, opacity: 0.75 }}
              >
                {shortcutLabel}
              </span>
            }
          >
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
