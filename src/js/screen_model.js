// 單一畫面模型的外殼（架構 review A3 步驟 a，docs/screen-model.md）。
//
// 「現在是哪個畫面」以前沒有統一的答案：pageState 是 0～6 的數字，各功能再各自叫
// TermBuf 的判定函式補判斷。這一層把它們收成**一幀一份**的畫面物件：
//   - kind：具名的畫面種類（SCREEN_KIND），認不出就是 UNKNOWN，不猜。
//   - 共用事實：一律是**現有判定函式的原樣結果**（isPassScreenNow、isPromptPending…），
//     這一步不改、不合併任何規則。功能刻意較嚴或較鬆的判定照舊各自留著。
//
// 「一幀」＝ TermBuf.notify 之間：notify 每處理一次內容或游標變動就把 frameSeq 加一（本地重繪
// 如 list_session._forceRedraw 也設 changed，也算一幀）。快取鍵另外帶 pageState、游標位置與
// 終端機大小：好讀會在 notify 以外直接改 pageState（easy_reading 的 pageStateOverride），
// 游標也可能在兩次 notify 之間被讀，resize（buf.resize）不經 notify。
// 每個事實是**用到才算**、算過這一幀就不再算，沒人問的事實不花成本。
//
// **讀的時機**：事實算的是「第一次讀它那一刻」的 buffer，之後同一幀沿用。parser 已寫入、
// 還沒 notify 的那一小段讀到的是半成品（updateCharAttr 還沒跑，雙位元組字沒併好），而且會
// 留到下一次 notify ⇒ 消費端只在 notify 之後讀（change／viewUpdate 監聽、screenSettled、
// 使用者輸入事件）。dismissTarget 這類刻意每次現算的判定不收進來（term_buf 那裡寫了理由）。

import { parseBoardName } from './screen_titles';

// TermBuf.setPageState 寫進 buf.pageState 的值。4 從 fork 進來就沒有人寫過，留著是因為
// 還有幾處比較它（步驟 c 換成具名常數時一起收）。
export const PAGE_STATE = Object.freeze({
  NORMAL: 0,
  MENU: 1, // 選單、信件列表、精華區（看板列表少數時候；大多是 2）
  LIST: 2, // 文章列表；看板列表（含我的最愛）通常也落在這裡
  READING: 3, // 文章（含推文實況）
  LEGACY_4: 4,
  PASS: 5, // 請按任意鍵、動畫畫面
  EDITOR: 6,
});

export const SCREEN_KIND = Object.freeze({
  UNKNOWN: 'unknown',
  PASS: 'pass',
  EDITOR: 'editor',
  ARTICLE: 'article',
  LIVE: 'live', // 官方推文實況（文章裡按 v）
  // pageState 2：文章列表或看板列表（看板列表大多判成 2，見 docs/board-list-smooth-scroll.md）。
  // 外殼不替它們加新的區分規則；要分的功能照舊問自己的指紋（board_list_parse）。
  LIST: 'list',
  // pageState 1 且標題列是【看板列表】（isBoardListScreen）。看板列表大多**不是**這個值而是 LIST；
  // 要判「是不是看板列表」請問 board_list_parse 的指紋。
  BOARD_LIST: 'boardList',
  MAIL_LIST: 'mailList',
  MENU: 'menu',
  OTHER_MENU: 'otherMenu', // pageState 1 但不是上面三種（例：精華區）
});

// 種類只由 pageState 與既有的子判定推出，規則跟各功能原本的寫法一致：
//   - pageState 本身會黏（pressanykey 後落在判不出的畫面時停在 5、編輯器 prompt 停在 6），
//     kind 照樣跟著黏。要「此刻真的是」的消費端讀 pass／editor 事實（isXxxScreenNow），
//     不讀 kind —— 這是兩個不同的問題，刻意不合併。
//   - 1 底下的子分類：信件列表只看指紋（isMailListScreen 不看 pageState）、看板列表與選單
//     的判定本來就只在 pageState 1 成立。
function kindOf(model) {
  switch (model.pageState) {
    case PAGE_STATE.PASS:
      return SCREEN_KIND.PASS;
    case PAGE_STATE.EDITOR:
      return SCREEN_KIND.EDITOR;
    case PAGE_STATE.READING:
      return model.live ? SCREEN_KIND.LIVE : SCREEN_KIND.ARTICLE;
    case PAGE_STATE.LIST:
      return SCREEN_KIND.LIST;
    case PAGE_STATE.MENU:
      if (model.mailList) return SCREEN_KIND.MAIL_LIST;
      if (model.boardList) return SCREEN_KIND.BOARD_LIST;
      if (model.menu) return SCREEN_KIND.MENU;
      return SCREEN_KIND.OTHER_MENU;
    default:
      return SCREEN_KIND.UNKNOWN;
  }
}

// 事實名 → 怎麼從 buf 算。每一條都是既有函式的原樣呼叫。
const FACTS = {
  row0Text: (buf) => buf.getRowText(0, 0, buf.cols),
  lastRowText: (buf) => buf.getRowText(buf.rows - 1, 0, buf.cols),
  pass: (buf) => buf.isPassScreenNow(),
  editor: (buf) => buf.isEditorScreenNow(),
  editorTyping: (buf) => buf.isEditorTypingNow(),
  live: (buf) => buf.isLiveScreenNow(),
  mailList: (buf) => buf.isMailListScreen(),
  boardList: (buf) => buf.isBoardListScreen(),
  menu: (buf) => buf.isMenuScreen(),
  cursorOnInputField: (buf) => buf.isCursorOnInputField(),
  promptPending: (buf) => buf.isPromptPending(),
  pagerContext: (buf) => buf.pagerContext(),
  boardName: (buf, model) => parseBoardName(model.row0Text),
};

export const SCREEN_FACTS = Object.freeze(Object.keys(FACTS));

class ScreenModel {
  constructor(buf, key) {
    this._buf = buf;
    this._key = key;
    this._memo = new Map();
    this._kind = undefined;
    this.frameSeq = key.frameSeq;
    this.pageState = key.pageState;
    this.cursorX = key.curX;
    this.cursorY = key.curY;
  }

  _fact(name) {
    if (!this._memo.has(name)) this._memo.set(name, FACTS[name](this._buf, this));
    return this._memo.get(name);
  }

  get kind() {
    if (this._kind === undefined) this._kind = kindOf(this);
    return this._kind;
  }

  get unknown() {
    return this.kind === SCREEN_KIND.UNKNOWN;
  }
}
for (const name of SCREEN_FACTS) {
  Object.defineProperty(ScreenModel.prototype, name, {
    get() {
      return this._fact(name);
    },
  });
}

function keyOf(buf) {
  return {
    frameSeq: buf.frameSeq | 0,
    pageState: buf.pageState,
    curX: buf.cur_x,
    curY: buf.cur_y,
    cols: buf.cols,
    rows: buf.rows,
  };
}

function sameKey(a, b) {
  return (
    a.frameSeq === b.frameSeq &&
    a.pageState === b.pageState &&
    a.curX === b.curX &&
    a.curY === b.curY &&
    a.cols === b.cols &&
    a.rows === b.rows
  );
}

const CACHE = new WeakMap();

// 這一幀的畫面物件。同一幀裡問幾次都是同一個物件。
export function screenOf(buf) {
  const key = keyOf(buf);
  const cached = CACHE.get(buf);
  if (cached && sameKey(cached._key, key)) return cached;
  const model = new ScreenModel(buf, key);
  CACHE.set(buf, model);
  return model;
}
