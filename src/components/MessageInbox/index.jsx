import { useEffect, useState } from "react";
import { i18n } from "../../js/i18n";
import { MESSAGE_INBOX_ID, isMessageInboxTarget } from "../../js/message_inbox";
import "./MessageInbox.css";

// 水球收件匣的鈴鐺＋清單（邏輯在 js/message_inbox.js，設計見 docs/message-inbox.md）。
// 狀態只從 pttchrome.messageInbox.onChange 來，這裡照畫。還沒收到任何一則就不畫
// （平常畫面上什麼都不多）。
//
// 位置：桌機貼視窗右上角（文章工具側欄展開時讓到它左邊）；手機放進 App Bar 右端
// （MobileAppBar 以 inline 渲染，浮動版在手機上不畫）。
//
// 不是 modal：焦點留在 #t，鍵盤照常送 PTT。事件規則同其他浮層：mousedown
// preventDefault（不搶 #t 焦點）、mousedown／mouseup／click stopPropagation（App 的
// 滑鼠入口在 window）；滾輪由 App._onUploadLayer 放過（它認 #messageInbox）。
const keepFocus = (e) => {
  e.preventDefault();
  e.stopPropagation();
};
const swallow = (e) => {
  e.stopPropagation();
};

const fmt = (key, vars) =>
  String(i18n(key) || "").replace(/\{(\w+)\}/g, (m, k) =>
    vars && vars[k] != null ? String(vars[k]) : m,
  );

const pad2 = (n) => (n < 10 ? "0" : "") + n;
const clock = (ms) => {
  const d = new Date(ms);
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
};

function Button({ className, onClick, children, ...rest }) {
  return (
    <button
      type="button"
      className={className}
      onMouseDown={keepFocus}
      onMouseUp={swallow}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      {...rest}
    >
      {children}
    </button>
  );
}

export const MessageInbox = ({ pttchrome, inline = false }) => {
  const inbox = pttchrome && pttchrome.messageInbox;
  const [state, setState] = useState(() => (inbox ? inbox.state : null));
  const [mobile, setMobile] = useState(() => !!(pttchrome && pttchrome.mobile));
  const [toolsWidth, setToolsWidth] = useState(0);

  useEffect(() => {
    if (!inbox || typeof inbox.onChange !== "function") return undefined;
    return inbox.onChange((s) => setState(s));
  }, [inbox]);

  useEffect(() => {
    if (!pttchrome || typeof pttchrome.onMobileChange !== "function")
      return undefined;
    setMobile(!!pttchrome.mobile);
    return pttchrome.onMobileChange((m) => setMobile(!!m));
  }, [pttchrome]);

  // 文章工具側欄佔住右邊時，鈴鐺讓到它左邊（不蓋住側欄的收合鈕）。
  useEffect(() => {
    const tools = pttchrome && pttchrome.articleTools;
    if (inline || !tools || typeof tools.onChange !== "function")
      return undefined;
    return tools.onChange((s) =>
      setToolsWidth(s && s.visible && !s.collapsed ? s.width || 0 : 0),
    );
  }, [pttchrome, inline]);

  // 點清單外面就收起（不吞那一下：該點到什麼照常點到）。
  const open = !!(state && state.open);
  useEffect(() => {
    if (!open || !inbox) return undefined;
    const onDown = (e) => {
      if (!isMessageInboxTarget(e.target)) inbox.setOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("touchstart", onDown, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("touchstart", onDown, true);
    };
  }, [open, inbox]);

  if (!state || !state.items.length) return null;
  if (inline !== mobile) return null;

  const unread = state.unread;
  const label = unread
    ? fmt("inbox_open", { count: unread })
    : i18n("inbox_title");
  const style = inline ? undefined : { right: 8 + toolsWidth };

  return (
    <div
      id={MESSAGE_INBOX_ID}
      className={"messageInbox" + (inline ? " messageInboxInline" : "")}
      style={style}
      onMouseDown={keepFocus}
      onMouseUp={swallow}
      onClick={swallow}
    >
      <Button
        className="inboxBell"
        data-inbox-bell=""
        aria-label={label}
        aria-expanded={open}
        title={label}
        onClick={() => inbox.toggle()}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22zm7-6V11a7 7 0 0 0-5.5-6.84V3.5a1.5 1.5 0 0 0-3 0v.66A7 7 0 0 0 5 11v5l-2 2v1h18v-1l-2-2z"
          />
        </svg>
        {unread ? (
          <span className="inboxBadge" data-inbox-unread={unread}>
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </Button>
      {open ? (
        <section
          className="inboxPanel"
          role="dialog"
          aria-label={i18n("inbox_title")}
        >
          <header className="inboxHeader">
            <span className="inboxTitle">{i18n("inbox_title")}</span>
            <Button
              className="inboxAction"
              data-inbox-clear=""
              onClick={() => inbox.clear()}
            >
              {i18n("inbox_clear")}
            </Button>
            <Button
              className="inboxAction"
              data-inbox-close=""
              onClick={() => inbox.setOpen(false)}
            >
              {i18n("inbox_close")}
            </Button>
          </header>
          <ol className="inboxList">
            {state.items.map((item) => (
              <li
                key={item.id}
                className="inboxItem"
                data-inbox-kind={item.kind}
              >
                <div className="inboxMeta">
                  <span className="inboxFrom">
                    {item.kind === "broadcast"
                      ? i18n("inbox_broadcast")
                      : item.kind === "mail"
                        ? i18n("inbox_mail")
                        : item.from}
                  </span>
                  <time className="inboxTime">{clock(item.at)}</time>
                  {inbox.canReply(item) ? (
                    <Button
                      className="inboxAction"
                      data-inbox-reply=""
                      title={fmt("inbox_reply_title", { id: item.from })}
                      onClick={() => inbox.reply(item)}
                    >
                      {i18n("inbox_reply")}
                    </Button>
                  ) : null}
                </div>
                <div className="inboxText">{item.text}</div>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
};

export default MessageInbox;
