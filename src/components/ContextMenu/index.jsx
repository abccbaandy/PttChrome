import { Fragment, useState, useRef, useCallback, useEffect } from "react";
import { i18n } from "../../js/i18n";
import DropdownMenu from "./DropdownMenu";
import InputHelperModal from "./InputHelperModal";
import LiveHelperModal from "./LiveHelperModal";
import PrefModal from "./PrefModal";
import TitleBlacklistModal from "./TitleBlacklistModal";
import DebugRecordButton from "../DebugRecordButton";
import { onPrefSaveImpl } from "./pref_save";
import { downloadAsFile } from "../../js/util";
import { readValuesWithDefault, writeValues } from "../../js/pref_storage";
import * as prefSync from "../../js/pref_sync";
import {
  parseBlacklist,
  listColRegion,
  appendBlacklistEntry,
  COMMENT_USERID_COL,
} from "../../js/comment_parse";
import {
  normalizeQuickSearchQuery,
  visibleQuickSearchItems,
  buildQuickSearchUrl,
} from "../../js/quick_search";

function noop() {}

const EVENT_KEY_BY_HOT_KEY = {
  ["C".charCodeAt(0)]: "copy",
  ["E".charCodeAt(0)]: "copyLinkUrl",
  ["P".charCodeAt(0)]: "paste",
  ["T".charCodeAt(0)]: "openUrlNewTab",
};

// Quick-add one blacklist entry (author id or title keyword) through the SAME
// persist pipeline the settings modal uses: localStorage → cloud sync (no-op when
// signed out) → onValuesPrefChange (re-parse + redraw). NOT onPrefSaveImpl — that
// carries settings-modal-only side effects (modalShown/easy-reading re-entry).
// appendBlacklistEntry returns null when the entry is already present/empty →
// skip the whole pipeline (no updatedAt bump pinging other devices for nothing).
const quickAddBlacklist = (pttchrome, prefKey, entry) => {
  const values = readValuesWithDefault();
  const appended = appendBlacklistEntry(values[prefKey], entry);
  if (appended === null) return;
  const newValues = { ...values, [prefKey]: appended };
  writeValues(newValues);
  prefSync.savePrefs(newValues);
  pttchrome.onValuesPrefChange(newValues);
};

const menuHandlerByEventKey = {
  addAuthorBlacklist: (pttchrome, { blacklistAuthorTarget }) =>
    quickAddBlacklist(pttchrome, "blacklist", blacklistAuthorTarget),
  copy: (pttchrome, { selectedText }) => pttchrome.doCopy(selectedText),
  copyAnsi: (pttchrome) => pttchrome.doCopyAnsi(),
  paste: (pttchrome) => pttchrome.doPaste(),
  openUrlNewTab: (pttchrome, { aElement }) =>
    pttchrome.doOpenUrlNewTab(aElement),
  copyLinkUrl: (pttchrome, { contextOnUrl }) => pttchrome.doCopy(contextOnUrl),
  copyArticleLink: (pttchrome) =>
    pttchrome.deepLinkController.copyCurrentPostLink(),
  selectAll: (pttchrome) => pttchrome.doSelectAll(),
  mouseBrowsing: (pttchrome) => pttchrome.switchMouseBrowsing(),
};

const initialState = {
  // --- Menu state ---
  open: false,
  pageX: 0,
  pageY: 0,
  contextOnUrl: "",
  aElement: undefined,
  selectedText: "",
  urlEnabled: false,
  normalEnabled: false,
  selEnabled: false,
  // Quick-add blacklist targets under the right-click cursor (null → item hidden).
  blacklistAuthorTarget: null,
  blacklistAuthorExists: false,
  blacklistTitleTarget: null,
  // 右鍵當下是不是在文章畫面（決定「複製本篇連結」出不出現）。
  articleLinkEnabled: false,
  // Quick search items shown for the current selection (already filtered by the
  // enabled flag + each item's match rule), and the normalized query they use.
  quickSearchItems: [],
  quickSearchQuery: "",
  // --- Modal state ---
  showsInputHelper: false,
  showsTitleBlacklist: false,
  titleBlacklistDraft: "",
  showsLiveArticleHelper: false,
  showsSettings: false,
  // --- LiveHelper state ---
  liveHelperEnabled: false,
  liveHelperSec: 1,
};

export const ContextMenu = ({ pttchrome }) => {
  const [state, setState] = useState(initialState);
  // Debug 模式（設定→關於）：獨立 useState、不進 initialState —— onMenuSelect 等
  // 路徑會 update(initialState) 全量 reset，混進去會被誤關。runtime-only：不進
  // pref_storage/pref_sync，重新整理即重設為關閉。
  const [debugMode, setDebugMode] = useState(false);
  // Several handlers both read state for a side-effect AND set it, so we mirror
  // state into a ref (synced every render) and read stateRef.current in
  // callbacks to avoid stale closures.
  const stateRef = useRef(state);
  stateRef.current = state;
  // Shallow-merge a partial into state; undefined → no-op.
  const update = useCallback((partial) => {
    if (partial !== undefined) setState((s) => ({ ...s, ...partial }));
  }, []);

  // pttchrome.modalShown（終端機鍵盤／焦點的總閘門）由 render state **推導**，不由各個
  // 事件處理器手動兩邊維護：任何一條關閉路徑中途 throw／early-return，都不會留下
  // 「畫面上有對話框、app 卻以為沒有」的失同步 —— 那個失同步會讓 term_view 的 keyup
  // 與 pttchrome 的 mouseover/mouseup 永久把焦點搶回隱藏 input #t，整頁只能重整才能
  // 打字。回歸守護：tests/e2e/offline/connect_failure.offline.spec.js。
  //
  // 界線（刻意維持現狀，勿順手擴大）：showsInputHelper／showsLiveArticleHelper 一直
  // 都不算 modal（終端機在它們開著時仍收鍵盤），ui_behavior.offline.spec.js 的
  // 「點到 Mantine 圖示(SVG) 不崩潰」正是靠 InputHelper 屬「非 modal 浮層」才測得到。
  const modalOpen = state.showsSettings || state.showsTitleBlacklist;
  useEffect(() => {
    pttchrome.setModalOpen("contextMenu", modalOpen);
  }, [pttchrome, modalOpen]);

  const onContextMenu = useCallback(
    (event) => {
      event.stopPropagation();
      event.preventDefault();
      const { CmdHandler } = pttchrome;
      const doDOMMouseScroll =
        CmdHandler.getAttribute("doDOMMouseScroll") === "1";
      if (doDOMMouseScroll) {
        CmdHandler.setAttribute("doDOMMouseScroll", "0");
        return;
      }
      pttchrome.contextMenuShown = true;
      // just in case the selection get de-selected
      if (window.getSelection().isCollapsed) {
        pttchrome.lastSelection = null;
      } else {
        pttchrome.lastSelection = pttchrome.view.getSelectionColRow();
      }

      const target = event.target;
      let contextOnUrl = "";
      let aElement;
      if (target.tagName === "A") {
        contextOnUrl = target.getAttribute("href");
        aElement = target;
      } else if (target.parentElement && target.parentElement.tagName === "A") {
        contextOnUrl = target.parentElement.getAttribute("href");
        aElement = target.parentElement;
      }

      // replace the &nbsp;
      const selectedText = window.getSelection().toString().replace(/ /g, " ");
      const urlEnabled = !!contextOnUrl;
      const normalEnabled = !urlEnabled && window.getSelection().isCollapsed;
      const selEnabled = !normalEnabled;

      // 快速搜尋：每次開選單「現讀」偏好（同下面黑名單判定的手法）→ 設定改完立刻
      // 生效，不必在 pttchrome.jsx#onPrefChange 掛 case。適用條件（純數字）不符的
      // 項目在這裡就被濾掉，DropdownMenu 只負責畫。
      const quickSearchQuery = selEnabled
        ? normalizeQuickSearchQuery(selectedText)
        : "";
      const quickSearchItems = quickSearchQuery
        ? visibleQuickSearchItems(readValuesWithDefault(), quickSearchQuery)
        : [];

      // Quick-add blacklist: which author/title region (if any) sits under the
      // cursor. The ROW comes from the DOM (data-pusher / data-list-author /
      // data-list-title — easy reading is one long accumulated page, so a visual
      // y→buf row mapping would be wrong there); the COLUMN comes from
      // clientToPos (fixed screen cells, x is mode-independent). Comment rows:
      // only the id cells [3, 3+id.length). List rows: author field vs title
      // region per listColRegion.
      let blacklistAuthorTarget = null;
      let blacklistAuthorExists = false;
      let blacklistTitleTarget = null;
      const rowElement =
        target.closest &&
        target.closest("[data-pusher], [data-list-author], [data-list-title]");
      if (rowElement && normalEnabled) {
        const { col } = pttchrome.clientToPos(event.clientX, event.clientY);
        const pusher = rowElement.getAttribute("data-pusher");
        const listAuthor = rowElement.getAttribute("data-list-author");
        const listTitle = rowElement.getAttribute("data-list-title");
        if (pusher) {
          if (
            col >= COMMENT_USERID_COL &&
            col < COMMENT_USERID_COL + pusher.length
          ) {
            blacklistAuthorTarget = pusher;
          }
        } else {
          const region = listColRegion(col);
          if (region === "author" && listAuthor) {
            blacklistAuthorTarget = listAuthor;
          } else if (region === "title" && listTitle) {
            blacklistTitleTarget = listTitle;
          }
        }
        if (blacklistAuthorTarget) {
          blacklistAuthorExists = parseBlacklist(
            readValuesWithDefault().blacklist,
          ).has(blacklistAuthorTarget.toLowerCase());
        }
      }

      update({
        open: true,
        pageX: event.pageX,
        pageY: event.pageY,
        contextOnUrl,
        aElement,
        selectedText,
        urlEnabled,
        normalEnabled,
        selEnabled,
        blacklistAuthorTarget,
        blacklistAuthorExists,
        blacklistTitleTarget,
        quickSearchItems,
        quickSearchQuery,
        // 「複製本篇連結」只在文章畫面有意義（要按 Q 問文章資訊框）。pageState 3
        // = READING，與 term_view 判「可切回好讀模式」用的是同一個值。
        articleLinkEnabled: pttchrome.buf.pageState === 3,
      });
    },
    [pttchrome, update],
  );

  // Close ONLY the context menu — never the modal flags. Mantine Menu's
  // closeOnItemClick/closeOnClickOutside fire onChange(false) → onHide after a
  // menu item runs, so resetting the whole state here (old initialState reset,
  // which relied on the items' event.stopPropagation to suppress it) would wipe
  // the showsSettings/showsInputHelper flag the click just set and the modal
  // would never open. The modals have their own hide handlers.
  const onHide = useCallback(() => {
    if (stateRef.current.open) {
      pttchrome.contextMenuShown = false;
      update({
        open: false,
        contextOnUrl: "",
        aElement: undefined,
        selectedText: "",
        urlEnabled: false,
        normalEnabled: false,
        selEnabled: false,
        blacklistAuthorTarget: null,
        blacklistAuthorExists: false,
        blacklistTitleTarget: null,
        quickSearchItems: [],
        quickSearchQuery: "",
      });
    }
  }, [pttchrome, update]);

  const onMenuSelect = useCallback(
    (eventKey, event) => {
      menuHandlerByEventKey[eventKey](pttchrome, stateRef.current);
      event.stopPropagation();
      pttchrome.contextMenuShown = false;
      update(initialState);
    },
    [pttchrome, update],
  );

  const onInputHelperClick = useCallback(
    (event) => {
      event.stopPropagation();
      pttchrome.contextMenuShown = false;
      update({ ...initialState, showsInputHelper: true });
    },
    [pttchrome, update],
  );

  // Title quick-add opens an editable prompt (prefilled with the full title)
  // instead of writing immediately. showsTitleBlacklist 會被上方的 useEffect 推導成
  // modalShown=true，讓終端機鍵盤處理器讓位給 TextInput（打字不會驅動 BBS session）。
  const onTitleBlacklistClick = useCallback(
    (event) => {
      event.stopPropagation();
      pttchrome.contextMenuShown = false;
      update({
        ...initialState,
        showsTitleBlacklist: true,
        titleBlacklistDraft: stateRef.current.blacklistTitleTarget || "",
      });
    },
    [pttchrome, update],
  );
  const onTitleBlacklistHide = useCallback(() => {
    update({ showsTitleBlacklist: false, titleBlacklistDraft: "" });
  }, [update]);
  const onTitleBlacklistConfirm = useCallback(
    (keyword) => {
      quickAddBlacklist(pttchrome, "titleBlacklist", keyword);
      onTitleBlacklistHide();
    },
    [pttchrome, onTitleBlacklistHide],
  );

  const onLiveArticleHelperClick = useCallback(
    (event) => {
      event.stopPropagation();
      pttchrome.contextMenuShown = false;
      update({ ...initialState, showsLiveArticleHelper: true });
    },
    [pttchrome, update],
  );

  const onSettingsClick = useCallback(
    (event) => {
      event.stopPropagation();
      pttchrome.contextMenuShown = false;
      pttchrome.onDisableLiveHelperModalState();
      update({ ...initialState, showsSettings: true });
    },
    [pttchrome, update],
  );

  const onQuickSearchSelect = useCallback(
    (item, event) => {
      const url = buildQuickSearchUrl(
        item.urlTemplate,
        stateRef.current.quickSearchQuery,
      );
      window.open(url, "_blank", "noopener");
      event.stopPropagation();
      pttchrome.contextMenuShown = false;
      update(initialState);
    },
    [pttchrome, update],
  );

  const onInputHelperHide = useCallback(
    () => update({ showsInputHelper: false }),
    [update],
  );
  const onInputHelperReset = useCallback(() => {
    pttchrome.conn.send("\x15[m");
  }, [pttchrome]);
  const onInputHelperCmdSend = useCallback(
    (cmd) => {
      if (!window.getSelection().isCollapsed && pttchrome.buf.pageState == 6) {
        // something selected
        var sel = pttchrome.view.getSelectionColRow();
        var y = pttchrome.buf.cur_y;
        var selCmd = "";
        // move cursor to end and send reset code
        selCmd += "\x1b[H";
        if (y > sel.end.row) {
          selCmd += "\x1b[A".repeat(y - sel.end.row);
        } else if (y < sel.end.row) {
          selCmd += "\x1b[B".repeat(sel.end.row - y);
        }
        var repeats = pttchrome.buf.getRowText(
          sel.end.row,
          0,
          sel.end.col,
        ).length;
        selCmd += "\x1b[C".repeat(repeats) + "\x15[m";

        // move cursor to start and send color code
        y = sel.end.row;
        selCmd += "\x1b[H";
        if (y > sel.start.row) {
          selCmd += "\x1b[A".repeat(y - sel.start.row);
        } else if (y < sel.start.row) {
          selCmd += "\x1b[B".repeat(sel.start.row - y);
        }
        repeats = pttchrome.buf.getRowText(
          sel.start.row,
          0,
          sel.start.col,
        ).length;
        selCmd += "\x1b[C".repeat(repeats);
        cmd = selCmd + cmd;
      }
      pttchrome.conn.send(cmd);
    },
    [pttchrome],
  );
  const onInputHelperConvSend = useCallback(
    (value) => {
      pttchrome.conn.convSend(value);
    },
    [pttchrome],
  );

  const onLiveHelperHide = useCallback(() => {
    pttchrome.setAutoPushthreadUpdate(-1);
    update({
      showsLiveArticleHelper: false,
      liveHelperEnabled: false,
    });
  }, [pttchrome, update]);
  const onLiveHelperChange = useCallback(
    (nextState) => {
      if (nextState.enabled) {
        // cancel easy reading mode first — always through the single exit entry point
        // (exitEasyReading), never by flipping useEasyReadingMode by hand: the exit
        // recipe also clears sendCommandAfterUpdate/pageLines and restores the overlay
        // rows. Guarded by easy-reading.offline.spec.js「LiveHelper 启用 → 关好读单一出口」.
        pttchrome.easyReading.exitEasyReading();
        pttchrome.setAutoPushthreadUpdate(nextState.sec);
      } else {
        pttchrome.setAutoPushthreadUpdate(-1);
      }
      update({
        liveHelperEnabled: nextState.enabled,
        liveHelperSec: nextState.sec,
      });
    },
    [pttchrome, update],
  );

  // 關閉 debug 模式時若仍在錄製：先停止並下載（不丟資料），再卸下按鈕。
  const onDebugModeChange = useCallback(
    (enabled) => {
      if (!enabled && pttchrome.debugRecorder?.isRecording) {
        const json = pttchrome.debugRecorder.stop({
          prefs: readValuesWithDefault(),
        });
        pttchrome.debugRecorder = null;
        if (json) downloadAsFile("ptt-debug-" + Date.now() + ".json", json);
      }
      setDebugMode(enabled);
    },
    [pttchrome],
  );

  const onPrefSave = useCallback(
    (values) => {
      update(onPrefSaveImpl(pttchrome, values));
    },
    [pttchrome, update],
  );
  const onPrefReset = useCallback(
    (values) => {
      pttchrome.view.redraw(true);
      update(onPrefSaveImpl(pttchrome, values));
    },
    [pttchrome, update],
  );

  // Expose the live-helper toggle/disable hooks on pttchrome (used by term_view's
  // End handler). Re-bind whenever the enabled flag flips. (The recompose version
  // referenced an out-of-scope `state` here and would ReferenceError if the toggle
  // ever ran; read the current flags from stateRef instead.)
  const liveHelperEnabled = state.liveHelperEnabled;
  useEffect(() => {
    if (liveHelperEnabled) {
      pttchrome.onToggleLiveHelperModalState = () => {
        onLiveHelperChange({
          enabled: !stateRef.current.liveHelperEnabled,
          sec: stateRef.current.liveHelperSec,
        });
        // Signal to term_view's End handler that the key was consumed; the noop
        // bound below (helper inactive) returns undefined so End falls through.
        return true;
      };
      pttchrome.onDisableLiveHelperModalState = () => {
        onLiveHelperChange({
          enabled: false,
          sec: stateRef.current.liveHelperSec,
        });
      };
    } else {
      pttchrome.onToggleLiveHelperModalState =
        pttchrome.onDisableLiveHelperModalState = noop;
    }
  }, [liveHelperEnabled, pttchrome, onLiveHelperChange]);

  // Global listeners for opening/closing the menu and its hotkeys. Mounted once;
  // the callbacks are stable (deps are pttchrome + the stable `update`).
  useEffect(() => {
    const bbsWindow = document.getElementById("BBSWindow");
    const contextMenuHandler = (event) => onContextMenu(event);
    bbsWindow.addEventListener("contextmenu", contextMenuHandler, true);

    const clickHandler = () => onHide();
    window.addEventListener("click", clickHandler, false);

    const hotKeyUpHandler = (event) => {
      if (!stateRef.current.open) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.altKey || event.ctrlKey || event.shiftKey) {
        return;
      }
      const eventKey = EVENT_KEY_BY_HOT_KEY[event.keyCode];
      if (eventKey) {
        onMenuSelect(eventKey, event);
      }
    };
    window.addEventListener("keyup", hotKeyUpHandler, false);

    return () => {
      window.removeEventListener("keyup", hotKeyUpHandler, false);
      window.removeEventListener("click", clickHandler, false);
      bbsWindow.removeEventListener("contextmenu", contextMenuHandler, true);
    };
  }, [onContextMenu, onHide, onMenuSelect]);

  const {
    pageX,
    pageY,
    open,
    urlEnabled,
    normalEnabled,
    selEnabled,
    blacklistAuthorTarget,
    blacklistAuthorExists,
    blacklistTitleTarget,
    articleLinkEnabled,
    quickSearchItems,
    quickSearchQuery,
    showsInputHelper,
    showsTitleBlacklist,
    titleBlacklistDraft,
    showsLiveArticleHelper,
    showsSettings,
    liveHelperSec,
  } = state;

  return (
    <Fragment>
      <DropdownMenu
        open={open}
        onHide={onHide}
        pageX={pageX}
        pageY={pageY}
        urlEnabled={urlEnabled}
        normalEnabled={normalEnabled}
        selEnabled={selEnabled}
        mouseBrowsingEnabled={pttchrome.buf.useMouseBrowsing}
        quickSearchItems={quickSearchItems}
        quickSearchQuery={quickSearchQuery}
        authorBlacklistId={blacklistAuthorTarget}
        authorBlacklistExists={blacklistAuthorExists}
        titleBlacklistText={blacklistTitleTarget}
        articleLinkEnabled={articleLinkEnabled}
        onTitleBlacklistClick={onTitleBlacklistClick}
        onMenuSelect={onMenuSelect}
        onInputHelperClick={onInputHelperClick}
        onLiveArticleHelperClick={onLiveArticleHelperClick}
        onSettingsClick={onSettingsClick}
        onQuickSearchSelect={onQuickSearchSelect}
      />
      <InputHelperModal
        show={showsInputHelper}
        onHide={onInputHelperHide}
        onReset={onInputHelperReset}
        onCmdSend={onInputHelperCmdSend}
        onConvSend={onInputHelperConvSend}
      />
      <LiveHelperModal
        show={showsLiveArticleHelper}
        onHide={onLiveHelperHide}
        enabled={liveHelperEnabled}
        sec={liveHelperSec}
        onChange={onLiveHelperChange}
      />
      <TitleBlacklistModal
        show={showsTitleBlacklist}
        draft={titleBlacklistDraft}
        onHide={onTitleBlacklistHide}
        onConfirm={onTitleBlacklistConfirm}
      />
      <PrefModal
        show={showsSettings}
        onSave={onPrefSave}
        onReset={onPrefReset}
        debugMode={debugMode}
        onDebugModeChange={onDebugModeChange}
      />
      {debugMode && <DebugRecordButton pttchrome={pttchrome} />}
    </Fragment>
  );
};

export default ContextMenu;
