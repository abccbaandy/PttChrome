import { useCallback, useEffect, useRef, useState } from "react";
import { i18n } from "../../js/i18n";
import { ARTICLE_NAV_ID } from "../../js/article_nav";
import "./ArticleNav.css";

// 文章導覽軸（邏輯在 js/article_nav.js，設計見 docs/article-tools.md「文章導覽軸」）。
// 位置、標記與顯示與否只從 pttchrome.articleNav.onChange 來；「目前看到哪」直接讀終端機的
// 捲動位置（.main 的 scroll 事件，rAF 合併）。
//
// 點／拖：pointer capture，整段拖曳都由軸接手（手機上不會變成捲頁或下拉重整）。點「推」
// 那一格＝跳到第一則推文（精準跳列），其他地方＝捲到那個比例。
// 滑鼠：App 的滑鼠入口在 window ⇒ 事件一律 stopPropagation，App._onUploadLayer 也認
// #articleNav 放過（不會被當成點終端機）。
const swallow = (e) => e.stopPropagation();

const KIND_TITLE = {
  comments: "articleNav_comments",
  new: "articleNav_new",
  mention: "articleNav_mention",
  image: "articleNav_image",
};

// 手機：終端機佔滿螢幕寬，軸疊在推文時間的最後一個字上 ⇒ 比照手機的原生捲軸，平常隱藏
// （也不接觸控），捲動中與捲完 IDLE_MS 內才出現、可以抓。
const IDLE_MS = 1500;

function useViewport(view, visible) {
  const [vp, setVp] = useState({ top: 0, size: 1, at: 0 });
  useEffect(() => {
    const el = view && view.mainDisplay;
    if (!visible || !el) return undefined;
    let raf = 0;
    const read = () => {
      raf = 0;
      const h = el.scrollHeight || 1;
      setVp({ top: el.scrollTop / h, size: Math.min(1, el.clientHeight / h), at: Date.now() });
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(read);
    };
    read();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [view, visible]);
  return vp;
}

export const ArticleNav = ({ pttchrome }) => {
  const nav = pttchrome && pttchrome.articleNav;
  const [state, setState] = useState(() => (nav ? nav.state : null));
  const dragRef = useRef(null);
  const visible = !!(state && state.visible);
  const vp = useViewport(pttchrome && pttchrome.view, visible);
  const [dragging, setDragging] = useState(false);
  const [awake, setAwake] = useState(false);
  // 手機的「醒著」：最近一次捲動後 IDLE_MS 內。開文那一刻的第一次量測不算。
  useEffect(() => {
    if (!vp.at) return undefined;
    setAwake(true);
    const id = setTimeout(() => setAwake(false), IDLE_MS);
    return () => clearTimeout(id);
  }, [vp.at]);

  useEffect(() => {
    if (!nav || typeof nav.onChange !== "function") return undefined;
    return nav.onChange((s) => setState(s));
  }, [nav]);

  const fractionAt = useCallback((e) => {
    const r = e.currentTarget.getBoundingClientRect();
    return r.height ? (e.clientY - r.top) / r.height : 0;
  }, []);

  const onPointerDown = useCallback(
    (e) => {
      e.stopPropagation();
      if (e.button != null && e.button !== 0) return;
      e.preventDefault();
      // 點在「推」上：精準跳到第一則推文。
      const mark = e.target.closest && e.target.closest("[data-nav-row]");
      if (mark) {
        nav.jumpTo(Number(mark.getAttribute("data-nav-row")));
        return;
      }
      dragRef.current = e.pointerId;
      setDragging(true);
      if (e.currentTarget.setPointerCapture)
        e.currentTarget.setPointerCapture(e.pointerId);
      nav.scrollToFraction(fractionAt(e));
    },
    [nav, fractionAt],
  );
  const onPointerMove = useCallback(
    (e) => {
      if (dragRef.current !== e.pointerId) return;
      e.stopPropagation();
      nav.scrollToFraction(fractionAt(e));
    },
    [nav, fractionAt],
  );
  const onPointerUp = useCallback((e) => {
    e.stopPropagation();
    if (dragRef.current === e.pointerId) {
      dragRef.current = null;
      setDragging(false);
    }
  }, []);

  if (!visible) return null;
  return (
    <div
      id={ARTICLE_NAV_ID}
      className={
        "articleNav" +
        (state.mobile ? " articleNav--mobile" : "") +
        (state.mobile && !awake && !dragging ? " articleNav--idle" : "")
      }
      role="scrollbar"
      aria-orientation="vertical"
      aria-label={i18n("articleNav_label")}
      aria-valuenow={Math.round(vp.top * 100)}
      style={{ left: state.left, top: state.top, height: state.height }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onMouseDown={swallow}
      onMouseUp={swallow}
      onClick={swallow}
      onContextMenu={swallow}
      onTouchStart={swallow}
      onTouchMove={swallow}
      onTouchEnd={swallow}
    >
      <div className="articleNavTrack" />
      <div
        className="articleNavThumb"
        style={{
          top: vp.top * 100 + "%",
          height: Math.max(vp.size * 100, 3) + "%",
        }}
      />
      {state.marks.map((m, i) => (
        <div
          key={m.kind + i}
          className={"articleNavMark articleNavMark--" + m.kind}
          style={{ top: m.f * 100 + "%" }}
          title={i18n(KIND_TITLE[m.kind])}
          data-nav-kind={m.kind}
          {...(m.kind === "comments" ? { "data-nav-row": m.row } : null)}
        >
          {m.kind === "comments" ? i18n("articleNav_commentsShort") : null}
        </div>
      ))}
    </div>
  );
};

export default ArticleNav;
