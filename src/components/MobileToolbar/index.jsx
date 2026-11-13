import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useLayoutEffect,
} from "react";
import {
  IconThumbUp,
  IconMessageReply,
  IconMail,
  IconPencilPlus,
  IconSearch,
  IconKeyboard,
  IconCursorText,
  IconDots,
  IconRefresh,
  IconArrowBarToDown,
  IconCircleDot,
  IconStar,
  IconChecks,
  IconHelp,
  IconShare,
  IconSelectAll,
  IconPhotoUp,
  IconChevronLeft,
  IconDeviceFloppy,
  IconChevronRight,
  IconChevronsLeft,
  IconBook,
  IconArchive,
  IconBookmark,
  IconInfoCircle,
} from "@tabler/icons-react";
import { i18n } from "../../js/i18n";
import {
  readValuesWithDefault,
  readEffectivePrefs,
} from "../../js/pref_storage";
import {
  normalizeQuickSearchQuery,
  visibleQuickSearchItems,
  buildQuickSearchUrl,
  quickSearchLabel,
} from "../../js/quick_search";
import { readSelectionText } from "../../render/screen_chunk";
import MobileSheet from "../MobileSheet";
import LogoutConfirm from "../LogoutConfirm";
import { androidCanQuit } from "../../js/android_bridge";
import {
  MOBILE_KEYPAD_ROWS,
  MOBILE_KEYPAD_EXTRA_ROW,
} from "../../js/mobile_layout";
import {
  EMPTY_TOOLBAR_CONTEXT,
  TOOLBAR_KEYS,
  THREAD_NAV_GROUPS,
  BOARD_TOOL_KEYS,
  toolbarSlots,
  mobileToolbarContext,
} from "../../js/mobile_toolbar";
import { promptPanelFromBuf, promptChoicesSig } from "../../js/prompt_choices";
import {
  splitMoreGrid,
  stableMoreSplit,
  MORE_GRID_LABEL_KEYS,
} from "./more_sheet_layout";
import { screenOf } from "../../js/screen_model";
import "./MobileToolbar.css";

// 文章導覽按鈕的方向圖示（THREAD_NAV_GROUPS 的 dir）。
const NAV_DIR_ICONS = {
  first: IconChevronsLeft,
  prev: IconChevronLeft,
  next: IconChevronRight,
};

// P66「這個看板」的圖示（BOARD_TOOL_KEYS 的 id）。
const BOARD_TOOL_ICONS = {
  __boardNotes: IconBook,
  __boardMan: IconArchive,
  __boardDigest: IconBookmark,
  __boardInfo: IconInfoCircle,
};

// 手機底部導覽（docs/mobile.md「底部導覽」）。只在 pttchrome.mobile 時渲染。
// Material 風格：icon＋小字，動作依畫面換（App.onScreenContextChange ← mobile_toolbar.js）：
//   固定 6 格（mobile_toolbar.toolbarSlots；位置不隨畫面變，不能用的反灰）：
//     1 主要（文章＝推 X、列表／主功能表＝搜尋）  2 次要（回文 y／回信、文章列表＝發文 Ctrl+P）
//     3 重整（冷卻中反灰＋倒數）  4 到底 End  5 按鍵  6 更多（分享、同主題前下首篇、列表前下篇…）
//   重整  screen_refresh（列表 s<板>⏎／看板列表 /⏎／文章重開並還原位置），與 F5 同一個入口
//   其他      搜尋（有可用種類時）／按鍵／更多
//   搜尋  直接開搜尋彈窗（不開子選單；種類在彈窗上方切，article_search.js）
//   按鍵  展開方向鍵面板（貼在工具列上方；含軟鍵盤開關與黏滯 Ctrl／Esc／Tab／Del）
//   更多  快速搜尋（選取模式下有選取時）／跳到第一篇未讀／設為全部已讀／分享／文章導覽／
//         選取模式／全選／圖片上傳／設定／登出
//         （全選與圖片上傳在桌機是右鍵選單項；手機長按選單不放，集中在這裡；主功能表不給，
//         見 mobile_toolbar.js 的 contentTools）
// 沒有返回：交給系統邊緣滑動／返回鍵（history_back_guard.js）。
//
// 三條不可以踩的線（同舊按鍵列，守護 tests/unit/mobile_toolbar.test.jsx）：
//   1. 送鍵一律 view.sendKeyAsUser(keyName, mods)：走鍵盤同一條 onKeyDown 分派（文章好讀／
//      列表好讀／原生三種語意）。不可 view._send（列表好讀底下是在序列化交易中途
//      插隊），也不可 App.onFunctionKey（文章好讀會先切 functionMode）。
//   2. mousedown 必須 preventDefault：預設動作會把焦點移到按鈕上 ⇒ #t 失焦 ⇒
//      軟鍵盤收起、實體鍵盤打不進終端機。
//   3. mousedown／mouseup／click 必須 stopPropagation：App 的滑鼠入口掛在 window，
//      放過去就會把這一下當成點終端機。彈出的小選單也畫在 root 底下（不用 Mantine
//      Menu 的 portal），同一道 stopPropagation 就罩得住。
const swallow = (e) => {
  e.stopPropagation();
};
const keepFocus = (e) => {
  e.preventDefault();
  e.stopPropagation();
};

// 觸覺回饋：短震一下（Android Chrome；沒有 API／APK 沒給 VIBRATE 權限時靜默）。
export const HAPTIC_MS = 8;
const haptic = () => {
  try {
    if (typeof navigator !== "undefined" && navigator.vibrate)
      navigator.vibrate(HAPTIC_MS);
  } catch (e) {
    // 被瀏覽器擋（沒有 user activation 之類）就算了。
  }
};

// 重整倒數的重讀間隔：秒數靠 Math.ceil 取整，250ms 讓跳秒最多晚 1/4 秒。
export const COOLDOWN_TICK_MS = 250;

const ICON_PROPS = { size: 22, stroke: 1.75, "aria-hidden": true };

// 選項按鈕的 data-choice（測試／除錯用的名字）：空白、控制碼給可讀的名字。
function choiceName(it) {
  if (it.action) return it.action;
  if (it.send === " ") return "Space";
  if (it.send === "\x03") return "Ctrl-C";
  return it.send || "Enter";
}

export const MobileToolbar = ({
  pttchrome,
  hidden,
  onOpenSearch,
  onOpenSettings,
}) => {
  const [mobile, setMobile] = useState(() => !!pttchrome.mobile);
  const [keyboard, setKeyboard] = useState(() => !!pttchrome.softKeyboard);
  const [selectMode, setSelectMode] = useState(
    () => !!pttchrome.mobileSelectMode,
  );
  const [ctrl, setCtrl] = useState(() => !!pttchrome.mobileCtrlArmed);
  const [context, setContext] = useState(EMPTY_TOOLBAR_CONTEXT);
  // null | 'keys' | 'more'：同一時間只開一個面板。
  const [panel, setPanel] = useState(null);
  // 「更多」開著時的分組（stableMoreSplit）；收起時清掉。
  const moreSplitRef = useRef(null);
  // 登出的全螢幕確認開著（components/LogoutConfirm）。
  const [confirmLogout, setConfirmLogout] = useState(false);
  // 「更多」裡的圖片上傳兩項跟著總開關 enableImageUpload（同桌機右鍵選單）：開 sheet
  // 當下現讀偏好；收起時不重算，退場動畫中項目才不會跳掉。
  const [imageUploadEnabled, setImageUploadEnabled] = useState(false);
  // 「更多」裡的快速搜尋（src/js/quick_search.js）：選取模式下的長按走原生選單，我們的
  // 長按選單（快速搜尋原本唯一的入口）出不來 ⇒ 選好字後按「更多」查。開 sheet 當下
  // 定案 { query, items }，收起時不重算（同 imageUploadEnabled）。
  const [quickSearch, setQuickSearch] = useState({ query: "", items: [] });
  // 按下工具列那一刻的選取：tap 手勢收尾時瀏覽器可能先把選取清掉才發 click，所以在
  // pointerdown（手指剛碰到、手勢還沒判定）先記下來。
  const pressSelectionRef = useRef("");
  const keysRef = useRef(null);
  // P61：PTT 提問的可點選項（context.choices）。和按鍵面板一樣貼在工具列上方、回報高度給 App
  // （終端機排在它上面，提問那一列才不會被蓋住）。按鍵／更多開著時不出現（同一時間一個面板）。
  const choicesRef = useRef(null);

  useEffect(() => {
    setMobile(!!pttchrome.mobile);
    // 測試常用假的 pttchrome 渲染 ContextMenu，沒有這支就當作永遠不是手機。
    if (typeof pttchrome.onMobileChange !== "function") return undefined;
    // 這些狀態都可能被 App 自己改（Android 返回鍵收鍵盤、Ctrl 用掉就解除），亮燈要跟
    // App 走，不能只信自己按下時的回傳值。
    return pttchrome.onMobileChange((m, kb, sel, c) => {
      setMobile(m);
      setKeyboard(!!m && !!kb);
      setSelectMode(!!m && !!sel);
      setCtrl(!!m && !!c);
    });
  }, [pttchrome]);

  useEffect(() => {
    if (typeof pttchrome.onScreenContextChange !== "function") return undefined;
    return pttchrome.onScreenContextChange((c) =>
      setContext(c || EMPTY_TOOLBAR_CONTEXT),
    );
  }, [pttchrome]);

  // 按鍵面板（或提問選項）蓋住的高度回報給 App（終端機排在它上面，見 setMobileKeysPanelInset）。
  const visible = mobile && !hidden;
  // P62 的「開鍵盤輸入」：鍵盤已經叫出來就沒用了，收起來（鍵盤收掉又會回來）。
  const choices =
    panel === null &&
    context.choices &&
    !(keyboard && context.choices.kind === "typeInput")
      ? context.choices
      : null;
  const choicesSig = promptChoicesSig(choices);
  useLayoutEffect(() => {
    if (typeof pttchrome.setMobileKeysPanelInset !== "function")
      return undefined;
    // 提問選項只在提問靠下時讓位（anchor，見 prompt_choices.js）：提問在上半部時讓位反而把它推進
    // App Bar 後面。
    const el =
      panel === "keys"
        ? keysRef.current
        : choices && choices.anchor === "bottom"
          ? choicesRef.current
          : null;
    pttchrome.setMobileKeysPanelInset(visible && el ? el.offsetHeight : 0);
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pttchrome, visible, panel, choicesSig, keyboard]);
  useEffect(
    () => () => {
      if (typeof pttchrome.setMobileKeysPanelInset === "function")
        pttchrome.setMobileKeysPanelInset(0);
    },
    [pttchrome],
  );

  const sendKey = useCallback(
    (key, mods) => {
      // 等待進度條：接著真的送出 byte 才會亮（mobile_busy.js）。
      if (typeof pttchrome.noteUserAction === "function")
        pttchrome.noteUserAction();
      if (mods) pttchrome.view.sendKeyAsUser(key, mods);
      else pttchrome.view.sendKeyAsUser(key);
    },
    [pttchrome],
  );

  // 點提問選項：先用**本幀**畫面再認一次（工具列的 context 是上次 settle 算的），同一組選項
  // 還在才送「字＋⏎」（it.enter false ＝只送字：P63 的空白、P62 的 ^C）；不一樣就不送（context
  // 下一次 settle 會跟上）。P62「開鍵盤輸入」（action keyboard）一個 byte 都不送，只叫鍵盤。
  const sendChoice = useCallback(
    (it) => {
      const now = promptPanelFromBuf(pttchrome.buf, readEffectivePrefs());
      if (!now || promptChoicesSig(now) !== choicesSig) return;
      if (it.action === "keyboard") {
        if (!pttchrome.softKeyboard)
          setKeyboard(pttchrome.toggleSoftKeyboard());
        return;
      }
      for (const ch of it.send) {
        const code = ch.charCodeAt(0);
        // 控制碼（^C）走 Alt remap（同 TOOLBAR_KEYS.post）：Alt+字母的 byte 與 Ctrl 相同。
        if (code > 0 && code < 0x1b)
          sendKey(String.fromCharCode(code + 0x60), { altKey: true });
        else sendKey(ch);
      }
      if (it.enter) sendKey("Enter");
    },
    [pttchrome, sendKey, choicesSig],
  );

  const sendAction = useCallback(
    (name) => {
      const k = TOOLBAR_KEYS[name];
      setPanel(null);
      sendKey(k.key, k.mods);
    },
    [sendKey],
  );

  // 推文：推文列收進底部導覽（js/comment_bar.js 收合模式）時展開它並叫出鍵盤，不送 X；
  // 其他情況（不在好讀文章、收合關掉）照原生送 X。
  const pushAction = useCallback(() => {
    const bar = pttchrome.commentBar;
    const s = bar && bar.state;
    if (s && s.available && s.folded && bar.expand()) {
      setPanel(null);
      return;
    }
    sendAction("push");
  }, [pttchrome, sendAction]);

  const togglePanel = useCallback(
    (p) => {
      if (p === "more") {
        const prefs = readValuesWithDefault();
        setImageUploadEnabled(
          !!pttchrome.imageUpload && !!prefs.enableImageUpload,
        );
        // 只在選取模式：模式關著時長按選單本身就有快速搜尋（長按的那個詞），而「全選」
        // 留下的整頁選取拿去查沒有意義。
        const query = pttchrome.mobileSelectMode
          ? normalizeQuickSearchQuery(
              pressSelectionRef.current || readSelectionText(),
            )
          : "";
        setQuickSearch({
          query,
          items: query ? visibleQuickSearchItems(prefs, query) : [],
        });
      }
      pressSelectionRef.current = "";
      setPanel((cur) => (cur === p ? null : p));
    },
    [pttchrome],
  );

  const onToolbarPointerDown = useCallback(() => {
    pressSelectionRef.current = readSelectionText();
  }, []);

  const onQuickSearch = useCallback(
    (item) => {
      setPanel(null);
      window.open(
        buildQuickSearchUrl(item.urlTemplate, quickSearch.query),
        "_blank",
        "noopener",
      );
    },
    [quickSearch],
  );

  // 「更多」sheet 的關閉（遮罩、拖把手、系統返回）。引用穩定：MobileSheet 拿它登記
  // 系統返回的關閉函式。
  const closeMore = useCallback(() => {
    setPanel((cur) => (cur === "more" ? null : cur));
  }, []);

  const onKeyboard = useCallback(() => {
    setKeyboard(pttchrome.toggleSoftKeyboard());
  }, [pttchrome]);

  const onCtrl = useCallback(() => {
    if (typeof pttchrome.setMobileCtrlArmed !== "function") return;
    setCtrl(pttchrome.setMobileCtrlArmed(!pttchrome.mobileCtrlArmed));
  }, [pttchrome]);

  const onSelectMode = useCallback(() => {
    if (typeof pttchrome.setMobileSelectMode !== "function") return;
    setSelectMode(pttchrome.setMobileSelectMode(!pttchrome.mobileSelectMode));
    setPanel(null);
  }, [pttchrome]);

  // 不開子選單：直接開搜尋彈窗，預設種類＝這個畫面可用的第一種（文章列表＝標題，
  // 看板列表／主功能表＝看板），要換種類在彈窗上方切。
  const onSearch = useCallback(() => {
    setPanel(null);
    if (onOpenSearch && context.search.length) onOpenSearch(context.search[0]);
  }, [onOpenSearch, context]);

  // 系統分享面板（Web Share API）。**同步**呼叫：免費路徑要在這個 click 的 user
  // activation 內叫出 navigator.share（deep_link_controller.shareCurrentPostLink）。
  const onShare = useCallback(() => {
    setPanel(null);
    const dl = pttchrome.deepLinkController;
    if (dl && typeof dl.shareCurrentPostLink === "function")
      dl.shareCurrentPostLink(context.appBar ? context.appBar.title : "");
  }, [pttchrome, context]);

  // 存到本機（P64，js/saved_articles.js）：只讀好讀累積頁，一個 byte 都不送。
  const onSaveLocal = useCallback(() => {
    setPanel(null);
    const sa = pttchrome.savedArticles;
    if (sa && typeof sa.saveCurrent === "function") sa.saveCurrent();
  }, [pttchrome]);

  // 跳到第一篇未讀：與桌機快捷鍵（預設 F7）同一個入口（unread_jump.js）。
  const onUnreadJump = useCallback(() => {
    setPanel(null);
    const u = pttchrome.unreadJump;
    if (!u || typeof u.start !== "function") return;
    if (typeof pttchrome.noteUserAction === "function")
      pttchrome.noteUserAction();
    u.start();
  }, [pttchrome]);

  // 設為全部已讀：與桌機右鍵選單同一個入口（mark_all_read.js）。
  const onMarkAllRead = useCallback(() => {
    setPanel(null);
    const m = pttchrome.markAllRead;
    if (!m || typeof m.start !== "function") return;
    if (typeof pttchrome.noteUserAction === "function")
      pttchrome.noteUserAction();
    m.start();
  }, [pttchrome]);

  // 只看關注（P36，js/follow_only.js）：手機的切換入口在「更多」（右上角的浮動鈕在手機會蓋到
  // 第一張卡片，只在整段都被收起時才浮出來提示）。只改顯示、不送鍵。
  const followOnlyState =
    pttchrome.followOnly && pttchrome.followOnly.state
      ? pttchrome.followOnly.state
      : null;
  const onFollowOnly = useCallback(() => {
    setPanel(null);
    const f = pttchrome.followOnly;
    if (f && typeof f.toggle === "function") f.toggle();
  }, [pttchrome]);

  const onEditorInput = useCallback(() => {
    setPanel(null);
    const ed = pttchrome.editorInput;
    if (ed && typeof ed.open === "function") ed.open();
  }, [pttchrome]);

  // 操作說明：送 h（與實體鍵盤同一條分派）；好讀開著時 PTT 的說明選單會變成 bottom sheet
  // （components/HelpMenu）。
  const onHelp = useCallback(() => {
    setPanel(null);
    sendKey(TOOLBAR_KEYS.help.key);
  }, [sendKey]);

  // P66「這個看板」：送那一個原生單鍵（sendKeyAsUser ＝鍵盤同一條分派，序列閘門照擋）。
  // sheet 開著的期間畫面可能換了（水球、斷線重連）⇒ 按下時用**本幀**再算一次，不是乾淨的
  // 文章列表就不送（下一次 settle 會把這一列收掉）。
  const onBoardTool = useCallback(
    (key) => {
      setPanel(null);
      const now =
        pttchrome.buf && typeof pttchrome.buf.getRowText === "function"
          ? mobileToolbarContext(pttchrome)
          : null;
      if (now && !now.boardTools) return;
      sendKey(key);
    },
    [pttchrome, sendKey],
  );

  // 全選／圖片上傳：與桌機右鍵選單同一組 App 入口（ContextMenu 的 menuHandlerByEventKey）。
  const onSelectAll = useCallback(() => {
    setPanel(null);
    if (typeof pttchrome.doSelectAll === "function") pttchrome.doSelectAll();
  }, [pttchrome]);

  const onUploadImage = useCallback(() => {
    setPanel(null);
    if (pttchrome.imageUpload) pttchrome.imageUpload.openFilePicker();
  }, [pttchrome]);

  const onUploadHistory = useCallback(() => {
    setPanel(null);
    if (pttchrome.imageUpload) pttchrome.imageUpload.openPanel();
  }, [pttchrome]);

  // 重新整理：與桌機 F5 同一個入口（冷卻、忙碌提示都在 ScreenRefresh 裡）。
  const onRefresh = useCallback(() => {
    setPanel(null);
    const r = pttchrome.screenRefresh;
    if (!r || typeof r.refresh !== "function") return;
    if (typeof pttchrome.noteUserAction === "function")
      pttchrome.noteUserAction();
    r.refresh("toolbar");
  }, [pttchrome]);

  // 重整冷卻的倒數（秒，0 ＝可以重整）。冷卻一開始（不論從工具列、F5 或下拉）
  // ScreenRefresh 會通知一次，之後自己每 250ms 重讀剩餘時間直到歸零。
  const [cooldownSec, setCooldownSec] = useState(0);
  useEffect(() => {
    const r = pttchrome.screenRefresh;
    if (!r || typeof r.onCooldown !== "function") return undefined;
    let timer = null;
    const tick = () => {
      const sec = Math.ceil(r.cooldownLeftMs() / 1000);
      setCooldownSec(sec);
      timer = sec > 0 ? setTimeout(tick, COOLDOWN_TICK_MS) : null;
    };
    const off = r.onCooldown(() => {
      clearTimeout(timer);
      tick();
    });
    tick();
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [pttchrome]);

  const onSettings = useCallback(() => {
    setPanel(null);
    if (onOpenSettings) onOpenSettings();
  }, [onOpenSettings]);

  // 登出：先收掉「更多」、蓋上全螢幕確認（components/LogoutConfirm）。
  const onLogout = useCallback(() => {
    setPanel(null);
    setConfirmLogout(true);
  }, []);
  const cancelLogout = useCallback(() => setConfirmLogout(false), []);
  const onLogoutConfirmed = useCallback(
    (quitApp) => {
      setConfirmLogout(false);
      if (typeof pttchrome.startLogout === "function")
        pttchrome.startLogout({ quitApp: !!quitApp });
    },
    [pttchrome],
  );

  if (!visible) return null;

  // 固定格位（mobile_toolbar.toolbarSlots）：位置不隨畫面變，不能用的反灰不藏。
  const refreshDisabled = !context.refresh || cooldownSec > 0;
  const renderSlot = (slot, i) => {
    switch (slot) {
      case "push":
        return navBtn(
          TOOLBAR_KEYS.push.key,
          IconThumbUp,
          i18n("mobileToolbar_push"),
          pushAction,
          { aria: i18n("mobileKeypad_push") },
        );
      case "editorInput":
        // 編輯器輸入框（P27，js/editor_input.js）：pref 關掉（或安全模式）⇒ 照空格畫。
        if (pttchrome.editorInput && pttchrome.editorInput.state.available)
          return navBtn(
            "__editorInput",
            IconCursorText,
            i18n("editorInput_open"),
            onEditorInput,
          );
        return (
          <span
            key={"__slot" + i}
            className="mobileToolbarBtn mobileToolbarSlotEmpty"
            data-slot-empty={i}
            aria-hidden="true"
          />
        );
      case "search":
        return navBtn(
          "__search",
          IconSearch,
          i18n("mobileToolbar_search"),
          onSearch,
        );
      case "reply":
        return navBtn(
          "__reply",
          context.mail ? IconMail : IconMessageReply,
          i18n(
            context.mail ? "mobileToolbar_replyMail" : "mobileToolbar_reply",
          ),
          () => sendAction("reply"),
        );
      case "editorSave":
        // P57：送之前再看一次本幀（工具列的 context 是上一次 settle 算的；這中間使用者可能
        // 自己按出了 ^S 搜尋之類的 prompt，^X 打進去就不是存檔了）。
        return navBtn(
          "__editorSave",
          IconDeviceFloppy,
          i18n("mobileToolbar_editorSave"),
          () => {
            const buf = pttchrome.buf;
            if (!buf || !screenOf(buf).editorTyping) return;
            sendAction("editorSave");
          },
        );
      case "mailCompose":
        // P59：信件列表的「寫信」送 ^P。送之前再看一次本幀：還在信件列表、沒有 prompt 開著
        // （工具列的 context 是上一次 settle 算的，^P 打進輸入欄就不是寄信了）。
        return navBtn(
          "__mailCompose",
          IconPencilPlus,
          i18n("mobileToolbar_mailCompose"),
          () => {
            const buf = pttchrome.buf;
            if (!buf) return;
            const screen = screenOf(buf);
            if (!screen.mailList || screen.promptPending) return;
            sendAction("mailCompose");
          },
        );
      case "post":
        return navBtn(
          "__post",
          IconPencilPlus,
          i18n("mobileToolbar_post"),
          () => sendAction("post"),
        );
      case "refresh":
        // 冷卻中：反灰＋倒數秒數取代 label（倒數由 screenRefresh.cooldownLeftMs 驅動，
        // F5／下拉觸發的冷卻一樣會顯示）。
        return navBtn(
          "__refresh",
          IconRefresh,
          cooldownSec > 0
            ? cooldownSec + i18n("mobileToolbar_secUnit")
            : i18n("mobileToolbar_refresh"),
          onRefresh,
          {
            disabled: refreshDisabled,
            aria: i18n("mobileToolbar_refresh"),
            extraClass: cooldownSec > 0 ? " cooling" : "",
          },
        );
      case "end":
        return navBtn(
          "__end",
          IconArrowBarToDown,
          i18n("mobileToolbar_end"),
          () => sendAction("end"),
          { disabled: !context.end },
        );
      case "keys":
        return navBtn(
          "__keys",
          IconKeyboard,
          i18n("mobileToolbar_keys"),
          () => togglePanel("keys"),
          { active: panel === "keys", expanded: panel === "keys" },
        );
      case "more":
        return navBtn(
          "__more",
          IconDots,
          i18n("mobileToolbar_more"),
          () => togglePanel("more"),
          { active: panel === "more", expanded: panel === "more" },
        );
      default:
        // 這個畫面沒有這一格的動作：佔位，寬度照算，旁邊的按鈕才不會挪位置。
        return (
          <span
            key={"__slot" + i}
            className="mobileToolbarBtn mobileToolbarSlotEmpty"
            data-slot-empty={i}
            aria-hidden="true"
          />
        );
    }
  };

  const keyBtn = (k, extraClass) => (
    <button
      key={k.key}
      type="button"
      className={"nomouse_command mobileKeypadKey" + (extraClass || "")}
      aria-label={k.aria}
      data-key={k.key}
      onClick={() => sendKey(k.key)}
    >
      {k.label}
    </button>
  );

  const navBtn = (key, Icon, label, onClick, opts) => {
    const o = opts || {};
    return (
      <button
        key={key}
        type="button"
        className={
          "nomouse_command mobileToolbarBtn pttRipple" +
          (o.active ? " active" : "") +
          (o.extraClass || "")
        }
        disabled={!!o.disabled}
        aria-label={o.aria || label}
        aria-pressed={o.pressed}
        aria-expanded={o.expanded}
        data-key={key}
        onClick={() => {
          haptic();
          onClick();
        }}
      >
        <Icon {...ICON_PROPS} />
        <span className="mobileToolbarLabel">{label}</span>
      </button>
    );
  };

  let panelEl = null;
  if (choices) {
    panelEl = (
      <div
        id="mobilePromptChoices"
        ref={choicesRef}
        className="nomouse_command mobilePromptChoices"
        role="group"
        aria-label={i18n("promptChoices_aria")}
      >
        <div className="mobilePromptChoicesTitle">
          {choices.titleKey ? i18n(choices.titleKey) : choices.title}
        </div>
        <div className="mobilePromptChoicesRow">
          {choices.items.map((it) => (
            <button
              key={it.action || it.send || "__enter"}
              type="button"
              className={
                "nomouse_command mobilePromptChoice pttRipple" +
                (it.isDefault ? " isDefault" : "")
              }
              data-choice={choiceName(it)}
              onClick={() => {
                haptic();
                sendChoice(it);
              }}
            >
              {it.key ? (
                <span className="mobilePromptChoiceKey">{it.key}</span>
              ) : null}
              {it.labelKey ? i18n(it.labelKey) : it.label}
            </button>
          ))}
        </div>
      </div>
    );
  } else if (panel === "keys") {
    panelEl = (
      <div
        id="mobileKeypad"
        ref={keysRef}
        className="nomouse_command mobileKeypadGrid"
      >
        {MOBILE_KEYPAD_ROWS[0].map((k) => keyBtn(k))}
        <button
          key="__keyboard"
          type="button"
          className={
            "nomouse_command mobileKeypadKey mobileKeypadAux" +
            (keyboard ? " active" : "")
          }
          aria-label={i18n("mobileKeypad_keyboard")}
          aria-pressed={keyboard}
          data-key="__keyboard"
          onClick={onKeyboard}
        >
          ⌨
        </button>
        {MOBILE_KEYPAD_ROWS[1].map((k) => keyBtn(k))}
        <button
          key="__ctrl"
          type="button"
          className={
            "nomouse_command mobileKeypadKey mobileKeypadAux" +
            (ctrl ? " active" : "")
          }
          aria-label={i18n("mobileKeypad_ctrl")}
          aria-pressed={ctrl}
          data-key="__ctrl"
          onClick={onCtrl}
        >
          Ctrl
        </button>
        {MOBILE_KEYPAD_EXTRA_ROW.map((k) => keyBtn(k, " mobileKeypadWide2"))}
      </div>
    );
  }

  // 「更多」是 bottom sheet（components/MobileSheet）：開著算 modal、系統返回＝收起。
  // 它畫在 portal 裡，不在工具列的事件攔截範圍內 —— 遮罩／項目的點擊靠 modalShown
  // 擋住 App 的滑鼠入口（MobileSheet 檔頭）。
  // 「更多」的項目（P40：常用的收成最上面的圖示格，見 more_sheet_layout.js）。key＝data-key。
  // label＝完整的字（清單項目的字、圖示格的 aria-label／title）。
  const moreItems = {
    __unreadJump: context.unreadJump && {
      label: i18n("mobileToolbar_unreadJump"),
      Icon: IconCircleDot,
      onClick: onUnreadJump,
    },
    __followOnly: followOnlyState &&
      followOnlyState.visible && {
        label: i18n("followOnly_label"),
        Icon: IconStar,
        onClick: onFollowOnly,
        pressed: !!followOnlyState.on,
      },
    __markAllRead: context.markAllRead && {
      label: i18n("cmenu_markAllRead"),
      Icon: IconChecks,
      onClick: onMarkAllRead,
    },
    __help: context.help && {
      label: i18n("mobileToolbar_help"),
      Icon: IconHelp,
      onClick: onHelp,
    },
    __share: context.share && {
      label: i18n("mobileToolbar_share"),
      Icon: IconShare,
      onClick: onShare,
    },
    // 好讀文章＋讀得到文末網址列才出現（savedArticles.canSave，開「更多」那一刻算）。
    __saveLocal: !!pttchrome.savedArticles?.canSave?.() && {
      label: i18n("saved_action"),
      onClick: onSaveLocal,
    },
    __threadNav: !!context.threadNav,
    __select: {
      label: i18n("mobileKeypad_select"),
      Icon: IconCursorText,
      onClick: onSelectMode,
      pressed: !!selectMode,
    },
    __selectAll: context.contentTools && {
      label: i18n("cmenu_selectAll"),
      Icon: IconSelectAll,
      onClick: onSelectAll,
    },
    // 唯讀頁（存到本機）沒有連線：上傳圖片要插進編輯器、登出要送鍵 ⇒ 都不列。
    __uploadImage: context.contentTools &&
      !context.readOnly &&
      imageUploadEnabled && {
        label: i18n("cmenu_uploadImage"),
        Icon: IconPhotoUp,
        onClick: onUploadImage,
      },
    __uploadHistory: context.contentTools &&
      !context.readOnly &&
      imageUploadEnabled && {
        label: i18n("cmenu_uploadHistory"),
        onClick: onUploadHistory,
      },
    __settings: { label: i18n("mobileToolbar_settings"), onClick: onSettings },
    __logout: !context.readOnly,
  };
  // 開著時沿用上一次的分組（stableMoreSplit：項目不在圖示格與清單之間搬家）；收起就重來。
  const moreVisible = Object.keys(moreItems).filter((k) => moreItems[k]);
  const moreSplit =
    panel === "more"
      ? stableMoreSplit(moreVisible, moreSplitRef.current)
      : splitMoreGrid(moreVisible);
  moreSplitRef.current = panel === "more" ? moreSplit : null;
  const { grid: moreGrid, list: moreList } = moreSplit;
  const pressedProps = (it) =>
    it.pressed === undefined
      ? {}
      : { "aria-pressed": it.pressed ? "true" : "false" };
  const renderMoreListItem = (key) => {
    if (key === "__threadNav")
      return (
        <div key={key} className="mobileToolbarNavGrid" data-key="__threadNav">
          {THREAD_NAV_GROUPS.map((g) => (
            <div key={g.title} className="mobileToolbarNavRow">
              <span className="mobileToolbarNavLabel">{i18n(g.title)}</span>
              {g.keys.map((k) => {
                const Icon = NAV_DIR_ICONS[k.dir];
                return (
                  <button
                    key={k.key}
                    type="button"
                    className="nomouse_command mobileSheetItem mobileToolbarNavBtn pttRipple"
                    data-key={k.key}
                    aria-label={i18n(k.label)}
                    onClick={() => {
                      setPanel(null);
                      sendKey(k.key);
                    }}
                  >
                    {k.dir !== "next" && (
                      <Icon size={18} stroke={2} aria-hidden="true" />
                    )}
                    <span>{i18n(k.short)}</span>
                    {k.dir === "next" && (
                      <Icon size={18} stroke={2} aria-hidden="true" />
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      );
    if (key === "__logout")
      return (
        <button
          key={key}
          type="button"
          className="nomouse_command mobileSheetItem mobileSheetDanger pttRipple"
          data-key="__logout"
          onClick={onLogout}
        >
          {i18n("mobileKeypad_logout")}
        </button>
      );
    const it = moreItems[key];
    return (
      <button
        key={key}
        type="button"
        className={
          "nomouse_command mobileSheetItem pttRipple" +
          (it.pressed ? " active" : "")
        }
        {...pressedProps(it)}
        data-key={key}
        onClick={it.onClick}
      >
        {it.label}
      </button>
    );
  };

  // 「更多」是 bottom sheet（components/MobileSheet）：開著算 modal、系統返回＝收起。
  // 它畫在 portal 裡，不在工具列的事件攔截範圍內 —— 遮罩／項目的點擊靠 modalShown
  // 擋住 App 的滑鼠入口（MobileSheet 檔頭）。
  const moreSheet = (
    <MobileSheet
      pttchrome={pttchrome}
      opened={panel === "more"}
      onClose={closeMore}
      sheetKey="more"
    >
      <div data-panel="more">
        {quickSearch.items.map((qs) => (
          <button
            key={"qs-" + qs.id}
            type="button"
            className="nomouse_command mobileSheetItem pttRipple"
            data-key={"__qs-" + qs.id}
            onClick={() => onQuickSearch(qs)}
          >
            <span>{quickSearchLabel(qs)}</span>
            <span className="mobileSheetItemPreview">{quickSearch.query}</span>
          </button>
        ))}
        {quickSearch.items.length ? (
          <div className="mobileSheetDivider" role="separator" />
        ) : null}
        {context.boardTools ? (
          <>
            <div className="mobileSheetSectionLabel">
              {i18n("mobileMore_sectionBoard")}
            </div>
            <div
              className="mobileSheetQuickRow mobileSheetQuickGrid"
              role="group"
              aria-label={i18n("mobileMore_sectionBoard")}
              data-board-tools=""
            >
              {BOARD_TOOL_KEYS.map((b) => {
                const Icon = BOARD_TOOL_ICONS[b.id];
                return (
                  <button
                    key={b.id}
                    type="button"
                    className="nomouse_command mobileSheetQuickItem pttRipple"
                    data-key={b.id}
                    aria-label={i18n(b.label)}
                    title={i18n(b.label)}
                    onClick={() => onBoardTool(b.key)}
                  >
                    <Icon size={22} stroke={1.75} aria-hidden="true" />
                    <span className="mobileSheetQuickLabel">
                      {i18n(b.short)}
                    </span>
                  </button>
                );
              })}
            </div>
            {moreGrid.length ? (
              <div className="mobileSheetSectionLabel">
                {i18n("mobileMore_sectionList")}
              </div>
            ) : null}
          </>
        ) : null}
        {moreGrid.length ? (
          <div
            className="mobileSheetQuickRow mobileSheetQuickGrid"
            role="group"
            data-more-grid=""
          >
            {moreGrid.map((key) => {
              const it = moreItems[key];
              const Icon = it.Icon;
              return (
                <button
                  key={key}
                  type="button"
                  className={
                    "nomouse_command mobileSheetQuickItem pttRipple" +
                    (it.pressed ? " active" : "")
                  }
                  {...pressedProps(it)}
                  data-key={key}
                  aria-label={it.label}
                  title={it.label}
                  onClick={it.onClick}
                >
                  <Icon size={22} stroke={1.75} aria-hidden="true" />
                  <span className="mobileSheetQuickLabel">
                    {i18n(MORE_GRID_LABEL_KEYS[key]) || it.label}
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}
        {moreList.map(renderMoreListItem)}
      </div>
    </MobileSheet>
  );

  return (
    <div
      id="mobileToolbar"
      className="nomouse_command mobileToolbar"
      onPointerDownCapture={onToolbarPointerDown}
      onMouseDown={keepFocus}
      onMouseUp={swallow}
      onClick={swallow}
    >
      {panelEl}
      {moreSheet}
      {confirmLogout ? (
        <LogoutConfirm
          pttchrome={pttchrome}
          canQuit={androidCanQuit()}
          onLogout={onLogoutConfirmed}
          onCancel={cancelLogout}
        />
      ) : null}
      <nav className="nomouse_command mobileToolbarBar">
        {toolbarSlots(context).map((slot, i) => renderSlot(slot, i))}
      </nav>
    </div>
  );
};

export default MobileToolbar;
