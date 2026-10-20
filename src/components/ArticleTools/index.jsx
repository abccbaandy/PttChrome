import { useEffect, useState } from "react";
import { i18n } from "../../js/i18n";
import { ARTICLE_TOOLS_ID } from "../../js/article_tools";
import { SPLIT_HANDLE_PX } from "../../js/split_reader";
import "./ArticleTools.css";

// 文章工具側欄（邏輯在 js/article_tools.js，設計見 docs/article-tools.md）。
// 狀態只從 pttchrome.articleTools.onChange 來，這裡照畫。
//
// 事件規則同雙欄閱讀的左欄：mousedown preventDefault（不搶 #t 焦點 ⇒ 鍵盤照常操作文章）、
// mousedown／mouseup／click stopPropagation（App 的滑鼠入口在 window）。滾輪由
// App._onUploadLayer 放過（它認 #articleTools），側欄自己捲。
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

function Button({ className, onClick, children, ...rest }) {
  return (
    <button
      type="button"
      className={"toolsButton " + (className || "")}
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

// 縮圖：候選依序試（代理 → 原址），全部失敗就整格收掉。
function Thumb({ image, onOpen }) {
  const [index, setIndex] = useState(0);
  if (index >= image.thumbs.length) return null;
  return (
    <Button
      className="toolsThumb"
      data-tools-image={image.row}
      title={image.url}
      onClick={() => onOpen(image.row)}
    >
      <img
        src={image.thumbs[index]}
        alt=""
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        draggable={false}
        onError={() => setIndex(index + 1)}
      />
    </Button>
  );
}

export const ArticleTools = ({ pttchrome }) => {
  const tools = pttchrome && pttchrome.articleTools;
  const [state, setState] = useState(() => (tools ? tools.state : null));
  const [showImages, setShowImages] = useState(false);

  useEffect(() => {
    if (!tools || typeof tools.onChange !== "function") return undefined;
    return tools.onChange((s) => setState(s));
  }, [tools]);

  if (!state || !state.visible) return null;

  if (state.collapsed) {
    return (
      <div
        id={ARTICLE_TOOLS_ID}
        className="articleTools"
        data-collapsed=""
        style={{ width: SPLIT_HANDLE_PX }}
        onMouseDown={keepFocus}
        onMouseUp={swallow}
        onClick={swallow}
      >
        <Button
          className="toolsHandle"
          data-tools-expand
          title={i18n("tools_expand")}
          aria-label={i18n("tools_expand")}
          onClick={() => tools.setCollapsed(false)}
        >
          ‹
        </Button>
      </div>
    );
  }

  const s = state.stats;
  const jump = (row) => tools.jumpTo(row);
  return (
    <aside
      id={ARTICLE_TOOLS_ID}
      className="articleTools"
      style={{ width: state.width }}
      onMouseDown={keepFocus}
      onMouseUp={swallow}
      onClick={swallow}
    >
      <div className="toolsHeader">
        <span className="toolsTitle">{i18n("tools_title")}</span>
        <Button data-tools-collapse onClick={() => tools.setCollapsed(true)}>
          {i18n("split_collapse")}
        </Button>
      </div>
      <div className="toolsBody">
        {state.aid && (
          <section className="toolsSection" data-tools-info>
            <div className="toolsAid">#{state.aid}</div>
            <div className="toolsRow">
              <Button data-tools-copy-url onClick={() => tools.copyUrl()}>
                {i18n("tools_copyUrl")}
              </Button>
              <Button data-tools-copy-aid onClick={() => tools.copyAid()}>
                {i18n("tools_copyAid")}
              </Button>
            </div>
          </section>
        )}
        <section className="toolsSection" data-tools-stats>
          <div className="toolsStats">
            <span data-kind="push">
              {i18n("tools_push")} {s.push}
            </span>
            <span data-kind="boo">
              {i18n("tools_boo")} {s.boo}
            </span>
            <span data-kind="arrow">→ {s.arrow}</span>
            {s.modern > 0 && (
              <span data-kind="modern">
                {i18n("tools_modern")} {s.modern}
              </span>
            )}
          </div>
        </section>
        {state.mentions && state.mentions.length > 0 && (
          <section className="toolsSection" data-tools-mentions>
            <h3>{fmt("tools_mentions", { n: state.mentions.length })}</h3>
            <ol className="toolsComments">
              {state.mentions.map((c) => (
                <li key={c.row}>
                  <Button
                    className="toolsComment"
                    data-tools-mention={c.row}
                    onClick={() => jump(c.row)}
                  >
                    <span className="toolsMentionUser">{c.user}</span>{" "}
                    {c.content || "…"}
                  </Button>
                </li>
              ))}
            </ol>
          </section>
        )}
        {state.users.length > 0 && (
          <section className="toolsSection">
            <h3>{i18n("tools_commenters")}</h3>
            <div className="toolsUsers" data-tools-users>
              {state.users.map((u) => (
                <Button
                  key={u.user}
                  className="toolsUser"
                  data-tools-user={u.user}
                  data-selected={u.user === state.selectedUser ? "" : undefined}
                  data-op={u.op ? "" : undefined}
                  onClick={() => tools.selectUser(u.user)}
                >
                  <span className="toolsUserName">
                    {u.user}
                    {u.op && (
                      <span className="toolsOp">{i18n("tools_op")}</span>
                    )}
                  </span>
                  <span className="toolsCount">{u.count}</span>
                </Button>
              ))}
            </div>
            {state.selectedUser && (
              <ol className="toolsComments" data-tools-comments>
                {state.selectedComments.map((c) => (
                  <li key={c.row}>
                    <Button
                      className="toolsComment"
                      data-tools-comment={c.row}
                      onClick={() => jump(c.row)}
                    >
                      {c.content || "…"}
                    </Button>
                  </li>
                ))}
              </ol>
            )}
          </section>
        )}
        {state.images.length > 0 && (
          <section className="toolsSection">
            <Button
              className="toolsSectionToggle"
              data-tools-images-toggle
              aria-expanded={showImages}
              onClick={() => setShowImages(!showImages)}
            >
              {fmt("tools_images", { n: state.images.length })}{" "}
              {showImages ? "▾" : "▸"}
            </Button>
            {showImages && (
              <div className="toolsThumbs" data-tools-images>
                {state.images.map((img) => (
                  <Thumb key={img.url} image={img} onOpen={jump} />
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </aside>
  );
};

export default ArticleTools;
