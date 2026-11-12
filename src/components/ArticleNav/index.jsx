import { useCallback, useEffect, useRef, useState } from "react";
import { i18n } from "../../js/i18n";
import { ARTICLE_NAV_ID } from "../../js/article_nav";
import "./ArticleNav.css";

// 文章導覽軸（邏輯在 js/article_nav.js，設計見 docs/article-tools.md「文章導覽軸」）。
// 位置、標記與顯示與否只從 pttchrome.articleNav.onChange 來；「目前看到哪」直接讀終端機的
// 捲動位置（.main 的 scroll 事件，rAF 合併）。
//
// **捲動不經 React**：滑塊位置（transform）與 aria-valuenow 由 scroll 直接寫進 DOM。經 state
// 的話每一幀整個軸連同上千個標記重新 render，實機約佔 165Hz 每幀預算的四成（耗電，
// docs/handoff/android-battery-drain.md U8）。手機的醒著／閒置只在切換那一刻 setState。
// 守護 tests/unit/article_nav_scroll_cost.test.jsx。
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

// 滑塊跟著 .main 的捲動位置走（直接寫 DOM，見檔頭）。navHeight＝軸的高度（px）：滑塊用
// translateY 定位（只動合成層，不重排）。出現那一刻與每次捲動呼叫 onActive（手機醒來用）；
// 軸的高度變了（推文列長高、鍵盤、resize）只重新定位、**不叫醒**（手機軸醒著會蓋住推文時間）。
function useScrollThumb(view, visible, navHeight, rootRef, thumbRef, onActive) {
  const activeRef = useRef(onActive);
  activeRef.current = onActive;
  const heightRef = useRef(navHeight);
  heightRef.current = navHeight;
  const placeRef = useRef(null);
  useEffect(() => {
    const el = view && view.mainDisplay;
    if (!visible || !el) return undefined;
    let raf = 0;
    let lastSize = -1;
    const place = () => {
      const h = el.scrollHeight || 1;
      const top = el.scrollTop / h;
      const size = Math.max(Math.min(1, el.clientHeight / h) * 100, 3);
      const thumb = thumbRef.current;
      if (thumb) {
        thumb.style.transform = "translateY(" + top * heightRef.current + "px)";
        if (size !== lastSize) thumb.style.height = size + "%";
        lastSize = size;
      }
      if (rootRef.current) rootRef.current.setAttribute("aria-valuenow", String(Math.round(top * 100)));
    };
    const read = () => {
      raf = 0;
      place();
      activeRef.current();
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(read);
    };
    placeRef.current = place;
    read();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      placeRef.current = null;
      el.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [view, visible, rootRef, thumbRef]);
  useEffect(() => {
    if (placeRef.current) placeRef.current();
  }, [navHeight]);
}

export const ArticleNav = ({ pttchrome }) => {
  const nav = pttchrome && pttchrome.articleNav;
  const [state, setState] = useState(() => (nav ? nav.state : null));
  const dragRef = useRef(null);
  const rootRef = useRef(null);
  const thumbRef = useRef(null);
  const visible = !!(state && state.visible);
  const [dragging, setDragging] = useState(false);
  const [awake, setAwake] = useState(false);
  // 手機的「醒著」：最近一次讀到捲動位置（含開文那一刻）後 IDLE_MS 內。只在切換時 setState。
  const awakeRef = useRef(false);
  const idleTimer = useRef(0);
  const wake = useCallback(() => {
    if (!awakeRef.current) {
      awakeRef.current = true;
      setAwake(true);
    }
    clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => {
      awakeRef.current = false;
      setAwake(false);
    }, IDLE_MS);
  }, []);
  useEffect(() => () => clearTimeout(idleTimer.current), []);
  useScrollThumb(pttchrome && pttchrome.view, visible, visible ? state.height : 0, rootRef, thumbRef, wake);

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
      ref={rootRef}
      id={ARTICLE_NAV_ID}
      className={
        "articleNav" +
        (state.mobile ? " articleNav--mobile" : "") +
        (state.mobile && !awake && !dragging ? " articleNav--idle" : "")
      }
      role="scrollbar"
      aria-orientation="vertical"
      aria-label={i18n("articleNav_label")}
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
      <div ref={thumbRef} className="articleNavThumb" />
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
