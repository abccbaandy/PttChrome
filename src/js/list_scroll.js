// 文章列表好讀模式的捲動數學（純函式，零 DOM / 零 app 狀態）。
//
// 2026-08-30 起列表好讀的 body 是一個真正的捲動容器（`.listBodyView`，
// `overflow-y:auto`，內容＝整段過濾後序列），捲動本身完全交給瀏覽器 —— 與文章
// 好讀模式同一套引擎。這支只負責兩件瀏覽器不知道的事：
//   1. **序列位置 ↔ scrollTop 的換算**：列高恆為 chh（等寬字 + `white-space:pre`），
//      所以是純乘除，不必量任何 offsetTop（那會強制 layout，而列表 30ms 就重繪一次）。
//   2. **錨定還原**：merge/evict/prune 會讓整段序列上下位移，重繪後必須把「使用者
//      原本看著的那一列」放回原處。這是舊架構「視窗以序號錨定、prepend/evict 不動
//      視窗」（docs/easy-reading-list.md 不變量 6）的原生捲動版本。
//
// 呼叫端在 js/list_session.js（captureScrollAnchor / applyScrollAfterRender /
// _moveSelection）。守護：tests/unit/list_scroll.test.js。

// floor 用的容差：target 剛好落在列邊界下方一點點時，floor 會少算一列。
export const POS_EPS = 1e-6;
// 可見性比較用的容差（px）。瀏覽器的 scrollTop 可以是小數（高 DPI／縮放），
// 差半個像素不該算成「露出視口外」——否則 nearest 會每次都想捲一下。
export const VISIBLE_EPS = 0.5;

// 內容總高：render 端會把短板補 blank 列到 bodyRows，所以內容至少一個視口高。
export function contentPx({ len, bodyRows, rowH }) {
  const n = Math.max(Number(len) || 0, Number(bodyRows) || 0);
  return n * (Number(rowH) || 0);
}

// 可捲距離的上限。
export function maxScrollTopFor({ len, bodyRows, rowH, viewportPx }) {
  const vp = viewportPx == null ? (Number(bodyRows) || 0) * (Number(rowH) || 0) : viewportPx;
  return Math.max(0, contentPx({ len, bodyRows, rowH }) - vp);
}

// scrollTop → 視口頂端停在序列的第幾列、那一列已經捲掉幾 px。
export function topPosFromScrollTop({ scrollTop, rowH }) {
  const h = Number(rowH);
  if (!(h > 0)) return { pos: 0, frac: 0 };
  const st = Math.max(0, Number(scrollTop) || 0);
  const pos = Math.floor(st / h + POS_EPS);
  return { pos: pos, frac: Math.max(0, st - pos * h) };
}

// (序列位置, 列內偏移) → scrollTop。錨定還原的核心，一次乘法。
export function anchorScrollTop({ pos, frac, rowH, maxScrollTop }) {
  const h = Number(rowH) || 0;
  const p = Math.max(0, Number(pos) || 0);
  const f = Math.max(0, Number(frac) || 0);
  return clamp(p * h + f, maxScrollTop);
}

// 某一列是否完整落在視口內。
export function isRowVisible({ pos, scrollTop, rowH, viewportPx }) {
  const h = Number(rowH) || 0;
  const top = (Number(pos) || 0) * h;
  const st = Number(scrollTop) || 0;
  return (
    top >= st - VISIBLE_EPS && top + h <= st + (Number(viewportPx) || 0) + VISIBLE_EPS
  );
}

// 把第 pos 列帶進視口所需的 scrollTop。block 語意同 scrollIntoView：
//   nearest 已經看得到就不動，否則捲最少的距離貼上／貼下
//   start   貼齊視口頂（＝「把這一列變成新的第一列」，PgUp/PgDn/Home 用）
//   end     貼齊視口底（End 用）
//   center  置中（游標被捲出視野後拉回來時用，比貼邊自然）
export function revealScrollTop({ pos, scrollTop, rowH, viewportPx, maxScrollTop, block }) {
  const h = Number(rowH) || 0;
  const vp = Number(viewportPx) || 0;
  const st = Number(scrollTop) || 0;
  const top = Math.max(0, Number(pos) || 0) * h;
  const bottom = top + h;
  let target;
  switch (block) {
    case 'start':
      target = top;
      break;
    case 'end':
      target = bottom - vp;
      break;
    case 'center':
      target = top - (vp - h) / 2;
      break;
    default: // nearest
      if (top < st - VISIBLE_EPS) target = top;
      else if (bottom > st + vp + VISIBLE_EPS) target = bottom - vp;
      else target = st;
      break;
  }
  return clamp(target, maxScrollTop);
}

// 這個導覽操作該怎麼捲。
//
// **behavior 是有實作理由的，不是美感**：瀏覽器的 programmatic 平滑捲動
// （`scrollTo({behavior:'smooth'})`）**不保留速度** —— 每一次呼叫都取消上一個動畫、
// 從當前位置以 ease-in-out 的**起始段**重新起跑（Blink：ProgrammaticScrollAnimator，
// 而 Chrome 自己的鍵盤捲動走的是保留速度的 ScrollAnimator::UpdateTarget，那個能力
// web API 沒有暴露）。所以只要按鍵比動畫快，畫面就只會一直爬：
//   - 逐列移動（↑↓，keydown 約 30/s）一律 instant；
//   - **按住／連發任何 nav 鍵**（`repeat`）也一律 instant —— 否則按住 PgUp/PgDn 是
//     「按著慢慢爬、放開才快速補捲 1~2 頁」（目標每次再往前一頁、動畫卻永遠從頭起跑）。
// 單發的大跨度操作（翻頁／頭尾／把捲出視野的游標拉回來）才用 smooth。
// 要翻回全 smooth 只改這一支。
export function revealPlan(op, opts) {
  const o = opts || {};
  const reduced = !!o.reducedMotion;
  // 按住／連發：block（捲到哪）不變，只把動畫關掉，位移才跟得上按鍵、放開即停。
  const smooth = reduced || o.repeat ? 'auto' : 'smooth';
  switch (op) {
    case 'up':
    case 'down':
      // 游標本來就看得到＝一次一列的微調（instant）；看不到＝先把它拉回畫面中央。
      return o.wasVisible
        ? { block: 'nearest', behavior: 'auto' }
        : { block: 'center', behavior: smooth };
    case 'pgup':
    case 'pgdn':
    case 'home':
      return { block: 'start', behavior: smooth };
    case 'end':
      return { block: 'end', behavior: smooth };
    default:
      // 非導覽入口（開文前的定位、re-seed、點擊）：最少的移動、不做動畫。
      return { block: 'nearest', behavior: 'auto' };
  }
}

function clamp(v, maxScrollTop) {
  const max = Number(maxScrollTop);
  let out = Number(v) || 0;
  if (out < 0) out = 0;
  if (isFinite(max) && out > max) out = Math.max(0, max);
  return out;
}
