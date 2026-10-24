// @unit-env browser
// real-input: tests/e2e/offline/mobile_reflow.offline.spec.js
//   （長按選單的觸控事件在 e2e 走既有豁免；本檔只測外殼與項目清單）
// 手機長按選單＝bottom sheet（ContextMenu/ContextSheet.jsx）。鎖：
//  1. 項目清單與桌機 Mantine Menu 同一份（context_menu_entries.js）：同樣的條件出現同樣的項目；
//  2. 點項目走同一個 handler（onMenuSelect 帶 key）；反灰項目不能點；
//  3. 開著＝modal（具名來源），收起時撤銷。
import mantineCss from "@mantine/core/styles.css?raw";
import sheetCss from "../../src/components/MobileSheet/MobileSheet.css?raw";
import { page } from "vitest/browser";
import { render, fireEvent, act } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { ContextSheet } from "../../src/components/ContextMenu/ContextSheet";
import { buildContextMenuEntries } from "../../src/components/ContextMenu/context_menu_entries";
import { setupI18n, i18n } from "../../src/js/i18n";

beforeAll(() => setupI18n());

const PROPS = {
  open: true,
  normalEnabled: true,
  selEnabled: false,
  urlEnabled: false,
  authorBlacklistId: "someone",
  authorBlacklistExists: false,
  markReadTarget: { num: 1 },
  longPushEnabled: true,
  articleLinkEnabled: true,
  previews: { copyArticleLink: "https://example/#Test/1abcDEFG" },
};

function setup(over = {}) {
  const sources = new Set();
  const pttchrome = {
    setModalOpen: vi.fn((s, on) => (on ? sources.add(s) : sources.delete(s))),
    registerSheetDismiss: () => () => {},
  };
  const handlers = {
    onHide: vi.fn(),
    onMenuSelect: vi.fn(),
    onTitleBlacklistClick: vi.fn(),
    onLongPushClick: vi.fn(),
    onInputHelperClick: vi.fn(),
    onLiveArticleHelperClick: vi.fn(),
    onSettingsClick: vi.fn(),
    onQuickSearchSelect: vi.fn(),
  };
  const props = { ...PROPS, ...handlers, ...over, pttchrome };
  const r = render(
    <MantineProvider>
      <ContextSheet {...props} />
    </MantineProvider>,
  );
  return { ...r, props, sources, handlers };
}

const items = () =>
  Array.from(document.querySelectorAll('[data-sheet="context"] [data-cmenu]'));

test("項目與桌機選單同一份清單、同一個順序", async () => {
  const { props } = setup();
  await vi.waitFor(() => expect(items().length).toBeGreaterThan(0));
  // 手機版清單（mobile: true）：全選／圖片上傳／設為全部已讀改在工具列「更多」。
  const want = buildContextMenuEntries({ ...props, mobile: true })
    .filter((e) => e.type === "item")
    .map((e) => e.key);
  expect(items().map((n) => n.getAttribute("data-cmenu"))).toEqual(want);
  // 複製類的第二行預覽照畫
  const link = document.querySelector('[data-cmenu="copyArticleLink"]');
  expect(link.textContent).toContain("https://example/#Test/1abcDEFG");
});

test("點項目走同一個 handler；反灰項目不能點", async () => {
  const { handlers } = setup({ authorBlacklistExists: true });
  await vi.waitFor(() => expect(items().length).toBeGreaterThan(0));
  const black = document.querySelector('[data-cmenu="addAuthorBlacklist"]');
  expect(black.disabled).toBe(true);
  fireEvent.click(document.querySelector('[data-cmenu="markReadUnread"]'));
  expect(handlers.onMenuSelect).toHaveBeenCalledWith(
    "markReadUnread",
    expect.anything(),
  );
  fireEvent.click(document.querySelector('[data-cmenu="longPush"]'));
  expect(handlers.onLongPushClick).toHaveBeenCalledTimes(1);
});

test("開著＝modal（具名來源），收起即撤銷", async () => {
  const { sources, rerender, props } = setup();
  expect(sources.size).toBe(1);
  act(() =>
    rerender(
      <MantineProvider>
        <ContextSheet {...props} open={false} />
      </MantineProvider>,
    ),
  );
  expect(sources.size).toBe(0);
});

// 長按 sheet 項目（「前已讀後未讀」…）不可叫出原生選字框；搜尋 sheet 的輸入框照常可選。
test("sheet 項目不可選字，輸入框例外", async () => {
  setup();
  await vi.waitFor(() => expect(items().length).toBeGreaterThan(0));
  const item = document.querySelector('[data-cmenu="markReadUnread"]');
  expect(getComputedStyle(item).userSelect).toBe("none");
  const sheet = document.querySelector('[data-sheet="context"]');
  const input = document.createElement("input");
  sheet.appendChild(input);
  expect(getComputedStyle(input).userSelect).not.toBe("none");
  input.remove();
});

// 長按畫面下方的文章（「前已讀後未讀」）：固定貼底的 sheet 會把那一列整個蓋掉，選中文章
// 外框等於沒畫；改貼頂又離手指一整個畫面遠。選單要像原生浮動選單一樣貼著長按的對象浮出、
// 不蓋住它（js/sheet_placement.js）。
describe("不蓋住長按的那一列", () => {
  // 真版面：Mantine 的 CSS 以 ?raw 注入（Vitest 不處理套件的 CSS import；沒有它 Drawer
  // 不是 fixed、量到的位置是假的），視窗改成手機大小（同 pref_modal_narrow.test.jsx）。
  let style;
  beforeAll(async () => {
    style = document.createElement("style");
    // MobileSheet.css 一起注入：浮動選單的絕對定位在它裡面。
    style.textContent = mantineCss + "\n" + sheetCss;
    document.head.appendChild(style);
    await page.viewport(390, 800);
  });
  afterAll(async () => {
    style.remove();
    await page.viewport(1024, 768);
  });

  const sheetRect = () =>
    document.querySelector('[data-sheet="context"]').getBoundingClientRect();

  // 選單與對象的距離上限：浮動選單要貼著對象（GAP 8px），不是跑到畫面另一端。
  const NEAR_PX = 16;

  test("REGRESSION：對象在畫面最下方 ⇒ 選單浮在對象正上方（不是畫面頂端），不蓋住它", async () => {
    const vh = window.innerHeight;
    const anchor = { top: vh - 60, bottom: vh - 30, x: 40 };
    setup({ menuAnchor: anchor });
    await vi.waitFor(() => expect(items().length).toBeGreaterThan(0));
    const sheet = document.querySelector('[data-sheet="context"]');
    expect(sheet.getAttribute("data-position")).toBe("float");
    await vi.waitFor(() => {
      const r = sheetRect();
      expect(r.height).toBeGreaterThan(0);
      expect(r.bottom).toBeLessThanOrEqual(anchor.top + 0.5);
      expect(anchor.top - r.bottom).toBeLessThanOrEqual(NEAR_PX);
      expect(r.left).toBeCloseTo(anchor.x, 0);
      expect(r.right).toBeLessThanOrEqual(window.innerWidth);
    });
  });

  test("對象在畫面上方 ⇒ 選單浮在對象正下方，不蓋住它", async () => {
    const anchor = { top: 20, bottom: 50, x: 380 };
    setup({ menuAnchor: anchor });
    await vi.waitFor(() => expect(items().length).toBeGreaterThan(0));
    await vi.waitFor(() => {
      const r = sheetRect();
      expect(r.height).toBeGreaterThan(0);
      expect(r.top).toBeGreaterThanOrEqual(anchor.bottom - 0.5);
      expect(r.top - anchor.bottom).toBeLessThanOrEqual(NEAR_PX);
      // 觸點靠右：選單往左推，不超出視窗
      expect(r.right).toBeLessThanOrEqual(window.innerWidth);
      expect(r.left).toBeGreaterThanOrEqual(0);
    });
  });

  test("量不到對象 ⇒ 退回貼底 sheet", async () => {
    setup({ menuAnchor: null });
    await vi.waitFor(() => expect(items().length).toBeGreaterThan(0));
    expect(
      document
        .querySelector('[data-sheet="context"]')
        .getAttribute("data-position"),
    ).toBe("bottom");
  });

  test("收起時（menuAnchor 被清掉）不跳位：退場動畫留在原本的位置", async () => {
    const vh = window.innerHeight;
    const { rerender, props } = setup({
      menuAnchor: { top: vh - 60, bottom: vh - 30, x: 40 },
    });
    await vi.waitFor(() => expect(items().length).toBeGreaterThan(0));
    act(() =>
      rerender(
        <MantineProvider>
          <ContextSheet {...props} open={false} menuAnchor={null} />
        </MantineProvider>,
      ),
    );
    const sheet = document.querySelector('[data-sheet="context"]');
    if (sheet) expect(sheet.getAttribute("data-position")).toBe("float");
  });
});

// P37：長按推文的選單，常用的幾項收成最上面一排圖示鈕（context_sheet_quick.js），其餘照舊。
describe("長按推文：常用項目收成一排圖示鈕", () => {
  const COMMENT = {
    ...PROPS,
    markReadTarget: null,
    authorBlacklistId: "friend",
    authorFollowEnabled: true,
    replyCommentTarget: "Friend",
    previews: {
      copyComment: "推 Friend: 嗨",
      copyCommentAll: "推 Friend: 嗨 06/14 10:01",
    },
    commentFilterTarget: {
      pusher: "friend",
      op: "opuser",
      row: 4,
      active: false,
    },
  };
  const quickKeys = () =>
    Array.from(
      document.querySelectorAll(
        '[data-sheet="context"] .mobileSheetQuickRow [data-cmenu]',
      ),
    ).map((n) => n.getAttribute("data-cmenu"));

  test("最多 5 顆、照優先序；短字在畫面上、完整的字在 aria-label；其餘項目照舊、一個都沒少", async () => {
    const { props, handlers } = setup(COMMENT);
    await vi.waitFor(() => expect(items().length).toBeGreaterThan(0));
    expect(quickKeys()).toEqual([
      "replyComment",
      "copyComment",
      "filterCommentUser",
      "filterCommentOp",
      "addAuthorFollow",
    ]);
    const reply = document.querySelector(
      '.mobileSheetQuickRow [data-cmenu="replyComment"]',
    );
    expect(reply.textContent).toBe(i18n("cmenuShort_replyComment"));
    expect(reply.getAttribute("aria-label")).toContain("'Friend'");
    // 跟桌機同一份清單：每一項都還在（圖示列＋下面的清單），只是重新分組
    const want = buildContextMenuEntries({ ...props, mobile: true })
      .filter((e) => e.type === "item")
      .map((e) => e.key)
      .sort();
    expect(
      items()
        .map((n) => n.getAttribute("data-cmenu"))
        .sort(),
    ).toEqual(want);
    // 下面的清單不重複列出已經在圖示列的
    const listed = Array.from(
      document.querySelectorAll('[data-sheet="context"] .mobileSheetItem'),
    ).map((n) => n.getAttribute("data-cmenu"));
    expect(listed).toContain("addAuthorBlacklist");
    expect(listed).not.toContain("replyComment");
    // 開頭不是分隔線
    const scroll = document.querySelector(
      '[data-sheet="context"] .mobileSheetQuickRow',
    ).parentElement;
    const afterRow = scroll.querySelector(
      ".mobileSheetQuickRow",
    ).nextElementSibling;
    expect(afterRow.classList.contains("mobileSheetDivider")).toBe(false);
    fireEvent.click(
      document.querySelector(
        '.mobileSheetQuickRow [data-cmenu="filterCommentUser"]',
      ),
    );
    expect(handlers.onMenuSelect).toHaveBeenCalledWith(
      "filterCommentUser",
      expect.anything(),
    );
  });

  test("篩選生效中 ⇒ 圖示列給「看全部」", async () => {
    setup({ ...COMMENT, commentFilterTarget: { active: true } });
    await vi.waitFor(() => expect(items().length).toBeGreaterThan(0));
    expect(quickKeys()).toContain("clearCommentFilter");
    expect(quickKeys()).not.toContain("filterCommentUser");
  });

  test("不是長按推文（列表卡片的黑名單／關注）⇒ 不收，照舊一列一項", async () => {
    setup({ ...PROPS, authorFollowEnabled: true });
    await vi.waitFor(() => expect(items().length).toBeGreaterThan(0));
    expect(document.querySelector(".mobileSheetQuickRow")).toBeNull();
  });
});
