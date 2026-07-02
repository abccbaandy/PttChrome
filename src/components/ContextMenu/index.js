import { Fragment, useState, useRef, useCallback, useEffect } from "react";
import { i18n } from "../../js/i18n";
import DropdownMenu from "./DropdownMenu";
import InputHelperModal from "./InputHelperModal";
import LiveHelperModal from "./LiveHelperModal";
import PrefModal from "./PrefModal";

function noop() {}

const EVENT_KEY_BY_HOT_KEY = {
  ["C".charCodeAt(0)]: "copy",
  ["E".charCodeAt(0)]: "copyLinkUrl",
  ["P".charCodeAt(0)]: "paste",
  ["S".charCodeAt(0)]: "searchGoogle",
  ["T".charCodeAt(0)]: "openUrlNewTab",
};

const menuHandlerByEventKey = {
  copy: (pttchrome, { selectedText }) => pttchrome.doCopy(selectedText),
  copyAnsi: (pttchrome) => pttchrome.doCopyAnsi(),
  paste: (pttchrome) => pttchrome.doPaste(),
  searchGoogle: (pttchrome, { selectedText }) =>
    pttchrome.doSearchGoogle(selectedText),
  openUrlNewTab: (pttchrome, { aElement }) =>
    pttchrome.doOpenUrlNewTab(aElement),
  copyLinkUrl: (pttchrome, { contextOnUrl }) => pttchrome.doCopy(contextOnUrl),
  selectAll: (pttchrome) => pttchrome.doSelectAll(),
  mouseBrowsing: (pttchrome) => pttchrome.switchMouseBrowsing(),
};

const onPrefSaveImpl = (pttchrome, values) => {
  pttchrome.onValuesPrefChange(values);
  pttchrome.modalShown = false;
  pttchrome.setInputAreaFocus();
  pttchrome.switchToEasyReadingMode(pttchrome.view.useEasyReadingMode);

  return {
    showsSettings: false,
  };
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
  // --- Modal state ---
  showsInputHelper: false,
  showsLiveArticleHelper: false,
  showsSettings: false,
  // --- LiveHelper state ---
  liveHelperEnabled: false,
  liveHelperSec: 1,
};

export const ContextMenu = ({ pttchrome }) => {
  const [state, setState] = useState(initialState);
  // Several handlers both read state for a side-effect AND set it, so we mirror
  // state into a ref (synced every render) and read stateRef.current in
  // callbacks to avoid stale closures.
  const stateRef = useRef(state);
  stateRef.current = state;
  // Shallow-merge a partial into state; undefined → no-op.
  const update = useCallback((partial) => {
    if (partial !== undefined) setState((s) => ({ ...s, ...partial }));
  }, []);

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
      pttchrome.modalShown = true;
      update({ ...initialState, showsSettings: true });
    },
    [pttchrome, update],
  );

  const onQuickSearchSelect = useCallback(
    (eventKey, event) => {
      const url = eventKey.replace("%s", stateRef.current.selectedText);
      window.open(url);
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
        // cancel easy reading mode first — go through the single exit recipe so the
        // React tree is unmounted too (the old useEasyReadingMode=false +
        // switchToEasyReadingMode() pair skipped that → latent freeze, 坑 1).
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

    const touchStartHandler = (event) => {
      if (event.target.getAttribute("role") === "menuitem") {
        return;
      }
      onHide();
    };
    window.addEventListener("touchstart", touchStartHandler, false);

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
      window.removeEventListener("touchstart", touchStartHandler, false);
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
    selectedText,
    showsInputHelper,
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
        selectedText={selectedText}
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
      <PrefModal
        show={showsSettings}
        onSave={onPrefSave}
        onReset={onPrefReset}
      />
    </Fragment>
  );
};

export default ContextMenu;
