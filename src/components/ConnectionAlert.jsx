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

// diagnose：回傳 Promise<{ verdict, suggestions }>（決策表在
// js/connection_probe.js#adviseConnectFailure）；舊形狀（只回 verdict 字串）也吃。
// 沒給就是原本只有重連的提示（被 PTT 封鎖、正常登出都不給 ⇒ 不出現任何建議）。
// onEnableProxy：使用者在「改用 Proxy？」選是 ⇒ App 開 useProxy 並重連。
// onSwitchProtocol(protocol)：建議裡的「改用 SSH／改用 WebSocket」⇒ App 記住新協議並立即重連
//（docs/ssh.md「失敗提示」）。只有使用者按了才切，不自動切。
// loggedOut：使用者自己按了登出（App.logout，server 正常關線）⇒ 不是連線失敗，
// 換成藍色的「已登出」標題，只留重新連線。
// loginBlocked：斷線前畫面是 PTT 的登入封鎖（js/login_block.js）⇒ 寫明封鎖規則與「本頁自動登入
// 已暫停」，不跑診斷（連得上，是 PTT 不讓登入）。
// SSH 載體的失敗原因 → 說明文字（verdict 見 connection_probe.js#adviseConnectFailure）。
const SSH_VERDICT_TEXT = {
  sshHostKey: "alert_connectionSshHostKey",
  sshRelay: "alert_connectionSshRelay",
  sshUnreachable: "alert_connectionSshUnreachable",
  sshUnsupported: "alert_connectionSshUnsupported",
  sshProtocol: "alert_connectionSshProtocol",
};

// 「改用另一個協議」的按鈕。
const SWITCHES = [
  { key: "useSsh", protocol: "ssh", labelKey: "alert_connectionUseSsh" },
  {
    key: "useWebsocket",
    protocol: "websocket",
    labelKey: "alert_connectionUseWebsocket",
  },
];

// 舊的 diagnose 只回 verdict 字串（origin 時隱含「建議 proxy」）。
export const normalizeAdvice = (r) => {
  if (r && typeof r === "object") {
    return {
      verdict: r.verdict ?? null,
      suggestions: Array.isArray(r.suggestions) ? r.suggestions : [],
    };
  }
  return { verdict: r ?? null, suggestions: r === "origin" ? ["proxy"] : [] };
};

export const ConnectionAlert = ({
  onDismiss,
  diagnose,
  onEnableProxy,
  onSwitchProtocol,
  loggedOut,
  loginBlocked,
}) => {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [verdict, setVerdict] = useState(diagnose ? "checking" : null);
  const [suggestions, setSuggestions] = useState([]);
  const [proxyAsked, setProxyAsked] = useState(true);
  useEffect(() => {
    if (!diagnose) return;
    let alive = true;
    Promise.resolve()
      .then(diagnose)
      .catch(() => "unreachable")
      .then((r) => {
        if (!alive) return;
        const advice = normalizeAdvice(r);
        setVerdict(advice.verdict);
        setSuggestions(advice.suggestions);
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
          color={loggedOut ? "blue" : "red"}
          className="PageTopAlert"
          withCloseButton
          onClose={onDismiss}
          title={i18n(
            loggedOut ? "alert_loggedOutHeader" : "alert_connectionHeader",
          )}
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
          {SSH_VERDICT_TEXT[verdict] && (
            <p>{i18n(SSH_VERDICT_TEXT[verdict])}</p>
          )}
          {suggestions.includes("checkRelay") && (
            <p>{i18n("alert_connectionCheckRelay")}</p>
          )}
          {suggestions.includes("proxy") && onEnableProxy && proxyAsked && (
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
          {onSwitchProtocol &&
            SWITCHES.filter((s) => suggestions.includes(s.key)).map((s) => (
              <Group gap="xs" mb="sm" key={s.key}>
                <Button
                  color="red"
                  variant="outline"
                  onClick={() => onSwitchProtocol(s.protocol)}
                >
                  {i18n(s.labelKey)}
                </Button>
              </Group>
            ))}
          {loginBlocked && <p>{i18n("alert_connectionLoginBlocked")}</p>}
          <p>{i18n("alert_connectionText")}</p>
          <Button color={loggedOut ? "blue" : "red"} onClick={onDismiss}>
            {i18n("alert_connectionReconnect")}
          </Button>
        </Alert>
      )}
    </Transition>
  );
};

export default ConnectionAlert;
