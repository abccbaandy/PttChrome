import { useEffect, useState } from "react";
import {
  Alert,
  Anchor,
  Button,
  Group,
  Loader,
  Transition,
} from "@mantine/core";
import { i18n } from "../js/i18n";
import { ORIGIN_SETUP_URL } from "../js/connection_probe";
import "./PageTopAlert.css";

// 斷線提示掛著時仍須正常運作的 UI：設定對話框、右鍵選單、以及任何表單元素。
// （終端機的隱藏 input#t 也是 input，故在 handler 內另外以 id 排除。）
const PASSTHROUGH =
  '[role="dialog"], [role="menu"], input, textarea, select, [contenteditable]';

// diagnose：回傳 Promise<'origin'|'unreachable'|'disconnected'|null>（決策表在
// js/connection_probe.js#diagnoseConnectFailure）。沒給就是原本只有重連的提示。
// onEnableProxy：使用者在「改用 Proxy？」選是 ⇒ App 開 useProxy 並重連。
export const ConnectionAlert = ({ onDismiss, diagnose, onEnableProxy }) => {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [verdict, setVerdict] = useState(diagnose ? "checking" : null);
  const [proxyAsked, setProxyAsked] = useState(true);
  useEffect(() => {
    if (!diagnose) return;
    let alive = true;
    Promise.resolve()
      .then(diagnose)
      .catch(() => "unreachable")
      .then((v) => {
        if (alive) setVerdict(v);
      });
    return () => {
      alive = false;
    };
  }, [diagnose]);

  useEffect(() => {
    const handler = (e) => {
      const t = e.target;
      // 斷線期間要擋的是**終端機**的按鍵（連線已死，送出去只會石沉大海），不是整個
      // 網頁的 UI。原本這裡無條件吃掉所有 keydown，導致斷線時設定頁的欄位完全打不了
      // 字，且在對話框裡按 Enter 會意外觸發重連（回報案例：PTT 維護期間開設定頁）。
      // 終端機自己的鍵盤入口是隱藏的 input#t（index.html / term_view.js），那個照擋。
      if (
        t &&
        t.id !== "t" &&
        typeof t.closest === "function" &&
        t.closest(PASSTHROUGH)
      ) {
        return;
      }
      if (e.keyCode == 13) {
        onDismiss();
      }
      // Kills everything becase we don't want any further action performed under ConnectionAlert status
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [onDismiss]);

  return (
    <Transition mounted={mounted} transition="fade" duration={200}>
      {(styles) => (
        <Alert
          style={styles}
          color="red"
          className="PageTopAlert"
          withCloseButton
          onClose={onDismiss}
          title={i18n("alert_connectionHeader")}
        >
          {verdict === "checking" && (
            <Group gap="xs">
              <Loader size="xs" color="red" />
              <span>{i18n("alert_connectionChecking")}</span>
            </Group>
          )}
          {verdict === "origin" && (
            <p>
              <span>{i18n("alert_connectionOriginBad")}</span>{" "}
              <Anchor
                href={ORIGIN_SETUP_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                {i18n("alert_connectionOriginHelp")}
              </Anchor>
            </p>
          )}
          {verdict === "unreachable" && (
            <p>{i18n("alert_connectionUnreachable")}</p>
          )}
          {verdict === "origin" && onEnableProxy && proxyAsked && (
            <>
              <p>{i18n("alert_connectionProxyAsk")}</p>
              <Group gap="xs" mb="sm">
                <Button color="red" variant="outline" onClick={onEnableProxy}>
                  {i18n("alert_connectionProxyYes")}
                </Button>
                <Button
                  color="gray"
                  variant="subtle"
                  onClick={() => setProxyAsked(false)}
                >
                  {i18n("alert_connectionProxyNo")}
                </Button>
              </Group>
            </>
          )}
          <p>{i18n("alert_connectionText")}</p>
          <Button color="red" onClick={onDismiss}>
            {i18n("alert_connectionReconnect")}
          </Button>
        </Alert>
      )}
    </Transition>
  );
};

export default ConnectionAlert;
