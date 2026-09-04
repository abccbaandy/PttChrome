// EasyReading.ensureEnabledOnArticle —— 外部導航（AID 跳文／deep link）落地時補上
// settle edge 給不了的那次「開好讀」。
//
// 為什麼需要它：deep link 的目標文章是踩著 **0→3** settle edge 進來的 —— 前一步
// 「#<aid>\r」的落地畫面 footer 列是空的（aid_navigation._enqueueAidSearch 的註解），
// term_buf.setPageState 末段的 isLineEmpty 分支把它判成 pageState 0。而
// nextEasyReadingState 只認 1|2 → 3，所以那條路**確定性**地不成立；另一條備援
// nextEasyReadingReentry 又要求 nativeArticleKey 已知，冷啟動時必然是 null。
//
// 實測 2026-08-16：「deep link 跳轉後有時不會進入好讀模式」——「有時」的來源是目標
// 看板有沒有帶 pmore footer 的進板畫面（有的話 s<board> 落地是 pageState 3，湊出一個
// 1→3 edge 讓好讀在**進板公告上**誤觸發，最後歪打正著）。

import { EasyReading } from "../../src/js/easy_reading";
import { readValuesWithDefault } from "../../src/js/pref_storage";

vi.mock("../../src/js/pref_storage", () => ({
  readValuesWithDefault: vi.fn(() => ({ enableEasyReading: true }))
}));

// 一篇文章第一頁的狀態列（string_util.parseStatusRow 認得的形狀，rowIndexStart = 1）。
const FIRST_PAGE_ROW =
  "  瀏覽 第 1/2 頁 ( 45%)  目前顯示: 第 1~23 行  (y)回應(X%)推文(h)說明(←)離開 ";
// 中途頁（rowIndexStart = 24）
const MID_PAGE_ROW =
  "  瀏覽 第 2/2 頁 ( 90%)  目前顯示: 第 24~46 行  (y)回應(X%)推文(h)說明(←)離開 ";

function harness({
  enabled = false,
  navActive = false,
  pageState = 3,
  lastRow = FIRST_PAGE_ROW,
  complete = true,
  supported = true
} = {}) {
  const buf = {
    rows: 24,
    cols: 80,
    pageState,
    // P6：完整回應的游標停在右下角
    cur_y: complete ? 23 : 5,
    cur_x: complete ? 79 : 0,
    getRowText(row) {
      return row === 23 ? lastRow : "";
    }
  };
  const ctx = {
    _enabled: enabled,
    _pendingEnableOnArticle: false,
    _termBuf: buf,
    enterCalls: 0,
    _core: {
      aidNavigation: { active: navActive },
      connectedUrl: { easyReadingSupported: supported }
    },
    _navActive: EasyReading.prototype._navActive,
    _currentPageStatus: EasyReading.prototype._currentPageStatus,
    // _onScreenSettled 第一件事就是掃 pmore 設定頁（見該函式）。用真的那一份，
    // 這個 harness 的畫面不是設定頁 ⇒ 回 false，不會動到旗標。
    _notePmorePrefScreen: EasyReading.prototype._notePmorePrefScreen,
    _pmorePrefSeen: false,
    _rawMode: null,
    enterEasyReading() {
      this.enterCalls++;
      this._enabled = true;
    }
  };
  return { ctx, buf };
}

const ensure = (ctx, allowRetry) =>
  EasyReading.prototype.ensureEnabledOnArticle.call(ctx, allowRetry);

beforeEach(() => {
  readValuesWithDefault.mockReturnValue({ enableEasyReading: true });
});

test("落在目標文章第一頁 → 開好讀", () => {
  const h = harness();
  expect(ensure(h.ctx, true)).toBe(true);
  expect(h.ctx.enterCalls).toBe(1);
});

test("REGRESSION：已經開著就絕不重開（守 P4 重複 PageDown）", () => {
  // 目標看板有進板畫面時，既有的 1→3 edge 路線會先開好讀。這裡若再開一次，
  // enterEasyReading 的 _resetPagingState 會清掉 _inFlightSig，於是同一頁被再送
  // 一次 PageDown → pttbbs typeahead skip → 那頁文字永久遺失。
  const h = harness({ enabled: true });
  expect(ensure(h.ctx, true)).toBe(false);
  expect(h.ctx.enterCalls).toBe(0);
});

test("導航還沒解鎖（active 仍為 true）→ 不開，也不留 one-shot 以外的東西", () => {
  // easy_reading._send 的第一道閘門就是 aidNavigation.active，這時開好讀會讓它
  // replay 出的第一個 PageDown 被整個吞掉，文章停在第一頁。
  const h = harness({ navActive: true });
  expect(ensure(h.ctx, true)).toBe(false);
  expect(h.ctx.enterCalls).toBe(0);
});

test("pref 關掉 / 連線不支援 → 不開", () => {
  readValuesWithDefault.mockReturnValue({ enableEasyReading: false });
  expect(ensure(harness().ctx, true)).toBe(false);
  readValuesWithDefault.mockReturnValue({ enableEasyReading: true });
  expect(ensure(harness({ supported: false }).ctx, true)).toBe(false);
});

test("落在文章中途頁 → 不開（從中途累積會少掉前面的內容）", () => {
  const h = harness({ lastRow: MID_PAGE_ROW });
  expect(ensure(h.ctx, true)).toBe(false);
});

test("落地當下畫面還沒完整 → 留 one-shot，下一次 settle 補開", () => {
  const h = harness({ complete: false });
  expect(ensure(h.ctx, true)).toBe(false);
  expect(h.ctx._pendingEnableOnArticle).toBe(true);
  // 下一次 settle：畫面完整了
  h.buf.cur_y = 23;
  h.buf.cur_x = 79;
  expect(ensure(h.ctx, false)).toBe(true);
  expect(h.ctx.enterCalls).toBe(1);
});

test("one-shot 只重試一次：第二次判不過就丟掉，不做輪詢", () => {
  const h = harness({ complete: false });
  ensure(h.ctx, true);
  expect(h.ctx._pendingEnableOnArticle).toBe(true);
  // 仍不完整，且這次是 allowRetry=false（消費點傳的）
  expect(ensure(h.ctx, false)).toBe(false);
  expect(h.ctx._pendingEnableOnArticle).toBe(false);
});

test("成功開啟後不留 one-shot", () => {
  const h = harness();
  ensure(h.ctx, true);
  expect(h.ctx._pendingEnableOnArticle).toBe(false);
});

// _onScreenSettled 的 disabled 分支是 one-shot 的唯一消費點。
describe("_onScreenSettled 消費 one-shot", () => {
  const settle = ctx => EasyReading.prototype._onScreenSettled.call(ctx);

  test("有 one-shot 且這次判得過 → 開好讀，且不再走 _maybeReenterOnNewArticle", () => {
    const h = harness({ complete: false });
    ensure(h.ctx, true);
    h.buf.cur_y = 23;
    h.buf.cur_x = 79;
    h.ctx.reenterCalls = 0;
    h.ctx.ensureEnabledOnArticle = EasyReading.prototype.ensureEnabledOnArticle;
    h.ctx._maybeReenterOnNewArticle = function() {
      this.reenterCalls++;
    };
    settle(h.ctx);
    expect(h.ctx.enterCalls).toBe(1);
    expect(h.ctx.reenterCalls).toBe(0);
  });

  test("沒有 one-shot → 照舊走 _maybeReenterOnNewArticle（不可被搶走）", () => {
    const h = harness();
    h.ctx.reenterCalls = 0;
    h.ctx.ensureEnabledOnArticle = EasyReading.prototype.ensureEnabledOnArticle;
    h.ctx._maybeReenterOnNewArticle = function() {
      this.reenterCalls++;
    };
    settle(h.ctx);
    expect(h.ctx.enterCalls).toBe(0);
    expect(h.ctx.reenterCalls).toBe(1);
  });
});
