// 右鍵選單的三件事：複製選項的預覽行、兩個小幫手的顯示開關，以及
// 「在連結上沒選取時不該出現複製項」那條回歸。
//
// 回歸來源：selEnabled 曾被寫成 normalEnabled 的補集 ⇒ 在連結上按右鍵（沒選取
// 任何文字）也會畫出「複製」「複製 (包含 ANSI 顏色)」，但 selectedText 是空字串
// ⇒ 點了什麼都沒發生。旗標本身守在 tests/unit/context_menu_items.test.js。
import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import DropdownMenu from "../../src/components/ContextMenu/DropdownMenu";
import { setupI18n, i18n } from "../../src/js/i18n";
import { copyPreviews } from "../../src/js/context_menu_items";

window.matchMedia =
  window.matchMedia ||
  (() => ({
    matches: false,
    media: "",
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
window.ResizeObserver =
  window.ResizeObserver ||
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

const renderMenu = (props = {}) =>
  render(
    <MantineProvider>
      <DropdownMenu
        open
        onHide={() => {}}
        pageX={10}
        pageY={10}
        urlEnabled={false}
        normalEnabled={false}
        selEnabled={false}
        quickSearchItems={[]}
        quickSearchQuery=""
        authorBlacklistId={null}
        authorBlacklistExists={false}
        titleBlacklistText={null}
        articleLinkEnabled={false}
        imageUploadEnabled={false}
        inputHelperEnabled={false}
        liveArticleHelperEnabled={false}
        contextArticle={null}
        previews={{}}
        onTitleBlacklistClick={() => {}}
        onMenuSelect={() => {}}
        onInputHelperClick={() => {}}
        onLiveArticleHelperClick={() => {}}
        onSettingsClick={() => {}}
        onQuickSearchSelect={() => {}}
        {...props}
      />
    </MantineProvider>,
  );

const previewTexts = () =>
  [...document.querySelectorAll(".DropdownMenu__preview")].map(
    (el) => el.textContent,
  );

beforeAll(() => setupI18n());

describe("右鍵選單：在連結上但沒選取文字", () => {
  test("不畫出點了沒作用的「複製」「複製 (包含 ANSI 顏色)」（REGRESSION）", () => {
    renderMenu({ urlEnabled: true, selEnabled: false });
    expect(screen.queryByText(i18n("cmenu_copy"), { exact: true })).toBeNull();
    expect(
      screen.queryByText(i18n("cmenu_copyAnsi"), { exact: true }),
    ).toBeNull();
    // 前提：連結那一組真的畫出來了（不然上面兩條是假綠）。
    expect(
      screen.getByText(i18n("cmenu_copyLinkUrl"), { exact: true }),
    ).toBeTruthy();
  });

  test("真的有選取時照舊有複製項", () => {
    renderMenu({ urlEnabled: true, selEnabled: true });
    expect(screen.getByText(i18n("cmenu_copy"), { exact: true })).toBeTruthy();
    expect(
      screen.getByText(i18n("cmenu_copyAnsi"), { exact: true }),
    ).toBeTruthy();
  });
});

describe("右鍵選單：複製預覽", () => {
  const article = { board: "movie", aid: "1gIeu-3A" };
  const HREF = "https://example.github.io/pttchrome/";

  test("四個複製項各自畫出自己的預覽行", () => {
    const previews = copyPreviews(
      {
        contextOnUrl: "https://i.imgur.com/Pn3XurX.jpeg",
        contextArticle: article,
        currentArticle: article,
      },
      HREF,
    );
    renderMenu({
      urlEnabled: true,
      normalEnabled: true,
      articleLinkEnabled: true,
      contextArticle: article,
      previews,
    });

    expect(previewTexts()).toEqual([
      "https://i.imgur.com/Pn3XurX.jpeg",
      "#1gIeu-3A (movie)",
      HREF + "#movie/M.1783270974.A.0CA.html",
      HREF + "#movie/M.1783270974.A.0CA.html",
    ]);
  });

  test("預覽是獨立元素：e2e 的 getByText(label, exact) 仍抓得到標題", () => {
    renderMenu({
      urlEnabled: true,
      previews: { copyLinkUrl: "https://i.imgur.com/Pn3XurX.jpeg" },
    });
    expect(
      screen.getByText(i18n("cmenu_copyLinkUrl"), { exact: true }),
    ).toBeTruthy();
  });

  test("算不出內容（長文還沒捲到「※ 文章網址」）→ 該項只有一行，仍在、仍可點", () => {
    renderMenu({
      normalEnabled: true,
      articleLinkEnabled: true,
      previews: {},
    });
    expect(
      screen.getByText(i18n("cmenu_copyArticleLink"), { exact: true }),
    ).toBeTruthy();
    expect(previewTexts()).toEqual([]);
  });
});

describe("右鍵選單：兩個小幫手的顯示開關", () => {
  test("預設（兩個都關）→ 選單裡看不到", () => {
    renderMenu({ normalEnabled: true });
    expect(
      screen.queryByText(i18n("cmenu_showInputHelper"), { exact: true }),
    ).toBeNull();
    expect(
      screen.queryByText(i18n("cmenu_showLiveArticleHelper"), { exact: true }),
    ).toBeNull();
  });

  test("各自打開 → 各自出現（互不牽連）", () => {
    const { unmount } = renderMenu({
      normalEnabled: true,
      inputHelperEnabled: true,
    });
    expect(
      screen.getByText(i18n("cmenu_showInputHelper"), { exact: true }),
    ).toBeTruthy();
    expect(
      screen.queryByText(i18n("cmenu_showLiveArticleHelper"), { exact: true }),
    ).toBeNull();
    unmount();

    renderMenu({ normalEnabled: true, liveArticleHelperEnabled: true });
    expect(
      screen.getByText(i18n("cmenu_showLiveArticleHelper"), { exact: true }),
    ).toBeTruthy();
    expect(
      screen.queryByText(i18n("cmenu_showInputHelper"), { exact: true }),
    ).toBeNull();
  });
});
