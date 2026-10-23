import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { i18n } from "../../js/i18n";
import { HOME_DASHBOARD_ID } from "../../js/home_dashboard";
import { recentKey } from "../../js/recent_articles";
import "./HomeDashboard.css";

// 首頁儀表板的外殼（邏輯與送鍵在 js/home_dashboard.js，設計見 docs/home-dashboard.md）。
// 狀態只從 pttchrome.homeDashboard.onChange 來，這裡照畫。
//
// 事件規則同 AidBackButton／MobileToolbar：mousedown preventDefault（不搶 #t 焦點 ⇒
// 打字照常送 PTT）、mousedown／mouseup／click stopPropagation（App 的滑鼠入口在 window）。
// 滾輪由 App._onUploadLayer 放過（它認 #homeDashboard），面板自己捲。
// 捲動位置屬於閱讀紀錄（home 紀錄）：每次畫完交給 applyPendingViewport 套用待還原錨。
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

const clock = (t) => {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, "0");
  return p(d.getHours()) + ":" + p(d.getMinutes());
};

function Button({ className, onClick, children, ...rest }) {
  return (
    <button
      type="button"
      className={"homeButton " + (className || "")}
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

// 儀表板上「稍後再讀」「最近讀過」各列幾篇（完整清單在指令面板 F4 打字找）。
export const HOME_ARTICLE_LIMIT = 8;

// 最近讀過／稍後再讀（P34，js/recent_articles.js）的一區。點一列 ＝ deep link 開回那篇；
// 稍後再讀的每一列多一顆 ✕（只移出清單，不送鍵）。
function ArticleSection({ titleKey, list, source, recent, onFail }) {
  if (!list.length) return null;
  return (
    <section className="homeSection">
      <div className="homeSectionHead">
        <h3>{i18n(titleKey)}</h3>
      </div>
      <div className="homeArticles" data-home-articles={source}>
        {list.slice(0, HOME_ARTICLE_LIMIT).map((e) => {
          const key = recentKey(e.board, e.aid);
          return (
            <div key={key} className="homeArticleRow">
              <Button
                className="homeArticle"
                data-home-article={key}
                title={e.title || "#" + e.aid}
                onClick={() => {
                  if (!recent.open(e)) onFail();
                }}
              >
                <span className="homeArticleTitle">
                  {e.title || "#" + e.aid}
                </span>
                <span className="homeArticleBoard">{e.board}</span>
              </Button>
              {source === "later" && (
                <Button
                  className="homeArticleRemove"
                  data-home-article-remove={key}
                  aria-label={i18n("recent_remove")}
                  title={i18n("recent_remove")}
                  onClick={() => recent.removeLater(key)}
                >
                  ✕
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export const HomeDashboard = ({ pttchrome }) => {
  const home = pttchrome && pttchrome.homeDashboard;
  const [state, setState] = useState(() => (home ? home.state : null));
  const [mobile, setMobile] = useState(() => !!(pttchrome && pttchrome.mobile));
  const recent = pttchrome && pttchrome.recentArticles;
  const [articles, setArticles] = useState(() =>
    recent ? recent.state : null,
  );
  const rootRef = useRef(null);

  useEffect(() => {
    if (!home || typeof home.onChange !== "function") return undefined;
    return home.onChange((s) => setState(s));
  }, [home]);
  useEffect(() => {
    if (!recent || typeof recent.onChange !== "function") return undefined;
    return recent.onChange((s) => setArticles(s));
  }, [recent]);
  useEffect(() => {
    if (!pttchrome || typeof pttchrome.onMobileChange !== "function")
      return undefined;
    return pttchrome.onMobileChange((m) => setMobile(!!m));
  }, [pttchrome]);

  useLayoutEffect(() => {
    if (
      rootRef.current &&
      home &&
      typeof home.applyPendingViewport === "function"
    )
      home.applyPendingViewport(rootRef.current);
  }, [home, state]);

  if (!state || !state.visible) return null;
  // 每次畫都重讀一次（storage 原文沒變就是同一份）：別的分頁寫的、這一頁讀過的都跟得上。
  const showArticles = !!recent && recent.enabled();
  const articleData = showArticles ? recent.state : articles;
  const onArticleFail = () =>
    pttchrome.view?.flashListHint?.(i18n("recent_failed"), 3000);
  const boards = state.boards;
  const status = state.fetching
    ? i18n("home_updating")
    : state.savedAt
      ? fmt("home_updatedAt", { time: clock(state.savedAt) })
      : "";

  let favBody;
  if (boards && boards.length) {
    favBody = (
      <div className="homeBoardGrid" data-home-favorites>
        {boards.map((b) => (
          <Button
            key={b.name}
            className="homeBoardCard"
            data-home-board={b.name}
            data-unread={b.unread ? "" : undefined}
            title={b.desc || b.name}
            onClick={() => home.openBoard(b.name)}
          >
            <span className="homeBoardName">
              {b.name}
              {b.unread && (
                <span className="homeUnread">{i18n("home_unread")}</span>
              )}
            </span>
            {b.desc && <span className="homeBoardDesc">{b.desc}</span>}
          </Button>
        ))}
      </div>
    );
  } else if (boards) {
    favBody = <p className="homeEmpty">{i18n("home_noFavorites")}</p>;
  } else {
    favBody = (
      <p className="homeEmpty" data-home-not-loaded>
        {i18n("home_notLoaded")}
      </p>
    );
  }

  return (
    <div
      id={HOME_DASHBOARD_ID}
      ref={rootRef}
      className="homeDashboard"
      data-mobile={mobile ? "" : undefined}
      onMouseDown={keepFocus}
      onMouseUp={swallow}
      onClick={swallow}
    >
      <div className="homeInner">
        {/* 手機：標題「首頁」與「原生主選單」都在 App Bar（MobileAppBar），這一行只在有新信時
          出現（放「開信箱」鈕）。桌機照舊。 */}
        {(!mobile || state.newMail) && (
          <div className="homeHeader">
            {!mobile && <h2 className="homeTitle">{i18n("home_title")}</h2>}
            {state.newMail && (
              <Button
                className="homeMail"
                data-home-mail
                onClick={() => home.openMail()}
              >
                {i18n("home_newMail")} · {i18n("home_openMail")}
              </Button>
            )}
            <span className="homeSpacer" />
            {!mobile && (
              <Button data-home-native onClick={() => home.dismiss()}>
                {i18n("home_native")}
              </Button>
            )}
          </div>
        )}
        <section className="homeSection">
          <div className="homeSectionHead">
            <h3>{i18n("home_favorites")}</h3>
            <span className="homeStatus" data-home-status>
              {status}
            </span>
            <Button
              data-home-refresh
              disabled={state.fetching}
              onClick={() => home.refresh("button")}
            >
              {boards ? i18n("home_refresh") : i18n("home_load")}
            </Button>
          </div>
          {favBody}
        </section>
        {state.recents && state.recents.length > 0 && (
          <section className="homeSection">
            <div className="homeSectionHead">
              <h3>{i18n("home_recents")}</h3>
            </div>
            <div className="homeChips" data-home-recents>
              {state.recents.map((name) => (
                <Button
                  key={name}
                  className="homeChip"
                  data-home-recent={name}
                  onClick={() => home.openBoard(name)}
                >
                  {name}
                </Button>
              ))}
            </div>
          </section>
        )}
        {showArticles && (
          <ArticleSection
            titleKey="recent_later"
            list={articleData.later}
            source="later"
            recent={recent}
            onFail={onArticleFail}
          />
        )}
        {showArticles && (
          <ArticleSection
            titleKey="recent_recent"
            list={articleData.recent}
            source="recent"
            recent={recent}
            onFail={onArticleFail}
          />
        )}
        {!mobile && <p className="homeHint">{i18n("home_hint")}</p>}
      </div>
    </div>
  );
};

export default HomeDashboard;
