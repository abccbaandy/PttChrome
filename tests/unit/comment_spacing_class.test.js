// 推文區塊行距的容器 class 接線（render/screen.js#_setCommentSpacing）。
//
// 樣式本身是純 CSS（守護在 comment_spacing_css.test.js），這一支守的是**什麼時候
// 才可以掛上去**：
//   1. pref 開 ＋ 文章好讀累積長頁（stableRows）⇒ 掛；
//   2. pref 關 ⇒ 不掛（且要能當場拿掉，設定頁改完走 redraw(true)）；
//   3. 原生畫面（easyReading:false／pageState 非 3）⇒ 不掛；
//   4. **easyReading:true ＋ pageState 3，但沒有 stableRows ⇒ 不掛**。
//      這是最重要的一條：functionMode 原生鏡像與「防黑守門」兩條 fallback 會把
//      活的 24 列 buffer 交進來，enhance.easyReading 仍是 true（見
//      js/screen_annotations.js#annotationsAreRowIndependent 的註解）。那裡多出
//      任何高度就打破「原生鏡像期間畫面必須不可捲」的不變量 ⇒ 復發 2026-08-20 的
//      「推文時游標戳出反白輸入匡」（docs/easy-reading.md）。
import { mountScreen, unmountAll } from "./helpers/mount_screen";

afterEach(unmountAll);

const COLOR = {
  fg: 7,
  bg: 0,
  blink: false,
  equals(o) {
    return o === this;
  },
};

function cell(c) {
  return {
    ch: c,
    isLeadByte: false,
    isStartOfURL: () => false,
    isEndOfURL: () => false,
    getFullURL: () => null,
    getColor: () => COLOR,
  };
}
const line = (str) => str.split("").map(cell);

const TIME_COL = 67;
const comment = (marker, id, content, time) => {
  const prefix = ` ${id}: `;
  const startCol = 2 + prefix.length;
  const pad = " ".repeat(TIME_COL - (startCol + content.length));
  return [cell(marker), cell("")].concat(line(prefix + content + pad + time));
};

const LINES = [
  line("--"),
  comment("推", "testuser01", "first", "07/20 14:26"),
  comment("→", "testuser01", "second", "07/20 14:27"),
  comment("推", "another01", "unrelated", "07/20 14:29"),
];

const BASE = {
  lines: LINES,
  forceWidth: 20,
  enableLinkInlinePreview: false,
  enableLinkHoverPreview: false,
};

const ENHANCE_EASY = {
  pageState: 3,
  easyReading: true,
  dropHidden: true,
  stableRows: true,
  articleId: 1,
  mergeSameAuthorComments: true,
  commentBlockSpacing: true,
};

const mount = (enhanceExtra) =>
  mountScreen(
    Object.assign({}, BASE, {
      enhance: Object.assign({}, ENHANCE_EASY, enhanceExtra),
    }),
  );

const hasClass = (screen) =>
  screen.container.classList.contains("commentSpacing");

describe("推文區塊行距的容器 class", () => {
  test("pref 開 ＋ 好讀累積長頁 ⇒ 掛上 commentSpacing", () => {
    expect(hasClass(mount())).toBe(true);
  });

  test("pref 關 ⇒ 不掛", () => {
    expect(hasClass(mount({ commentBlockSpacing: false }))).toBe(false);
  });

  test("pref 從開改成關 ⇒ 當場拿掉（設定頁的 redraw(true)）", () => {
    const screen = mount();
    expect(hasClass(screen)).toBe(true);
    screen.update(
      Object.assign({}, BASE, {
        enhance: Object.assign({}, ENHANCE_EASY, {
          commentBlockSpacing: false,
        }),
      }),
    );
    expect(hasClass(screen)).toBe(false);
  });

  test("原生文章（easyReading:false）⇒ 不掛", () => {
    expect(
      hasClass(
        mount({ easyReading: false, dropHidden: false, stableRows: false }),
      ),
    ).toBe(false);
  });

  test("非文章頁（pageState 2）⇒ 不掛", () => {
    expect(hasClass(mount({ pageState: 2, stableRows: false }))).toBe(false);
  });

  // 回歸守護：這一組（easyReading:true + pageState 3 + 活 buffer）就是 functionMode
  // 原生鏡像與防黑守門的形狀。掛上去 ⇒ .main 變得可捲 ⇒ 推文時游標戳出輸入匡。
  test("functionMode 原生鏡像（easyReading:true、pageState 3，但無 stableRows）⇒ 不掛", () => {
    expect(hasClass(mount({ stableRows: false }))).toBe(false);
  });

  test("好讀 → functionMode 鏡像 ⇒ class 要跟著拿掉", () => {
    const screen = mount();
    expect(hasClass(screen)).toBe(true);
    screen.update(
      Object.assign({}, BASE, {
        enhance: Object.assign({}, ENHANCE_EASY, { stableRows: false }),
      }),
    );
    expect(hasClass(screen)).toBe(false);
  });
});
