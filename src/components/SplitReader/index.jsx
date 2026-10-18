import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { i18n } from "../../js/i18n";
import { SPLIT_READER_ID, SPLIT_HANDLE_PX } from "../../js/split_reader";
import "./SplitReader.css";

// 寬螢幕雙欄閱讀的左欄（邏輯與送鍵在 js/split_reader.js，設計見 docs/split-reader.md）。
// 狀態只從 pttchrome.splitReader.onChange 來，這裡照畫。
//
// 事件規則同 HomeDashboard：mousedown preventDefault（不搶 #t 焦點 ⇒ 鍵盤照常操作文章）、
// mousedown／mouseup／click stopPropagation（App 的滑鼠入口在 window）。滾輪由
// App._onUploadLayer 放過（它認 #splitReader），左欄自己捲，不會變成文章翻頁。
const keepFocus = (e) => {
  e.preventDefault();
  e.stopPropagation();
};
const swallow = (e) => {
  e.stopPropagation();
};

// 推文數的顏色照 bbs.c#readdoent：爆＝紅、兩位數＝黃、一位數＝綠、X＝灰。
function recommendTone(r) {
  if (!r) return null;
  if (r === "爆") return "hot";
  if (/^X/.test(r)) return "down";
  if (/^\d{2}$/.test(r)) return "many";
  return "some";
}

function Item({ entry, current, pending, onOpen }) {
  const tone = recommendTone(entry.recommend);
  return (
    <li>
      <button
        type="button"
        className="splitItem"
        data-split-num={entry.num}
        data-current={current ? "" : undefined}
        data-pending={pending ? "" : undefined}
        data-unread={entry.unread ? "" : undefined}
        data-deleted={entry.deleted ? "" : undefined}
        disabled={entry.deleted}
        title={entry.title}
        onMouseDown={keepFocus}
        onMouseUp={swallow}
        onClick={(e) => {
          e.stopPropagation();
          onOpen(entry.num);
        }}
      >
        <span className="splitItemTitle">
          {entry.unread && (
            <span className="splitUnread" aria-label={i18n("split_unread")} />
          )}
          {tone && (
            <span className="splitRecommend" data-tone={tone}>
              {entry.recommend}
            </span>
          )}
          <span className="splitItemText">{entry.title}</span>
        </span>
        <span className="splitItemMeta">
          {pending
            ? i18n("split_opening")
            : entry.date + " · " + entry.author}
        </span>
      </button>
    </li>
  );
}

export const SplitReader = ({ pttchrome }) => {
  const split = pttchrome && pttchrome.splitReader;
  const [state, setState] = useState(() => (split ? split.state : null));
  const listRef = useRef(null);

  useEffect(() => {
    if (!split || typeof split.onChange !== "function") return undefined;
    return split.onChange((s) => setState(s));
  }, [split]);

  // 正在讀的那篇捲進視野（換文、剛出現時）。只捲左欄自己，不碰頁面。
  const visible = !!(state && state.visible && !state.collapsed);
  const currentNum = state ? state.currentNum : null;
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!visible || !list || currentNum == null) return;
    const el = list.querySelector('[data-split-num="' + currentNum + '"]');
    if (!el) return;
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    if (top >= list.scrollTop && bottom <= list.scrollTop + list.clientHeight)
      return;
    list.scrollTop = Math.max(
      0,
      top - (list.clientHeight - el.offsetHeight) / 2,
    );
  }, [visible, currentNum]);

  if (!state || !state.visible) return null;

  if (state.collapsed) {
    return (
      <div
        id={SPLIT_READER_ID}
        className="splitReader"
        data-collapsed=""
        style={{ width: SPLIT_HANDLE_PX }}
        onMouseDown={keepFocus}
        onMouseUp={swallow}
        onClick={swallow}
      >
        <button
          type="button"
          className="splitHandle"
          data-split-expand
          title={i18n("split_expand")}
          aria-label={i18n("split_expand")}
          onMouseDown={keepFocus}
          onMouseUp={swallow}
          onClick={(e) => {
            e.stopPropagation();
            split.setCollapsed(false);
          }}
        >
          ›
        </button>
      </div>
    );
  }

  return (
    <aside
      id={SPLIT_READER_ID}
      className="splitReader"
      style={{ width: state.width }}
      onMouseDown={keepFocus}
      onMouseUp={swallow}
      onClick={swallow}
    >
      <div className="splitHeader">
        <span className="splitBoard" data-split-board>
          {state.board}
        </span>
        <button
          type="button"
          className="splitCollapse"
          data-split-collapse
          onMouseDown={keepFocus}
          onMouseUp={swallow}
          onClick={(e) => {
            e.stopPropagation();
            split.setCollapsed(true);
          }}
        >
          {i18n("split_collapse")}
        </button>
      </div>
      <ol className="splitList" ref={listRef} data-split-list>
        {state.entries.map((entry) => (
          <Item
            key={entry.num}
            entry={entry}
            current={entry.num === state.currentNum}
            pending={entry.num === state.pendingNum}
            onOpen={(num) => split.openNum(num)}
          />
        ))}
      </ol>
    </aside>
  );
};

export default SplitReader;
